-- ============================================================================
-- Nöbet2027 — Hibrit Görev Paketi Modeli (duty_plan_assignment_packages)
-- ============================================================================
-- KÖK NEDEN
-- ----------------------------------------------------------------------------
-- 20260915090000/20260917090000'daki model her (gün×yer×blok) hücresini
-- BAĞIMSIZ bir görev sayar; bir öğretmen günde en fazla bir hücre alabilir
-- (bkz. duty_plan_assignments_normal_teacher_day_uq, 20260915090000 satır
-- 150-152). ~41 blok/gün olduğu için eksiksiz plan üretmek zorlaşıyor. Bu
-- migration aynı öğretmenin AYNI GÜN AYNI NÖBET YERİNDE birden çok bloğu TEK
-- "görev paketi" (FULL_DAY / SHORT_BREAKS / SINGLE_BLOCK / FIXED_SHORT_BREAKS)
-- olarak almasını sağlayan canonical bir paket tablosu ekler; haftalık yük
-- artık SATIR değil PAKET (öğretmen-gün) sayılır.
--
-- BU MIGRATION NE YAPMAZ
-- ----------------------------------------------------------------------------
-- 20260915090000/20260916090000/20260917090000 dosyalarına HİÇ dokunulmadı.
-- Nöbet yeri/blok isimleri veya UUID'leri burada hard-code EDİLMEZ — paket
-- şablonları (FULL_DAY/SHORT_BREAKS hangi yerde mümkün) duty_location_blocks
-- + duty_blocks konfigürasyonundan türetilir (bkz. classify_duty_plan_
-- package_coverage). Mevcut plan verisi (draft/published/archived, varsa)
-- idempotent bir backfill ile paketlere dönüştürülür — "duty_plans=0"
-- varsayılmaz.
-- ============================================================================

