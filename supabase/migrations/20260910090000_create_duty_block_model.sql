-- ============================================================================
-- Nöbet2027 — Dört Bloklu Nöbet Modeli (şema + iş kuralı referans verisi)
-- ============================================================================
-- Bu migration, "gün bazlı nöbet uygunluğu" modelini "gün + nöbet bloğu"
-- modeline taşımanın BİRİNCİ adımıdır. Bu dosya yalnızca:
--   1. duty_blocks              — okulun dört nöbet bloğu (referans verisi)
--   2. duty_locations.allows_fixed_assignment — sabit nöbete uygunluk bayrağı
--   3. duty_location_blocks     — nöbet yeri × blok gereksinimi
-- tanımlar ve mevcut üç RPC'yi (create_duty_location,
-- create_fixed_duty_assignment, get_fixed_duty_assignments) bu modele
-- uyarlar.
--
-- Öğretmen uygunluğunun blok modeline taşınması AYRI bir migration'dadır
-- (bkz. 20260910091000_create_teacher_duty_block_availability.sql);
-- planlanabilirlik analizi de AYRIDIR (bkz. 20260910092000_*).
--
-- HİÇBİR ÖNCEKİ MİGRATION DOSYASI DEĞİŞTİRİLMEDİ.
--
-- ----------------------------------------------------------------------------
-- "Referans verisi" ile "seed/demo verisi" ayrımı — ÖNEMLİ
-- ----------------------------------------------------------------------------
-- Bu dosya dört duty_blocks satırı EKLER. Bunlar demo/örnek veri DEĞİLDİR:
-- uygulamanın tüm iş mantığı (uygunluk matrisi, sabit nöbet semantiği,
-- planlanabilirlik analizi) bu dört kodun VARLIĞINA bağlıdır — tıpkı bir
-- enum gibi. Bu yüzden kodlar CHECK ile kapalı bir kümeye sabitlenir ve bir
-- BEFORE DELETE trigger'ı bu dört satırın silinmesini engeller.
--
-- Buna karşılık duty_location_blocks eşlemeleri MEVCUT gerçek nöbet yeri
-- satırları üzerinde çalışır; hiçbir yeni nöbet yeri OLUŞTURULMAZ ve hiçbir
-- mevcut nöbet yeri satırı SİLİNMEZ/PASİFLEŞTİRİLMEZ. Uzak veritabanında
-- ilgili short_code'lar yoksa o eşlemeler basitçe oluşmaz (idempotent).
--
-- ----------------------------------------------------------------------------
-- İŞ KURALLARI (okul tarafından doğrulanmış — kullanıcı düzenleyemez)
-- ----------------------------------------------------------------------------
-- Günlük dört blok:
--   1 MORNING_BREAKS   Sabah Teneffüs Bloğu     (kısa teneffüsleri topluca temsil eder)
--   2 LONG_BREAK_1     Uzun Nöbet 1             (çakışan ders: "5-OO")
--   3 LONG_BREAK_2     Uzun Nöbet 2             (çakışan ders: "5-IO")
--   4 AFTERNOON_BREAKS Öğleden Sonra Teneffüs Bloğu
--
-- Nöbet yeri × blok gereksinimleri (KARARLI short_code ile eşlenir; değişebilen
-- `name` metni ASLA eşleştirme anahtarı olarak kullanılmaz):
--   ILKOKUL1          → MORNING_BREAKS, AFTERNOON_BREAKS   (sabit nöbete uygun)
--   ILKOKUL2          → MORNING_BREAKS, AFTERNOON_BREAKS   (sabit nöbete uygun)
--   OGLEARASIILKOKUL  → LONG_BREAK_1                       (sabit nöbete uygun DEĞİL)
--   diğer tüm yerler  → dört bloğun tamamı                 (sabit nöbete uygun DEĞİL)
--
-- OGLEARASIILKOKUL, Uzun Nöbet 1'de TEK öğretmenle hem İLKOKUL-1 hem
-- İLKOKUL-2 koridorunu gözetir — bu yüzden sabit öğretmen başına ayrı bir
-- destek görevi/nöbet yeri OLUŞTURULMAZ.
--
-- KAPASİTE NOTU: duty_locations.capacity sütunu KORUNUR ama blok modelinde
-- KULLANILMAZ. İş kuralı nettir: "her nöbet yeri, aktif olduğu her blokta
-- TAM OLARAK 1 öğretmen ister". capacity, blok öncesi modelden kalan ve
-- yalnızca bilgilendirme amacıyla gösterilen bir alandır; planlanabilirlik
-- analizi (bkz. 20260910092000_*) her (yer, blok) görevini 1 kişilik sayar.
-- ============================================================================

