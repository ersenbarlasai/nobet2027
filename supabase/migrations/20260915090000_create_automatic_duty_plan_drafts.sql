-- ============================================================================
-- Nöbet2027 — Otomatik Nöbet Planı Taslakları (draft altyapısı)
-- ============================================================================
-- KÖK NEDEN
-- ----------------------------------------------------------------------------
-- analyze_duty_plan_feasibility (bkz. 20260910092000, 20260913090000) yalnız
-- planlanabilirliği RAPORLAR, hiçbir atama YAZMAZ. Bu migration, salt-okunur
-- analiz katmanının ÜZERİNE, gerçek bir nöbet planı TASLAĞI üretip
-- SAKLAYABİLEN bir altyapı ekler: veri modeli (duty_plans, duty_plan_
-- assignments), kaynak veri parmak izi (compute_duty_plan_source_fingerprint),
-- üretim snapshot'ı (get_duty_plan_generation_snapshot) ve atomik, yeniden
-- doğrulayan kayıt RPC'si (save_duty_plan_draft). Planlama ALGORİTMASI bu
-- migration'da YOKTUR — saf TypeScript modülü olarak ayrıca yazılır
-- (server/lib/dutyPlanning/solver.ts); bu dosya yalnız solver'ın girdisini
-- (snapshot) üretir ve çıktısını (assignments) atomik biçimde doğrulayıp
-- saklar.
--
-- ORTAKLAŞTIRMA
-- ----------------------------------------------------------------------------
-- Görev evreni, aday evreni ve zaman uygunluğu kuralı burada TEKRAR
-- YAZILMAZ. get_duty_plan_generation_snapshot ve save_duty_plan_draft,
-- analyze_duty_plan_feasibility ile BİREBİR AYNI süzgeçleri (aktif+silinmemiş
-- yer, allows_fixed_assignment=false, güncel duty_location_blocks eşlemesi,
-- teacher_duty_settings.is_included, o gün sabit nöbeti yok,
-- is_teacher_eligible_for_duty_block_time) kullanır; snapshot ayrıca
-- analyze_duty_plan_feasibility'nin TAM SONUCUNU 'feasibility' alanında
-- gömer — ikinci, çelişebilecek bir kural kümesi YOKTUR.
--
-- BU MIGRATION NE YAPMAZ
-- ----------------------------------------------------------------------------
-- Önceki hiçbir migration dosyası değiştirilmedi. teacher_duty_block_
-- availabilities / fixed_duty_assignments / duty_location_blocks / timetable_*
-- tablolarına HİÇ INSERT/UPDATE/DELETE yapılmaz (yalnız SELECT). Yayımlama
-- (draft → published) bu aşamada YOKTUR; yalnız durum modeli (status sütunu)
-- hazırlanır.
-- ============================================================================

-- ============================================================================
-- 1. duty_plans — bir üretim/kayıt denemesinin başlığı
-- ============================================================================
create table public.duty_plans (
  id uuid primary key default gen_random_uuid(),
  campus_id uuid not null references public.campuses (id) on delete cascade,
  academic_year_id uuid not null,
  timetable_import_id uuid not null,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  -- sha256 hex — compute_duty_plan_source_fingerprint'in ürettiği biçimle aynı.
  source_fingerprint text not null check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  algorithm_version text not null check (btrim(algorithm_version) <> ''),
  generation_seed integer,
  generation_options jsonb not null default '{}'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),

  constraint duty_plans_id_campus_uq unique (id, campus_id),
  constraint duty_plans_year_campus_fk
    foreign key (academic_year_id, campus_id)
    references public.academic_years (id, campus_id) on delete cascade,
  constraint duty_plans_import_campus_year_fk
    foreign key (timetable_import_id, campus_id, academic_year_id)
    references public.timetable_imports (id, campus_id, academic_year_id) on delete cascade
);

comment on table public.duty_plans is
  'Otomatik/manüel nöbet planı denemesi başlığı. Bir kampüs+eğitim yılı için aynı anda en fazla bir status=draft satırı olabilir (bkz. duty_plans_one_active_draft_uq). Yayımlama (published) bu aşamada YAZILMAZ; durum modeli yalnız ileriye hazırlıktır.';

-- Bir kampüs+eğitim yılı için aynı anda en fazla bir AKTİF (draft) taslak.
create unique index duty_plans_one_active_draft_uq
  on public.duty_plans (campus_id, academic_year_id)
  where status = 'draft';