-- ============================================================================
-- 1. duty_plan_assignment_packages — bir öğretmenin bir plandaki bir GÜNLÜK
--    görev paketi (bir veya birden çok hücreyi kapsar, hepsi aynı gün/yer/
--    öğretmen)
-- ============================================================================
create table public.duty_plan_assignment_packages (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.duty_plans (id) on delete cascade,
  campus_id uuid not null,
  day_order smallint not null check (day_order between 1 and 5),
  duty_location_id uuid not null,
  teacher_source_id text not null check (btrim(teacher_source_id) <> ''),
  teacher_name_snapshot text not null check (btrim(teacher_name_snapshot) <> ''),
  coverage_mode text not null
    check (coverage_mode in ('FULL_DAY', 'SHORT_BREAKS', 'SINGLE_BLOCK', 'FIXED_SHORT_BREAKS')),
  assignment_kind text not null check (assignment_kind in ('fixed', 'generated', 'manual')),
  fixed_duty_assignment_id uuid references public.fixed_duty_assignments (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),

  constraint duty_plan_assignment_packages_plan_campus_fk
    foreign key (plan_id, campus_id)
    references public.duty_plans (id, campus_id) on delete cascade,
  constraint duty_plan_assignment_packages_location_campus_fk
    foreign key (duty_location_id, campus_id)
    references public.duty_locations (id, campus_id) on delete restrict,

  -- Merkezi kural: bir öğretmen bir planda bir günde EN FAZLA bir paket alır.
  constraint duty_plan_assignment_packages_teacher_day_uq
    unique (plan_id, day_order, teacher_source_id),
  -- duty_plan_assignments'tan composite FK hedefi (paket başka plana ait olamaz).
  constraint duty_plan_assignment_packages_id_plan_uq unique (id, plan_id),

  -- fixed ⇔ FIXED_SHORT_BREAKS (yalnız sabit paketler bu coverage_mode'u alır ve tersi).
  constraint duty_plan_assignment_packages_fixed_mode_ck
    check ((assignment_kind = 'fixed') = (coverage_mode = 'FIXED_SHORT_BREAKS')),
  -- Yalnız 'fixed' paketler bir sabit atamaya bağlanabilir (duty_plan_assignments_
  -- fixed_link_ck ile aynı desen).
  constraint duty_plan_assignment_packages_fixed_link_ck
    check (assignment_kind = 'fixed' or fixed_duty_assignment_id is null)
);

comment on table public.duty_plan_assignment_packages is
  'Bir duty_plans satırının her öğretmen-günü için EN FAZLA bir satır (bkz. duty_plan_assignment_packages_teacher_day_uq). Haftalık yük (totalDutyDayCount) HER YERDE bu tablonun teacher_source_id bazlı satır sayısıdır — ikinci bir formül yoktur. FULL_DAY/SHORT_BREAKS/SINGLE_BLOCK normal (generated/manual) paketlerdir; FIXED_SHORT_BREAKS mevcut fixed_duty_assignments''ı yansıtır ve kilitlidir.';
comment on column public.duty_plan_assignment_packages.coverage_mode is
  'FULL_DAY = yerin 4 bloğunun tamamı; SHORT_BREAKS = yalnız MORNING_BREAKS+AFTERNOON_BREAKS (normal yer); SINGLE_BLOCK = tek hücre; FIXED_SHORT_BREAKS = sabit nöbetin mevcut Sabah+Öğleden Sonra karşılığı.';

create index duty_plan_assignment_packages_plan_day_idx
  on public.duty_plan_assignment_packages (plan_id, day_order);
create index duty_plan_assignment_packages_plan_teacher_idx
  on public.duty_plan_assignment_packages (plan_id, teacher_source_id);
create index duty_plan_assignment_packages_fixed_link_idx
  on public.duty_plan_assignment_packages (fixed_duty_assignment_id)
  where fixed_duty_assignment_id is not null;

create trigger set_updated_at
  before update on public.duty_plan_assignment_packages
  for each row execute function public.set_updated_at();

-- Yayımlanmış/arşivlenmiş bir planın paketleri de değiştirilemez — duty_plan_
-- assignments_write_rules ile BİREBİR aynı desen (fixed_duty_assignment_id'nin
-- ON DELETE SET NULL ile TEK BAŞINA null'a düşmesi istisnadır).
create or replace function public.enforce_duty_plan_package_write_rules()
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
      and new.teacher_source_id is not distinct from old.teacher_source_id
      and new.teacher_name_snapshot is not distinct from old.teacher_name_snapshot
      and new.coverage_mode is not distinct from old.coverage_mode
      and new.created_at is not distinct from old.created_at
    );
  end if;

  if v_plan_status in ('published', 'archived') and not v_is_fixed_link_clear then
    raise exception 'Yayımlanmış veya arşivlenmiş bir planın görev paketleri değiştirilemez.' using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then return old; end if;

  if tg_op = 'UPDATE' and old.assignment_kind = 'fixed' and not v_is_fixed_link_clear and (
       new.assignment_kind is distinct from old.assignment_kind
    or new.teacher_source_id is distinct from old.teacher_source_id
    or new.duty_location_id is distinct from old.duty_location_id
    or new.day_order is distinct from old.day_order
    or new.coverage_mode is distinct from old.coverage_mode
  ) then
    raise exception 'Sabit görev paketleri düzenlenemez.' using errcode = '55000';
  end if;

  return new;
end;
$$;

comment on function public.enforce_duty_plan_package_write_rules() is
  'BEFORE INSERT/UPDATE/DELETE: plan published/archived ise paket satırı yazılamaz (fixed_duty_assignment_id''nin SET NULL ile tek başına temizlenmesi istisna); fixed paketlerin öğretmen/tür/gün/yer/kapsam kimliği asla değiştirilemez.';

-- KASITLI OLARAK BURADA TETİKLEYİCİ OLUŞTURULMAZ: bu migration, published/
-- archived planları İÇEREN dolu bir duty_plan_assignments üzerinde çalışmak
-- zorundadır (bkz. bölüm 4 backfill). Backfill, published/archived planlar
-- için de yeni paket satırları INSERT eder — tetikleyici burada aktif
-- olsaydı bu INSERT'ler "yayımlanmış plan değiştirilemez" hatasıyla
-- REDDEDİLİRDİ. Tetikleyici, backfill TAMAMLANDIKTAN SONRA (bölüm 4'ün
-- sonunda) oluşturulur — o andan itibaren TÜM paket satırları (yeni backfill
-- edilenler dahil) normal immutability korumasına tabi olur.

alter table public.duty_plan_assignment_packages enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.duty_plan_assignment_packages from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.duty_plan_assignment_packages from authenticated;
  end if;
end
$$;

-- ============================================================================
-- 2. classify_duty_plan_package_coverage — TEK kaynak: bir hücre grubunun
--    (block_code kümesi) hangi coverage_mode'a karşılık geldiğini yerin
--    GÜNCEL duty_location_blocks konfigürasyonundan türetir. Konfigürasyon
--    tabanlı: hiçbir yer adı/UUID'i hard-code edilmez.
-- ============================================================================
create or replace function public.classify_duty_plan_package_coverage(
  p_duty_location_id uuid,
  p_assignment_kind text,
  p_block_codes text[]
)
returns text
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with input_codes as (
    select coalesce(array_agg(distinct code order by code), array[]::text[]) as codes
      from unnest(p_block_codes) as code
  ),
  location_codes as (
    select coalesce(array_agg(b.code order by b.code), array[]::text[]) as codes
      from public.duty_location_blocks lb
      join public.duty_blocks b on b.id = lb.duty_block_id and b.is_active
      where lb.duty_location_id = p_duty_location_id
  )
  select case
    when p_assignment_kind = 'fixed' then
      case
        when (select codes from input_codes) = array['AFTERNOON_BREAKS', 'MORNING_BREAKS']
        then 'FIXED_SHORT_BREAKS'
        else null
      end
    when (select codes from input_codes) = array['AFTERNOON_BREAKS', 'LONG_BREAK_1', 'LONG_BREAK_2', 'MORNING_BREAKS']
     and (select codes from input_codes) = (select codes from location_codes)
      then 'FULL_DAY'
    when (select codes from input_codes) = array['AFTERNOON_BREAKS', 'MORNING_BREAKS']
      then 'SHORT_BREAKS'
    when coalesce(array_length((select codes from input_codes), 1), 0) = 1
      then 'SINGLE_BLOCK'
    else null
  end;
$$;

comment on function public.classify_duty_plan_package_coverage(uuid, text, text[]) is
  'TEK kaynak: bir (gün, yer, öğretmen) grubunun kapsadığı duty_blocks.code kümesinden geçerli coverage_mode''u türetir (FULL_DAY/SHORT_BREAKS/SINGLE_BLOCK/FIXED_SHORT_BREAKS) — geçersiz kombinasyonda NULL. Yer adı/UUID''i hard-code edilmez; yerin GÜNCEL duty_location_blocks eşlemesinden türetilir. save_duty_plan_draft, set_duty_plan_manual_package ve publish_duty_plan_draft AYNI bu fonksiyonu kullanır.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.classify_duty_plan_package_coverage(uuid, text, text[]) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.classify_duty_plan_package_coverage(uuid, text, text[]) from authenticated;
  end if;
end
$$;
grant execute on function public.classify_duty_plan_package_coverage(uuid, text, text[]) to service_role;

-- ============================================================================
-- 3. duty_plan_assignments.package_id — her hücre HANGİ pakete ait
-- ============================================================================
alter table public.duty_plan_assignments
  add column package_id uuid references public.duty_plan_assignment_packages (id) on delete set null;

alter table public.duty_plan_assignments
  add constraint duty_plan_assignments_package_plan_fk
    foreign key (package_id, plan_id)
    references public.duty_plan_assignment_packages (id, plan_id);

-- NOT VALID: bu migration DOLU bir duty_plan_assignments üzerinde çalışır —
-- mevcut atanmış (unassigned OLMAYAN) satırların HEPSİ şu an package_id=null
-- (sütun YENİ eklendi), yani kısıt anında doğrulanırsa İLK ALTER TABLE'DA
-- BAŞARISIZ OLURDU (backfill henüz çalışmadı). NOT VALID yalnız BUNDAN
-- SONRAKİ yazmaları anında doğrular; mevcut satırlar backfill'den SONRA
-- `validate constraint` ile (bölüm 4 sonu) doğrulanır.
alter table public.duty_plan_assignments
  add constraint duty_plan_assignments_package_presence_ck
    check ((assignment_kind = 'unassigned') = (package_id is null))
    not valid;

comment on column public.duty_plan_assignments.package_id is
  'unassigned ⇔ null; fixed/generated/manual ⇔ zorunlu, ilgili duty_plan_assignment_packages satırına işaret eder. Bir paketin TÜM hücreleri aynı (day_order, duty_location_id, teacher_source_id, assignment_kind) değerlerini paylaşır (bkz. enforce_duty_plan_assignment_package_consistency).';

-- Paket-hücre tutarlılığı: NEW.package_id doluysa, işaret ettiği paketin
-- day_order/duty_location_id/teacher_source_id/assignment_kind alanları NEW
-- ile birebir eşleşmeli. CHECK ile ifade edilemeyen (başka tabloya bağlı) bir
-- kural olduğu için trigger kullanılır.
create or replace function public.enforce_duty_plan_assignment_package_consistency()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_pkg record;
begin
  if new.package_id is null then return new; end if;

  select * into v_pkg from public.duty_plan_assignment_packages where id = new.package_id;
  if not found then
    raise exception 'package_id % bulunamadı.', new.package_id using errcode = '23503';
  end if;

  if v_pkg.day_order is distinct from new.day_order
    or v_pkg.duty_location_id is distinct from new.duty_location_id
    or v_pkg.teacher_source_id is distinct from new.teacher_source_id
    or v_pkg.assignment_kind is distinct from new.assignment_kind
  then
    raise exception 'Görev hücresi (gün/yer/öğretmen/tür) paketiyle uyuşmuyor.' using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.enforce_duty_plan_assignment_package_consistency() is
  'BEFORE INSERT/UPDATE: bir hücrenin package_id''si doluysa, işaret ettiği paketin gün/yer/öğretmen/tür alanları hücreninkiyle BİREBİR eşleşmeli — paket ve hücreleri asla farklı öğretmen/gün/yere sürüklenemez.';

create trigger enforce_duty_plan_assignment_package_consistency
  before insert or update on public.duty_plan_assignments
  for each row execute function public.enforce_duty_plan_assignment_package_consistency();

-- Eski partial unique index PAKET MODELİYLE ÇELİŞİYOR: aynı gün aynı
-- öğretmenin birden çok generated/manual hücresi (FULL_DAY/SHORT_BREAKS
-- paketi) artık MEŞRU. Tekillik artık duty_plan_assignment_packages_teacher_
-- day_uq ile korunuyor (bkz. bölüm 1).
drop index if exists public.duty_plan_assignments_normal_teacher_day_uq;

create index duty_plan_assignments_package_idx
  on public.duty_plan_assignments (package_id)
  where package_id is not null;

-- ============================================================================
-- 4. İDEMPOTENT BACKFILL — mevcut duty_plan_assignments satırlarını paketlere
--    dönüştürür ("duty_plans=0" varsayılmaz; her plan durumu için çalışır).
-- ============================================================================
do $$
declare
  v_backfilled integer := 0;
begin
  -- Published/archived planların immutability trigger'ı bu tek seferlik
  -- backfill'e takılmasın diye geçici olarak devre dışı bırakılır.
  alter table public.duty_plan_assignments disable trigger enforce_duty_plan_assignment_write_rules;
  alter table public.duty_plan_assignments disable trigger enforce_duty_plan_assignment_package_consistency;

  with grouped as (
    select
      a.plan_id, a.campus_id, a.day_order, a.duty_location_id,
      a.teacher_source_id, min(a.teacher_name_snapshot) as teacher_name_snapshot,
      a.assignment_kind,
      case when a.assignment_kind = 'fixed' then min(a.fixed_duty_assignment_id::text)::uuid else null end as fixed_duty_assignment_id,
      array_agg(distinct b.code) as block_codes
    from public.duty_plan_assignments a
    join public.duty_blocks b on b.id = a.duty_block_id
    where a.teacher_source_id is not null and a.package_id is null
    group by a.plan_id, a.campus_id, a.day_order, a.duty_location_id, a.teacher_source_id, a.assignment_kind
  ),
  inserted as (
    insert into public.duty_plan_assignment_packages (
      plan_id, campus_id, day_order, duty_location_id, teacher_source_id, teacher_name_snapshot,
      coverage_mode, assignment_kind, fixed_duty_assignment_id
    )
    select
      g.plan_id, g.campus_id, g.day_order, g.duty_location_id, g.teacher_source_id, g.teacher_name_snapshot,
      -- Eski model her zaman TEKİL hücre üretiyordu (fixed hariç, o da hep
      -- Sabah+Öğleden Sonra çifti idi) — bu yüzden backfill'de FULL_DAY/
      -- SHORT_BREAKS asla oluşmaz, yalnız SINGLE_BLOCK/FIXED_SHORT_BREAKS.
      coalesce(
        public.classify_duty_plan_package_coverage(g.duty_location_id, g.assignment_kind, g.block_codes),
        case when g.assignment_kind = 'fixed' then 'FIXED_SHORT_BREAKS' else 'SINGLE_BLOCK' end
      ),
      g.assignment_kind, g.fixed_duty_assignment_id
    from grouped g
    returning id, plan_id, day_order, duty_location_id, teacher_source_id, assignment_kind
  )
  update public.duty_plan_assignments a
    set package_id = ins.id
    from inserted ins
    where a.plan_id = ins.plan_id and a.day_order = ins.day_order
      and a.duty_location_id = ins.duty_location_id and a.teacher_source_id = ins.teacher_source_id
      and a.assignment_kind = ins.assignment_kind and a.package_id is null;

  get diagnostics v_backfilled = row_count;
  raise notice 'duty_plan_assignment_packages backfill: % hücre paketlere bağlandı.', v_backfilled;

  alter table public.duty_plan_assignments enable trigger enforce_duty_plan_assignment_write_rules;
  alter table public.duty_plan_assignments enable trigger enforce_duty_plan_assignment_package_consistency;
end
$$;

-- Backfill HER atanmış hücreyi bir pakete bağladı (grouped CTE'nin WHERE'i
-- teacher_source_id IS NOT NULL olan — yani unassigned OLMAYAN — HER satırı
-- kapsar, bkz. duty_plan_assignments_teacher_presence_ck: assignment_kind
-- 'unassigned' ⇔ teacher_source_id null). Artık NOT VALID kısıtı GÜVENLE
-- doğrulanabilir (yalnız mevcut satırları TARAR, yeni bir ALTER/lock riski
-- taşımaz — Postgres VALIDATE CONSTRAINT bir SHARE UPDATE EXCLUSIVE kilidi
-- kullanır, tabloyu okuma/yazmaya kilitlemez).
alter table public.duty_plan_assignments
  validate constraint duty_plan_assignments_package_presence_ck;

-- Paket immutability tetikleyicisi ANCAK ŞİMDİ (backfill TAMAMLANDIKTAN
-- SONRA) oluşturulur — bkz. bölüm 1'deki gerekçe notu. Bu andan itibaren
-- backfill edilenler DAHİL TÜM paket satırları normal published/archived
-- immutability korumasına tabidir.
create trigger enforce_duty_plan_package_write_rules
  before insert or update or delete on public.duty_plan_assignment_packages
  for each row execute function public.enforce_duty_plan_package_write_rules();

-- ============================================================================
-- 5. get_duty_plan_generation_snapshot — additive: `locations[]` eklenir
--    (solver'ın paket şablonunu config'ten türetmesi için). tasks/candidateEdges/
--    teachers/feasibility şekli DEĞİŞMEZ — geriye uyumlu.
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
  v_locations jsonb;
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

  -- YENİ: her aktif/silinmemiş yerin GÜNCEL aktif blok kodu kümesi — solver'ın
  -- FULL_DAY/SHORT_BREAKS paket şablonunu hard-code ETMEDEN buradan türetmesi
  -- için (iş kuralı: konfigürasyon tabanlı, yer adı/UUID'i solver'da yok).
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'shortCode', x.short_code, 'category', x.category,
      'allowsFixedAssignment', x.allows_fixed_assignment, 'activeBlockCodes', x.codes
      ) order by x.short_code), '[]'::jsonb)
    into v_locations
    from (
      select dl.id, dl.short_code, dl.category, dl.allows_fixed_assignment,
             coalesce(array_agg(b.code order by b.code) filter (where b.id is not null), array[]::text[]) as codes
        from public.duty_locations dl
        left join public.duty_location_blocks lb on lb.duty_location_id = dl.id
        left join public.duty_blocks b on b.id = lb.duty_block_id and b.is_active
       where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null
       group by dl.id, dl.short_code, dl.category, dl.allows_fixed_assignment
    ) x;

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

  select coalesce(jsonb_agg(jsonb_build_object(
      'teacherSourceId', s.teacher_source_id, 'teacherName', coalesce(t.name, s.teacher_name_snapshot)
      ) order by s.teacher_source_id), '[]'::jsonb)
    into v_teachers
    from public.teacher_duty_settings s
    left join public.teachers t on t.timetable_import_id = v_import.id and t.source_id = s.teacher_source_id
    where s.academic_year_id = v_year_id and s.is_included;

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
    'locations', v_locations,
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
  'Salt okunur: otomatik plan üretimi için TEK girdi görüntüsü. `locations[]` (id/shortCode/category/allowsFixedAssignment/activeBlockCodes) paket-farkında solver''ın FULL_DAY/SHORT_BREAKS şablonlarını hard-code ETMEDEN config''ten türetmesi içindir. Diğer alanlar 20260915090000 ile aynı süzgeçten gelir. Yalnız service_role çağırabilir.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.get_duty_plan_generation_snapshot(text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.get_duty_plan_generation_snapshot(text, text) from authenticated;
  end if;