-- ============================================================================
-- 1. duty_blocks — dört nöbet bloğu
-- ============================================================================
create table public.duty_blocks (
  id uuid primary key default gen_random_uuid(),
  -- Kararlı, İngilizce, büyük harf kod. Türkçe karşılığı `name` sütunundadır
  -- ve frontend'de gösterilir (duty_locations.category ile aynı desen).
  -- CHECK bilinçli olarak KAPALI bir kümedir: uygulamanın tüm blok semantiği
  -- (ders çakışması, sabit nöbet davranışı, analiz) bu dört koda göre
  -- yazılmıştır; bilinmeyen bir kod sessizce yanlış analiz üretirdi.
  code text not null
    check (code in ('MORNING_BREAKS', 'LONG_BREAK_1', 'LONG_BREAK_2', 'AFTERNOON_BREAKS')),
  name text not null check (btrim(name) <> ''),
  block_order smallint not null check (block_order between 1 and 4),
  -- Bu blokta nöbet tutamayacak öğretmeni belirleyen ders saati adı
  -- (lesson_periods.name ile birebir eşleşir; ör. "5-OO"). NULL ise bu blok
  -- için ders çakışması kuralı YOKTUR (sabah/öğleden sonra blokları kısa
  -- teneffüsleri topluca temsil ettiğinden tek bir ders saatine bağlanamaz).
  conflict_period_name text check (conflict_period_name is null or btrim(conflict_period_name) <> ''),
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint duty_blocks_code_uq unique (code),
  constraint duty_blocks_order_uq unique (block_order)
);

comment on table public.duty_blocks is
  'Okulun dört günlük nöbet bloğu (referans verisi, demo/seed DEĞİL). Kodlar kapalı bir kümedir ve uygulamanın tüm blok semantiği bunlara dayanır.';
comment on column public.duty_blocks.conflict_period_name is
  'lesson_periods.name ile eşleşen ders saati adı; o saatte dersi olan öğretmen bu blokta nöbete aday OLAMAZ. NULL = bu blok için ders çakışması kuralı yok.';
comment on column public.duty_blocks.block_order is
  'Gün içi sıra (1=sabah teneffüsleri, 2=uzun nöbet 1, 3=uzun nöbet 2, 4=öğleden sonra teneffüsleri). Frontend sütun sırası bu değerden türetilir.';

create trigger set_updated_at
  before update on public.duty_blocks
  for each row execute function public.set_updated_at();

alter table public.duty_blocks enable row level security;

-- ----------------------------------------------------------------------------
-- Dört blok — uygulamanın zorunlu referans verisi
-- ----------------------------------------------------------------------------
insert into public.duty_blocks (code, name, block_order, conflict_period_name) values
  ('MORNING_BREAKS',   'Sabah Teneffüs Bloğu',        1, null),
  ('LONG_BREAK_1',     'Uzun Nöbet 1',                2, '5-OO'),
  ('LONG_BREAK_2',     'Uzun Nöbet 2',                3, '5-IO'),
  ('AFTERNOON_BREAKS', 'Öğleden Sonra Teneffüs Bloğu', 4, null);