create index duty_plans_campus_year_status_idx
  on public.duty_plans (campus_id, academic_year_id, status);
create index duty_plans_import_idx
  on public.duty_plans (timetable_import_id);

create trigger set_updated_at
  before update on public.duty_plans
  for each row execute function public.set_updated_at();

alter table public.duty_plans enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.duty_plans from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.duty_plans from authenticated;
  end if;
end
$$;

-- ============================================================================
-- 2. duty_plan_assignments — planın her GEREKLİ görev hücresi için tek satır
-- ============================================================================
create table public.duty_plan_assignments (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.duty_plans (id) on delete cascade,
  campus_id uuid not null,
  day_order smallint not null check (day_order between 1 and 5),
  duty_location_id uuid not null,
  duty_block_id uuid not null,
  teacher_source_id text,
  teacher_name_snapshot text,
  duty_location_name_snapshot text not null check (btrim(duty_location_name_snapshot) <> ''),
  duty_block_name_snapshot text not null check (btrim(duty_block_name_snapshot) <> ''),
  assignment_kind text not null check (assignment_kind in ('fixed', 'generated', 'manual', 'unassigned')),
  fixed_duty_assignment_id uuid references public.fixed_duty_assignments (id) on delete set null,
  score_details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),

  constraint duty_plan_assignments_plan_campus_fk
    foreign key (plan_id, campus_id)
    references public.duty_plans (id, campus_id) on delete cascade,
  constraint duty_plan_assignments_location_campus_fk
    foreign key (duty_location_id, campus_id)
    references public.duty_locations (id, campus_id) on delete restrict,
  constraint duty_plan_assignments_block_fk
    foreign key (duty_block_id) references public.duty_blocks (id) on delete restrict,

  -- Her görev hücresi (gün × yer × blok) planda TEK satırla temsil edilir.
  constraint duty_plan_assignments_cell_uq
    unique (plan_id, day_order, duty_location_id, duty_block_id),

  -- unassigned ⇔ öğretmen yok; diğer üç türde öğretmen ZORUNLUDUR.
  constraint duty_plan_assignments_teacher_presence_ck
    check ((assignment_kind = 'unassigned') = (teacher_source_id is null)),
  constraint duty_plan_assignments_teacher_source_id_ck
    check (teacher_source_id is null or btrim(teacher_source_id) <> ''),
  -- YALNIZ 'fixed' satırlar bir sabit atamaya bağlanabilir. generated/manual/
  -- unassigned satırlarda bu sütun HER ZAMAN null'dur. 'fixed' satırda ise
  -- kayıt anında non-null OLMALIDIR (save_duty_plan_draft bunu ayrıca
  -- doğrular) — ama fixed_duty_assignments'taki KAYNAK satır sonradan
  -- silinirse (ON DELETE SET NULL) bu sütun null'a düşebilir: taslak satırı
  -- SİLİNMEZ, yalnız "stale" (bkz. get_duty_plan_draft.isStale) hale gelir.
  -- Bu yüzden CHECK, 'fixed' + null id kombinasyonunu YASAKLAMAZ.
  constraint duty_plan_assignments_fixed_link_ck
    check (assignment_kind = 'fixed' or fixed_duty_assignment_id is null)
);

comment on table public.duty_plan_assignments is
  'Bir duty_plans satırının her GEREKLİ görev hücresi (gün×yer×blok) için tam olarak bir satır. fixed satırlar gerçek fixed_duty_assignments''ı yansıtır ve kilitlidir (save_duty_plan_draft tarafından değiştirilemez biçimde yeniden doğrulanır). generated/manual normal atamalarda aynı planda aynı gün aynı öğretmen yalnız bir kez görünebilir (bkz. duty_plan_assignments_normal_teacher_day_uq) — fixed satırlar bu kısıtın DIŞINDADIR, çünkü aynı sabit öğretmenin aynı gün MORNING_BREAKS ve AFTERNOON_BREAKS için iki fixed satırı olması BEKLENİR (bkz. iş kuralı 6-7).';

-- generated/manual: plan+gün+öğretmen tekil (fixed satırlar HARİÇ — aynı
-- sabit öğretmenin sabah+öğleden sonra iki fixed satırı normaldir).
create unique index duty_plan_assignments_normal_teacher_day_uq
  on public.duty_plan_assignments (plan_id, day_order, teacher_source_id)
  where assignment_kind in ('generated', 'manual');

create index duty_plan_assignments_plan_day_idx
  on public.duty_plan_assignments (plan_id, day_order);