end
$$;
grant execute on function public.get_duty_plan_generation_snapshot(text, text) to service_role;

-- ============================================================================
-- 6. save_duty_plan_draft — PAKET-FARKINDA yeniden doğrulama + yazma. İmza
--    AYNI (yeni parametre yok) — sunucu paketleri submitted p_assignments'tan
--    (day_order, duty_location_id, teacher_source_id) gruplayarak türetir.
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
  -- PAKET GRUPLARI: aynı gün+öğretmen+yer bir arada — coverage_mode geçerli
  -- bir şablona (FULL_DAY/SHORT_BREAKS/FIXED_SHORT_BREAKS/SINGLE_BLOCK) uymalı
  -- VE grup içinde TEK bir assignment_kind olmalı.
  package_groups as (
    select s.day_order, s.loc, s.teacher_source_id, s.assignment_kind,
           array_agg(distinct b.code) as block_codes
      from submitted s
      join public.duty_blocks b on b.id = s.blk
     where s.teacher_source_id is not null and s.assignment_kind in ('fixed', 'generated', 'manual')
     group by s.day_order, s.loc, s.teacher_source_id, s.assignment_kind
  ),
  package_kind_variety as (
    select day_order, loc, teacher_source_id, count(distinct assignment_kind) as kind_variety
      from package_groups
      group by day_order, loc, teacher_source_id
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

  -- (5) Aynı gün aynı öğretmen FARKLI yerde iki paket alamaz (teacher_day_conflict).
  -- (CTE'ler yalnız tek bir statement içinde yaşar — package_groups burada
  -- p_assignments'tan YENİDEN türetilir, yukarıdaki analiz statement'ıyla
  -- AYNI mantık.)
  select exists (
    select 1 from (
      select distinct x.day_order, nullif(btrim(x.teacher_source_id), '') as teacher_source_id, x.duty_location_id as loc
        from jsonb_to_recordset(p_assignments)
          as x(day_order int, duty_location_id uuid, duty_block_id uuid, teacher_source_id text, assignment_kind text)
       where x.assignment_kind in ('fixed', 'generated', 'manual') and nullif(btrim(x.teacher_source_id), '') is not null
    ) x
    group by x.day_order, x.teacher_source_id
    having count(distinct x.loc) > 1
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'teacher_day_conflict');
  end if;

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
    return jsonb_build_object('status', 'teacher_day_conflict');
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

  -- Önce PAKETLER yazılır (submitted'tan aynı gruplama ile), sonra hücreler
  -- bu paketlere package_id ile bağlanır.
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
  'Volatile, atomik: PAKET-FARKINDA yeniden doğrulama. Sunucu, gönderilen p_assignments''ı (day_order, duty_location_id, teacher_source_id, assignment_kind) gruplayarak paketleri kendisi türetir (istemciden ayrı bir paket girdisi ALINMAZ). Her grubun block_code kümesi classify_duty_plan_package_coverage''a uymalı (aksi halde invalid_package_combination). Haftalık yük artık PAKET-GÜN sayısıdır (satır değil). Aynı gün aynı öğretmen farklı yerde iki paket alamaz (teacher_day_conflict). Diğer tüm kurallar (fixed tutarlılığı, aday geçerliliği, task_set_mismatch, invalid_summary, version_conflict, p_expected_plan_version atomik FOR UPDATE karşılaştırması) 20260917090000 ile BİREBİR aynıdır. Yalnız service_role çağırabilir.';

revoke all on function public.save_duty_plan_draft(text, text, text, text, integer, jsonb, jsonb, jsonb, boolean, uuid, integer) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.save_duty_plan_draft(text, text, text, text, integer, jsonb, jsonb, jsonb, boolean, uuid, integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.save_duty_plan_draft(text, text, text, text, integer, jsonb, jsonb, jsonb, boolean, uuid, integer) from authenticated;
  end if;
end
$$;
grant execute on function public.save_duty_plan_draft(text, text, text, text, integer, jsonb, jsonb, jsonb, boolean, uuid, integer) to service_role;

-- ============================================================================
-- 7. update_duty_plan_assignment — PAKET-FARKINDA tekil hücre düzenleme.
--    Hücre >1 hücreli bir paketin parçasıysa artık DOĞRUDAN YAZMAZ
--    (requires_package_action) — sessiz bölme yok, set_duty_plan_manual_
--    package'a yönlendirir. 1 hücreli (SINGLE_BLOCK) paketlerde eskisi gibi.
-- ============================================================================
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
  -- v_teacher (record) hiç atanmadan (ör. temizleme yolunda) alanına
  -- erişmek PL/pgSQL'de dal ALINMASA BİLE "record is not assigned yet"
  -- hatası verir; bu yüzden son dönüşte v_teacher.name YERİNE bu düz text
  -- değişken kullanılır (yalnız atama dalında doldurulur).
  v_teacher_name text;
  v_pkg_cell_count integer;
  v_conflict_pkg record;
  v_max integer;
  v_current_total integer;
  v_new_pkg_id uuid;
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

  -- Hücre çok-hücreli bir pakete (FULL_DAY/SHORT_BREAKS) aitse bu RPC ARTIK
  -- DOĞRUDAN YAZMAZ — sessiz bölme yok. Paket 1 hücreliyse (SINGLE_BLOCK)
  -- veya hiç paketi yoksa (unassigned) eskisi gibi çalışır.
  if v_row.package_id is not null then
    select count(*) into v_pkg_cell_count from public.duty_plan_assignments where package_id = v_row.package_id;
    if v_pkg_cell_count > 1 then
      return jsonb_build_object(
        'status', 'requires_package_action',
        'package', (
          select jsonb_build_object(
            'id', p.id, 'coverageMode', p.coverage_mode, 'teacherSourceId', p.teacher_source_id,
            'teacherName', p.teacher_name_snapshot, 'dutyLocationId', p.duty_location_id,
            'coveredTaskIds', (select coalesce(jsonb_agg(a2.id), '[]'::jsonb) from public.duty_plan_assignments a2 where a2.package_id = p.id)
          )
          from public.duty_plan_assignment_packages p where p.id = v_row.package_id
        )
      );
    end if;
  end if;

  if v_teacher_source_id is null then
    if v_row.package_id is not null then
      update public.duty_plan_assignments
        set teacher_source_id = null, teacher_name_snapshot = null, assignment_kind = 'unassigned',
            package_id = null, updated_at = timezone('utc', now())
        where id = v_row.id;
      delete from public.duty_plan_assignment_packages where id = v_row.package_id;
    end if;
  else
    select id, name into v_teacher from public.teachers
      where timetable_import_id = v_plan.timetable_import_id and source_id = v_teacher_source_id;
    if not found then return jsonb_build_object('status', 'teacher_not_in_import'); end if;
    v_teacher_name := v_teacher.name;

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

    -- Hedef öğretmenin o gün BAŞKA (bu hücrenin kendi paketi DIŞINDA) bir
    -- paketi varsa sessizce taşınmaz — conflictingPackage ile bildirilir.
    select p.* into v_conflict_pkg from public.duty_plan_assignment_packages p
      where p.plan_id = p_plan_id and p.day_order = v_day_order and p.teacher_source_id = v_teacher_source_id
        and p.id is distinct from v_row.package_id
      limit 1;
    if found then
      return jsonb_build_object(
        'status', 'teacher_day_conflict',
        'conflictingPackage', jsonb_build_object(
          'id', v_conflict_pkg.id, 'coverageMode', v_conflict_pkg.coverage_mode,
          'dutyLocationId', v_conflict_pkg.duty_location_id, 'assignmentKind', v_conflict_pkg.assignment_kind
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

    -- Haftalık toplam artık PAKET sayısı — bu hücrenin KENDİ eski paketi
    -- (varsa) hariç tutularak sayılır, çünkü o zaten değiştirilecek/silinecek.
    select count(*) into v_current_total
      from public.duty_plan_assignment_packages
      where plan_id = p_plan_id and teacher_source_id = v_teacher_source_id
        and id is distinct from v_row.package_id;

    v_max := coalesce((v_plan.generation_options ->> 'maxWeeklyDuties')::int, 3);
    if v_current_total + 1 > v_max then
      return jsonb_build_object('status', 'weekly_limit_exceeded');
    end if;

    -- TÜM doğrulamalar geçti — ancak ŞİMDİ (erken dönüşle yarım kalmış bir
    -- yazma asla olmasın diye) hücreyi eski paketinden AYIR. Bu, hedef
    -- öğretmenin BİZZAT bu hücrenin kendi eski (SINGLE_BLOCK) paketini
    -- tutuyor olması (kendine yeniden atama) dahil HER durumda, yeni paketin
    -- (plan_id, day_order, teacher_source_id) anahtarının eskisiyle
    -- çakışmamasını garanti eder — insert ÖNCE detach yapılmazsa aynı
    -- anahtarla iki satır aynı anda var olmaya çalışır (unique ihlali).
    if v_row.package_id is not null then
      update public.duty_plan_assignments
        set teacher_source_id = null, teacher_name_snapshot = null, assignment_kind = 'unassigned',
            package_id = null, updated_at = timezone('utc', now())
        where id = v_row.id;
      delete from public.duty_plan_assignment_packages where id = v_row.package_id;
    end if;

    insert into public.duty_plan_assignment_packages (
      plan_id, campus_id, day_order, duty_location_id, teacher_source_id, teacher_name_snapshot,
      coverage_mode, assignment_kind
    ) values (
      p_plan_id, v_plan.campus_id, v_day_order, v_duty_location_id, v_teacher_source_id, v_teacher.name,
      'SINGLE_BLOCK', 'manual'
    ) returning id into v_new_pkg_id;

    update public.duty_plan_assignments
      set teacher_source_id = v_teacher_source_id, teacher_name_snapshot = v_teacher.name,
          assignment_kind = 'manual', package_id = v_new_pkg_id, updated_at = timezone('utc', now())
      where id = v_row.id;
  end if;

  -- Planın summary'sini TÜM plan paketlerinden (yetkili) yeniden hesapla —
  -- KANONİK formül: totalDutyCount = teacher_source_id başına PAKET sayısı.
  with teacher_universe as (
    select s.teacher_source_id from public.teacher_duty_settings s where s.academic_year_id = v_year_id and s.is_included
    union
    select fa.teacher_source_id from public.fixed_duty_assignments fa where fa.academic_year_id = v_year_id
  ),
  fixed_days as (
    select p.teacher_source_id, count(*) as fixed_days
      from public.duty_plan_assignment_packages p
      where p.plan_id = p_plan_id and p.assignment_kind = 'fixed'
      group by p.teacher_source_id
  ),
  normal_counts as (
    select p.teacher_source_id, count(*) as normal_count
      from public.duty_plan_assignment_packages p
      where p.plan_id = p_plan_id and p.assignment_kind in ('generated', 'manual')
      group by p.teacher_source_id
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
      'teacherName', v_teacher_name,
      'assignmentKind', case when v_teacher_source_id is null then 'unassigned' else 'manual' end
    ),
    'summary', v_new_summary
  );
end;
$$;

comment on function public.update_duty_plan_assignment(uuid, uuid, text, text, text, integer) is
  'TEK bir taslak görev hücresini elle değiştirir — YALNIZ hücre SINGLE_BLOCK bir pakete aitse (veya hiç paketi yoksa). Hücre >1 hücreli bir FULL_DAY/SHORT_BREAKS paketinin parçasıysa requires_package_action döner (sessiz bölme yok) — çok hücreli işlemler set_duty_plan_manual_package''a yönlendirilir. Haftalık toplam artık PAKET sayısıdır (satır değil). teacher_day_conflict artık conflictingPackage döner. Yalnız service_role çağırabilir.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.update_duty_plan_assignment(uuid, uuid, text, text, text, integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.update_duty_plan_assignment(uuid, uuid, text, text, text, integer) from authenticated;
  end if;
end
$$;
grant execute on function public.update_duty_plan_assignment(uuid, uuid, text, text, text, integer) to service_role;

-- ============================================================================
-- 8. resolve_duty_plan_package_target_blocks — TEK kaynak: bir (yer,
--    coverage_mode) için hedeflenen duty_block_id kümesini yerin GÜNCEL
--    duty_location_blocks konfigürasyonundan türetir. Geçersizse NULL.
-- ============================================================================
create or replace function public.resolve_duty_plan_package_target_blocks(
  p_duty_location_id uuid,
  p_coverage_mode text,
  p_duty_block_id uuid default null
)
returns uuid[]
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with loc_blocks as (
    select b.id, b.code from public.duty_location_blocks lb
      join public.duty_blocks b on b.id = lb.duty_block_id and b.is_active
      where lb.duty_location_id = p_duty_location_id
  )
  select case p_coverage_mode
    when 'FULL_DAY' then
      case when (select coalesce(array_agg(code order by code), array[]::text[]) from loc_blocks)
             = array['AFTERNOON_BREAKS', 'LONG_BREAK_1', 'LONG_BREAK_2', 'MORNING_BREAKS']
        then (select array_agg(id) from loc_blocks)
        else null
      end
    when 'SHORT_BREAKS' then
      case when (select array['AFTERNOON_BREAKS', 'MORNING_BREAKS'] <@ coalesce(array_agg(code), array[]::text[]) from loc_blocks)
        then (select array_agg(id) from loc_blocks where code in ('MORNING_BREAKS', 'AFTERNOON_BREAKS'))
        else null
      end
    when 'SINGLE_BLOCK' then
      case when p_duty_block_id is not null and exists (select 1 from loc_blocks where id = p_duty_block_id)
        then array[p_duty_block_id]
        else null
      end
    else null
  end;
$$;

comment on function public.resolve_duty_plan_package_target_blocks(uuid, text, uuid) is
  'TEK kaynak: bir (yer, coverage_mode) isteği için hedeflenen duty_block_id dizisini yerin GÜNCEL duty_location_blocks eşlemesinden türetir; yer o coverage_mode''u desteklemiyorsa NULL. FULL_DAY/SHORT_BREAKS istemin manuel yollarda yalnız fixed OLMAYAN yerlerde anlamlıdır (çağıran taraf ayrıca doğrular). preview/set_duty_plan_manual_package AYNI bu fonksiyonu kullanır.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.resolve_duty_plan_package_target_blocks(uuid, text, uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.resolve_duty_plan_package_target_blocks(uuid, text, uuid) from authenticated;
  end if;
end
$$;
grant execute on function public.resolve_duty_plan_package_target_blocks(uuid, text, uuid) to service_role;

-- ============================================================================
-- 9. compute_duty_plan_manual_package_change — TEK KARAR MANTIĞI: hedef hücre
--    kümesi, dokunulan (bölünecek) YABANCI paketler ve bunların hedef kümenin
--    DIŞINDA kalan (açık onay gerektiren) hücreleri. preview VE set AYNI bu
--    fonksiyonu çağırır — iki AYRI hesaplama YOKTUR.
-- ============================================================================
-- BULGU: önceki sürüm dokunulan paketleri `duty_block_id = any(target_blocks)`
-- ile buluyordu — duty_blocks KÜÇÜK bir referans tablosudur (MORNING_BREAKS
-- vb. kod başına TEK satır, TÜM yerlerde PAYLAŞILIR), bu yüzden bu filtre
-- gün/yer AYIRT ETMEDEN aynı blok TÜRÜNÜ kullanan HER paketi (başka gün,
-- başka yer, başka öğretmen) "dokunulan" sayıyordu. Doğrusu: yalnız GERÇEKTEN
-- hedef hücrelerin (a.id = any(...), aynı gün+yer+blok'ta olan somut satırlar)
-- sahibi olan paketler dokunulandır.
create or replace function public.compute_duty_plan_manual_package_change(
  p_plan_id uuid,
  p_day_order integer,
  p_duty_location_id uuid,
  p_target_blocks uuid[]
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with target as (
    select a.id, a.duty_block_id, a.duty_block_name_snapshot, a.assignment_kind,
           a.teacher_source_id, a.teacher_name_snapshot, a.package_id
      from public.duty_plan_assignments a
     where a.plan_id = p_plan_id and a.day_order = p_day_order and a.duty_location_id = p_duty_location_id
       and a.duty_block_id = any(p_target_blocks)
  ),
  touched_packages as (
    select distinct package_id from target where package_id is not null
  ),
  affected as (
    select a2.id, a2.duty_block_id, a2.duty_block_name_snapshot, a2.teacher_source_id, a2.teacher_name_snapshot, a2.package_id
      from public.duty_plan_assignments a2
     where a2.package_id in (select package_id from touched_packages)
       and a2.id not in (select id from target)
  )
  select jsonb_build_object(
    'targetTaskIds', (select coalesce(jsonb_agg(id order by duty_block_id), '[]'::jsonb) from target),
    'targetTaskCount', (select count(*) from target),
    'targetTasks', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', id, 'dutyBlockId', duty_block_id, 'dutyBlockName', duty_block_name_snapshot,
        'currentTeacherSourceId', teacher_source_id, 'currentTeacherName', teacher_name_snapshot,
        'currentAssignmentKind', assignment_kind, 'currentPackageId', package_id
      ) order by duty_block_id), '[]'::jsonb) from target),
    'anyTargetFixed', coalesce((select bool_or(assignment_kind = 'fixed') from target), false),
    'touchedPackageIds', (select coalesce(jsonb_agg(package_id), '[]'::jsonb) from touched_packages),
    'anyTouchedPackageFixed', exists (
      select 1 from public.duty_plan_assignment_packages p
       where p.id in (select package_id from touched_packages) and p.assignment_kind = 'fixed'
    ),
    'affectedTaskIds', (select coalesce(jsonb_agg(id order by duty_block_id), '[]'::jsonb) from affected),
    'affectedTasks', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', id, 'dutyBlockId', duty_block_id, 'dutyBlockName', duty_block_name_snapshot,
        'currentTeacherSourceId', teacher_source_id, 'currentTeacherName', teacher_name_snapshot,
        'packageId', package_id
      ) order by duty_block_id), '[]'::jsonb) from affected)
  );
