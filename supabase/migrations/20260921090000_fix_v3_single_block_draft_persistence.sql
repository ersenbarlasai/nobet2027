-- ============================================================================
-- Nöbet2027 — solver-v3 TEK BLOK paket kalıcılığı düzeltmesi
-- ============================================================================
-- SORUN (20260920090000 incelemesinde bulundu):
--
--   20260919090000 (satır 546-548) yarım günü KAPALI bir öğretmenin aynı gün
--   AYNI nöbet yerinde iki farklı blok almasını AÇIKÇA meşru sayar ve paket
--   tablosundaki teacher+day+location tekilliğini bu yüzden KALDIRIR.
--   Buna karşılık 20260920090000'deki save_duty_plan_draft:
--     (a) R3 kontrolüyle bu durumu invalid_assignment ile REDDEDİYORDU, ve
--     (b) hücreleri paketlere (gün, yer, öğretmen, tür) BELİRSİZ JOIN'iyle
--         bağlıyordu — R3 kaldırılsaydı bu join aynı gün+yerdeki iki blok için
--         satır ÇOĞALTIRDI.
--
--   Yani yalnız R3'ü kaldırmak YETMEZ; yazma aşaması da düzeltilmelidir.
--
-- ÇÖZÜM (yalnız ileri yönlü, eski migration'lar DEĞİŞTİRİLMEDİ):
--   * v3 planlarda HER normal hücre KENDİ SINGLE_BLOCK paketini alır; paket
--     hücre bazında oluşturulur ve dönen UUID DOĞRUDAN o hücreye bağlanır.
--   * Sabit hücreler (gün, yer, öğretmen) bazında TEK FIXED_SHORT_BREAKS
--     paketi altında gruplanmaya DEVAM eder.
--   * Atanmamış hücrelerin package_id değeri NULL kalır.
--   * v3 authoritative teacherLoads: her normal SINGLE_BLOCK paket BİR normal
--     görev birimidir (aynı gün+yerde iki blok = 2 birim). Sabit yük distinct
--     sabit nöbet günüdür. Haftalık max AYNI birimle değerlendirilir.
--   * v1/v2 paketleme ve yük sayımı DEĞİŞMEZ — tarihsel planlar etkilenmez.
--
-- Bütün doğrulamalar herhangi bir DELETE/INSERT'ten ÖNCE biter; işlem tek
-- transaction içinde atomiktir.
-- ============================================================================

create or replace function public.save_duty_plan_draft(
  p_campus_name text,
  p_academic_year_name text,
  p_expected_source_fingerprint text,
  p_algorithm_version text,
  p_generation_seed integer,
  p_generation_options jsonb,
  p_assignments jsonb,
  p_summary jsonb,
  p_allow_partial boolean,
  p_expected_plan_id uuid default null,
  p_expected_plan_version integer default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  -- v3 ⇔ normal görevler TEK HÜCRELİ (SINGLE_BLOCK). Paketleme ve yük sayımı
  -- v3'te HÜCRE bazlıdır; v1/v2 davranışı DEĞİŞMEZ.
  v_is_v3 boolean := p_algorithm_version like 'duty-plan-solver-v3%';
  v_cell record;
  v_pkg_id uuid;
  v_fixed_pkg_id uuid;
  v_campus_id uuid;
  v_year_id uuid;
  v_import record;
  v_current_fingerprint text;
  v_min integer;
  v_target integer;
  v_max integer;
  v_bad boolean;
  v_analysis record;
  v_existing_plan_id uuid;
  v_existing_plan_version integer;
  v_plan_id uuid;
  v_plan record;
  v_summary_teacher_loads jsonb;
begin
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_algorithm_version), '') = '' then
    raise exception 'algorithm_version zorunludur.' using errcode = '22023';
  end if;
  if p_allow_partial is null then
    raise exception 'allow_partial zorunludur.' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_assignments, 'null'::jsonb)) is distinct from 'array' then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'assignments_not_array');
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then
    return jsonb_build_object('status', 'source_changed', 'currentSourceFingerprint', null);
  end if;

  select id into v_year_id
    from public.academic_years
    where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then
    return jsonb_build_object('status', 'source_changed', 'currentSourceFingerprint', null);
  end if;

  select * into v_import
    from public.timetable_imports
    where campus_id = v_campus_id and academic_year_id = v_year_id and status = 'imported'
    order by imported_at desc nulls last, created_at desc
    limit 1;
  if not found then
    return jsonb_build_object('status', 'source_changed', 'currentSourceFingerprint', null);
  end if;

  v_current_fingerprint := public.compute_duty_plan_source_fingerprint(p_campus_name, p_academic_year_name);
  if v_current_fingerprint is distinct from p_expected_source_fingerprint then
    return jsonb_build_object('status', 'source_changed', 'currentSourceFingerprint', v_current_fingerprint);
  end if;

  v_min := coalesce((p_generation_options ->> 'minWeeklyDuties')::integer, 1);
  v_target := coalesce((p_generation_options ->> 'targetWeeklyDuties')::integer, 2);
  v_max := coalesce((p_generation_options ->> 'maxWeeklyDuties')::integer, 3);
  if v_min < 0 or v_min > 5 or v_target < 0 or v_target > 5 or v_max < 0 or v_max > 5
     or not (v_min <= v_target and v_target <= v_max) then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'invalid_generation_options');
  end if;

  select exists (
    select 1 from jsonb_to_recordset(p_assignments)
      as x(day_order int, duty_location_id uuid, duty_block_id uuid, teacher_source_id text, assignment_kind text)
    group by x.day_order, x.duty_location_id, x.duty_block_id
    having count(*) > 1
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'duplicate_cell');
  end if;

  -- ==========================================================================
  -- ÖĞRETMEN × GÜN KURALLARI — analizden ÖNCE, hiçbir satır yazılmadan.
  -- Sıra ÖNEMLİ: en NET ihlal önce döner (sabit gün > aynı blok > yarım gün),
  -- aksi halde aday geçerliliği gibi TÜREV bir gerekçe gerçek nedeni gizler.
  -- ==========================================================================

  -- (R1) SABİT nöbet günü: o gün HİÇBİR normal görev alınamaz — yarım gün
  -- ayarından BAĞIMSIZDIR.
  select exists (
    select 1 from (
      select distinct x.day_order, nullif(btrim(x.teacher_source_id), '') as teacher_source_id
        from jsonb_to_recordset(p_assignments)
          as x(day_order int, duty_location_id uuid, duty_block_id uuid, teacher_source_id text, assignment_kind text)
       where x.assignment_kind in ('generated', 'manual') and nullif(btrim(x.teacher_source_id), '') is not null
    ) x
    join public.fixed_duty_assignments fa
      on fa.academic_year_id = v_year_id and fa.day_order = x.day_order and fa.teacher_source_id = x.teacher_source_id
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'teacher_has_fixed_duty');
  end if;

  -- (R2) AYNI GÜN + AYNI BLOK'ta ikinci görev HER ZAMAN yasaktır (yarım gün
  -- kuralı kapalı olsa bile aynı blokta iki farklı yerde bulunulamaz).
  select exists (
    select 1 from (
      select distinct x.day_order, nullif(btrim(x.teacher_source_id), '') as teacher_source_id,
             x.duty_block_id as blk, x.duty_location_id as loc
        from jsonb_to_recordset(p_assignments)
          as x(day_order int, duty_location_id uuid, duty_block_id uuid, teacher_source_id text, assignment_kind text)
       where x.assignment_kind in ('fixed', 'generated', 'manual') and nullif(btrim(x.teacher_source_id), '') is not null
    ) x
    group by x.day_order, x.teacher_source_id, x.blk
    having count(distinct x.loc) > 1
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'teacher_block_conflict');
  end if;

  -- (R3) KALDIRILDI (bkz. 20260921090000 başlığı). Eski kontrol, aynı gün AYNI
  -- YERDE iki farklı blok alan (yarım günü KAPALI) bir öğretmeni reddediyordu;
  -- oysa 20260919090000 bu durumu AÇIKÇA meşru sayar ve paket tablosundaki
  -- teacher+day+location tekilliğini bu yüzden kaldırmıştır. Kuralın gerçek
  -- gereği "her normal hücre AYRI bir SINGLE_BLOCK paket olsun"dur; bu artık
  -- YAZMA aşamasında yapısal olarak sağlanır (aşağıdaki v3 döngüsü), bu yüzden
  -- reddetmeye gerek yoktur.

  -- (R4) YARIM GÜN kuralı AÇIK öğretmen: aynı gün EN FAZLA BİR normal blok.
  -- Kapalı öğretmende günlük tavan dört bloktur.
  select exists (
    select 1 from (
      select x.day_order, nullif(btrim(x.teacher_source_id), '') as teacher_source_id,
             count(distinct x.duty_block_id) as block_count
        from jsonb_to_recordset(p_assignments)
          as x(day_order int, duty_location_id uuid, duty_block_id uuid, teacher_source_id text, assignment_kind text)
       where x.assignment_kind in ('generated', 'manual') and nullif(btrim(x.teacher_source_id), '') is not null
       group by x.day_order, nullif(btrim(x.teacher_source_id), '')
    ) g
    where g.block_count > case when public.teacher_half_day_rule_enabled(v_year_id, g.teacher_source_id) then 1 else 4 end
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'teacher_day_conflict', 'reason', 'half_day_rule');
  end if;

  with expected as (
    -- AUTHORITATIVE: sabitlik BLOK düzeyindedir (assignment_mode).
    select d.day_order, dl.id as loc, b.id as blk, (lb.assignment_mode = 'fixed_only') as is_fixed
      from generate_series(1, 5) as d(day_order)
      cross join public.duty_locations dl
      join public.duty_location_blocks lb on lb.duty_location_id = dl.id
      join public.duty_blocks b on b.id = lb.duty_block_id and b.is_active
     where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null
  ),
  submitted as (
    select x.day_order, x.duty_location_id as loc, x.duty_block_id as blk,
           nullif(btrim(x.teacher_source_id), '') as teacher_source_id, x.assignment_kind
      from jsonb_to_recordset(p_assignments)
        as x(day_order int, duty_location_id uuid, duty_block_id uuid, teacher_source_id text, assignment_kind text)
  ),
  joined as (
    select e.day_order as e_day, e.loc as e_loc, e.blk as e_blk, e.is_fixed as e_is_fixed,
           s.loc as s_loc, s.teacher_source_id, s.assignment_kind
      from expected e
      full outer join submitted s
        on s.day_order = e.day_order and s.loc = e.loc and s.blk = e.blk
  ),
  existing_fixed as (
    select fa.day_order, fa.duty_location_id as loc, fa.teacher_source_id, fa.id as fixed_id
      from public.fixed_duty_assignments fa
      where fa.academic_year_id = v_year_id
  ),
  candidate_valid as (
    select distinct d.day_order, dl.id as loc, b.id as blk, ts.teacher_source_id
      from generate_series(1, 5) as d(day_order)
      cross join public.duty_locations dl
      join public.duty_location_blocks lb on lb.duty_location_id = dl.id
      join public.duty_blocks b on b.id = lb.duty_block_id and b.is_active
      join public.teacher_duty_block_availabilities av
        on av.duty_location_id = dl.id and av.duty_block_id = b.id and av.day_order = d.day_order
      join public.teacher_duty_settings ts
        on ts.id = av.teacher_duty_setting_id and ts.academic_year_id = v_year_id and ts.is_included
      join public.teachers tt on tt.timetable_import_id = v_import.id and tt.source_id = ts.teacher_source_id
     where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null
       -- Normal aday YALNIZ assignment_mode='normal' hücrelerde oluşur.
       and lb.assignment_mode = 'normal'
       and not exists (
         select 1 from public.fixed_duty_assignments fa2
         where fa2.academic_year_id = v_year_id and fa2.day_order = d.day_order and fa2.teacher_source_id = ts.teacher_source_id
       )
       and public.is_teacher_eligible_for_duty_block_time(v_import.id, tt.id, d.day_order, b.id)
  ),
  -- PAKET GRUPLARI: aynı gün+öğretmen+yer bir arada — coverage_mode geçerli
  -- bir şablona (FULL_DAY/SHORT_BREAKS/FIXED_SHORT_BREAKS/SINGLE_BLOCK) uymalı
  -- VE grup içinde TEK bir assignment_kind olmalı.
  -- PAKET GRUPLARI. v3'te NORMAL paketler HÜCRE bazlıdır: gruplama anahtarına
  -- blok da girer, böylece aynı gün+yerdeki iki farklı blok İKİ AYRI paket
  -- sayılır (yük formülünün authoritative birimi). Sabit paketler her iki
  -- sürümde de (gün, yer, öğretmen) bazında GRUPLANMAYA devam eder
  -- (FIXED_SHORT_BREAKS = Sabah + Öğleden Sonra çifti).
  package_groups as (
    select s.day_order, s.loc, s.teacher_source_id, s.assignment_kind,
           case when v_is_v3 and s.assignment_kind in ('generated', 'manual') then s.blk else null end as grp_blk,
           array_agg(distinct b.code) as block_codes
      from submitted s
      join public.duty_blocks b on b.id = s.blk
     where s.teacher_source_id is not null and s.assignment_kind in ('fixed', 'generated', 'manual')
     group by s.day_order, s.loc, s.teacher_source_id, s.assignment_kind,
              case when v_is_v3 and s.assignment_kind in ('generated', 'manual') then s.blk else null end
  ),
  -- "Paket içi karışık tür" kontrolü MANTIKSAL PAKET anahtarında yapılır.
  -- v3'te bu anahtar (gün, yer, öğretmen, BLOK)'tur: aynı gün+yerdeki Sabah
  -- hücresinin 'manual', Öğleden Sonra hücresinin 'generated' olması İKİ AYRI
  -- SINGLE_BLOCK paket demektir ve karışık tür DEĞİLDİR. v1/v2'de anahtar
  -- (gün, yer, öğretmen) olarak KALIR (tarihsel davranış korunur).
  package_kind_variety as (
    select day_order, loc, teacher_source_id, grp_blk, count(distinct assignment_kind) as kind_variety
      from package_groups
      group by day_order, loc, teacher_source_id, grp_blk
  ),
  package_groups_classified as (
    select pg.*, public.classify_duty_plan_package_coverage(pg.loc, pg.assignment_kind, pg.block_codes) as coverage_mode
      from package_groups pg
  ),
  teacher_universe as (
    select s.teacher_source_id
      from public.teacher_duty_settings s
      where s.academic_year_id = v_year_id and s.is_included
    union
    select fa.teacher_source_id
      from public.fixed_duty_assignments fa
      where fa.academic_year_id = v_year_id
  ),
  -- YENİ haftalık yük: satır değil PAKET-GÜN sayısı (aynı gün+yer+öğretmen
  -- grubu = 1 paket = 1 gün, kapsadığı hücre sayısından BAĞIMSIZ).
  normal_by_teacher as (
    select teacher_source_id, count(*) as normal_count
      from package_groups
      where assignment_kind in ('generated', 'manual')
      group by teacher_source_id
  ),
  fixed_days_by_teacher as (
    select fa.teacher_source_id, count(distinct fa.day_order) as fixed_days
      from public.fixed_duty_assignments fa
      where fa.academic_year_id = v_year_id
      group by fa.teacher_source_id
  ),
  teacher_loads as (
    select coalesce(jsonb_agg(jsonb_build_object(
        'teacherSourceId', tu.teacher_source_id,
        'normalDutyCount', coalesce(nb.normal_count, 0),
        'fixedDutyDayCount', coalesce(fb.fixed_days, 0),
        'totalDutyCount', coalesce(nb.normal_count, 0) + coalesce(fb.fixed_days, 0)
        ) order by tu.teacher_source_id), '[]'::jsonb) as arr
      from teacher_universe tu
      left join normal_by_teacher nb on nb.teacher_source_id = tu.teacher_source_id
      left join fixed_days_by_teacher fb on fb.teacher_source_id = tu.teacher_source_id
  )
  select
    bool_or(j.e_loc is not null and j.s_loc is null) as missing_task,
    bool_or(j.e_loc is null and j.s_loc is not null) as extra_task,
    bool_or(j.e_loc is not null and j.assignment_kind is null) as missing_kind,
    bool_or(j.e_is_fixed and j.assignment_kind not in ('fixed', 'unassigned')) as fixed_task_wrong_kind,
    bool_or(not j.e_is_fixed and j.assignment_kind = 'fixed') as normal_task_marked_fixed,
    bool_or(j.e_is_fixed and j.assignment_kind = 'fixed' and ef.fixed_id is null) as fixed_missing_underlying,
    bool_or(j.e_is_fixed and j.assignment_kind = 'fixed' and ef.fixed_id is not null and ef.teacher_source_id is distinct from j.teacher_source_id) as fixed_teacher_mismatch,
    bool_or(j.e_is_fixed and j.assignment_kind = 'unassigned' and ef.fixed_id is not null) as fixed_wrongly_unassigned,
    bool_or(not j.e_is_fixed and j.assignment_kind = 'unassigned' and not p_allow_partial) as unassigned_not_allowed,
    bool_or(j.e_loc is not null and (j.assignment_kind = 'unassigned') is distinct from (j.teacher_source_id is null)) as teacher_null_mismatch,
    bool_or(not j.e_is_fixed and j.assignment_kind in ('generated', 'manual') and cv.teacher_source_id is null) as candidate_invalid,
    count(*) filter (where j.e_loc is not null) as total_task_count,
    count(*) filter (where j.e_is_fixed) as fixed_task_count,
    count(*) filter (where j.e_is_fixed and j.assignment_kind = 'fixed') as fixed_covered_count,
    count(*) filter (where not j.e_is_fixed) as normal_task_count,
    count(*) filter (where not j.e_is_fixed and j.assignment_kind in ('generated', 'manual')) as normal_covered_count,
    count(*) filter (where j.assignment_kind = 'unassigned') as uncovered_count,
    (select bool_or(kind_variety > 1) from package_kind_variety) as package_mixed_kind,
    (select bool_or(coverage_mode is null) from package_groups_classified) as package_invalid_combination,
    (select arr from teacher_loads) as teacher_loads_json
    into v_analysis
  from joined j
  left join existing_fixed ef on j.e_is_fixed and ef.day_order = j.e_day and ef.loc = j.e_loc
  left join candidate_valid cv
    on not j.e_is_fixed and j.assignment_kind in ('generated', 'manual')
   and cv.day_order = j.e_day and cv.loc = j.e_loc and cv.blk = j.e_blk and cv.teacher_source_id = j.teacher_source_id;

  if v_analysis.missing_task or v_analysis.extra_task then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'task_set_mismatch');
  end if;
  if v_analysis.missing_kind or v_analysis.teacher_null_mismatch or v_analysis.normal_task_marked_fixed then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'invalid_assignment_kind');
  end if;
  if v_analysis.fixed_task_wrong_kind or v_analysis.fixed_wrongly_unassigned then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'fixed_task_requires_fixed_or_unassigned');
  end if;
  if v_analysis.fixed_missing_underlying or v_analysis.fixed_teacher_mismatch then
    return jsonb_build_object('status', 'fixed_assignment_changed');
  end if;
  if v_analysis.unassigned_not_allowed then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'partial_not_allowed');
  end if;
  if v_analysis.candidate_invalid then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'candidate_no_longer_valid');
  end if;


  -- (5b) Paket içi: TEK assignment_kind, block kümesi GEÇERLİ bir şablona uymalı.
  if v_analysis.package_mixed_kind then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'invalid_package_combination');
  end if;
  if v_analysis.package_invalid_combination then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'invalid_package_combination');
  end if;

  -- (6) Haftalık üst sınır — artık PAKET-GÜN sayısı (satır değil).
  select exists (
    select 1 from jsonb_array_elements(v_analysis.teacher_loads_json) as tl
    where (tl ->> 'totalDutyCount')::int > v_max
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'weekly_limit_exceeded');
  end if;

  v_summary_teacher_loads := coalesce(p_summary -> 'teacherLoads', '[]'::jsonb);
  if (p_summary ->> 'totalTaskCount')::int is distinct from v_analysis.total_task_count
     or (p_summary ->> 'fixedTaskCount')::int is distinct from v_analysis.fixed_task_count
     or (p_summary ->> 'fixedCoveredCount')::int is distinct from v_analysis.fixed_covered_count
     or (p_summary ->> 'normalTaskCount')::int is distinct from v_analysis.normal_task_count
     or (p_summary ->> 'normalCoveredCount')::int is distinct from v_analysis.normal_covered_count
     or (p_summary ->> 'uncoveredCount')::int is distinct from v_analysis.uncovered_count
     or v_summary_teacher_loads is distinct from v_analysis.teacher_loads_json
  then
    return jsonb_build_object(
      'status', 'invalid_summary',
      'authoritative', jsonb_build_object(
        'totalTaskCount', v_analysis.total_task_count,
        'fixedTaskCount', v_analysis.fixed_task_count,
        'fixedCoveredCount', v_analysis.fixed_covered_count,
        'normalTaskCount', v_analysis.normal_task_count,
        'normalCoveredCount', v_analysis.normal_covered_count,
        'uncoveredCount', v_analysis.uncovered_count,
        'teacherLoads', v_analysis.teacher_loads_json
      )
    );
  end if;

  perform pg_advisory_xact_lock(hashtext('duty-plan-draft:' || v_year_id::text));

  select id, version into v_existing_plan_id, v_existing_plan_version
    from public.duty_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id and status = 'draft'
    for update;

  if v_existing_plan_id is distinct from p_expected_plan_id then
    return jsonb_build_object('status', 'version_conflict', 'currentPlanId', v_existing_plan_id, 'currentVersion', v_existing_plan_version);
  end if;

  if v_existing_plan_id is not null and p_expected_plan_version is not null
     and v_existing_plan_version is distinct from p_expected_plan_version then
    return jsonb_build_object('status', 'version_conflict', 'currentPlanId', v_existing_plan_id, 'currentVersion', v_existing_plan_version);
  end if;

  delete from public.duty_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id and status = 'draft';

  insert into public.duty_plans (
    campus_id, academic_year_id, timetable_import_id, status,
    source_fingerprint, algorithm_version, generation_seed, generation_options, summary, version
  ) values (
    v_campus_id, v_year_id, v_import.id, 'draft',
    v_current_fingerprint, p_algorithm_version, p_generation_seed,
    coalesce(p_generation_options, '{}'::jsonb), coalesce(p_summary, '{}'::jsonb), 1
  ) returning id into v_plan_id;

  -- ==========================================================================
  -- YAZMA AŞAMASI. Bütün doğrulamalar YUKARIDA bitmiştir; buradan sonrası
  -- tek transaction içinde atomik yazımdır.
  --
  -- v3: her normal hücre KENDİ SINGLE_BLOCK paketini alır. Paket hücre
  -- bazında oluşturulur ve dönen UUID DOĞRUDAN o hücreye bağlanır — belirsiz
  -- (gün, yer, öğretmen, tür) JOIN'i KULLANILMAZ (o join, aynı gün+yerde iki
  -- blok olduğunda satır ÇOĞALTIRDI). ~190 hücre için deterministik döngü
  -- maliyeti önemsizdir; doğruluk önceliklidir.
  -- ==========================================================================
  if v_is_v3 then
    -- (a) SABİT paketler: (gün, yer, öğretmen) bazında TEK paket (grup).
    for v_cell in
      select distinct x.day_order, x.duty_location_id as loc, nullif(btrim(x.teacher_source_id), '') as teacher_source_id
        from jsonb_to_recordset(p_assignments)
          as x(day_order int, duty_location_id uuid, duty_block_id uuid, teacher_source_id text, assignment_kind text)
       where x.assignment_kind = 'fixed' and nullif(btrim(x.teacher_source_id), '') is not null
       order by 1, 2, 3
    loop
      insert into public.duty_plan_assignment_packages (
        plan_id, campus_id, day_order, duty_location_id, teacher_source_id, teacher_name_snapshot,
        coverage_mode, assignment_kind, fixed_duty_assignment_id
      )
      select v_plan_id, v_campus_id, v_cell.day_order, v_cell.loc, v_cell.teacher_source_id,
             coalesce(tt.name, ef3.teacher_name_snapshot),
             'FIXED_SHORT_BREAKS', 'fixed', ef3.id
        from public.fixed_duty_assignments ef3
        left join public.teachers tt on tt.timetable_import_id = v_import.id and tt.source_id = v_cell.teacher_source_id
       where ef3.academic_year_id = v_year_id and ef3.day_order = v_cell.day_order
         and ef3.duty_location_id = v_cell.loc and ef3.teacher_source_id = v_cell.teacher_source_id
      returning id into v_fixed_pkg_id;

      insert into public.duty_plan_assignments (
        plan_id, campus_id, day_order, duty_location_id, duty_block_id,
        teacher_source_id, teacher_name_snapshot, duty_location_name_snapshot, duty_block_name_snapshot,
        assignment_kind, fixed_duty_assignment_id, score_details, package_id
      )
      select v_plan_id, v_campus_id, x.day_order, x.duty_location_id, x.duty_block_id,
             v_cell.teacher_source_id, coalesce(tt.name, ef2.teacher_name_snapshot),
             dl.name, b.name, 'fixed', ef2.id, coalesce(x.score_details, '{}'::jsonb), v_fixed_pkg_id
        from jsonb_to_recordset(p_assignments) as x(
          day_order int, duty_location_id uuid, duty_block_id uuid,
          teacher_source_id text, assignment_kind text, score_details jsonb
        )
        join public.duty_locations dl on dl.id = x.duty_location_id
        join public.duty_blocks b on b.id = x.duty_block_id
        left join public.teachers tt on tt.timetable_import_id = v_import.id and tt.source_id = v_cell.teacher_source_id
        left join public.fixed_duty_assignments ef2
          on ef2.academic_year_id = v_year_id and ef2.day_order = x.day_order
         and ef2.duty_location_id = x.duty_location_id and ef2.teacher_source_id = v_cell.teacher_source_id
       where x.assignment_kind = 'fixed'
         and x.day_order = v_cell.day_order and x.duty_location_id = v_cell.loc
         and nullif(btrim(x.teacher_source_id), '') = v_cell.teacher_source_id;
    end loop;

    -- (b) NORMAL hücreler: HER BİRİ için ayrı SINGLE_BLOCK paket.
    for v_cell in
      select x.day_order, x.duty_location_id as loc, x.duty_block_id as blk,
             nullif(btrim(x.teacher_source_id), '') as teacher_source_id,
             x.assignment_kind, coalesce(x.score_details, '{}'::jsonb) as score_details
        from jsonb_to_recordset(p_assignments) as x(
          day_order int, duty_location_id uuid, duty_block_id uuid,
          teacher_source_id text, assignment_kind text, score_details jsonb
        )
       where x.assignment_kind in ('generated', 'manual') and nullif(btrim(x.teacher_source_id), '') is not null
       order by 1, 2, 3, 4
    loop
      insert into public.duty_plan_assignment_packages (
        plan_id, campus_id, day_order, duty_location_id, teacher_source_id, teacher_name_snapshot,
        coverage_mode, assignment_kind, fixed_duty_assignment_id
      )
      select v_plan_id, v_campus_id, v_cell.day_order, v_cell.loc, v_cell.teacher_source_id,
             coalesce(tt.name, v_cell.teacher_source_id),
             'SINGLE_BLOCK', v_cell.assignment_kind, null
        from (select 1) as one
        left join public.teachers tt on tt.timetable_import_id = v_import.id and tt.source_id = v_cell.teacher_source_id
      returning id into v_pkg_id;

      insert into public.duty_plan_assignments (
        plan_id, campus_id, day_order, duty_location_id, duty_block_id,
        teacher_source_id, teacher_name_snapshot, duty_location_name_snapshot, duty_block_name_snapshot,
        assignment_kind, fixed_duty_assignment_id, score_details, package_id
      )
      select v_plan_id, v_campus_id, v_cell.day_order, v_cell.loc, v_cell.blk,
             v_cell.teacher_source_id, coalesce(tt.name, v_cell.teacher_source_id),
             dl.name, b.name, v_cell.assignment_kind, null, v_cell.score_details, v_pkg_id
        from public.duty_locations dl
        join public.duty_blocks b on b.id = v_cell.blk
        left join public.teachers tt on tt.timetable_import_id = v_import.id and tt.source_id = v_cell.teacher_source_id
       where dl.id = v_cell.loc;
    end loop;

    -- (c) ATANMAMIŞ hücreler: package_id NULL.
    insert into public.duty_plan_assignments (
      plan_id, campus_id, day_order, duty_location_id, duty_block_id,
      teacher_source_id, teacher_name_snapshot, duty_location_name_snapshot, duty_block_name_snapshot,
      assignment_kind, fixed_duty_assignment_id, score_details, package_id
    )
    select v_plan_id, v_campus_id, x.day_order, x.duty_location_id, x.duty_block_id,
           null, null, dl.name, b.name, 'unassigned', null, coalesce(x.score_details, '{}'::jsonb), null
      from jsonb_to_recordset(p_assignments) as x(
        day_order int, duty_location_id uuid, duty_block_id uuid,
        teacher_source_id text, assignment_kind text, score_details jsonb
      )
      join public.duty_locations dl on dl.id = x.duty_location_id
      join public.duty_blocks b on b.id = x.duty_block_id
     where x.assignment_kind = 'unassigned';

    select * into v_plan from public.duty_plans where id = v_plan_id;
    return jsonb_build_object(
      'status', 'ok',
      'planId', v_plan.id,
      'version', v_plan.version,
      'sourceFingerprint', v_plan.source_fingerprint,
      'createdAt', v_plan.created_at,
      'updatedAt', v_plan.updated_at
    );
  end if;

  -- ==========================================================================
  -- v1/v2 YOLU — DEĞİŞTİRİLMEDİ (tarihsel paketleme davranışı korunur).
  -- ==========================================================================
  with submitted2 as (
    select x.day_order, x.duty_location_id as loc, x.duty_block_id as blk,
           nullif(btrim(x.teacher_source_id), '') as teacher_source_id, x.assignment_kind
      from jsonb_to_recordset(p_assignments)
        as x(day_order int, duty_location_id uuid, duty_block_id uuid, teacher_source_id text, assignment_kind text)
  ),
  groups2 as (
    select s.day_order, s.loc, s.teacher_source_id, s.assignment_kind,
           array_agg(distinct b.code) as block_codes
      from submitted2 s
      join public.duty_blocks b on b.id = s.blk
     where s.teacher_source_id is not null and s.assignment_kind in ('fixed', 'generated', 'manual')
     group by s.day_order, s.loc, s.teacher_source_id, s.assignment_kind
  )
  insert into public.duty_plan_assignment_packages (
    plan_id, campus_id, day_order, duty_location_id, teacher_source_id, teacher_name_snapshot,
    coverage_mode, assignment_kind, fixed_duty_assignment_id
  )
  select
    v_plan_id, v_campus_id, g.day_order, g.loc, g.teacher_source_id,
    coalesce(tt.name, ef3.teacher_name_snapshot),
    public.classify_duty_plan_package_coverage(g.loc, g.assignment_kind, g.block_codes),
    g.assignment_kind,
    case when g.assignment_kind = 'fixed' then ef3.id else null end
  from groups2 g
  left join public.teachers tt on tt.timetable_import_id = v_import.id and tt.source_id = g.teacher_source_id
  left join public.fixed_duty_assignments ef3
    on g.assignment_kind = 'fixed'
   and ef3.academic_year_id = v_year_id and ef3.day_order = g.day_order and ef3.duty_location_id = g.loc
   and ef3.teacher_source_id = g.teacher_source_id;

  insert into public.duty_plan_assignments (
    plan_id, campus_id, day_order, duty_location_id, duty_block_id,
    teacher_source_id, teacher_name_snapshot, duty_location_name_snapshot, duty_block_name_snapshot,
    assignment_kind, fixed_duty_assignment_id, score_details, package_id
  )
  select
    v_plan_id, v_campus_id, x.day_order, x.duty_location_id, x.duty_block_id,
    nullif(btrim(x.teacher_source_id), ''),
    case when nullif(btrim(x.teacher_source_id), '') is not null
      then coalesce(tt.name, ef2.teacher_name_snapshot)
      else null
    end,
    dl.name, b.name,
    x.assignment_kind, ef2.id,
    coalesce(x.score_details, '{}'::jsonb),
    pkg.id
  from jsonb_to_recordset(p_assignments) as x(
    day_order int, duty_location_id uuid, duty_block_id uuid,
    teacher_source_id text, assignment_kind text, score_details jsonb
  )
  join public.duty_locations dl on dl.id = x.duty_location_id
  join public.duty_blocks b on b.id = x.duty_block_id
  left join public.teachers tt
    on tt.timetable_import_id = v_import.id and tt.source_id = nullif(btrim(x.teacher_source_id), '')
  left join public.fixed_duty_assignments ef2
    on x.assignment_kind = 'fixed'
   and ef2.academic_year_id = v_year_id and ef2.day_order = x.day_order and ef2.duty_location_id = x.duty_location_id
   and ef2.teacher_source_id = nullif(btrim(x.teacher_source_id), '')
  left join public.duty_plan_assignment_packages pkg
    on pkg.plan_id = v_plan_id and pkg.day_order = x.day_order and pkg.duty_location_id = x.duty_location_id
   and pkg.teacher_source_id = nullif(btrim(x.teacher_source_id), '') and pkg.assignment_kind = x.assignment_kind;

  select * into v_plan from public.duty_plans where id = v_plan_id;

  return jsonb_build_object(
    'status', 'ok',
    'planId', v_plan.id,
    'version', v_plan.version,
    'sourceFingerprint', v_plan.source_fingerprint,
    'createdAt', v_plan.created_at,
    'updatedAt', v_plan.updated_at
  );