create index duty_plan_assignments_plan_teacher_idx
  on public.duty_plan_assignments (plan_id, teacher_source_id)
  where teacher_source_id is not null;

create trigger set_updated_at
  before update on public.duty_plan_assignments
  for each row execute function public.set_updated_at();

alter table public.duty_plan_assignments enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.duty_plan_assignments from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.duty_plan_assignments from authenticated;
  end if;
end
$$;

-- ============================================================================
-- 3. compute_duty_plan_source_fingerprint — TEK ortak kaynak parmak izi
-- ============================================================================
-- Etkin girdiler: güncel imported timetable_import_id; aktif duty_blocks
-- (kod+sıra+çakışma periyodu+id — bkz. aşağıda "UUID'LER NEDEN DAHİL");
-- aktif/silinmemiş duty_locations (iş anahtarı short_code İLE BİRLİKTE id
-- de dahildir); güncel duty_location_blocks eşlemeleri (yer+blok id'leriyle);
-- teacher_duty_settings.is_included; yalnız GÖRÜNÜR/GEÇERLİ VE ETKİLİ (yalnız
-- is_included=true öğretmenlerin) blok tercihleri (aktif+silinmemiş+aynı
-- kampüs yer, allows_fixed_assignment=false, GÜNCEL yer×blok eşlemesi —
-- kaldırılmış eşlemeye ait fiziksel olarak korunmuş tarihsel satırlar HARİÇ,
-- bkz. 20260913090000 "KORUNMUŞ TERCİHLER"); fixed_duty_assignments. Zaman
-- uygunluğu (5-OO/5-IO) AYRICA hash'lenmez — timetable_import_id zaten o
-- importun TÜM ders verisini (dolayısıyla zaman uygunluğunu) benzersiz
-- temsil eder (bkz. timetable_imports.source_sha256 tekilliği).
--
-- UUID'LER NEDEN DAHİL (iş anahtarına EK olarak, ONUN YERİNE DEĞİL)
-- ----------------------------------------------------------------------------
-- duty_plan_assignments.duty_location_id / duty_block_id, KALICI olarak o
-- ANDAKİ gerçek uuid'yi saklar. Bir yer soft-delete edilip AYNI short_code/
-- ad/özelliklerle YENİ bir uuid ile yeniden oluşturulursa, iş anahtarı
-- (short_code) tabanlı bir fingerprint DEĞİŞMEZ — oysa daha önce üretilmiş
-- bir taslağın atamaları artık VAR OLMAYAN eski uuid'e işaret eder ve
-- kaydedilmiş görev evreni gerçek/güncel evrenden SAPMIŞTIR. Bu yüzden id'ler
-- de canonical girdiye eklenir: içerik AYNI kalsa bile kimlik değişince
-- fingerprint DEĞİŞİR.
--
-- Canonical biçim: sabit anahtar adlarıyla TEK bir jsonb nesnesi, her dizi
-- İÇERİDE açıkça ORDER BY ile sıralanmış olarak kurulur (jsonb metin
-- gösterimi aynı değer için HER ZAMAN aynıdır — nesne anahtar sırası
-- Postgres'in dahili kurallarıyla belirlenir, çağrılar arası DEĞİŞMEZ).
-- sha256(canonical_text) hex olarak döner. Aynı veri HER ZAMAN aynı
-- fingerprint'i üretir; import/kampüs/yıl yoksa NULL döner.
create or replace function public.compute_duty_plan_source_fingerprint(
  p_campus_name text,
  p_academic_year_name text
)
returns text
language plpgsql
stable
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_import record;
  v_blocks jsonb;
  v_locations jsonb;
  v_location_blocks jsonb;
  v_settings jsonb;
  v_preferences jsonb;
  v_fixed jsonb;
  v_canonical jsonb;
begin
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then return null; end if;

  select id into v_year_id
    from public.academic_years
    where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then return null; end if;

  select * into v_import
    from public.timetable_imports
    where campus_id = v_campus_id and academic_year_id = v_year_id and status = 'imported'
    order by imported_at desc nulls last, created_at desc
    limit 1;
  if not found then return null; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'code', b.code, 'blockOrder', b.block_order, 'conflictPeriodName', b.conflict_period_name
      ) order by b.code, b.id), '[]'::jsonb)
    into v_blocks
    from public.duty_blocks b where b.is_active;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', dl.id, 'shortCode', dl.short_code, 'name', dl.name, 'category', dl.category,
      'capacity', dl.capacity, 'sortOrder', dl.sort_order, 'allowsFixedAssignment', dl.allows_fixed_assignment
      ) order by dl.short_code, dl.id), '[]'::jsonb)
    into v_locations
    from public.duty_locations dl
    where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'dutyLocationId', dl.id, 'locationShortCode', dl.short_code,
      'dutyBlockId', b.id, 'blockCode', b.code
      ) order by dl.short_code, dl.id, b.code, b.id), '[]'::jsonb)
    into v_location_blocks
    from public.duty_location_blocks lb
    join public.duty_locations dl on dl.id = lb.duty_location_id
    join public.duty_blocks b on b.id = lb.duty_block_id
    where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null and b.is_active;

  select coalesce(jsonb_agg(jsonb_build_object(
      'teacherSourceId', s.teacher_source_id, 'isIncluded', s.is_included
      ) order by s.teacher_source_id), '[]'::jsonb)
    into v_settings
    from public.teacher_duty_settings s
    where s.academic_year_id = v_year_id;

  -- YALNIZ is_included=true öğretmenlerin GÖRÜNÜR/GEÇERLİ tercihleri: bir
  -- is_included=false öğretmenin (zaten planlamaya DAHİL EDİLMEYEN, yukarıda
  -- v_settings'te ayrıca hash'lenen) tercih hücrelerindeki değişiklik
  -- fingerprint'i GEREKSİZ YERE değiştirmemeli.
  select coalesce(jsonb_agg(jsonb_build_object(
      'teacherSourceId', s.teacher_source_id,
      'dutyLocationId', av.duty_location_id, 'locationShortCode', dl.short_code,
      'dayOrder', av.day_order,
      'dutyBlockId', av.duty_block_id, 'blockCode', b.code
      ) order by s.teacher_source_id, dl.short_code, dl.id, av.day_order, b.code, b.id), '[]'::jsonb)
    into v_preferences
    from public.teacher_duty_block_availabilities av
    join public.teacher_duty_settings s on s.id = av.teacher_duty_setting_id
    join public.duty_locations dl on dl.id = av.duty_location_id
    join public.duty_blocks b on b.id = av.duty_block_id
    where s.academic_year_id = v_year_id
      and s.is_included
      and dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null and not dl.allows_fixed_assignment
      and b.is_active
      and exists (
        select 1 from public.duty_location_blocks lb
        where lb.duty_location_id = av.duty_location_id and lb.duty_block_id = av.duty_block_id
      );

  select coalesce(jsonb_agg(jsonb_build_object(
      'teacherSourceId', fa.teacher_source_id, 'dayOrder', fa.day_order,
      'dutyLocationId', dl.id, 'locationShortCode', dl.short_code
      ) order by fa.teacher_source_id, fa.day_order), '[]'::jsonb)
    into v_fixed
    from public.fixed_duty_assignments fa
    join public.duty_locations dl on dl.id = fa.duty_location_id
    where fa.academic_year_id = v_year_id;

  v_canonical := jsonb_build_object(
    'timetableImportId', v_import.id,
    'dutyBlocks', v_blocks,
    'dutyLocations', v_locations,
    'dutyLocationBlocks', v_location_blocks,
    'teacherDutySettings', v_settings,
    'teacherDutyBlockPreferences', v_preferences,
    'fixedDutyAssignments', v_fixed
  );

  return encode(extensions.digest(convert_to(v_canonical::text, 'utf8'), 'sha256'), 'hex');
