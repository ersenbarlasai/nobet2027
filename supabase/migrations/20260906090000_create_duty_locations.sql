-- ============================================================================
-- Nöbet2027 — Nöbet Yerleri (duty_locations)
-- ============================================================================
-- "Nöbet Yerleri" yönetim ekranı için kalıcı tablo. Öğretmenlerin nöbet
-- tutacağı fiziksel alanları (bahçe, giriş, kat, koridor, yemekhane, spor
-- alanı, diğer) tanımlar. Bu migration YALNIZCA şema kurar — gerçek okul
-- verisi/seed eklenmez (bkz. aşağıdaki "Seed edilmedi" notu).
--
-- Kategori kodları veritabanında kararlı İngilizce metinlerdir; Türkçe
-- karşılıkları YALNIZCA frontend'de gösterilir (garden→Bahçe, entrance→Giriş,
-- floor→Kat, corridor→Koridor, cafeteria→Yemekhane, sports_area→Spor Alanı,
-- other→Diğer).
-- ============================================================================

-- ============================================================================
-- 1. duty_locations
-- ============================================================================
create table public.duty_locations (
  id uuid primary key default gen_random_uuid(),
  -- ON DELETE CASCADE (BİLİNÇLİ): tek-kampüs mimarisinde bir campuses
  -- satırının silinmesi zaten tüm kampüse ait verinin sonu anlamına gelir
  -- (bkz. mevcut timetable_imports/academic_years aynı deseni kullanıyor).
  -- Pratikte bu uygulamada campuses satırları hiç silinmez (yalnızca ilk
  -- XML içe aktarımında find-or-create ile oluşturulur); CASCADE burada
  -- yetim (orphan) duty_locations satırı bırakmamak için bir güvenlik
  -- ağıdır, aktif bir silme akışı değildir.
  campus_id uuid not null references public.campuses (id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  short_code text not null
    check (btrim(short_code) <> '')
    -- Yalnız büyük ASCII harf + rakam gruplarının TEK tirelerle ayrılması;
    -- baş/son tire yok, ardışık çift tire yok (her tireden sonra en az bir
    -- alfanumerik zorunlu — bu yapı POSIX ERE'de lookahead olmadan aynı
    -- kısıtı sağlar). Toplam uzunluk 2–16 karakter (ör. "ON-BAH").
    check (short_code ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$')
    check (char_length(short_code) between 2 and 16),
  category text not null
    check (category in ('garden', 'entrance', 'floor', 'corridor', 'cafeteria', 'sports_area', 'other')),
  capacity integer not null default 1 check (capacity between 1 and 20),
  -- Boş string yerine NULL saklanır (uygulama katmanında normalize edilir);
  -- bu CHECK, boş-string'in yanlışlıkla DB'ye sızmasına karşı ikinci savunma
  -- katmanıdır.
  description text check (description is null or btrim(description) <> ''),
  is_active boolean not null default true,
  sort_order integer not null check (sort_order > 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  -- Soft-delete: gelecekte nöbet planları bu kayıtlara bağlandığında,
  -- geçmiş planlardaki referansların bozulmaması için satır fiziksel olarak
  -- SİLİNMEZ (bkz. server tarafındaki DELETE endpoint'i). deleted_at
  -- doluysa satır "arşivlenmiş" sayılır: normal listede, özetlerde ve
  -- filtrelerde görünmez, ama geçmiş kayıtlarla referans bütünlüğü korunur.
  deleted_at timestamptz
);

comment on table public.duty_locations is
  'Öğretmenlerin nöbet tutacağı fiziksel alan (bahçe/giriş/kat/koridor/yemekhane/spor alanı/diğer). Soft-delete kullanır (deleted_at) — bkz. tablo yorumundaki gerekçe.';
comment on column public.duty_locations.short_code is
  'Kararlı, büyük harf kısa kod (ör. "ON-BAH"). Kullanıcı girişi sunucuda uppercase''e normalize edilir; DB kısıtı yalnız normalize edilmiş biçimi kabul eder.';
comment on column public.duty_locations.deleted_at is
  'NULL değilse satır soft-delete edilmiştir: listede/özetlerde/filtrelerde görünmez ama geçmiş nöbet planı referansları için saklanır.';

-- ----------------------------------------------------------------------------
-- Benzersizlik: aynı kampüste, SİLİNMEMİŞ kayıtlar arasında short_code ve
-- name case-insensitive benzersiz olmalı. Partial index (WHERE deleted_at IS
-- NULL) sayesinde silinmiş bir kaydın adı/kodu yeniden kullanılabilir.
-- ----------------------------------------------------------------------------
create unique index duty_locations_campus_short_code_unique_idx
  on public.duty_locations (campus_id, upper(short_code))
  where deleted_at is null;

create unique index duty_locations_campus_name_unique_idx
  on public.duty_locations (campus_id, lower(btrim(name)))
  where deleted_at is null;

-- ----------------------------------------------------------------------------
-- İndeksler
-- ----------------------------------------------------------------------------
-- Aktif listeleme (varsayılan sort=order): silinmemiş kayıtları sort_order'a göre.
create index duty_locations_campus_sort_order_idx
  on public.duty_locations (campus_id, sort_order)
  where deleted_at is null;

-- is_active filtresi (status=active|inactive).
create index duty_locations_campus_active_idx
  on public.duty_locations (campus_id, is_active)
  where deleted_at is null;

-- category filtresi.
create index duty_locations_campus_category_idx
  on public.duty_locations (campus_id, category)
  where deleted_at is null;

create trigger set_updated_at
  before update on public.duty_locations
  for each row execute function public.set_updated_at();

-- ============================================================================
-- Row Level Security
-- ============================================================================
-- Mevcut projedeki desenle birebir aynı: RLS AÇIK, hiçbir policy YOK. Bu,
-- tablo sahibi dışındaki hiçbir rol (anon/authenticated dahil) için
-- varsayılan SELECT/INSERT/UPDATE/DELETE erişimini KAPATIR. Yalnızca yerel
-- backend'in sahip olduğu service_role anahtarı (RLS'yi bypass eder) bu
-- tabloya erişebilir. Kimlik doğrulama/üyelik modeli netleştiğinde policy'ler
-- ayrı bir migration ile eklenecek (bkz. supabase/README.md).
alter table public.duty_locations enable row level security;

-- Savunma derinliği: Supabase projelerinde "auto_expose_new_tables" kapalıyken
-- yeni tablolar zaten anon/authenticated'e otomatik açılmaz, ama bunu açıkça
-- ve idempotent biçimde garanti ediyoruz (yerel vanilla PostgreSQL'de
-- anon/authenticated rolleri hiç yoktur — bu yüzden DO $$ ... $$ ile varlık
-- kontrolü yapılır).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.duty_locations from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.duty_locations from authenticated;
  end if;
end
$$;

-- ============================================================================
-- 2. create_duty_location — RPC: eşzamanlı-güvenli sort_order üretimi
-- ============================================================================
-- Neden RPC: "sort_order = mevcut en yüksek + 1" hesaplaması ile INSERT
-- arasında bir düz REST isteğinde yarış durumu (race condition) vardır — iki
-- eşzamanlı POST isteği aynı sort_order'ı hesaplayıp yinelenen bir sıra
-- üretebilir. Bu fonksiyon, aynı kampüs için pg_advisory_xact_lock ile
-- transaction sonuna kadar süren bir kilit alarak hesaplama+INSERT'i atomik
-- hale getirir (aynı kampüste eşzamanlı iki create isteği serileşir; farklı
-- kampüsler birbirini bloklamaz).
--
-- SECURITY INVOKER (BİLİNÇLİ, DEFINER DEĞİL): yalnızca yerel backend'in
-- service_role anahtarıyla çağrılması amaçlanır; service_role zaten RLS'yi
-- bypass eder ve bu tabloda tam DML hakkına sahiptir. Ek yetki kazandırmaya
-- gerek yok (en az yetki ilkesi).
--
-- Dinamik SQL YOKTUR. search_path sabittir. Girdi doğrulaması tablo
-- CHECK/UNIQUE kısıtlarıyla desteklenir — bu fonksiyon onları TEKRARLAMAZ,
-- ihlal edilirse Postgres hatası olduğu gibi çağırana yükselir (server bunu
-- constraint/index adına göre VALIDATION_ERROR/DUPLICATE_* olarak eşler).
-- ============================================================================
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
  -- Aynı kampüs için transaction sonuna kadar süren advisory lock: bu
  -- kampüste eşzamanlı çağrılan create_duty_location'lar birbirini bekler,
  -- böylece "select max(sort_order)+1" + insert ikilisi atomik davranır.
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

  return v_row;
end;
$$;

comment on function public.create_duty_location(uuid, text, text, text, integer, text, boolean) is
  'Yerel backend tarafından (yalnız service_role) çağrılan, aynı kampüs için sort_order''ı advisory lock ile eşzamanlı-güvenli üreten ve yeni bir nöbet yeri ekleyen RPC. Tarayıcıdan asla doğrudan çağrılmamalıdır.';

revoke all on function public.create_duty_location(uuid, text, text, text, integer, text, boolean) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.create_duty_location(uuid, text, text, text, integer, text, boolean) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.create_duty_location(uuid, text, text, text, integer, text, boolean) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.create_duty_location(uuid, text, text, text, integer, text, boolean) to service_role;
  end if;
end
$$;

-- Bu migration hiçbir gerçek okul verisi barındırmaz — yalnızca şema
-- (tablo/kısıt/index/trigger/RLS/RPC) tanımlanır. Referans görseldeki
-- "Ön Bahçe / Arka Bahçe / Yemekhane" gibi örnek satırlar BİLEREK seed
-- edilmedi; ilk açılışta tablo boştur ve frontend gerçek boş durumu gösterir.