$$;

comment on function public.compute_duty_plan_manual_package_change(uuid, integer, uuid, uuid[]) is
  'TEK KARAR MANTIĞI: bir manuel paket işleminin hedef hücrelerini (day_order+duty_location_id+duty_block_id = any(target_blocks) ile TAM eşleşen somut satırlar — id bazlı, blok TÜRÜ bazlı DEĞİL) ve o hedef hücrelerin GERÇEKTEN sahip olduğu (id = any(target_task_ids)) YABANCI paketleri (touchedPackageIds) ve bunların hedef küme DIŞINDA kalan hücrelerini (affectedTasks) döner. preview_duty_plan_manual_package VE set_duty_plan_manual_package AYNI bu fonksiyonu çağırır — başka gün/yer/öğretmenin, yalnız aynı blok TÜRÜNÜ paylaşan paketleri ASLA etkilenmez. Yalnız service_role çağırabilir.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.compute_duty_plan_manual_package_change(uuid, integer, uuid, uuid[]) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.compute_duty_plan_manual_package_change(uuid, integer, uuid, uuid[]) from authenticated;
  end if;
end
$$;
grant execute on function public.compute_duty_plan_manual_package_change(uuid, integer, uuid, uuid[]) to service_role;

-- ============================================================================
-- 10. preview_duty_plan_manual_package — salt okunur: hedef+etkilenen hücre
--    kümesi, uygunluk ve varsa çakışan paket. YAZMAZ.
-- ============================================================================
create or replace function public.preview_duty_plan_manual_package(
  p_plan_id uuid,
  p_campus_name text,
  p_academic_year_name text,
  p_day_order integer,
  p_duty_location_id uuid,
  p_teacher_source_id text,
  p_coverage_mode text,
  p_duty_block_id uuid default null
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
  v_teacher_source_id text := nullif(btrim(p_teacher_source_id), '');
  v_target_blocks uuid[];
  v_dl record;
  v_change jsonb;
  v_touched_package_ids uuid[];
  v_eligible boolean := true;
  v_reasons text[] := array[]::text[];
  v_conflict_pkg record;
  -- 0 satır dönen bir SELECT INTO, `record` tipli değişkeni "unassigned"
  -- bırakır — sonraki jsonb_build_object'te v_conflict_pkg.id erişimi HİÇ
  -- dal alınmasa bile hata verir. Bu yüzden sonuç jsonb'si burada, YALNIZ
  -- satır bulunduğunda, ayrı bir değişkene önceden hazırlanır.
  v_conflict_pkg_json jsonb;
begin
  if p_plan_id is null or p_day_order is null or p_duty_location_id is null or coalesce(btrim(p_coverage_mode), '') = '' then
    raise exception 'plan_id, day_order, duty_location_id ve coverage_mode zorunludur.' using errcode = '22023';
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

  select * into v_dl from public.duty_locations where id = p_duty_location_id and campus_id = v_campus_id;
  if not found or v_dl.allows_fixed_assignment then
    return jsonb_build_object('found', true, 'eligible', false, 'reasons', array['location_not_available_for_manual_package']);
  end if;

  v_target_blocks := public.resolve_duty_plan_package_target_blocks(p_duty_location_id, p_coverage_mode, p_duty_block_id);
  if v_target_blocks is null then
    return jsonb_build_object('found', true, 'eligible', false, 'reasons', array['invalid_package_combination']);
  end if;

  -- TEK KARAR MANTIĞI: hedef+dokunulan+etkilenen küme set_duty_plan_manual_
  -- package ile AYNI fonksiyondan gelir (bkz. bölüm 9).
  v_change := public.compute_duty_plan_manual_package_change(p_plan_id, p_day_order, p_duty_location_id, v_target_blocks);

  if (v_change ->> 'targetTaskCount')::int <> array_length(v_target_blocks, 1) then
    return jsonb_build_object('found', true, 'eligible', false, 'reasons', array['task_not_found']);
  end if;
  if (v_change ->> 'anyTargetFixed')::boolean then
    return jsonb_build_object('found', true, 'eligible', false, 'reasons', array['fixed_task_immutable']);
  end if;
  if (v_change ->> 'anyTouchedPackageFixed')::boolean then
    return jsonb_build_object('found', true, 'eligible', false, 'reasons', array['fixed_task_immutable']);
  end if;

  select coalesce(array_agg((x)::uuid), array[]::uuid[]) into v_touched_package_ids
    from jsonb_array_elements_text(v_change -> 'touchedPackageIds') as x;

  if v_teacher_source_id is not null then
    if exists (
      select 1 from public.fixed_duty_assignments fa
      where fa.academic_year_id = v_year_id and fa.day_order = p_day_order and fa.teacher_source_id = v_teacher_source_id
    ) then
      v_eligible := false; v_reasons := v_reasons || 'teacher_has_fixed_duty';
    end if;

    -- Çakışan paket: hedef teacher'ın o gün BAŞKA (dokunulan/bölünecek
    -- paketler DIŞINDA) bir paketi var mı — dokunulan paketler zaten
    -- çözülecek olduğu için "çakışma" SAYILMAZ.
    select p.* into v_conflict_pkg from public.duty_plan_assignment_packages p
      where p.plan_id = p_plan_id and p.day_order = p_day_order and p.teacher_source_id = v_teacher_source_id
        and not (p.id = any(v_touched_package_ids));
    if found then
      v_eligible := false; v_reasons := v_reasons || 'teacher_day_conflict';
      v_conflict_pkg_json := jsonb_build_object(
        'id', v_conflict_pkg.id, 'coverageMode', v_conflict_pkg.coverage_mode,
        'dutyLocationId', v_conflict_pkg.duty_location_id, 'assignmentKind', v_conflict_pkg.assignment_kind
      );
    end if;

    if exists (
      select b.id from unnest(v_target_blocks) as b(id)
      where not exists (
        select 1 from public.teacher_duty_block_availabilities av
        join public.teacher_duty_settings s on s.id = av.teacher_duty_setting_id
        where s.academic_year_id = v_year_id and s.teacher_source_id = v_teacher_source_id
          and av.duty_location_id = p_duty_location_id and av.duty_block_id = b.id and av.day_order = p_day_order
      )
    ) then
      v_eligible := false; v_reasons := v_reasons || 'no_preference_for_cell';
    end if;

    if exists (
      select 1 from unnest(v_target_blocks) as b(id)
      join public.teachers t on t.timetable_import_id = v_plan.timetable_import_id and t.source_id = v_teacher_source_id
      where not public.is_teacher_eligible_for_duty_block_time(v_plan.timetable_import_id, t.id, p_day_order, b.id)
    ) then
      v_eligible := false; v_reasons := v_reasons || 'time_rule_violation';
    end if;

    -- Haftalık limit: dokunulan (zaten çözülecek) paketler HARİÇ tutularak
    -- sayılır — aksi halde öğretmenin KENDİ paketini büyütmesi/küçültmesi
    -- (ör. SINGLE_BLOCK → SHORT_BREAKS) yanlışlıkla weekly_limit_exceeded'a
    -- takılırdı.
    if (
      select count(*) from public.duty_plan_assignment_packages
      where plan_id = p_plan_id and teacher_source_id = v_teacher_source_id
        and not (id = any(v_touched_package_ids))
    ) + 1 > coalesce((v_plan.generation_options ->> 'maxWeeklyDuties')::int, 3) then
      v_eligible := false; v_reasons := v_reasons || 'weekly_limit_exceeded';
    end if;
  end if;

  return jsonb_build_object(
    'found', true,
    'planStatus', v_plan.status,
    'planVersion', v_plan.version,
    'targetTaskIds', v_change -> 'targetTaskIds',
    'targetTasks', v_change -> 'targetTasks',
    'affectedTasks', v_change -> 'affectedTasks',
    'eligible', v_eligible,
    'reasons', to_jsonb(v_reasons),
    'conflictingPackage', v_conflict_pkg_json
  );