end;
$$;

comment on function public.compute_duty_plan_source_fingerprint(text, text) is
  'Salt okunur TEK ortak kaynak parmak izi (sha256 hex). Yalnız etkin girdileri (güncel import, aktif blok/yer/eşleme, is_included, GÖRÜNÜR blok tercihleri, sabit atamalar) kapsar — görünmez/tarihsel korunmuş tercih satırları fingerprint''i değiştirmez. Aynı veri her zaman aynı sonucu üretir. Import/kampüs/yıl yoksa NULL. Yalnız service_role çağırabilir.';

-- ============================================================================
-- 4. get_duty_plan_generation_snapshot — üretim için TEK okunabilir görüntü
-- ============================================================================
create or replace function public.get_duty_plan_generation_snapshot(
  p_campus_name text,
  p_academic_year_name text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_import record;
  v_fingerprint text;
  v_days jsonb;
  v_blocks jsonb;
  v_tasks jsonb;
  v_teachers jsonb;
  v_candidate_edges jsonb;
  v_teacher_fixed_loads jsonb;
  v_feasibility jsonb;
  v_configuration_errors jsonb;
begin
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then return jsonb_build_object('hasImport', false); end if;

  select id into v_year_id
    from public.academic_years
    where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then return jsonb_build_object('hasImport', false); end if;

  select * into v_import
    from public.timetable_imports
    where campus_id = v_campus_id and academic_year_id = v_year_id and status = 'imported'
    order by imported_at desc nulls last, created_at desc
    limit 1;
  if not found then return jsonb_build_object('hasImport', false); end if;

  v_fingerprint := public.compute_duty_plan_source_fingerprint(p_campus_name, p_academic_year_name);

  select coalesce(jsonb_agg(jsonb_build_object('order', d.day_order, 'name', d.name) order by d.day_order), '[]'::jsonb)
    into v_days
    from public.timetable_days d
    where d.timetable_import_id = v_import.id and d.day_order between 1 and 5;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'code', b.code, 'name', b.name, 'blockOrder', b.block_order,
      'conflictPeriodName', b.conflict_period_name
      ) order by b.block_order), '[]'::jsonb)
    into v_blocks
    from public.duty_blocks b where b.is_active;

  -- Görev evreni: her aktif duty_location_blocks satırı × her gün = bir görev
  -- hücresi (iş kuralı 1). duty_locations.capacity görev SAYISINI ARTIRMAZ
  -- (iş kuralı 2) — her hücre için ihtiyaç zaten 1'dir, capacity hiç
  -- kullanılmaz. Pasif/silinmiş yerler ve kaldırılmış yer×blok eşlemeleri
  -- görev ÜRETMEZ (iş kuralı 12).
  select coalesce(jsonb_agg(jsonb_build_object(
      'dayOrder', t.day_order,
      'dutyLocationId', t.loc, 'dutyLocationName', t.loc_name, 'shortCode', t.short_code, 'category', t.category,
      'dutyBlockId', t.blk, 'blockCode', t.block_code, 'blockName', t.block_name, 'blockOrder', t.block_order,
      'kind', case when t.is_fixed then 'fixed' else 'normal' end,
      'fixedCoveredByTeacherSourceId', t.fixed_teacher_source_id,
      'fixedCoveredByTeacherName', t.fixed_teacher_name
      ) order by t.day_order, t.block_order, t.loc_name), '[]'::jsonb)
    into v_tasks
    from (
      select d.day_order, dl.id as loc, dl.name as loc_name, dl.short_code, dl.category,
             b.id as blk, b.code as block_code, b.name as block_name, b.block_order,
             dl.allows_fixed_assignment as is_fixed,
             fa.teacher_source_id as fixed_teacher_source_id,
             coalesce(ft.name, fa.teacher_name_snapshot) as fixed_teacher_name
        from generate_series(1, 5) as d(day_order)
        cross join public.duty_locations dl
        join public.duty_location_blocks lb on lb.duty_location_id = dl.id
        join public.duty_blocks b on b.id = lb.duty_block_id and b.is_active
        left join public.fixed_duty_assignments fa
          on fa.academic_year_id = v_year_id and fa.day_order = d.day_order and fa.duty_location_id = dl.id
        left join public.teachers ft
          on ft.timetable_import_id = v_import.id and ft.source_id = fa.teacher_source_id
       where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null
    ) t;

  -- Normal görevler için geçerli aday kenarları: analyze_duty_plan_
  -- feasibility'nin eşleştirme kenarlarıyla BİREBİR AYNI evren (iş kuralı 9,
  -- 10, 12) — is_teacher_eligible_for_duty_block_time TEK ortak fonksiyondan.
  select coalesce(jsonb_agg(jsonb_build_object(
      'dayOrder', e.day_order, 'dutyLocationId', e.loc, 'dutyBlockId', e.blk,
      'teacherSourceId', e.teacher_source_id, 'teacherName', e.teacher_name
      ) order by e.day_order, e.loc, e.blk, e.teacher_source_id), '[]'::jsonb)
    into v_candidate_edges
    from (
      select distinct d.day_order, dl.id as loc, b.id as blk, s.teacher_source_id, t.name as teacher_name
        from generate_series(1, 5) as d(day_order)
        cross join public.duty_locations dl
        join public.duty_location_blocks lb on lb.duty_location_id = dl.id
        join public.duty_blocks b on b.id = lb.duty_block_id and b.is_active
        join public.teacher_duty_block_availabilities av
          on av.duty_location_id = dl.id and av.duty_block_id = b.id and av.day_order = d.day_order
        join public.teacher_duty_settings s
          on s.id = av.teacher_duty_setting_id and s.academic_year_id = v_year_id and s.is_included
        join public.teachers t on t.timetable_import_id = v_import.id and t.source_id = s.teacher_source_id
       where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null and not dl.allows_fixed_assignment
         and not exists (
           select 1 from public.fixed_duty_assignments fa
           where fa.academic_year_id = v_year_id and fa.day_order = d.day_order and fa.teacher_source_id = s.teacher_source_id
         )
         and public.is_teacher_eligible_for_duty_block_time(v_import.id, t.id, d.day_order, b.id)
    ) e;

  -- Plana dahil TÜM öğretmenler (is_included=true) — candidateEdges'te hiç
  -- görünmeyen (adayı olmayan ya da yalnız sabit nöbeti bulunan) öğretmenler
  -- de dahil, ki solver/servis yük özetinde onları da 0 ile raporlayabilsin.
  select coalesce(jsonb_agg(jsonb_build_object(
      'teacherSourceId', s.teacher_source_id, 'teacherName', coalesce(t.name, s.teacher_name_snapshot)
      ) order by s.teacher_source_id), '[]'::jsonb)
    into v_teachers
    from public.teacher_duty_settings s
    left join public.teachers t on t.timetable_import_id = v_import.id and t.source_id = s.teacher_source_id
    where s.academic_year_id = v_year_id and s.is_included;

  -- Öğretmenlerin mevcut sabit nöbet GÜN sayısı (iş kuralı 7: sabah+öğleden
  -- sonra çifti birlikte BİR gün sayılır — fixed_duty_assignments'ta zaten
  -- gün başına en fazla bir satır vardır, bu yüzden count(*) = gün sayısı).
  select coalesce(jsonb_agg(jsonb_build_object(
      'teacherSourceId', x.teacher_source_id, 'fixedDutyDayCount', x.day_count
      ) order by x.teacher_source_id), '[]'::jsonb)
    into v_teacher_fixed_loads
    from (
      select fa.teacher_source_id, count(distinct fa.day_order) as day_count
        from public.fixed_duty_assignments fa
        where fa.academic_year_id = v_year_id
        group by fa.teacher_source_id
    ) x;

  -- Planlanabilirlik: İKİNCİ, çelişebilecek bir kural YAZILMAZ — mevcut
  -- analyze_duty_plan_feasibility'nin TAM SONUCU olduğu gibi gömülür.
  v_feasibility := public.analyze_duty_plan_feasibility(p_campus_name, p_academic_year_name);

  select coalesce(jsonb_agg(jsonb_build_object(
      'dayOrder', (dd ->> 'order')::int, 'blockCode', ce ->> 'blockCode', 'blockName', ce ->> 'blockName',
      'periodName', ce ->> 'periodName', 'teacherCount', (ce ->> 'teacherCount')::int
      )), '[]'::jsonb)
    into v_configuration_errors
    from jsonb_array_elements(v_feasibility -> 'days') as dd
    cross join lateral jsonb_array_elements(dd -> 'excludedByConfigurationError') as ce
    where (ce ->> 'teacherCount')::int > 0;

  return jsonb_build_object(
    'hasImport', true,
    'campusId', v_campus_id,
    'academicYearId', v_year_id,
    'timetableImportId', v_import.id,
    'importedAt', v_import.imported_at,
    'sourceFingerprint', v_fingerprint,
    'days', v_days,
    'blocks', v_blocks,
    'tasks', v_tasks,
    'teachers', v_teachers,
    'candidateEdges', v_candidate_edges,
    'teacherFixedDutyLoads', v_teacher_fixed_loads,
    'feasibility', v_feasibility,
    'configurationErrors', v_configuration_errors
  );
