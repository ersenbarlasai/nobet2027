-- ============================================================================
-- Nöbet2027 — Manuel atama + Yayımlama (draft → published → archived)
-- ============================================================================
-- KÖK NEDEN
-- ----------------------------------------------------------------------------
-- Otomatik taslak (bkz. 20260915090000) yalnız üretim/okuma/silme sağlıyordu;
-- "Manuel atama ve yayımlama bu aşamada YOKTUR" (bkz. o migration'ın 5.
-- bölüm yorumu). Bu migration iki yeni yetenek ekler:
--   1) Taslaktaki TEK bir normal görev hücresini, sunucu tarafında TAM
--      yeniden doğrulanarak (kaynak fingerprint, aday geçerliliği, zaman
--      kuralı, günlük/haftalık kısıt) elle değiştirmek.
--   2) Tamamlanmış bir taslağı, atomik olarak "published" yapmak — eski
--      published planı "archived"a çevirerek — ve bu andan itibaren HEM
--      API HEM DE DB SEVİYESİNDE değiştirilemez kılmak.
--
-- ORTAKLAŞTIRMA
-- ----------------------------------------------------------------------------
-- Aday geçerliliği / zaman uygunluğu (is_teacher_eligible_for_duty_block_time)
-- ve günlük/haftalık kısıt formülleri save_duty_plan_draft (20260915090000)
-- ile AYNI kaynaktan (aynı ortak fonksiyon, aynı sayım biçimi: sabit GÜN
-- sayısı + normal SATIR sayısı) hesaplanır — ikinci, çelişebilecek bir kural
-- kümesi YOKTUR.
--
-- BU MIGRATION NE YAPMAZ
-- ----------------------------------------------------------------------------
-- Önceki hiçbir migration dosyası değiştirilmedi. Hiçbir backfill/veri
-- taşıma yapılmaz. duty_locations / duty_blocks / fixed_duty_assignments /
-- teacher_duty_* tablolarına HİÇ INSERT/UPDATE/DELETE yapılmaz (yalnız
-- SELECT). Remote'a asla dokunulmaz.
-- ============================================================================

-- ============================================================================
-- 1. Tek aktif "published" plan — draft'takiyle aynı desende partial unique.
-- ============================================================================
create unique index duty_plans_one_active_published_uq
  on public.duty_plans (campus_id, academic_year_id)
  where status = 'published';