end;
$$;

comment on function public.preview_duty_plan_manual_package(uuid, text, text, integer, uuid, text, text, uuid) is
  'Salt okunur: bir manuel paket işleminin (coverage_mode = FULL_DAY/SHORT_BREAKS/SINGLE_BLOCK) hedef hücrelerini (duty_location_blocks''tan türetilir), etkilenecek (bölünecek/boşalacak) YABANCI paket hücrelerini, uygunluğu ve varsa conflictingPackage''ı döner. Yazmaz. set_duty_plan_manual_package''ın yazma anında YENİDEN hesapladığı ile AYNI mantığı kullanır. Yalnız service_role çağırabilir.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.preview_duty_plan_manual_package(uuid, text, text, integer, uuid, text, text, uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.preview_duty_plan_manual_package(uuid, text, text, integer, uuid, text, text, uuid) from authenticated;
  end if;
end
$$;
grant execute on function public.preview_duty_plan_manual_package(uuid, text, text, integer, uuid, text, text, uuid) to service_role;

-- ============================================================================
-- 10. set_duty_plan_manual_package — YAZAN taraf. expected_affected_task_ids
--     taze hesaplananla eşleşmezse ASLA sessiz yazmaz (stale_affected_set).
-- ============================================================================
create or replace function public.set_duty_plan_manual_package(
  p_plan_id uuid,
  p_campus_name text,
  p_academic_year_name text,
  p_day_order integer,
  p_duty_location_id uuid,
  p_teacher_source_id text,
  p_coverage_mode text,
  p_expected_plan_version integer,
  p_expected_affected_task_ids uuid[] default null,
  p_duty_block_id uuid default null
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
  v_dl record;
  v_teacher_source_id text := nullif(btrim(p_teacher_source_id), '');
  v_teacher record;
  v_target_blocks uuid[];
  v_change jsonb;
  v_target_task_ids uuid[];
  v_target_task_count integer;
  v_any_target_fixed boolean;
  v_any_touched_fixed boolean;
  v_affected_task_ids uuid[];
  v_affected_tasks jsonb;
  v_touched_package_ids uuid[];
  v_conflict_pkg record;
  v_current_total integer;
  v_max integer;
  v_new_pkg_id uuid;
  v_new_summary jsonb;
  v_new_version integer;
begin
  if p_plan_id is null or p_day_order is null or p_duty_location_id is null
     or coalesce(btrim(p_coverage_mode), '') = '' or p_expected_plan_version is null then
    raise exception 'plan_id, day_order, duty_location_id, coverage_mode ve expected_plan_version zorunludur.' using errcode = '22023';
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

  select * into v_dl from public.duty_locations where id = p_duty_location_id and campus_id = v_campus_id;
  if not found or v_dl.allows_fixed_assignment then
    return jsonb_build_object('status', 'invalid_package_combination');
  end if;

  v_target_blocks := public.resolve_duty_plan_package_target_blocks(p_duty_location_id, p_coverage_mode, p_duty_block_id);
  if v_target_blocks is null then
    return jsonb_build_object('status', 'invalid_package_combination');
  end if;

  -- TEK KARAR MANTIĞI: preview_duty_plan_manual_package İLE AYNI fonksiyon.
  -- Yalnız GERÇEKTEN hedef hücrelerin (id bazlı) sahibi olan paketler
  -- "dokunulan" sayılır — başka gün/yer/öğretmenin, yalnız aynı blok TÜRÜNÜ
  -- paylaşan paketleri ASLA etkilenmez.
  v_change := public.compute_duty_plan_manual_package_change(p_plan_id, p_day_order, p_duty_location_id, v_target_blocks);
  v_target_task_count := (v_change ->> 'targetTaskCount')::int;
  v_any_target_fixed := (v_change ->> 'anyTargetFixed')::boolean;
  v_any_touched_fixed := (v_change ->> 'anyTouchedPackageFixed')::boolean;
  v_affected_tasks := v_change -> 'affectedTasks';
  select coalesce(array_agg((x)::uuid), array[]::uuid[]) into v_target_task_ids from jsonb_array_elements_text(v_change -> 'targetTaskIds') as x;
  select coalesce(array_agg((x)::uuid), array[]::uuid[]) into v_touched_package_ids from jsonb_array_elements_text(v_change -> 'touchedPackageIds') as x;
  select coalesce(array_agg((x)::uuid), array[]::uuid[]) into v_affected_task_ids from jsonb_array_elements_text(v_change -> 'affectedTaskIds') as x;

  if v_target_task_count is distinct from array_length(v_target_blocks, 1) then
    return jsonb_build_object('status', 'task_not_found');
  end if;
  if v_any_target_fixed or v_any_touched_fixed then
    return jsonb_build_object('status', 'fixed_task_immutable');
  end if;

  -- affectedTasks onayı — HENÜZ HİÇBİR SATIR YAZILMADI (aşağıdaki dissolve/
  -- insert/update adımlarının HİÇBİRİ bu noktadan önce ÇALIŞMAZ).
  if array_length(v_affected_task_ids, 1) > 0 then
    if p_expected_affected_task_ids is null
       or (select coalesce(array_agg(x order by x), array[]::uuid[]) from unnest(p_expected_affected_task_ids) x)
          is distinct from (select coalesce(array_agg(x order by x), array[]::uuid[]) from unnest(v_affected_task_ids) x)
    then
      return jsonb_build_object(
        'status', case when p_expected_affected_task_ids is null then 'requires_confirmation' else 'stale_affected_set' end,
        'affectedTasks', v_affected_tasks
      );
    end if;
  end if;

  -- ================================================================
  -- ATOMİKLİK: yeni öğretmenin TÜM kuralları (import/dahil/tercih/zaman/
  -- sabit-gün/günlük-tekillik/haftalık-limit) burada, HERHANGİ BİR
  -- UPDATE/DELETE'DEN ÖNCE tamamen doğrulanır. Bu blok reddederse (return),
  -- şu ana kadar TEK BİR SATIR bile değişmemiş olur — kısmi yazma YOKTUR.
  -- ================================================================
  if v_teacher_source_id is not null then
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
      where fa.academic_year_id = v_year_id and fa.day_order = p_day_order and fa.teacher_source_id = v_teacher_source_id
    ) then
      return jsonb_build_object('status', 'teacher_has_fixed_duty');
    end if;

    -- Çakışan paket: hedef teacher'ın o gün BAŞKA (dokunulan/çözülecek
    -- paketler DIŞINDA) bir paketi var mı.
    select p.* into v_conflict_pkg from public.duty_plan_assignment_packages p
      where p.plan_id = p_plan_id and p.day_order = p_day_order and p.teacher_source_id = v_teacher_source_id
        and not (p.id = any(v_touched_package_ids));
    if found then
      return jsonb_build_object(
        'status', 'teacher_day_conflict',
        'conflictingPackage', jsonb_build_object(
          'id', v_conflict_pkg.id, 'coverageMode', v_conflict_pkg.coverage_mode,
          'dutyLocationId', v_conflict_pkg.duty_location_id, 'assignmentKind', v_conflict_pkg.assignment_kind
        )
      );
    end if;

    if exists (
      select b.id from unnest(v_target_blocks) as b(id)
      where not exists (
        select 1 from public.teacher_duty_block_availabilities av
        join public.teacher_duty_settings s on s.id = av.teacher_duty_setting_id
        where s.academic_year_id = v_year_id and s.teacher_source_id = v_teacher_source_id
          and av.duty_location_id = p_duty_location_id and av.duty_block_id = b.id and av.day_order = p_day_order
      )
    ) then
      return jsonb_build_object('status', 'no_preference_for_cell');
    end if;

    if exists (
      select 1 from unnest(v_target_blocks) as b(id)
      where not public.is_teacher_eligible_for_duty_block_time(v_plan.timetable_import_id, v_teacher.id, p_day_order, b.id)
    ) then
      return jsonb_build_object('status', 'time_rule_violation');
    end if;

    -- Haftalık limit: dokunulan (zaten çözülecek) paketler HARİÇ tutularak
    -- sayılır — öğretmenin KENDİ paketini büyütmesi/küçültmesi yanlışlıkla
    -- weekly_limit_exceeded'a takılmasın diye.
    select count(*) into v_current_total
      from public.duty_plan_assignment_packages
      where plan_id = p_plan_id and teacher_source_id = v_teacher_source_id
        and not (id = any(v_touched_package_ids));
    v_max := coalesce((v_plan.generation_options ->> 'maxWeeklyDuties')::int, 3);
    if v_current_total + 1 > v_max then
      return jsonb_build_object('status', 'weekly_limit_exceeded');
    end if;
  end if;

  -- ================================================================
  -- YAZMA — buraya kadar HİÇBİR satır değişmedi. TÜM doğrulamalar geçti.
  -- ================================================================
  if array_length(v_touched_package_ids, 1) > 0 then
    update public.duty_plan_assignments
      set teacher_source_id = null, teacher_name_snapshot = null, assignment_kind = 'unassigned',
          package_id = null, updated_at = timezone('utc', now())
      where package_id = any(v_touched_package_ids);
    delete from public.duty_plan_assignment_packages where id = any(v_touched_package_ids);
  end if;

  if v_teacher_source_id is not null then
    insert into public.duty_plan_assignment_packages (
      plan_id, campus_id, day_order, duty_location_id, teacher_source_id, teacher_name_snapshot,
      coverage_mode, assignment_kind
    ) values (
      p_plan_id, v_plan.campus_id, p_day_order, p_duty_location_id, v_teacher_source_id, v_teacher.name,
      p_coverage_mode, 'manual'
    ) returning id into v_new_pkg_id;

    update public.duty_plan_assignments
      set teacher_source_id = v_teacher_source_id, teacher_name_snapshot = v_teacher.name,
          assignment_kind = 'manual', package_id = v_new_pkg_id, updated_at = timezone('utc', now())
      where id = any(v_target_task_ids);
  end if;

  with teacher_universe as (
    select s.teacher_source_id from public.teacher_duty_settings s where s.academic_year_id = v_year_id and s.is_included
    union
    select fa.teacher_source_id from public.fixed_duty_assignments fa where fa.academic_year_id = v_year_id
  ),
  fixed_days as (
    select p.teacher_source_id, count(*) as fixed_days
      from public.duty_plan_assignment_packages p
      where p.plan_id = p_plan_id and p.assignment_kind = 'fixed'
      group by p.teacher_source_id
  ),
  normal_counts as (
    select p.teacher_source_id, count(*) as normal_count
      from public.duty_plan_assignment_packages p
      where p.plan_id = p_plan_id and p.assignment_kind in ('generated', 'manual')
      group by p.teacher_source_id
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
    'packageId', v_new_pkg_id,
    'summary', v_new_summary
  );
