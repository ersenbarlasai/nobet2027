-- ============================================================================
-- Nöbet2027 — save_duty_plan_draft: teacherLoads evren uyumsuzluğu düzeltmesi
-- ============================================================================
-- KÖK NEDEN
-- ----------------------------------------------------------------------------
-- 20260915090000_create_automatic_duty_plan_drafts.sql REMOTE'A UYGULANDIKTAN
-- SONRA, save_duty_plan_draft içindeki teacher_union/fixed_days_by_teacher
-- CTE'lerinin YALNIZ o isteğin 'submitted' kümesinden (fixed/normal
-- satırlardan) türetildiği, get_duty_plan_generation_snapshot.teachers ve
-- solver'ın kullandığı GERÇEK evrenle (is_included=true TÜM öğretmenler ∪ o
-- yılın TÜM sabit atama öğretmenleri) AYNI OLMADIĞI görüldü. Hiç atanmamış
-- ama dahil bir öğretmen authoritative teacherLoads dizisinden kayboluyor,
-- servisin doğru (solver'dan gelen) özeti bu yüzden invalid_summary ile
-- reddediliyordu.
--
-- Supabase migration takibi DOSYA VERSİYONUNA göredir, İÇERİK HASH'İNE göre
-- DEĞİL — 20260915090000 zaten "applied" işaretliyken yerel dosyada yapılan
-- bu düzeltme remote'a YENİDEN UYGULANMAZ. Bu yüzden AYRI, YENİ bir migration
-- gerekiyor. 20260915090000 dosyası BURADA DA DEĞİŞTİRİLMEDİ (yalnız arşiv
-- kaydı olarak kalır) — bu dosya save_duty_plan_draft'ı `create or replace`
-- ile GÜNCEL (düzeltilmiş) gövdesiyle yeniden tanımlar. İmza AYNIDIR, hiçbir
-- tablo/RLS/yetki değişmez, veri kaybı riski yoktur.
--
-- DÜZELTME
-- ----------------------------------------------------------------------------
-- teacher_universe: teacher_duty_settings(is_included=true) ∪
--   fixed_duty_assignments — GÜNCEL tablolardan, submitted'tan DEĞİL.
-- fixed_days_by_teacher: GÜNCEL fixed_duty_assignments tablosundan
--   count(distinct day_order) — submitted'taki 'fixed' satırlarından DEĞİL.
-- teacher_loads: bu evrenden LEFT JOIN ile üretilir; hiç atanmamış dahil
--   öğretmen de 0/0/0 ile authoritative dizide bulunur.
-- weekly_limit_exceeded kontrolü AYNI authoritative teacher_loads'ı kullanır
--   (değişmedi).
--
-- BU MIGRATION NE YAPMAZ
-- ----------------------------------------------------------------------------
-- Hiçbir tablo/CHECK/index/trigger değişmez. Hiçbir başka fonksiyon
-- değişmez (compute_duty_plan_source_fingerprint, get_duty_plan_generation_
-- snapshot, get_current_duty_plan_draft, get_duty_plan_draft,
-- delete_duty_plan_draft AYNEN kalır). RLS/yetki/GRANT dokunulmaz (fonksiyon
-- imzası değişmediği için 20260915090000'deki GRANT'ler geçerliliğini korur).
-- ============================================================================

-- p_expected_plan_id anlamı (KESİN):
--   NULL          — istemci AKTİF TASLAK OLMADIĞINI düşünüyor. Şu anda bir
--                    aktif taslak VARSA (başka biri/istek onu zaten
--                    oluşturmuş) version_conflict döner — sessizce EZİLMEZ.
--   <uuid>        — istemci BİLİNÇLİ olarak BU taslağı yenilemek istiyor.
--                    Mevcut aktif taslağın id'si bununla eşleşmiyorsa
--                    (farklı bir taslak VARSA YA DA HİÇ taslak yoksa)
--                    version_conflict döner.
-- Her iki durumda da tek karşılaştırma yeterlidir: mevcut aktif taslağın id'si
-- (null olabilir) p_expected_plan_id'den (null olabilir) FARKLIYSA reddet.
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
  p_expected_plan_id uuid default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
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

  -- (1) KAYNAK PARMAK İZİ hâlâ istemcinin beklediğiyle aynı mı.
  v_current_fingerprint := public.compute_duty_plan_source_fingerprint(p_campus_name, p_academic_year_name);
  if v_current_fingerprint is distinct from p_expected_source_fingerprint then
    return jsonb_build_object('status', 'source_changed', 'currentSourceFingerprint', v_current_fingerprint);
  end if;

  -- (2) generation_options sınırları.
  v_min := coalesce((p_generation_options ->> 'minWeeklyDuties')::integer, 1);
  v_target := coalesce((p_generation_options ->> 'targetWeeklyDuties')::integer, 2);
  v_max := coalesce((p_generation_options ->> 'maxWeeklyDuties')::integer, 3);
  if v_min < 0 or v_min > 5 or v_target < 0 or v_target > 5 or v_max < 0 or v_max > 5
     or not (v_min <= v_target and v_target <= v_max) then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'invalid_generation_options');
  end if;

  -- (3) Tekrarlanan hücre.
  select exists (
    select 1 from jsonb_to_recordset(p_assignments)
      as x(day_order int, duty_location_id uuid, duty_block_id uuid, teacher_source_id text, assignment_kind text)
    group by x.day_order, x.duty_location_id, x.duty_block_id
    having count(*) > 1
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'duplicate_cell');
  end if;

  -- (4) TEK büyük analiz sorgusu: görev kümesi eksiksiz/tekil mi, fixed
  -- satırlar gerçek sabit atamayla aynı mı, normal aday hâlâ geçerli mi —
  -- HEPSİ aynı 'expected'/'submitted' evreninden, tek seferde.
  with expected as (
    select d.day_order, dl.id as loc, b.id as blk, dl.allows_fixed_assignment as is_fixed
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
     where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null and not dl.allows_fixed_assignment
       and not exists (
         select 1 from public.fixed_duty_assignments fa2
         where fa2.academic_year_id = v_year_id and fa2.day_order = d.day_order and fa2.teacher_source_id = ts.teacher_source_id
       )
       and public.is_teacher_eligible_for_duty_block_time(v_import.id, tt.id, d.day_order, b.id)
  ),
  -- Yetkili özet (bkz. bulgu 7, ve bulgu 1 revizyonu). ÖĞRETMEN EVRENİ,
  -- get_duty_plan_generation_snapshot.teachers ve solver'ın kullandığı
  -- evrenle BİREBİR AYNI olmalıdır: is_included=true TÜM öğretmenler
  -- (candidateEdges'te hiç görünmese, hiç görev almasa BİLE) ∪ o eğitim
  -- yılındaki TÜM sabit atama öğretmenleri. Yalnız 'submitted'tan (bu isteğe
  -- ait atamalardan) türetilirse, hiç görev almamış ama dahil bir öğretmen
  -- authoritative dizide KAYBOLUR ve solver'ın ürettiği (doğru) özetle
  -- uyuşmaz — bu ÖNCEKİ HATANIN kök nedeniydi.
  teacher_universe as (
    select s.teacher_source_id
      from public.teacher_duty_settings s
      where s.academic_year_id = v_year_id and s.is_included
    union
    select fa.teacher_source_id
      from public.fixed_duty_assignments fa
      where fa.academic_year_id = v_year_id
  ),
  -- fixed_days_by_teacher: GÜNCEL fixed_duty_assignments tablosundan (snapshot'ın
  -- teacherFixedDutyLoads'uyla AYNI kaynak) — submitted'taki 'fixed' satırlarından
  -- DEĞİL. Böylece normal adayı/görevi olmayan ama sabit nöbeti bulunan bir
  -- öğretmen de doğru yükle görünür; aynı günün sabah+öğleden sonra iki fixed
  -- hücresi count(distinct day_order) ile YİNE tek gün sayılır.
  fixed_days_by_teacher as (
    select fa.teacher_source_id, count(distinct fa.day_order) as fixed_days
      from public.fixed_duty_assignments fa
      where fa.academic_year_id = v_year_id
      group by fa.teacher_source_id
  ),
  normal_by_teacher as (
    select s.teacher_source_id, count(*) as normal_count
      from submitted s
      where s.assignment_kind in ('generated', 'manual') and s.teacher_source_id is not null
      group by s.teacher_source_id
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

  -- (5) Aynı gün aynı öğretmen iki kez normal/sabit görev alamaz.
  select exists (
    select 1 from jsonb_to_recordset(p_assignments)
      as x(day_order int, duty_location_id uuid, duty_block_id uuid, teacher_source_id text, assignment_kind text)
    where x.assignment_kind in ('generated', 'manual')
    group by x.day_order, x.teacher_source_id
    having count(*) > 1
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'teacher_day_conflict');
  end if;

  select exists (
    select 1 from jsonb_to_recordset(p_assignments)
      as x(day_order int, duty_location_id uuid, duty_block_id uuid, teacher_source_id text, assignment_kind text)
    join public.fixed_duty_assignments fa
      on fa.academic_year_id = v_year_id and fa.day_order = x.day_order and fa.teacher_source_id = x.teacher_source_id
    where x.assignment_kind in ('generated', 'manual')
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'teacher_day_conflict');
  end if;

  -- (6) Haftalık üst sınır — bulgu 1: yük = normal generated/manual GÜN
  -- sayısı + AYRI sabit nöbet GÜN sayısı (aynı sabit günün sabah+öğleden
  -- sonra iki satırı BİR gün sayılır, iki değil — bkz. fixed_days_by_teacher/
  -- teacher_loads). v_analysis.teacher_loads_json zaten bu toplamı
  -- (totalDutyCount) taşır; burada yalnız v_max ile karşılaştırılır.
  select exists (
    select 1 from jsonb_array_elements(v_analysis.teacher_loads_json) as tl
    where (tl ->> 'totalDutyCount')::int > v_max
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'weekly_limit_exceeded');
  end if;

  -- (6b) Özet doğrulama (bulgu 7): istemcinin p_summary'si, doğrulanmış
  -- atama kümesinden yeniden hesaplanan yetkili değerlerle BİREBİR
  -- uyuşmalıdır. Kısmi/çelişkili bir özet KAYDEDİLMEZ.
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

  -- (7) EŞZAMANLILIK: kampüs+yıl için tek aktif draft — advisory lock.
  perform pg_advisory_xact_lock(hashtext('duty-plan-draft:' || v_year_id::text));

  select id into v_existing_plan_id
    from public.duty_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id and status = 'draft';

  -- p_expected_plan_id semantiği (bkz. fonksiyon üstü yorum): mevcut aktif
  -- taslağın id'si (null olabilir) beklenenden (null olabilir) FARKLIYSA
  -- reddet — NULL beklenirken var olan bir taslak SESSİZCE EZİLMEZ.
  if v_existing_plan_id is distinct from p_expected_plan_id then
    return jsonb_build_object('status', 'version_conflict', 'currentPlanId', v_existing_plan_id);
  end if;

  -- (8) Atomik: eski aktif taslağı değiştir, yenisini yaz.
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

  insert into public.duty_plan_assignments (
    plan_id, campus_id, day_order, duty_location_id, duty_block_id,
    teacher_source_id, teacher_name_snapshot, duty_location_name_snapshot, duty_block_name_snapshot,
    assignment_kind, fixed_duty_assignment_id, score_details
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
    coalesce(x.score_details, '{}'::jsonb)
  from jsonb_to_recordset(p_assignments) as x(
    day_order int, duty_location_id uuid, duty_block_id uuid,
    teacher_source_id text, assignment_kind text, score_details jsonb
  )
  join public.duty_locations dl on dl.id = x.duty_location_id
  join public.duty_blocks b on b.id = x.duty_block_id
  left join public.teachers tt
    on tt.timetable_import_id = v_import.id and tt.source_id = nullif(btrim(x.teacher_source_id), '')
  -- YALNIZ 'fixed' satırlar için eşleştirilir — CHECK
  -- (duty_plan_assignments_fixed_link_ck) generated/manual/unassigned
  -- satırlarda bu sütunun HER ZAMAN null olmasını zorunlu kılar.
  left join public.fixed_duty_assignments ef2
    on x.assignment_kind = 'fixed'
   and ef2.academic_year_id = v_year_id and ef2.day_order = x.day_order and ef2.duty_location_id = x.duty_location_id
   and ef2.teacher_source_id = nullif(btrim(x.teacher_source_id), '');

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

comment on function public.save_duty_plan_draft(text, text, text, text, integer, jsonb, jsonb, jsonb, boolean, uuid) is
  'Volatile, atomik: sunucudan gelen üretilmiş atamaları TEK transaction''da yeniden doğrulayıp kaydeder. Görev kümesi eksiksizliği, fixed satır tutarlılığı, aday geçerliliği, günlük/haftalık kısıtlar (normal gün sayısı + AYRI sabit gün sayısı toplamı) YENİDEN hesaplanır (istemciye güvenilmez). teacherLoads evreni is_included=true TÜM öğretmenler ∪ o yılın TÜM sabit atama öğretmenlerinden türetilir (bkz. 20260916090000 düzeltmesi) — yalnız submitted''tan DEĞİL. İstemcinin özeti (p_summary) bu yetkili değerlerle karşılaştırılır, uyuşmazsa invalid_summary. p_expected_plan_id NULL ⇔ istemci aktif taslak yok sanıyor; dolu ⇔ o taslağı bilinçli yeniliyor — her iki durumda da mevcut aktif taslağın id''si beklenenden farklıysa version_conflict (sessiz ezme yok). Tek hata TÜM kaydı rollback eder. Kampüs+yıl için tek aktif draft advisory lock ile garantilenir. Yalnız service_role çağırabilir.';

-- ============================================================================
-- Yetkilendirme
-- ============================================================================
-- İmza DEĞİŞMEDİ (aynı parametre listesi) — 20260915090000'deki GRANT/REVOKE
-- (service_role-only) geçerliliğini korur; burada TEKRAR EDİLMEZ.