-- ----------------------------------------------------------------------------
-- Referans satırlarının silinmesini engelle
-- ----------------------------------------------------------------------------
-- Bir blok satırı silinirse uygunluk/sabit nöbet/analiz mantığı sessizce
-- eksik çalışırdı (ör. "Uzun Nöbet 1 hiç gerekmiyormuş" gibi görünürdü).
-- FK'ler ON DELETE RESTRICT ile zaten kullanımdaki blokları korur, ama HİÇ
-- kullanılmayan bir blok da silinememelidir. Bloğu devre dışı bırakmanın
-- doğru yolu is_active = false'tur.
create or replace function public.prevent_duty_block_delete()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'duty_blocks satırları silinemez (uygulamanın zorunlu referans verisi). Devre dışı bırakmak için is_active = false kullanın.'
    using errcode = '23514';
end;
$$;

create trigger duty_blocks_prevent_delete
  before delete on public.duty_blocks
  for each row execute function public.prevent_duty_block_delete();

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.duty_blocks from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.duty_blocks from authenticated;
  end if;
end
$$;

-- ============================================================================
-- 2. duty_locations.allows_fixed_assignment
-- ============================================================================
-- Sabit nöbet YALNIZ bu bayrağı true olan nöbet yerlerine verilebilir.
-- Varsayılan false: yeni oluşturulan her nöbet yeri sabit nöbete kapalıdır ve
-- bu bayrak kullanıcı arayüzünden DEĞİŞTİRİLEMEZ (okulun doğrulanmış iş
-- kuralı). Değişiklik gerekirse yeni bir migration ile yapılır.
alter table public.duty_locations
  add column allows_fixed_assignment boolean not null default false;

comment on column public.duty_locations.allows_fixed_assignment is
  'true ise bu nöbet yerine sabit nöbet atanabilir (yalnız ILKOKUL1/ILKOKUL2). Kullanıcı arayüzünden değiştirilemez; create_fixed_duty_assignment RPC''si bunu zorunlu kılar.';

-- Mevcut gerçek nöbet yerleri: yalnız iki ilkokul koridoru sabit nöbete uygun.
-- Kararlı short_code ile eşlenir (upper(): DB kısıtı zaten büyük harf
-- dayatıyor, ama savunma derinliği için normalize edilir).
update public.duty_locations
  set allows_fixed_assignment = true
  where upper(short_code) in ('ILKOKUL1', 'ILKOKUL2');

-- ----------------------------------------------------------------------------
-- Mevcut sabit nöbet atamalarının korunması
-- ----------------------------------------------------------------------------
-- Hiçbir mevcut fixed_duty_assignments satırı SİLİNMEZ. Ama yeni kural
-- geriye dönük olarak ihlal ediliyorsa (ör. uygun olmayan bir yere daha önce
-- sabit nöbet verilmişse) bunu SESSİZCE bırakmak yerine migration'ı
-- durdurmak doğrudur: veri ile iş kuralı çelişiyorsa insan kararı gerekir.
do $$
declare
  v_violation_count integer;
begin
  select count(*) into v_violation_count
    from public.fixed_duty_assignments a
    join public.duty_locations dl on dl.id = a.duty_location_id
    where not dl.allows_fixed_assignment;

  if v_violation_count > 0 then
    raise exception
      'Sabit nöbete uygun OLMAYAN nöbet yerlerinde % adet mevcut sabit atama var. Bu migration hiçbir atamayı silmez; önce bu atamalar elle gözden geçirilmelidir.',
      v_violation_count
      using errcode = '23514';
  end if;
end
$$;