end;
$$;

comment on function public.get_duty_plan_generation_snapshot(text, text) is
  'Salt okunur: otomatik plan üretimi için TEK girdi görüntüsü. Görev/aday evreni analyze_duty_plan_feasibility ile BİREBİR aynı süzgeçten gelir (feasibility alanı o RPC''nin TAM SONUCUNU gömer — ikinci bir kural kümesi yoktur). Hiçbir şey yazmaz. Yalnız service_role çağırabilir.';

-- ============================================================================
-- 5. save_duty_plan_draft — atomik, YENİDEN DOĞRULAYAN taslak kaydı
-- ============================================================================
-- p_assignments: jsonb dizisi, her eleman
--   { day_order, duty_location_id, duty_block_id, teacher_source_id (null
--     olabilir), assignment_kind, score_details (opsiyonel) }.
--
-- Bu RPC İSTEMCİDEN GELEN hiçbir şeye güvenmez: görev kümesini, sabit
-- satırları, aday geçerliliğini, zaman uygunluğunu, günlük/haftalık
-- kısıtları YENİDEN hesaplar. Tek hata TÜM kaydı rollback eder (fonksiyon
-- gövdesi tek bir transaction'dır) — kısmi taslak OLUŞMAZ.
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
  'Volatile, atomik: sunucudan gelen üretilmiş atamaları TEK transaction''da yeniden doğrulayıp kaydeder. Görev kümesi eksiksizliği, fixed satır tutarlılığı, aday geçerliliği, günlük/haftalık kısıtlar (normal gün sayısı + AYRI sabit gün sayısı toplamı) YENİDEN hesaplanır (istemciye güvenilmez). İstemcinin özeti (p_summary) yetkili biçimde yeniden hesaplanan değerlerle karşılaştırılır, uyuşmazsa invalid_summary. p_expected_plan_id NULL ⇔ istemci aktif taslak yok sanıyor; dolu ⇔ o taslağı bilinçli yeniliyor — her iki durumda da mevcut aktif taslağın id''si beklenenden farklıysa version_conflict (sessiz ezme yok). Tek hata TÜM kaydı rollback eder. Kampüs+yıl için tek aktif draft advisory lock ile garantilenir. Yalnız service_role çağırabilir.';

-- ============================================================================
-- 6. get_current_duty_plan_draft / get_duty_plan_draft — salt okunur okuma
-- ============================================================================
create or replace function public.get_current_duty_plan_draft(
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
  v_plan_id uuid;
begin
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then return jsonb_build_object('found', false); end if;

  select id into v_year_id
    from public.academic_years
    where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then return jsonb_build_object('found', false); end if;

  select id into v_plan_id
    from public.duty_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id and status = 'draft';
  if not found then return jsonb_build_object('found', false); end if;

  return public.get_duty_plan_draft(v_plan_id, p_campus_name, p_academic_year_name);
end;
$$;

comment on function public.get_current_duty_plan_draft(text, text) is
  'Salt okunur: kampüs+eğitim yılının AKTİF (status=draft) planını, varsa, döner. Yalnız service_role çağırabilir.';

create or replace function public.get_duty_plan_draft(
  p_plan_id uuid,
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
  v_current_fingerprint text;
begin
  if p_plan_id is null then
    raise exception 'plan_id zorunludur.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then return jsonb_build_object('found', false); end if;

  select id into v_year_id
    from public.academic_years
    where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then return jsonb_build_object('found', false); end if;

  select * into v_plan
    from public.duty_plans
    where id = p_plan_id and campus_id = v_campus_id and academic_year_id = v_year_id;
  if not found then return jsonb_build_object('found', false); end if;

  -- Bulgu 8: "stale" (bayat) bilgisi YETKİLİ biçimde burada hesaplanır —
  -- ön yüzün ayrıca tahmin yürütmesi gerekmez. NULL currentSourceFingerprint
  -- (ör. import artık yok) da isStale=true sayılır (coalesce ile distinct).
  v_current_fingerprint := public.compute_duty_plan_source_fingerprint(p_campus_name, p_academic_year_name);

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'dayOrder', a.day_order,
      'dutyLocationId', a.duty_location_id, 'dutyLocationName', a.duty_location_name_snapshot,
      'dutyBlockId', a.duty_block_id, 'dutyBlockName', a.duty_block_name_snapshot,
      'teacherSourceId', a.teacher_source_id, 'teacherName', a.teacher_name_snapshot,
      'assignmentKind', a.assignment_kind, 'fixedDutyAssignmentId', a.fixed_duty_assignment_id,
      'scoreDetails', a.score_details
      ) order by a.day_order, a.duty_location_name_snapshot, a.duty_block_name_snapshot), '[]'::jsonb)
    into v_assignments
    from public.duty_plan_assignments a
    where a.plan_id = v_plan.id;

  return jsonb_build_object(
    'found', true,
    'id', v_plan.id,
    'status', v_plan.status,
    'timetableImportId', v_plan.timetable_import_id,
    'sourceFingerprint', v_plan.source_fingerprint,
    'savedSourceFingerprint', v_plan.source_fingerprint,
    'currentSourceFingerprint', v_current_fingerprint,
    'isStale', (v_current_fingerprint is distinct from v_plan.source_fingerprint),
    'algorithmVersion', v_plan.algorithm_version,
    'generationSeed', v_plan.generation_seed,
    'generationOptions', v_plan.generation_options,
    'summary', v_plan.summary,
    'version', v_plan.version,
    'createdAt', v_plan.created_at,
    'updatedAt', v_plan.updated_at,
    'assignments', v_assignments
  );