end;
$$;

comment on function public.set_duty_plan_manual_package(uuid, text, text, integer, uuid, text, text, integer, uuid[], uuid) is
  'Volatile: bir günlük görev paketini (FULL_DAY/SHORT_BREAKS/SINGLE_BLOCK, teacher_source_id NULL ⇔ paketi kaldır) elle yazar. Hedef+etkilenen hücre kümesi HER ÇAĞRIDA yeniden hesaplanır; p_expected_affected_task_ids taze kümeyle eşleşmezse (veya hiç verilmemişse ve etkilenen küme boş değilse) requires_confirmation/stale_affected_set döner ve HİÇBİR ŞEY YAZMAZ — sessiz bölme/taşıma yok. Dokunulan YABANCI paketler tamamen çözülür (hücreleri unassigned). Başka bir paketi olan öğretmen seçilirse teacher_day_conflict + conflictingPackage. Haftalık toplam PAKET sayısıdır. Yalnız service_role çağırabilir.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.set_duty_plan_manual_package(uuid, text, text, integer, uuid, text, text, integer, uuid[], uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.set_duty_plan_manual_package(uuid, text, text, integer, uuid, text, text, integer, uuid[], uuid) from authenticated;
  end if;
end
$$;
grant execute on function public.set_duty_plan_manual_package(uuid, text, text, integer, uuid, text, text, integer, uuid[], uuid) to service_role;