-- ============================================================================
-- 3. duty_location_blocks — nöbet yeri × blok gereksinimi
-- ============================================================================
-- Bir satır = "bu nöbet yeri, bu blokta AKTİFTİR ve tam olarak 1 öğretmen
-- ister". Kapasite kavramı burada YOKTUR (bkz. dosya başlığındaki kapasite
-- notu).
create table public.duty_location_blocks (
  id uuid primary key default gen_random_uuid(),
  -- Kampüs sütunu, mevcut şemadaki composite-FK deseniyle aynı amaçla
  -- taşınır: bir eşlemenin nöbet yeri ile kampüsünün AYNI olması veritabanı
  -- seviyesinde garanti edilir (bkz. teacher_duty_availabilities).
  campus_id uuid not null,
  duty_location_id uuid not null,
  -- ON DELETE RESTRICT: kullanımdaki bir blok satırı yok edilemez. (Ayrıca
  -- yukarıdaki prevent_delete trigger'ı hiç kullanılmayan blokları da korur.)
  duty_block_id uuid not null references public.duty_blocks (id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),

  constraint duty_location_blocks_location_campus_fk
    foreign key (duty_location_id, campus_id)
    references public.duty_locations (id, campus_id)
    on delete cascade,
  constraint duty_location_blocks_unique_pair
    unique (duty_location_id, duty_block_id),
  -- İleride bu tabloya composite FK ile bağlanmak gerekirse hazır olsun.
  constraint duty_location_blocks_id_campus_uq unique (id, campus_id)
);

comment on table public.duty_location_blocks is
  'Nöbet yeri × nöbet bloğu gereksinimi: satır varsa o yer o blokta aktiftir ve TAM OLARAK 1 öğretmen ister. Kullanıcı arayüzünden düzenlenmez (okulun doğrulanmış iş kuralı).';

create index duty_location_blocks_location_idx on public.duty_location_blocks (duty_location_id);
create index duty_location_blocks_block_idx on public.duty_location_blocks (duty_block_id);
create index duty_location_blocks_campus_idx on public.duty_location_blocks (campus_id);

alter table public.duty_location_blocks enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.duty_location_blocks from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.duty_location_blocks from authenticated;
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- Başlangıç eşlemesi — MEVCUT gerçek nöbet yerleri üzerinde
-- ----------------------------------------------------------------------------
-- SİLİNMEMİŞ (deleted_at is null) tüm nöbet yerleri eşlenir; `is_active`
-- durumuna BAKILMAZ. Gerekçe: blok gereksinimi yerin KALICI bir özelliğidir,
-- o anki aktiflik durumunun değil. Pasif bir yer sonradan yeniden aktif
-- edildiğinde blok tanımı hazır olmalıdır (mevcut kod tabanındaki
-- "pasif/soft-delete kaydı fiziksel olarak koru" deseniyle aynı mantık —
-- bkz. save_teacher_duty_matrix'teki BULGU A düzeltmesi). Planlanabilirlik
-- analizi zaten yalnız `is_active` yerleri sayar.
--
-- Soft-delete edilmiş yerler BİLEREK eşlenmez: onlar arşivdir ve yeniden
-- kullanıma alınmaları ayrı, bilinçli bir işlem olmalıdır.

-- (a) İki ilkokul koridoru: sabah + öğleden sonra
insert into public.duty_location_blocks (campus_id, duty_location_id, duty_block_id)
select dl.campus_id, dl.id, b.id
  from public.duty_locations dl
  cross join public.duty_blocks b
  where dl.deleted_at is null
    and upper(dl.short_code) in ('ILKOKUL1', 'ILKOKUL2')
    and b.code in ('MORNING_BREAKS', 'AFTERNOON_BREAKS');

-- (b) Öğle arası ilkokul gözetimi: yalnız Uzun Nöbet 1
insert into public.duty_location_blocks (campus_id, duty_location_id, duty_block_id)
select dl.campus_id, dl.id, b.id
  from public.duty_locations dl
  cross join public.duty_blocks b
  where dl.deleted_at is null
    and upper(dl.short_code) = 'OGLEARASIILKOKUL'
    and b.code = 'LONG_BREAK_1';

-- (c) Diğer bütün silinmemiş nöbet yerleri: dört bloğun tamamı
insert into public.duty_location_blocks (campus_id, duty_location_id, duty_block_id)
select dl.campus_id, dl.id, b.id
  from public.duty_locations dl
  cross join public.duty_blocks b
  where dl.deleted_at is null
    and upper(dl.short_code) not in ('ILKOKUL1', 'ILKOKUL2', 'OGLEARASIILKOKUL');

-- ============================================================================
-- 4. create_duty_location — yeni yerler dört bloğa bağlanır
-- ============================================================================
-- İMZA DEĞİŞMEDİ (7 parametre, returns public.duty_locations) — bu yüzden
-- 20260906090000'daki GRANT/REVOKE bloğu aynen geçerli kalır ve fonksiyon
-- overload'u OLUŞMAZ. Dönüş satırı yeni allows_fixed_assignment sütununu
-- otomatik olarak içerir (returns table-type).
--
-- Yeni yerler HER ZAMAN dört bloğa bağlanır ve allows_fixed_assignment
-- varsayılanı (false) korunur. Kullanıcı bunu değiştiremez; ILKOKUL1/2 gibi
-- özel yerler bu migration'ın referans eşlemesiyle kurulur, arayüzden
-- yeniden üretilemez.
create or replace function public.create_duty_location(
  p_campus_id uuid,
  p_name text,
  p_short_code text,
  p_category text,
  p_capacity integer,
  p_description text,
  p_is_active boolean
)
returns public.duty_locations
language plpgsql
volatile
set search_path = pg_catalog, public
as $$
declare
  v_next_sort_order integer;
  v_row public.duty_locations;
begin
  perform pg_advisory_xact_lock(hashtext('duty_locations:' || p_campus_id::text));

  select coalesce(max(sort_order), 0) + 1
    into v_next_sort_order
    from public.duty_locations
    where campus_id = p_campus_id and deleted_at is null;

  insert into public.duty_locations (
    campus_id, name, short_code, category, capacity, description, is_active, sort_order
  ) values (
    p_campus_id, p_name, p_short_code, p_category, p_capacity, p_description, p_is_active, v_next_sort_order
  )
  returning * into v_row;

  -- Yeni nöbet yeri dört bloğun tamamında aktiftir (varsayılan iş kuralı).
  -- Aynı transaction içinde yapılır: blok eşlemesi olmayan bir nöbet yeri
  -- satırı hiçbir zaman görünür olmaz.
  insert into public.duty_location_blocks (campus_id, duty_location_id, duty_block_id)
    select v_row.campus_id, v_row.id, b.id
      from public.duty_blocks b
      where b.is_active;

  return v_row;
end;
$$;

comment on function public.create_duty_location(uuid, text, text, text, integer, text, boolean) is
  'Yeni nöbet yeri ekler (sort_order advisory lock ile eşzamanlı-güvenli) ve yeri AYNI transaction içinde dört nöbet bloğunun tamamına bağlar. allows_fixed_assignment varsayılan false kalır — sabit nöbete uygunluk arayüzden verilemez. Yalnız service_role çağırabilir.';

-- ============================================================================
-- 5. get_fixed_duty_assignments — yalnız sabit nöbete uygun yerleri listeler
-- ============================================================================
-- Sabit Nöbetler ekranındaki "Nöbet yeri" seçim listesi artık YALNIZ
-- allows_fixed_assignment = true olan yerleri içerir. Bu bir kolaylık
-- filtresidir; asıl zorlama create_fixed_duty_assignment içindedir (bkz. 6).
--
-- `assignments` listesi FİLTRELENMEZ: geçmişte oluşmuş bir atama, yerin
-- bayrağı ne olursa olsun görünür kalmalıdır (aksi halde kullanıcı
-- kaldıramayacağı görünmez bir atamayla baş başa kalırdı).
create or replace function public.get_fixed_duty_assignments(
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
  v_import_id uuid;
begin
  select c.id into v_campus_id
    from public.campuses c where c.name = p_campus_name limit 1;
  if v_campus_id is null then
    return jsonb_build_object('hasImport', false);
  end if;

  select ay.id into v_year_id
    from public.academic_years ay
    where ay.campus_id = v_campus_id and ay.name = p_academic_year_name
    limit 1;
  if v_year_id is null then
    return jsonb_build_object('hasImport', false);
  end if;

  select ti.id into v_import_id
    from public.timetable_imports ti
    where ti.academic_year_id = v_year_id and ti.status = 'imported'
    order by ti.imported_at desc, ti.created_at desc limit 1;
  if v_import_id is null then
    return jsonb_build_object('hasImport', false);
  end if;

  return jsonb_build_object(
    'hasImport', true,
    'teachers', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'sourceId', t.source_id, 'name', t.name)
                       order by t.name)
      from public.teachers t where t.timetable_import_id = v_import_id
    ), '[]'::jsonb),
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('order', d.day_order, 'name', d.name) order by d.day_order)
      from public.timetable_days d where d.timetable_import_id = v_import_id
    ), '[]'::jsonb),
    -- YALNIZ sabit nöbete uygun yerler.
    'dutyLocations', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', dl.id, 'name', dl.name, 'shortCode', dl.short_code,
               'allowsFixedAssignment', dl.allows_fixed_assignment)
                       order by dl.sort_order, dl.name)
      from public.duty_locations dl
      where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null
        and dl.allows_fixed_assignment
    ), '[]'::jsonb),
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id,
        'teacherSourceId', a.teacher_source_id,
        'teacherName', coalesce(t.name, a.teacher_name_snapshot),
        'dayOrder', a.day_order,
        'dutyLocationId', a.duty_location_id,
        'dutyLocationName', dl.name
      ) order by a.day_order, dl.sort_order, a.teacher_name_snapshot)
      from public.fixed_duty_assignments a
      join public.duty_locations dl on dl.id = a.duty_location_id
      left join public.teachers t
        on t.timetable_import_id = v_import_id and t.source_id = a.teacher_source_id
      where a.academic_year_id = v_year_id
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.get_fixed_duty_assignments(text, text) is
  'Sabit Nöbetler ekranının snapshot''ı. dutyLocations YALNIZ allows_fixed_assignment=true olan aktif yerleri içerir; assignments ise geçmiş atamaları kaybetmemek için filtrelenmez. Yalnız service_role çağırabilir.';