end;
$$;

comment on function public.get_duty_plan_draft(uuid, text, text) is
  'Salt okunur: kimliği verilen bir nöbet planını (herhangi bir status) ve atamalarını döner. Kampüs/yıl uyuşmazsa found:false. savedSourceFingerprint/currentSourceFingerprint/isStale YETKİLİ biçimde burada hesaplanır (ön yüz tahmin yürütmez). Yalnız service_role çağırabilir.';

-- ============================================================================
-- 7. delete_duty_plan_draft — yalnız status=draft silinebilir
-- ============================================================================
create or replace function public.delete_duty_plan_draft(
  p_plan_id uuid,
  p_campus_name text,
  p_academic_year_name text
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
  v_status text;
begin
  if p_plan_id is null then
    raise exception 'plan_id zorunludur.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then return jsonb_build_object('status', 'not_found'); end if;

  select id into v_year_id
    from public.academic_years
    where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then return jsonb_build_object('status', 'not_found'); end if;

  select status into v_status
    from public.duty_plans
    where id = p_plan_id and campus_id = v_campus_id and academic_year_id = v_year_id;
  if not found then return jsonb_build_object('status', 'not_found'); end if;

  if v_status <> 'draft' then
    return jsonb_build_object('status', 'not_draft');
  end if;

  delete from public.duty_plans where id = p_plan_id;

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function public.delete_duty_plan_draft(uuid, text, text) is
  'Yalnız status=draft bir planı siler (cascade ile atamaları da). published/archived planlar bu yoldan silinemez (not_draft). Yalnız service_role çağırabilir.';

-- ============================================================================
-- Yetkilendirme
-- ============================================================================
revoke all on function public.compute_duty_plan_source_fingerprint(text, text) from public;
revoke all on function public.get_duty_plan_generation_snapshot(text, text) from public;
revoke all on function public.save_duty_plan_draft(text, text, text, text, integer, jsonb, jsonb, jsonb, boolean, uuid) from public;
revoke all on function public.get_current_duty_plan_draft(text, text) from public;
revoke all on function public.get_duty_plan_draft(uuid, text, text) from public;
revoke all on function public.delete_duty_plan_draft(uuid, text, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.compute_duty_plan_source_fingerprint(text, text) from anon;
    revoke all on function public.get_duty_plan_generation_snapshot(text, text) from anon;
    revoke all on function public.save_duty_plan_draft(text, text, text, text, integer, jsonb, jsonb, jsonb, boolean, uuid) from anon;
    revoke all on function public.get_current_duty_plan_draft(text, text) from anon;
    revoke all on function public.get_duty_plan_draft(uuid, text, text) from anon;
    revoke all on function public.delete_duty_plan_draft(uuid, text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.compute_duty_plan_source_fingerprint(text, text) from authenticated;
    revoke all on function public.get_duty_plan_generation_snapshot(text, text) from authenticated;
    revoke all on function public.save_duty_plan_draft(text, text, text, text, integer, jsonb, jsonb, jsonb, boolean, uuid) from authenticated;
    revoke all on function public.get_current_duty_plan_draft(text, text) from authenticated;
    revoke all on function public.get_duty_plan_draft(uuid, text, text) from authenticated;
    revoke all on function public.delete_duty_plan_draft(uuid, text, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.compute_duty_plan_source_fingerprint(text, text) to service_role;
    grant execute on function public.get_duty_plan_generation_snapshot(text, text) to service_role;
    grant execute on function public.save_duty_plan_draft(text, text, text, text, integer, jsonb, jsonb, jsonb, boolean, uuid) to service_role;
    grant execute on function public.get_current_duty_plan_draft(text, text) to service_role;
    grant execute on function public.get_duty_plan_draft(uuid, text, text) to service_role;
    grant execute on function public.delete_duty_plan_draft(uuid, text, text) to service_role;
  end if;
end
$$;