-- ============================================================================
-- 11. publish_duty_plan_draft — PAKET-FARKINDA son doğrulama kapısı.
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

  -- Paket-hücre tutarlılığı: her generated/manual/fixed hücrenin package_id'si
  -- dolu olmalı (unassigned dışında hiç boş kalmamalı — DB CHECK zaten
  -- garanti eder, ama savunma amaçlı bağımsız kontrol).
  select exists (
    select 1 from public.duty_plan_assignments
    where plan_id = p_plan_id and assignment_kind <> 'unassigned' and package_id is null
  ) into v_bad;
  if v_bad then return jsonb_build_object('status', 'rule_violation', 'reason', 'package_task_mismatch'); end if;

  -- Her paketin kapsadığı block_code kümesi HÂLÂ kendi coverage_mode'una uyuyor
  -- mu (config drift'e karşı son savunma — normalde source_fingerprint bunu
  -- zaten yakalar).
  select exists (
    select 1 from (
      select p.id, p.coverage_mode, p.duty_location_id, p.assignment_kind,
             array_agg(b.code) as codes
        from public.duty_plan_assignment_packages p
        join public.duty_plan_assignments a on a.package_id = p.id
        join public.duty_blocks b on b.id = a.duty_block_id
        where p.plan_id = p_plan_id
        group by p.id, p.coverage_mode, p.duty_location_id, p.assignment_kind
    ) x
    where public.classify_duty_plan_package_coverage(x.duty_location_id, x.assignment_kind, x.codes) is distinct from x.coverage_mode
  ) into v_bad;
  if v_bad then return jsonb_build_object('status', 'rule_violation', 'reason', 'invalid_package_combination'); end if;

  -- Haftalık üst sınır — artık PAKET sayısı (satır değil).
  v_max := coalesce((v_plan.generation_options ->> 'maxWeeklyDuties')::int, 3);
  select exists (
    select 1 from (
      select teacher_source_id, count(*) as total
        from public.duty_plan_assignment_packages
        where plan_id = p_plan_id
        group by teacher_source_id
    ) x where x.total > v_max
  ) into v_bad;
  if v_bad then return jsonb_build_object('status', 'rule_violation', 'reason', 'weekly_limit_exceeded'); end if;

  -- Normal görevlerin TAMAMI bağımsız NOT EXISTS/anti-join ile doğrulanır.
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

  -- Fixed PAKETLER güncel fixed_duty_assignments ile gün×yer×öğretmen
  -- açısından BİREBİR eşleşmeli (iki yönlü anti-join, paket seviyesinde).
  select exists (
    select 1 from public.duty_plan_assignment_packages p
     where p.plan_id = p_plan_id and p.assignment_kind = 'fixed'
       and not exists (
         select 1 from public.fixed_duty_assignments fa
          where fa.academic_year_id = v_year_id and fa.day_order = p.day_order
            and fa.duty_location_id = p.duty_location_id and fa.teacher_source_id = p.teacher_source_id
       )
    union all
    select 1 from public.fixed_duty_assignments fa
     where fa.academic_year_id = v_year_id
       and not exists (
         select 1 from public.duty_plan_assignment_packages p
          where p.plan_id = p_plan_id and p.assignment_kind = 'fixed'
            and p.day_order = fa.day_order and p.duty_location_id = fa.duty_location_id and p.teacher_source_id = fa.teacher_source_id
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
  'Atomik, PAKET-FARKINDA: bir draft planı published yapar. Açık görev=0, paket-hücre tutarlılığı, her paketin block kümesi kendi coverage_mode''una uyuyor, haftalık üst sınır PAKET sayısıyla, normal görev adayları bağımsız anti-join, görev kümesi eksiksiz/fazlasız, fixed paketler güncel fixed_duty_assignments ile birebir. Aynı transaction''da varsa eski published planı archived''a çevirir. Kısmi plan HİÇBİR ŞEKİLDE yayımlanamaz. Yalnız service_role çağırabilir.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.publish_duty_plan_draft(uuid, text, text, integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.publish_duty_plan_draft(uuid, text, text, integer) from authenticated;
  end if;
end
$$;
grant execute on function public.publish_duty_plan_draft(uuid, text, text, integer) to service_role;

-- ============================================================================
-- 12. get_published_duty_plan / get_duty_plan_draft — additive `packages[]`
--     (haftalık plan ekranının FULL_DAY paketini TEK satır göstermesi için).
-- ============================================================================
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
  v_packages jsonb;
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
      'assignmentKind', a.assignment_kind, 'packageId', a.package_id
      ) order by a.day_order, a.duty_location_name_snapshot, a.duty_block_name_snapshot), '[]'::jsonb)
    into v_assignments
    from public.duty_plan_assignments a
    where a.plan_id = v_plan.id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'dayOrder', p.day_order,
      'dutyLocationId', p.duty_location_id,
      'dutyLocationName', (select min(a.duty_location_name_snapshot) from public.duty_plan_assignments a where a.package_id = p.id),
      'teacherSourceId', p.teacher_source_id, 'teacherName', p.teacher_name_snapshot,
      'coverageMode', p.coverage_mode, 'assignmentKind', p.assignment_kind,
      'coveredBlockCodes', (
        select coalesce(jsonb_agg(b.code order by b.block_order), '[]'::jsonb)
          from public.duty_plan_assignments a2 join public.duty_blocks b on b.id = a2.duty_block_id
          where a2.package_id = p.id
      )
      ) order by p.day_order, p.teacher_name_snapshot), '[]'::jsonb)
    into v_packages
    from public.duty_plan_assignment_packages p
    where p.plan_id = v_plan.id;

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
    'assignments', v_assignments,
    'packages', v_packages
  );