end;
$$;
comment on function public.save_duty_plan_draft(text, text, text, text, integer, jsonb, jsonb, jsonb, boolean, uuid, integer) is
  'Volatile, atomik: PAKET-FARKINDA yeniden doğrulama + taslak yazımı. v3 (duty-plan-solver-v3*) planlarda HER normal hücre AYRI bir SINGLE_BLOCK paket olarak yazılır (paket hücre bazında oluşturulup dönen UUID doğrudan bağlanır; belirsiz JOIN YOK); sabit hücreler (gün, yer, öğretmen) bazında tek FIXED_SHORT_BREAKS paketinde gruplanır; unassigned hücrelerde package_id NULL kalır. v3 yük birimi = normal SINGLE_BLOCK paket sayısı + distinct sabit nöbet günü. v1/v2 paketleme davranışı DEĞİŞMEDİ. Yeni kurallar: aynı gün+blok ikinci görev ⇒ teacher_block_conflict; yarım gün kuralı açık öğretmende günde birden fazla normal görev ⇒ teacher_day_conflict/half_day_rule; sabit nöbet gününde normal görev ⇒ teacher_has_fixed_duty. Atomiklik, fingerprint, expected version ve FOR UPDATE korumaları KORUNDU. Yalnız service_role çağırabilir.';

revoke all on function public.save_duty_plan_draft(text, text, text, text, integer, jsonb, jsonb, jsonb, boolean, uuid, integer) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.save_duty_plan_draft(text, text, text, text, integer, jsonb, jsonb, jsonb, boolean, uuid, integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.save_duty_plan_draft(text, text, text, text, integer, jsonb, jsonb, jsonb, boolean, uuid, integer) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.save_duty_plan_draft(text, text, text, text, integer, jsonb, jsonb, jsonb, boolean, uuid, integer) to service_role;
  end if;
end
$$;