-- ============================================================================
-- 2. DB SEVİYESİNDE immutability — API'nin ötesinde, tablo yazma yolunun
--    KENDİSİ engellenir (bir sonraki geliştirici API kontrolünü atlasa/bir
--    hata yapsa bile published/archived satırlar değişemez).
-- ============================================================================
-- enforce_duty_plan_lifecycle: published bir plan yalnız archived'a geçebilir
-- ve bu geçişte YALNIZ status+updated_at değişebilir (summary/options/
-- version/fingerprint/vb. AYNI kalmalı — "arşivleme" başka hiçbir alanı
-- değiştiremeyen dar bir işlemdir). archived bir plan hiçbir şekilde
-- değişemez/silinemez. Yeni bir plan satırı YALNIZ 'draft' olarak
-- oluşturulabilir — INSERT ile doğrudan published/archived YASAK (yayımlama
-- her zaman publish_duty_plan_draft'ın draft→published geçişinden geçmelidir).
create or replace function public.enforce_duty_plan_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'Yeni bir nöbet planı yalnız taslak (draft) olarak oluşturulabilir.' using errcode = '55000';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status in ('published', 'archived') then
      raise exception 'Yayımlanmış veya arşivlenmiş bir plan silinemez.' using errcode = '55000';
    end if;
    return old;
  end if;

  -- UPDATE
  if old.status = 'archived' then
    raise exception 'Arşivlenmiş bir plan değiştirilemez.' using errcode = '55000';
  end if;
  if old.status = 'published' then
    if new.status is distinct from 'archived' then
      raise exception 'Yayımlanmış bir plan yalnız arşivlenebilir, başka biçimde değiştirilemez.' using errcode = '55000';
    end if;
    if new.campus_id is distinct from old.campus_id
       or new.academic_year_id is distinct from old.academic_year_id
       or new.timetable_import_id is distinct from old.timetable_import_id
       or new.source_fingerprint is distinct from old.source_fingerprint
       or new.algorithm_version is distinct from old.algorithm_version
       or new.generation_seed is distinct from old.generation_seed
       or new.generation_options is distinct from old.generation_options
       or new.summary is distinct from old.summary
       or new.version is distinct from old.version
       or new.created_at is distinct from old.created_at
    then
      raise exception 'Yayımlanmış bir plan arşivlenirken yalnız durum değişebilir; başka alan değiştirilemez.' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.enforce_duty_plan_lifecycle() is
  'BEFORE INSERT/UPDATE/DELETE tetikleyicisi: yeni plan satırı yalnız draft olarak oluşturulabilir; published bir plan yalnız archived''a geçebilir VE bu geçişte yalnız status+updated_at değişebilir (başka alan değişirse reddedilir); archived bir plan hiçbir şekilde değişemez/silinemez; published/archived planlar silinemez. API katmanının (publish_duty_plan_draft/delete_duty_plan_draft) ötesinde DB seviyesinde son savunma hattıdır.';

create trigger enforce_duty_plan_lifecycle
  before insert or update or delete on public.duty_plans
  for each row execute function public.enforce_duty_plan_lifecycle();

-- enforce_duty_plan_assignment_write_rules: published/archived bir planın
-- atamaları hiçbir normal yazma yoluyla (INSERT DAHİL) değiştirilemez. TEK
-- istisna: fixed_duty_assignment_id'nin ON DELETE SET NULL referential
-- action'ıyla null'a düşmesi — bu durumda (assignment_kind/teacher_source_id/
-- day_order/duty_location_id/duty_block_id/snapshot alanları/score_details
-- AYNEN kalırken YALNIZ fixed_duty_assignment_id null'a düşerse) satır
-- published/archived bir planda bile güncellenebilir; başka HİÇBİR alanın
-- AYNI ANDA değişmesine izin verilmez.
create or replace function public.enforce_duty_plan_assignment_write_rules()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_plan_status text;
  v_is_fixed_link_clear boolean := false;
begin
  select status into v_plan_status from public.duty_plans where id = coalesce(new.plan_id, old.plan_id);

  if tg_op = 'UPDATE' then
    v_is_fixed_link_clear := (
      old.assignment_kind = 'fixed'
      and new.assignment_kind = 'fixed'
      and old.fixed_duty_assignment_id is not null
      and new.fixed_duty_assignment_id is null
      and new.plan_id is not distinct from old.plan_id
      and new.campus_id is not distinct from old.campus_id
      and new.day_order is not distinct from old.day_order
      and new.duty_location_id is not distinct from old.duty_location_id
      and new.duty_block_id is not distinct from old.duty_block_id
      and new.teacher_source_id is not distinct from old.teacher_source_id
      and new.teacher_name_snapshot is not distinct from old.teacher_name_snapshot
      and new.duty_location_name_snapshot is not distinct from old.duty_location_name_snapshot
      and new.duty_block_name_snapshot is not distinct from old.duty_block_name_snapshot
      and new.score_details is not distinct from old.score_details
      and new.created_at is not distinct from old.created_at
    );
  end if;

  if v_plan_status in ('published', 'archived') and not v_is_fixed_link_clear then
    raise exception 'Yayımlanmış veya arşivlenmiş bir planın atamaları değiştirilemez.' using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  -- UPDATE: fixed satırlar hiçbir durumda düzenlenemez (öğretmen/tür/hücre
  -- kimliği DEĞİŞTİRİLEMEZ) — yalnız yukarıdaki dar fixed_duty_assignment_id
  -- temizleme istisnası (v_is_fixed_link_clear) buradan MUAFTIR.
  if tg_op = 'UPDATE' and old.assignment_kind = 'fixed' and not v_is_fixed_link_clear and (
       new.assignment_kind is distinct from old.assignment_kind
    or new.teacher_source_id is distinct from old.teacher_source_id
    or new.duty_location_id is distinct from old.duty_location_id
    or new.duty_block_id is distinct from old.duty_block_id
    or new.day_order is distinct from old.day_order
  ) then
    raise exception 'Sabit görev hücreleri düzenlenemez.' using errcode = '55000';
  end if;

  return new;
end;
$$;

comment on function public.enforce_duty_plan_assignment_write_rules() is
  'BEFORE INSERT/UPDATE/DELETE tetikleyicisi: (1) plan published/archived ise HİÇBİR atama satırı yazılamaz/değişemez/silinemez — TEK istisna fixed_duty_assignment_id''nin ON DELETE SET NULL ile (başka HİÇBİR alan değişmeden) null''a düşmesidir; (2) fixed satırların öğretmeni/türü/hücre kimliği asla değiştirilemez. update_duty_plan_assignment RPC''sinin ötesinde DB seviyesinde son savunma hattıdır.';

create trigger enforce_duty_plan_assignment_write_rules
  before insert or update or delete on public.duty_plan_assignments
  for each row execute function public.enforce_duty_plan_assignment_write_rules();

-- ============================================================================
-- 3. get_duty_plan_task_candidates — TEK görev hücresi için aday listesi
-- ============================================================================
-- p_task_id, duty_plan_assignments.id'dir ("tasks/:taskId" — istemcinin
-- zaten elinde olan taslak satır kimliği; gün/yer/blok üçlüsü YERİNE tek,
-- kararlı bir kimlik kullanılır).
--
-- Salt okunur/bilgilendirici: gerçek yazma anında update_duty_plan_assignment
-- HER ŞEYİ bağımsız olarak (bu fonksiyona güvenmeden) yeniden doğrular —
-- burada "eligible" görünen bir adayın update anında reddedilmesi (ör. o
-- arada başka bir manuel değişiklik oldu) mümkündür; update_duty_plan_
-- assignment'ın kendi hata kodu her zaman yetkilidir.
create or replace function public.get_duty_plan_task_candidates(
  p_plan_id uuid,
  p_task_id uuid,
  p_campus_name text,
  p_academic_year_name text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_plan record;
  v_row record;
  v_current_fp text;
  v_max integer;
  v_candidates jsonb;
  v_day_order integer;
  v_duty_location_id uuid;
  v_duty_block_id uuid;
begin
  if p_plan_id is null or p_task_id is null then
    raise exception 'plan_id ve task_id zorunludur.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then return jsonb_build_object('found', false); end if;

  select id into v_year_id from public.academic_years where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then return jsonb_build_object('found', false); end if;

  select * into v_plan from public.duty_plans where id = p_plan_id and campus_id = v_campus_id and academic_year_id = v_year_id;
  if not found then return jsonb_build_object('found', false); end if;

  select * into v_row from public.duty_plan_assignments where id = p_task_id and plan_id = p_plan_id;
  if not found then
    return jsonb_build_object('found', true, 'taskFound', false, 'planStatus', v_plan.status, 'planVersion', v_plan.version);
  end if;
  v_day_order := v_row.day_order;
  v_duty_location_id := v_row.duty_location_id;
  v_duty_block_id := v_row.duty_block_id;

  v_current_fp := public.compute_duty_plan_source_fingerprint(p_campus_name, p_academic_year_name);
  v_max := coalesce((v_plan.generation_options ->> 'maxWeeklyDuties')::int, 3);

  select coalesce(jsonb_agg(jsonb_build_object(
      'teacherSourceId', s.teacher_source_id,
      'teacherName', coalesce(t.name, s.teacher_name_snapshot),
      'isCurrent', s.teacher_source_id = v_row.teacher_source_id,
      'eligible', (
        v_row.assignment_kind <> 'fixed'
        and not exists (
          select 1 from public.fixed_duty_assignments fa
          where fa.academic_year_id = v_year_id and fa.day_order = v_day_order and fa.teacher_source_id = s.teacher_source_id
        )
        and not exists (
          select 1 from public.duty_plan_assignments other
          where other.plan_id = p_plan_id and other.day_order = v_day_order and other.teacher_source_id = s.teacher_source_id
            and other.assignment_kind in ('generated', 'manual') and other.id <> v_row.id
        )
        and exists (
          select 1 from public.teacher_duty_block_availabilities av
          where av.teacher_duty_setting_id = s.id and av.duty_location_id = v_duty_location_id
            and av.duty_block_id = v_duty_block_id and av.day_order = v_day_order
        )
        and public.is_teacher_eligible_for_duty_block_time(v_plan.timetable_import_id, t.id, v_day_order, v_duty_block_id)
        and (
          (
            select coalesce(count(distinct a.day_order) filter (where a.assignment_kind = 'fixed'), 0)
                 + count(*) filter (where a.assignment_kind in ('generated', 'manual'))
              from public.duty_plan_assignments a
              where a.plan_id = p_plan_id and a.teacher_source_id = s.teacher_source_id and a.id <> v_row.id
          ) + 1
        ) <= v_max
      ),
      'reasons', (
        select coalesce(jsonb_agg(x), '[]'::jsonb) from (
          select unnest(array_remove(array[
            case when exists (
              select 1 from public.fixed_duty_assignments fa
              where fa.academic_year_id = v_year_id and fa.day_order = v_day_order and fa.teacher_source_id = s.teacher_source_id
            ) then 'fixed_duty_day' end,
            case when exists (
              select 1 from public.duty_plan_assignments other
              where other.plan_id = p_plan_id and other.day_order = v_day_order and other.teacher_source_id = s.teacher_source_id
                and other.assignment_kind in ('generated', 'manual') and other.id <> v_row.id
            ) then 'already_assigned_that_day' end,
            case when not exists (
              select 1 from public.teacher_duty_block_availabilities av
              where av.teacher_duty_setting_id = s.id and av.duty_location_id = v_duty_location_id
                and av.duty_block_id = v_duty_block_id and av.day_order = v_day_order
            ) then 'no_preference_for_cell' end,
            case when not public.is_teacher_eligible_for_duty_block_time(v_plan.timetable_import_id, t.id, v_day_order, v_duty_block_id)
              then 'time_rule_violation' end,
            case when (
              (
                select coalesce(count(distinct a.day_order) filter (where a.assignment_kind = 'fixed'), 0)
                     + count(*) filter (where a.assignment_kind in ('generated', 'manual'))
                  from public.duty_plan_assignments a
                  where a.plan_id = p_plan_id and a.teacher_source_id = s.teacher_source_id and a.id <> v_row.id
              ) + 1
            ) > v_max then 'weekly_limit_reached' end
          ], null)) as x
        ) y
      )
      ) order by coalesce(t.name, s.teacher_name_snapshot)), '[]'::jsonb)
    into v_candidates
    from public.teacher_duty_settings s
    join public.teachers t on t.timetable_import_id = v_plan.timetable_import_id and t.source_id = s.teacher_source_id
    where s.academic_year_id = v_year_id and s.is_included;

  return jsonb_build_object(
    'found', true,
    'taskFound', true,
    'planStatus', v_plan.status,
    'planVersion', v_plan.version,
    'isFixed', v_row.assignment_kind = 'fixed',
    'currentAssignment', jsonb_build_object(
      'teacherSourceId', v_row.teacher_source_id,
      'teacherName', v_row.teacher_name_snapshot,
      'assignmentKind', v_row.assignment_kind
    ),
    'isStale', (v_current_fp is distinct from v_plan.source_fingerprint),
    'currentSourceFingerprint', v_current_fp,
    'candidates', v_candidates
  );
end;
$$;

comment on function public.get_duty_plan_task_candidates(uuid, uuid, text, text) is
  'Salt okunur: TEK bir görev hücresi (p_task_id = duty_plan_assignments.id) için aday öğretmen listesi + uygunluk gerekçeleri. BİLGİLENDİRİCİDİR — yetkili karar update_duty_plan_assignment''ta verilir (bu fonksiyona güvenmeden bağımsız yeniden doğrulanır). Yalnız service_role çağırabilir.';

-- ============================================================================
-- 4. update_duty_plan_assignment — TEK hücreyi güvenli biçimde elle değiştir
-- ============================================================================
-- p_teacher_source_id NULL ⇔ hücreyi 'unassigned' yap (atamayı kaldır).
-- Dolu ⇔ o öğretmeni 'manual' olarak ata — HER kural (kaynak fingerprint
-- güncelliği, görev aktifliği, öğretmen güncel importta var, plana dahil,
-- hücreyi tercih etmiş, zaman kuralı, sabit nöbeti yok, aynı gün başka
-- görevi yok, haftalık üst sınır) BAĞIMSIZ OLARAK yeniden doğrulanır.
-- Başka bir hücrede zaten görevli bir öğretmen seçilirse SESSİZCE
-- TAŞINMAZ — teacher_day_conflict döner, mevcut görevi (conflictingTask)
-- belirtir; swap İSTEMCİNİN AYRI, açık bir sonraki çağrısıdır (bu RPC bunu
-- OTOMATİK yapmaz).
create or replace function public.update_duty_plan_assignment(
  p_plan_id uuid,
  p_task_id uuid,
  p_campus_name text,
  p_academic_year_name text,
  p_teacher_source_id text,
  p_expected_plan_version integer
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_plan record;
  v_current_fp text;
  v_row record;
  v_day_order integer;
  v_duty_location_id uuid;
  v_duty_block_id uuid;
  v_teacher_source_id text := nullif(btrim(p_teacher_source_id), '');
  v_teacher record;
  v_conflict record;
  v_max integer;
  v_current_total integer;
  v_new_summary jsonb;
  v_new_version integer;
begin
  if p_plan_id is null or p_task_id is null then
    raise exception 'plan_id ve task_id zorunludur.' using errcode = '22023';
  end if;
  if p_expected_plan_version is null then
    raise exception 'expected_plan_version zorunludur.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then return jsonb_build_object('status', 'source_changed', 'currentSourceFingerprint', null); end if;

  select id into v_year_id from public.academic_years where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then return jsonb_build_object('status', 'source_changed', 'currentSourceFingerprint', null); end if;

  select * into v_plan from public.duty_plans
    where id = p_plan_id and campus_id = v_campus_id and academic_year_id = v_year_id
    for update;
  if not found then return jsonb_build_object('status', 'plan_not_found'); end if;
  if v_plan.status <> 'draft' then return jsonb_build_object('status', 'plan_not_draft'); end if;
  if v_plan.version <> p_expected_plan_version then
    return jsonb_build_object('status', 'version_conflict', 'currentVersion', v_plan.version);
  end if;

  v_current_fp := public.compute_duty_plan_source_fingerprint(p_campus_name, p_academic_year_name);
  if v_current_fp is distinct from v_plan.source_fingerprint then
    return jsonb_build_object('status', 'source_changed', 'currentSourceFingerprint', v_current_fp);
  end if;

  select * into v_row from public.duty_plan_assignments
    where id = p_task_id and plan_id = p_plan_id
    for update;
  if not found then return jsonb_build_object('status', 'task_not_found'); end if;
  if v_row.assignment_kind = 'fixed' then return jsonb_build_object('status', 'fixed_task_immutable'); end if;
  v_day_order := v_row.day_order;
  v_duty_location_id := v_row.duty_location_id;
  v_duty_block_id := v_row.duty_block_id;

  if v_teacher_source_id is null then
    update public.duty_plan_assignments
      set teacher_source_id = null, teacher_name_snapshot = null, assignment_kind = 'unassigned', updated_at = timezone('utc', now())
      where id = v_row.id;
  else
    select id, name into v_teacher from public.teachers
      where timetable_import_id = v_plan.timetable_import_id and source_id = v_teacher_source_id;
    if not found then return jsonb_build_object('status', 'teacher_not_in_import'); end if;

    if not exists (
      select 1 from public.teacher_duty_settings s
      where s.academic_year_id = v_year_id and s.teacher_source_id = v_teacher_source_id and s.is_included
    ) then
      return jsonb_build_object('status', 'teacher_not_included');
    end if;

    if exists (
      select 1 from public.fixed_duty_assignments fa
      where fa.academic_year_id = v_year_id and fa.day_order = v_day_order and fa.teacher_source_id = v_teacher_source_id
    ) then
      return jsonb_build_object('status', 'teacher_has_fixed_duty');
    end if;

    select other.* into v_conflict from public.duty_plan_assignments other
      where other.plan_id = p_plan_id and other.day_order = v_day_order and other.teacher_source_id = v_teacher_source_id
        and other.assignment_kind in ('generated', 'manual') and other.id <> v_row.id
      limit 1;
    if found then
      return jsonb_build_object(
        'status', 'teacher_day_conflict',
        'conflictingTask', jsonb_build_object(
          'dutyLocationId', v_conflict.duty_location_id, 'dutyLocationName', v_conflict.duty_location_name_snapshot,
          'dutyBlockId', v_conflict.duty_block_id, 'dutyBlockName', v_conflict.duty_block_name_snapshot,
          'assignmentKind', v_conflict.assignment_kind
        )
      );
    end if;

    if not exists (
      select 1 from public.teacher_duty_block_availabilities av
      join public.teacher_duty_settings s2 on s2.id = av.teacher_duty_setting_id
      where s2.academic_year_id = v_year_id and s2.teacher_source_id = v_teacher_source_id
        and av.duty_location_id = v_duty_location_id and av.duty_block_id = v_duty_block_id and av.day_order = v_day_order
    ) then
      return jsonb_build_object('status', 'no_preference_for_cell');
    end if;

    if not public.is_teacher_eligible_for_duty_block_time(v_plan.timetable_import_id, v_teacher.id, v_day_order, v_duty_block_id) then
      return jsonb_build_object('status', 'time_rule_violation');
    end if;

    select coalesce(count(distinct a.day_order) filter (where a.assignment_kind = 'fixed'), 0)
         + count(*) filter (where a.assignment_kind in ('generated', 'manual'))
      into v_current_total
      from public.duty_plan_assignments a
      where a.plan_id = p_plan_id and a.teacher_source_id = v_teacher_source_id and a.id <> v_row.id;

    v_max := coalesce((v_plan.generation_options ->> 'maxWeeklyDuties')::int, 3);
    if v_current_total + 1 > v_max then
      return jsonb_build_object('status', 'weekly_limit_exceeded');
    end if;

    update public.duty_plan_assignments
      set teacher_source_id = v_teacher_source_id, teacher_name_snapshot = v_teacher.name,
          assignment_kind = 'manual', updated_at = timezone('utc', now())
      where id = v_row.id;
  end if;

  -- Planın summary'sini TÜM plan atamalarından (yetkili) yeniden hesapla —
  -- öğretmen evreni is_included=true ∪ fixed atama öğretmenleri, save_duty_
  -- plan_draft ile BİREBİR aynı formül.
  with teacher_universe as (
    select s.teacher_source_id from public.teacher_duty_settings s where s.academic_year_id = v_year_id and s.is_included
    union
    select fa.teacher_source_id from public.fixed_duty_assignments fa where fa.academic_year_id = v_year_id
  ),
  fixed_days as (
    select a.teacher_source_id, count(distinct a.day_order) as fixed_days
      from public.duty_plan_assignments a
      where a.plan_id = p_plan_id and a.assignment_kind = 'fixed' and a.teacher_source_id is not null
      group by a.teacher_source_id
  ),
  normal_counts as (
    select a.teacher_source_id, count(*) as normal_count
      from public.duty_plan_assignments a
      where a.plan_id = p_plan_id and a.assignment_kind in ('generated', 'manual')
      group by a.teacher_source_id
  ),
  loads as (
    select coalesce(jsonb_agg(jsonb_build_object(
        'teacherSourceId', tu.teacher_source_id,
        'normalDutyCount', coalesce(nc.normal_count, 0),
        'fixedDutyDayCount', coalesce(fd.fixed_days, 0),
        'totalDutyCount', coalesce(nc.normal_count, 0) + coalesce(fd.fixed_days, 0)
      ) order by tu.teacher_source_id), '[]'::jsonb) as arr
      from teacher_universe tu
      left join normal_counts nc on nc.teacher_source_id = tu.teacher_source_id
      left join fixed_days fd on fd.teacher_source_id = tu.teacher_source_id
  )
  select coalesce(v_plan.summary, '{}'::jsonb)
      || jsonb_build_object(
           'teacherLoads', (select arr from loads),
           'uncoveredCount', (select count(*) from public.duty_plan_assignments where plan_id = p_plan_id and assignment_kind = 'unassigned'),
           'normalCoveredCount', (select count(*) from public.duty_plan_assignments where plan_id = p_plan_id and assignment_kind in ('generated', 'manual')),
           'fixedCoveredCount', (select count(*) from public.duty_plan_assignments where plan_id = p_plan_id and assignment_kind = 'fixed')
         )
    into v_new_summary;

  update public.duty_plans
    set version = version + 1, summary = v_new_summary, updated_at = timezone('utc', now())
    where id = p_plan_id
    returning version into v_new_version;

  return jsonb_build_object(
    'status', 'ok',
    'version', v_new_version,
    'assignment', jsonb_build_object(
      'taskId', p_task_id, 'dayOrder', v_day_order, 'dutyLocationId', v_duty_location_id, 'dutyBlockId', v_duty_block_id,
      'teacherSourceId', v_teacher_source_id,
      'teacherName', case when v_teacher_source_id is null then null else v_teacher.name end,
      'assignmentKind', case when v_teacher_source_id is null then 'unassigned' else 'manual' end
    ),
    'summary', v_new_summary
  );
end;
$$;

comment on function public.update_duty_plan_assignment(uuid, uuid, text, text, text, integer) is
  'TEK bir taslak görev hücresini (p_task_id = duty_plan_assignments.id) elle değiştirir (p_teacher_source_id NULL ⇔ unassigned). HER kural (kaynak fingerprint, görev aktifliği, öğretmen güncelliği/dahilliği, hücre tercihi, zaman kuralı, sabit nöbet, günlük tekillik, haftalık üst sınır) bağımsız yeniden doğrulanır. Başka hücrede görevli bir öğretmen seçilirse SESSİZCE taşınmaz — teacher_day_conflict + conflictingTask döner; swap istemcinin AYRI bir sonraki çağrısıdır. Fixed hücreler asla düzenlenemez (fixed_task_immutable). Yalnız status=draft planlarda çalışır (plan_not_draft), optimistic concurrency ile (version_conflict). Yalnız service_role çağırabilir.';

-- ============================================================================
-- 5. publish_duty_plan_draft — atomik draft → published (+ eski published → archived)
-- ============================================================================
create or replace function public.publish_duty_plan_draft(
  p_plan_id uuid,
  p_campus_name text,
  p_academic_year_name text,
  p_expected_plan_version integer
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_plan record;
  v_current_fp text;
  v_uncovered integer;
  v_bad boolean;
  v_max integer;
  v_existing_published uuid;
  v_final record;
begin
  if p_plan_id is null then raise exception 'plan_id zorunludur.' using errcode = '22023'; end if;
  if p_expected_plan_version is null then raise exception 'expected_plan_version zorunludur.' using errcode = '22023'; end if;
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then return jsonb_build_object('status', 'source_stale', 'currentSourceFingerprint', null); end if;

  select id into v_year_id from public.academic_years where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then return jsonb_build_object('status', 'source_stale', 'currentSourceFingerprint', null); end if;

  select * into v_plan from public.duty_plans
    where id = p_plan_id and campus_id = v_campus_id and academic_year_id = v_year_id
    for update;
  if not found then return jsonb_build_object('status', 'plan_not_found'); end if;
  if v_plan.status <> 'draft' then return jsonb_build_object('status', 'plan_not_draft'); end if;
  if v_plan.version <> p_expected_plan_version then
    return jsonb_build_object('status', 'version_conflict', 'currentVersion', v_plan.version);
  end if;

  v_current_fp := public.compute_duty_plan_source_fingerprint(p_campus_name, p_academic_year_name);
  if v_current_fp is distinct from v_plan.source_fingerprint then
    return jsonb_build_object('status', 'source_stale', 'currentSourceFingerprint', v_current_fp);
  end if;

  select count(*) into v_uncovered from public.duty_plan_assignments where plan_id = p_plan_id and assignment_kind = 'unassigned';
  if v_uncovered > 0 then
    return jsonb_build_object('status', 'open_tasks_remaining', 'uncoveredCount', v_uncovered);
  end if;

  -- Zorunlu kural yeniden doğrulaması (savunma amaçlı — save_duty_plan_draft
  -- ve update_duty_plan_assignment bunları ZATEN yazma anında garantiler; bu
  -- yalnız yayımlama kapısında SON bir bağımsız kontroldür).
  select exists (
    select 1 from (
      select day_order, teacher_source_id from public.duty_plan_assignments
        where plan_id = p_plan_id and assignment_kind in ('generated', 'manual')
        group by day_order, teacher_source_id having count(*) > 1
    ) x
  ) into v_bad;
  if v_bad then return jsonb_build_object('status', 'rule_violation', 'reason', 'teacher_day_conflict'); end if;

  v_max := coalesce((v_plan.generation_options ->> 'maxWeeklyDuties')::int, 3);
  select exists (
    select 1 from (
      select a.teacher_source_id,
             coalesce(count(distinct a.day_order) filter (where a.assignment_kind = 'fixed'), 0)
             + count(*) filter (where a.assignment_kind in ('generated', 'manual')) as total
        from public.duty_plan_assignments a
        where a.plan_id = p_plan_id and a.teacher_source_id is not null
        group by a.teacher_source_id
    ) x where x.total > v_max
  ) into v_bad;
  if v_bad then return jsonb_build_object('status', 'rule_violation', 'reason', 'weekly_limit_exceeded'); end if;

  -- (5) Normal görevlerin TAMAMI bağımsız NOT EXISTS/anti-join ile doğrulanır
  -- — bulgu: inner join kullanılırsa, karşılığı OLMAYAN (ör. artık teachers
  -- tablosunda bulunmayan ya da is_included=false olmuş) bir öğretmenin
  -- ataması sorgudan SESSİZCE DÜŞER ve hiç yakalanmaz. Burada TERSİ: her
  -- şart NOT EXISTS ile ayrı ayrı doğrulanır, hiçbiri eksikse satır "geçersiz"
  -- sayılır — hiçbir geçersiz atama inner join'in arkasına saklanamaz.
  select exists (
    select 1
      from public.duty_plan_assignments a
     where a.plan_id = p_plan_id and a.assignment_kind in ('generated', 'manual')
       and not (
         exists (
           select 1 from public.teachers t
            where t.timetable_import_id = v_plan.timetable_import_id and t.source_id = a.teacher_source_id
         )
         and exists (
           select 1 from public.teacher_duty_settings s
            where s.academic_year_id = v_year_id and s.teacher_source_id = a.teacher_source_id and s.is_included
         )
         and exists (
           select 1
             from public.teacher_duty_settings s2
             join public.teacher_duty_block_availabilities av on av.teacher_duty_setting_id = s2.id
            where s2.academic_year_id = v_year_id and s2.teacher_source_id = a.teacher_source_id
              and av.duty_location_id = a.duty_location_id and av.duty_block_id = a.duty_block_id and av.day_order = a.day_order
         )
         and exists (
           select 1 from public.teachers t2
            where t2.timetable_import_id = v_plan.timetable_import_id and t2.source_id = a.teacher_source_id
              and public.is_teacher_eligible_for_duty_block_time(v_plan.timetable_import_id, t2.id, a.day_order, a.duty_block_id)
         )
         and not exists (
           select 1 from public.fixed_duty_assignments fa
            where fa.academic_year_id = v_year_id and fa.day_order = a.day_order and fa.teacher_source_id = a.teacher_source_id
         )
         and exists (
           select 1 from public.duty_locations dl
            where dl.id = a.duty_location_id and dl.is_active and dl.deleted_at is null
         )
         and exists (
           select 1 from public.duty_location_blocks lb
            where lb.duty_location_id = a.duty_location_id and lb.duty_block_id = a.duty_block_id
         )
       )
  ) into v_bad;
  if v_bad then return jsonb_build_object('status', 'rule_violation', 'reason', 'candidate_invalid'); end if;

  -- (6a) Görev kümesi güncel yer×blok×gün evrenine göre eksiksiz/fazlasız mı
  -- (full outer join ile iki yönlü de kontrol edilir — normal fingerprint
  -- kontrolü zaten bunu kapsar, bu SON, bağımsız bir savunma katmanıdır).
  select exists (
    select 1
      from (
        select d.day_order, dl.id as loc, b.id as blk
          from generate_series(1, 5) as d(day_order)
          cross join public.duty_locations dl
          join public.duty_location_blocks lb on lb.duty_location_id = dl.id
          join public.duty_blocks b on b.id = lb.duty_block_id and b.is_active
         where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null
      ) expected
      -- ÖNCE p_plan_id'ye göre filtrelenmiş bir alt sorgu, SONRA full outer
      -- join — filtre doğrudan ON'a konursa (a.plan_id = p_plan_id AND ...),
      -- full outer join BAŞKA planların satırlarını da "eşleşmeyen sağ satır"
      -- olarak yüzeye çıkarır (ON'daki tek taraflı eşitlik WHERE gibi
      -- davranmaz) — bu, her zaman sahte task_set_mismatch üretirdi.
      full outer join (
        select id, day_order, duty_location_id, duty_block_id
          from public.duty_plan_assignments
         where plan_id = p_plan_id
      ) a
        on a.day_order = expected.day_order
       and a.duty_location_id = expected.loc and a.duty_block_id = expected.blk
     where expected.day_order is null or a.id is null
  ) into v_bad;
  if v_bad then return jsonb_build_object('status', 'rule_violation', 'reason', 'task_set_mismatch'); end if;

  -- (6b) Fixed satırlar güncel fixed_duty_assignments ile gün×yer×öğretmen
  -- açısından BİREBİR eşleşmeli — iki yönlü anti-join (plandaki fixed satırı
  -- gerçek karşılığı olmayan VE gerçek sabit atama plana yansımamış).
  select exists (
    select 1 from public.duty_plan_assignments a
     where a.plan_id = p_plan_id and a.assignment_kind = 'fixed'
       and not exists (
         select 1 from public.fixed_duty_assignments fa
          where fa.academic_year_id = v_year_id and fa.day_order = a.day_order
            and fa.duty_location_id = a.duty_location_id and fa.teacher_source_id = a.teacher_source_id
       )
    union all
    select 1 from public.fixed_duty_assignments fa
     where fa.academic_year_id = v_year_id
       and not exists (
         select 1 from public.duty_plan_assignments a
          where a.plan_id = p_plan_id and a.assignment_kind = 'fixed'
            and a.day_order = fa.day_order and a.duty_location_id = fa.duty_location_id and a.teacher_source_id = fa.teacher_source_id
       )
  ) into v_bad;
  if v_bad then return jsonb_build_object('status', 'rule_violation', 'reason', 'fixed_assignment_mismatch'); end if;

  select id into v_existing_published from public.duty_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id and status = 'published';
  if v_existing_published is not null then
    update public.duty_plans set status = 'archived', updated_at = timezone('utc', now()) where id = v_existing_published;
  end if;

  update public.duty_plans
    set status = 'published', version = version + 1, updated_at = timezone('utc', now())
    where id = p_plan_id
    returning * into v_final;

  return jsonb_build_object(
    'status', 'ok',
    'planId', v_final.id,
    'version', v_final.version,
    'publishedAt', v_final.updated_at,
    'archivedPreviousPlanId', v_existing_published
  );
end;
$$;

comment on function public.publish_duty_plan_draft(uuid, text, text, integer) is
  'Atomik: bir draft planı published yapar (açık görev=0, zorunlu kural ihlali=0, kaynak fingerprint + plan versiyonu güncel olmalı — aksi halde open_tasks_remaining/rule_violation/source_stale/version_conflict). Aynı transaction içinde varsa eski published planı archived''a çevirir. Kısmi bir plan HİÇBİR ŞEKİLDE yayımlanamaz. Yayımlanan plan bu andan itibaren enforce_duty_plan_lifecycle/enforce_duty_plan_assignment_write_rules trigger''larıyla DB seviyesinde değiştirilemez hale gelir. Yalnız service_role çağırabilir.';

-- ============================================================================
-- 6. get_published_duty_plan — Haftalık Nöbet Planı ekranı için salt okunur
-- ============================================================================
-- Kayıtlı duty_location_name_snapshot/duty_block_name_snapshot/teacher_name_
-- snapshot alanlarını kullanır (bkz. 20260915090000 bölüm 2) — bir sonraki
-- XML importu bu isimleri DEĞİŞTİRMEZ/BOZMAZ, çünkü live join YOKTUR.
create or replace function public.get_published_duty_plan(
  p_campus_name text,
  p_academic_year_name text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_plan record;
  v_assignments jsonb;
begin
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then return jsonb_build_object('found', false); end if;

  select id into v_year_id from public.academic_years where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then return jsonb_build_object('found', false); end if;

  select * into v_plan from public.duty_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id and status = 'published';
  if not found then return jsonb_build_object('found', false); end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'dayOrder', a.day_order,
      'dutyLocationId', a.duty_location_id, 'dutyLocationName', a.duty_location_name_snapshot,
      'dutyBlockId', a.duty_block_id, 'dutyBlockName', a.duty_block_name_snapshot,
      'teacherSourceId', a.teacher_source_id, 'teacherName', a.teacher_name_snapshot,
      'assignmentKind', a.assignment_kind
      ) order by a.day_order, a.duty_location_name_snapshot, a.duty_block_name_snapshot), '[]'::jsonb)
    into v_assignments
    from public.duty_plan_assignments a
    where a.plan_id = v_plan.id;

  return jsonb_build_object(
    'found', true,
    'id', v_plan.id,
    'status', v_plan.status,
    'algorithmVersion', v_plan.algorithm_version,
    'generationOptions', v_plan.generation_options,
    'summary', v_plan.summary,
    'version', v_plan.version,
    'createdAt', v_plan.created_at,
    'updatedAt', v_plan.updated_at,
    'assignments', v_assignments
  );
end;
$$;

comment on function public.get_published_duty_plan(text, text) is
  'Salt okunur: kampüs+eğitim yılının AKTİF (status=published) planını, atamalarını (tarihsel snapshot isimleriyle — sonraki XML importundan ETKİLENMEZ) döner. Yalnız service_role çağırabilir.';

-- ============================================================================
-- 7. save_duty_plan_draft — p_expected_plan_version ile atomik eşzamanlılık
-- ============================================================================
-- KÖK NEDEN (bu migration henüz remote'a UYGULANMADIĞI için 20260915090000
-- dosyası DEĞİŞTİRİLMEDEN, bu pending dosya içinde patch edilir — signature
-- DEĞİŞTİĞİ için önce DROP edilir, aksi halde create-or-replace AYRI bir
-- overload oluşturur ve iki fonksiyon aynı anda var olur, isimle çağıran
-- PostgREST/supabase-js RPC'si BELİRSİZLEŞİR).
--
-- Regenerate akışı: istemci taslağı bir SNAPSHOT'tan (plan.version dahil)
-- yeniden hesaplar (solver'ı Node tarafında çalıştırır — bu SÜRE alır) ve
-- SONRA save_duty_plan_draft'ı p_expected_plan_id + p_expected_plan_version
-- ile çağırır. Eski davranışta yalnız p_expected_plan_id (aynı plan mı)
-- kontrol ediliyordu — plan id'si DEĞİŞMEDEN aradaki bir manuel PUT
-- (update_duty_plan_assignment) plan.version'ı ARTIRMIŞ olsa bile regenerate
-- bunu FARK ETMİYOR ve DELETE+INSERT ile SESSİZCE EZİYORDU. Şimdi: aktif
-- draft satırı SELECT ... FOR UPDATE ile kilitlenir (update_duty_plan_
-- assignment'ın KENDİ FOR UPDATE kilidiyle AYNI satır üzerinde serileşir),
-- ardından p_expected_plan_version (verilmişse) o an kilit altındaki GERÇEK
-- version ile karşılaştırılır — uyuşmazsa version_conflict (currentVersion
-- dahil) döner, HİÇBİR satır silinmez/yazılmaz. p_expected_plan_version
-- NULL ⇔ eski davranış (yalnız id kontrolü — generate/ilk üretim akışı için).
drop function if exists public.save_duty_plan_draft(text, text, text, text, integer, jsonb, jsonb, jsonb, boolean, uuid);

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

  -- (7) EŞZAMANLILIK: kampüs+yıl için tek aktif draft — advisory lock İLE
  -- BİRLİKTE, mevcut draft satırı SELECT ... FOR UPDATE ile de kilitlenir.
  -- Bu ikinci kilit, update_duty_plan_assignment'ın AYNI satır üzerindeki
  -- KENDİ FOR UPDATE kilidiyle doğrudan SERİLEŞİR: aradaki bir manuel PUT
  -- bu SELECT'i (dolayısıyla tüm regenerate'i) commit'ine kadar BLOKLAR;
  -- PUT önce commit ederse burada okunan v_existing_plan_version ARTIK
  -- p_expected_plan_version'dan FARKLIDIR ve aşağıda version_conflict
  -- döner — manuel atama SESSİZCE EZİLMEZ.
  perform pg_advisory_xact_lock(hashtext('duty-plan-draft:' || v_year_id::text));

  select id, version into v_existing_plan_id, v_existing_plan_version
    from public.duty_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id and status = 'draft'
    for update;

  -- p_expected_plan_id semantiği (bkz. fonksiyon üstü yorum): mevcut aktif
  -- taslağın id'si (null olabilir) beklenenden (null olabilir) FARKLIYSA
  -- reddet — NULL beklenirken var olan bir taslak SESSİZCE EZİLMEZ.
  if v_existing_plan_id is distinct from p_expected_plan_id then
    return jsonb_build_object('status', 'version_conflict', 'currentPlanId', v_existing_plan_id, 'currentVersion', v_existing_plan_version);
  end if;

  -- p_expected_plan_version semantiği: NULL ⇔ çağıran versiyon takip etmiyor
  -- (eski davranış, ör. ilk generate). Dolu ⇔ çağıran BİLİNÇLİ olarak BU
  -- versiyonu bekliyor (regenerate) — kilit altında okunan GERÇEK versiyonla
  -- uyuşmuyorsa (aradaki bir manuel PUT versiyonu artırmışsa) reddedilir.
  if v_existing_plan_id is not null and p_expected_plan_version is not null
     and v_existing_plan_version is distinct from p_expected_plan_version then
    return jsonb_build_object('status', 'version_conflict', 'currentPlanId', v_existing_plan_id, 'currentVersion', v_existing_plan_version);
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

comment on function public.save_duty_plan_draft(text, text, text, text, integer, jsonb, jsonb, jsonb, boolean, uuid, integer) is
  'Volatile, atomik: sunucudan gelen üretilmiş atamaları TEK transaction''da yeniden doğrulayıp kaydeder. Görev kümesi eksiksizliği, fixed satır tutarlılığı, aday geçerliliği, günlük/haftalık kısıtlar (normal gün sayısı + AYRI sabit gün sayısı toplamı) YENİDEN hesaplanır (istemciye güvenilmez). İstemcinin özeti (p_summary) yetkili biçimde yeniden hesaplanan değerlerle karşılaştırılır, uyuşmazsa invalid_summary. p_expected_plan_id NULL ⇔ istemci aktif taslak yok sanıyor; dolu ⇔ o taslağı bilinçli yeniliyor — her iki durumda da mevcut aktif taslağın id''si beklenenden farklıysa version_conflict. p_expected_plan_version (opsiyonel) verilmişse, SELECT...FOR UPDATE ile kilitlenen satırın GERÇEK versiyonuyla ATOMİK karşılaştırılır — aradaki eşzamanlı bir update_duty_plan_assignment (manuel atama) versiyonu artırmışsa regenerate version_conflict döner ve o manuel atamayı SESSİZCE EZMEZ (sessiz ezme yok). Tek hata TÜM kaydı rollback eder. Kampüs+yıl için tek aktif draft hem advisory lock hem de satır FOR UPDATE kilidiyle garantilenir. Yalnız service_role çağırabilir.';

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

-- ============================================================================
-- Yetkilendirme
-- ============================================================================
revoke all on function public.get_duty_plan_task_candidates(uuid, uuid, text, text) from public;
revoke all on function public.update_duty_plan_assignment(uuid, uuid, text, text, text, integer) from public;
revoke all on function public.publish_duty_plan_draft(uuid, text, text, integer) from public;
revoke all on function public.get_published_duty_plan(text, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.get_duty_plan_task_candidates(uuid, uuid, text, text) from anon;
    revoke all on function public.update_duty_plan_assignment(uuid, uuid, text, text, text, integer) from anon;
    revoke all on function public.publish_duty_plan_draft(uuid, text, text, integer) from anon;
    revoke all on function public.get_published_duty_plan(text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.get_duty_plan_task_candidates(uuid, uuid, text, text) from authenticated;
    revoke all on function public.update_duty_plan_assignment(uuid, uuid, text, text, text, integer) from authenticated;
    revoke all on function public.publish_duty_plan_draft(uuid, text, text, integer) from authenticated;
    revoke all on function public.get_published_duty_plan(text, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.get_duty_plan_task_candidates(uuid, uuid, text, text) to service_role;
    grant execute on function public.update_duty_plan_assignment(uuid, uuid, text, text, text, integer) to service_role;
    grant execute on function public.publish_duty_plan_draft(uuid, text, text, integer) to service_role;
    grant execute on function public.get_published_duty_plan(text, text) to service_role;
  end if;
end
$$;