-- ============================================================================
-- 6. create_fixed_duty_assignment — sabit nöbet yalnız uygun yerlere
-- ============================================================================
-- KRİTİK: bu kontrol backend/RPC seviyesindedir. Frontend'in seçim listesi
-- filtresi (bkz. 5) aşılsa bile — eski bir tarayıcı sekmesi, doğrudan HTTP
-- isteği veya doğrudan RPC çağrısı — uygun olmayan bir yere sabit nöbet
-- YAZILAMAZ. Kontrollü {status:"location_not_fixed_eligible"} döner; ham
-- Postgres hatası sızmaz.
--
-- Mevcut eşzamanlılık kilidi (pg_advisory_xact_lock 'fixed-duty:{year}:{day}')
-- AYNEN korunur — save_teacher_duty_matrix bu anahtarları 1→5 artan sırada
-- aldığı için iki fonksiyon arasındaki karşılıklı dışlama bozulmaz
-- (bkz. 20260909090000_integrate_fixed_duties_with_availability_matrix.sql).
--
-- Uygunluk kontrolü BİLİNÇLİ olarak kilitten ÖNCE, location_not_found ile
-- aynı adımda yapılır: allows_fixed_assignment yalnız migration ile değişen,
-- eşzamanlı yazma yarışına girmeyen bir bayraktır; kilit yalnız (gün, yer) ve
-- (gün, öğretmen) benzersizlik yarışlarını korur.
create or replace function public.create_fixed_duty_assignment(
  p_campus_name text,
  p_academic_year_name text,
  p_teacher_id uuid,
  p_day_order integer,
  p_duty_location_id uuid
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
  v_import_id uuid;
  v_teacher public.teachers;
  v_location public.duty_locations;
  v_assignment public.fixed_duty_assignments;
begin
  if p_day_order not between 1 and 5 then
    return jsonb_build_object('status', 'invalid_day');
  end if;

  select c.id into v_campus_id from public.campuses c where c.name = p_campus_name limit 1;
  select ay.id into v_year_id from public.academic_years ay
    where ay.campus_id = v_campus_id and ay.name = p_academic_year_name limit 1;
  select ti.id into v_import_id from public.timetable_imports ti
    where ti.academic_year_id = v_year_id and ti.status = 'imported'
    order by ti.imported_at desc, ti.created_at desc limit 1;
  if v_import_id is null then return jsonb_build_object('status', 'not_found'); end if;

  select * into v_teacher from public.teachers t
    where t.id = p_teacher_id and t.timetable_import_id = v_import_id;
  if not found then return jsonb_build_object('status', 'teacher_not_found'); end if;

  if not exists (
    select 1 from public.timetable_days d
    where d.timetable_import_id = v_import_id and d.day_order = p_day_order
  ) then return jsonb_build_object('status', 'invalid_day'); end if;

  select * into v_location from public.duty_locations dl
    where dl.id = p_duty_location_id and dl.campus_id = v_campus_id
      and dl.is_active and dl.deleted_at is null;
  if not found then return jsonb_build_object('status', 'location_not_found'); end if;

  -- YENİ İŞ KURALI: sabit nöbet yalnız ILKOKUL1 / ILKOKUL2 gibi
  -- allows_fixed_assignment = true olan yerlere verilebilir.
  if not v_location.allows_fixed_assignment then
    return jsonb_build_object('status', 'location_not_fixed_eligible');
  end if;

  perform pg_advisory_xact_lock(hashtext('fixed-duty:' || v_year_id::text || ':' || p_day_order::text));

  if exists (
    select 1 from public.fixed_duty_assignments a
    where a.academic_year_id = v_year_id and a.day_order = p_day_order
      and a.duty_location_id = p_duty_location_id
  ) then return jsonb_build_object('status', 'location_conflict'); end if;

  if exists (
    select 1 from public.fixed_duty_assignments a
    where a.academic_year_id = v_year_id and a.day_order = p_day_order
      and a.teacher_source_id = v_teacher.source_id
  ) then return jsonb_build_object('status', 'teacher_conflict'); end if;

  insert into public.fixed_duty_assignments (
    campus_id, academic_year_id, teacher_source_id, teacher_name_snapshot,
    duty_location_id, day_order
  ) values (
    v_campus_id, v_year_id, v_teacher.source_id, v_teacher.name,
    p_duty_location_id, p_day_order
  ) returning * into v_assignment;

  return jsonb_build_object('status', 'ok', 'id', v_assignment.id);
end;
$$;

comment on function public.create_fixed_duty_assignment(text, text, uuid, integer, uuid) is
  'Sabit nöbet atar. YALNIZ allows_fixed_assignment=true olan aktif nöbet yerlerine izin verir; aksi halde {status:"location_not_fixed_eligible"} döner (frontend filtresi aşılsa bile). Gün×yer ve gün×öğretmen benzersizlikleri pg_advisory_xact_lock ile korunur. Yalnız service_role çağırabilir.';

-- ============================================================================
-- Yetkilendirme
-- ============================================================================
-- create_duty_location / create_fixed_duty_assignment / get_fixed_duty_assignments
-- imzaları DEĞİŞMEDİĞİ için mevcut GRANT'ler korunur; yeniden tanımlanmaz.
-- Yeni tablolar (duty_blocks, duty_location_blocks) yalnız service_role
-- tarafından erişilebilir: RLS açık + policy yok (mevcut desen).

-- Bu migration hiçbir RLS policy eklemez ve hiçbir mevcut nöbet yeri, sabit
-- nöbet ataması veya öğretmen uygunluk satırını silmez/değiştirmez
-- (allows_fixed_assignment sütununun eklenmesi ve iki ilkokul koridoru için
-- true yapılması dışında).