end;
$$;

comment on function public.get_published_duty_plan(text, text) is
  'Salt okunur: kampüs+eğitim yılının AKTİF (status=published) planını, hücre atamalarını VE paketlerini (packages[] — coverageMode/coveredBlockCodes ile, tarihsel snapshot isimleriyle) döner. Haftalık plan ekranı bir FULL_DAY paketini dört ayrı görev yerine TEK satır göstermek için packages[]''i kullanır. Yalnız service_role çağırabilir.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.get_published_duty_plan(text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.get_published_duty_plan(text, text) from authenticated;
  end if;
end
$$;
grant execute on function public.get_published_duty_plan(text, text) to service_role;

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
  v_packages jsonb;
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

  v_current_fingerprint := public.compute_duty_plan_source_fingerprint(p_campus_name, p_academic_year_name);

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'dayOrder', a.day_order,
      'dutyLocationId', a.duty_location_id, 'dutyLocationName', a.duty_location_name_snapshot,
      'dutyBlockId', a.duty_block_id, 'dutyBlockName', a.duty_block_name_snapshot,
      'teacherSourceId', a.teacher_source_id, 'teacherName', a.teacher_name_snapshot,
      'assignmentKind', a.assignment_kind, 'fixedDutyAssignmentId', a.fixed_duty_assignment_id,
      'scoreDetails', a.score_details, 'packageId', a.package_id
      ) order by a.day_order, a.duty_location_name_snapshot, a.duty_block_name_snapshot), '[]'::jsonb)
    into v_assignments
    from public.duty_plan_assignments a
    where a.plan_id = v_plan.id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'dayOrder', p.day_order, 'dutyLocationId', p.duty_location_id,
      'teacherSourceId', p.teacher_source_id, 'teacherName', p.teacher_name_snapshot,
      'coverageMode', p.coverage_mode, 'assignmentKind', p.assignment_kind,
      'coveredTaskIds', (select coalesce(jsonb_agg(a2.id), '[]'::jsonb) from public.duty_plan_assignments a2 where a2.package_id = p.id)
      ) order by p.day_order, p.teacher_name_snapshot), '[]'::jsonb)
    into v_packages
    from public.duty_plan_assignment_packages p
    where p.plan_id = v_plan.id;

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
    'assignments', v_assignments,
    'packages', v_packages
  );
end;
$$;

comment on function public.get_duty_plan_draft(uuid, text, text) is
  'Salt okunur: kimliği verilen bir nöbet planını, hücre atamalarını VE paketlerini (packages[]) döner. savedSourceFingerprint/currentSourceFingerprint/isStale YETKİLİ biçimde burada hesaplanır. Yalnız service_role çağırabilir.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.get_duty_plan_draft(uuid, text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.get_duty_plan_draft(uuid, text, text) from authenticated;
  end if;
end
$$;
grant execute on function public.get_duty_plan_draft(uuid, text, text) to service_role;

-- ============================================================================
-- 13. get_teacher_lesson_period_counts — öğretmenin GÜN BAZINDA gerçek ders
--     yükü (lessonPeriodCount). Solver için SIRALAMA maliyeti — ZORUNLU bir
--     uygunluk kuralı DEĞİLDİR. teacher_source_id (kararlı) üzerinden
--     ilişkilendirilir, teachers.id (import-snapshot UUID) ÜZERİNDEN DEĞİL.
-- ============================================================================
create or replace function public.get_teacher_lesson_period_counts(
  p_timetable_import_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'teacherSourceId', x.source_id, 'dayOrder', x.day_order, 'lessonPeriodCount', x.cnt
      ) order by x.source_id, x.day_order), '[]'::jsonb)
    from (
      select t.source_id, d.day_order, count(distinct ta.lesson_period_id) as cnt
        from public.timetable_assignments ta
        join public.teachers t on t.id = ta.teacher_id and t.timetable_import_id = p_timetable_import_id
        join public.timetable_days d on d.id = ta.timetable_day_id and d.timetable_import_id = p_timetable_import_id
        where ta.timetable_import_id = p_timetable_import_id
        group by t.source_id, d.day_order
    ) x;
$$;

comment on function public.get_teacher_lesson_period_counts(uuid) is
  'Salt okunur: öğretmenin GÜN BAZINDA gerçek ders yükü — count(distinct lesson_period_id), aynı karttan gelen tekrarlar çift SAYILMAZ. teacher_source_id (KARARLI) üzerinden döner, teachers.id (import-snapshot UUID) değil. Solver''da SIRALAMA maliyetidir (öncelik 6) — hiçbir zorunlu uygunluk kuralını geçersiz KILMAZ. Yalnız service_role çağırabilir.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.get_teacher_lesson_period_counts(uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.get_teacher_lesson_period_counts(uuid) from authenticated;
  end if;
end
$$;
grant execute on function public.get_teacher_lesson_period_counts(uuid) to service_role;
