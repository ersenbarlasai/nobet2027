-- ============================================================================
-- Nöbet2027 — Öğretmen Nöbet Uygunluk Matrisi
-- ============================================================================
-- "Öğretmen Ders Programı" ekranının altında gösterilecek "Nöbet Uygunluk
-- Matrisi" için kalıcı depolama. Bu migration YALNIZCA öğretmenin hangi
-- gün + nöbet yerinde görevlendirilebileceğine dair TERCİHİ saklar — gerçek
-- bir nöbet ataması OLUŞTURMAZ (atama/planlama ayrı bir aşamadır).
--
-- KALICI ÖĞRETMEN KİMLİĞİ — GEREKÇE
-- ----------------------------------------------------------------------------
-- Mevcut şemada (20260831192218_create_initial_timetable_schema.sql) her XML
-- importu kendi bağımsız `teachers` satır kümesini taşır (import-snapshot
-- yaklaşımı, bkz. supabase/README.md "Import-snapshot yaklaşımı"). Yani
-- `teachers.id` bir importa özeldir ve yeni bir XML yüklendiğinde eskisiyle
-- BİRLEŞTİRİLMEZ — aynı gerçek öğretmen için yeni bir `teachers.id` üretilir.
-- Bu nedenle nöbet uygunluk tercihini doğrudan `teachers.id`'ye bağlamak,
-- her yeni XML importunda tüm tercihlerin "kaybolması" (artık hiçbir
-- `teachers` satırına karşılık gelmemesi) anlamına gelir.
--
-- `teachers.source_id` ise aSc XML'deki `<teacher id="...">` kaynak
-- kimliğidir ve `teachers_import_source_uq unique (timetable_import_id,
-- source_id)` ile YALNIZ bir import içinde benzersizliği garanti edilir —
-- ama aynı okulun ardışık dönem/yıl XML dosyalarında aynı öğretmen için aSc
-- tarafında genellikle aynı source_id korunur (aSc, öğretmen kaydını okul
-- veritabanında tutar). Bu nedenle bu migration, tercihi
-- `(academic_year_id, teacher_source_id)` çiftine bağlar: aynı eğitim yılı
-- içinde art arda yapılan XML importlarında (ör. programda küçük bir
-- düzeltme sonrası yeniden yükleme) tercih KORUNUR, çünkü source_id importlar
-- arasında değişmez, yalnızca `teachers.id` (snapshot satırı) değişir.
--
-- Bu varsayımın sınırı açıkça bilinir ve README'de belgelenir: eğer okul,
-- BİR öğretmen için aSc tarafında source_id'yi değiştirirse (nadir — aSc
-- normalde kalıcı tutar), o öğretmenin tercihi yeni source_id ile "sıfırdan"
-- görünür; eski kayıt fiziksel olarak silinmez, yalnızca artık hiçbir mevcut
-- öğretmene eşlenmez (yetim/tarihsel kalır).
--
-- GÜN ANAHTARI — GEREKÇE
-- ----------------------------------------------------------------------------
-- `timetable_days.id` de aynı şekilde import-snapshot'tır ve
-- `timetable_days_import_order_uq unique (timetable_import_id, day_order)`
-- ile her import kendi Pazartesi–Cuma (1–5) sırasını taşır. Kaynak XML'de
-- her zaman tam 5 tek-bitli <daysdef> (Pazartesi..Cuma) bulunur (bkz.
-- src/lib/timetableXml/ascAdapter.ts normalizeDays: "days" bitmask'i 5
-- karakterdir, bitPosition 1..5 aralığında `day_order` üretir). Bu nedenle
-- tercih, `timetable_days.id`'ye DEĞİL, kararlı `day_order` (1–5, CHECK ile
-- zorunlu) tam sayısına bağlanır — yeni bir import'ta `timetable_days`
-- satırları değişse bile day_order anlamı (1=Pazartesi..5=Cuma) sabittir.
-- Arayüz, gün ADLARINI yine de en güncel importun `timetable_days`
-- tablosundan çeker (uydurma Türkçe metin YOK) — yalnızca depolama anahtarı
-- olarak day_order kullanılır.
--
-- KAMPÜS SINIRI — GEREKÇE
-- ----------------------------------------------------------------------------
-- Bir nöbet yerinin yanlışlıkla başka bir kampüsün eğitim yılına
-- bağlanmasını veritabanı seviyesinde engellemek için, mevcut şemada zaten
-- kullanılan "composite FK" desenini (bkz. timetable_imports_year_campus_fk,
-- teachers_id_import_uq vb.) aynen izliyoruz: hem `teacher_duty_settings`
-- hem `teacher_duty_availabilities` satırlarına DENORMALİZE bir `campus_id`
-- eklenir ve composite FK'ler bu sütunun, ilişkili `academic_years`/
-- `duty_locations` satırının GERÇEK campus_id'siyle aynı olmasını zorunlu
-- kılar. `duty_locations` tablosunda bu composite FK'nin hedefi olabilecek
-- bir `(id, campus_id)` UNIQUE kısıtı henüz yoktu; bu migration onu EKLER
-- (mevcut migration dosyaları DEĞİŞTİRİLMEDİ — bu yeni bir ALTER TABLE'dır).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. duty_locations üzerinde composite FK hedefi için gereken UNIQUE kısıt
-- ----------------------------------------------------------------------------
-- id zaten PRIMARY KEY (tek başına benzersiz), ama PostgreSQL composite FK
-- hedefi için TAM OLARAK referans alınan sütun çiftinde bir UNIQUE/PK kısıtı
-- ister. Bu, mevcut satırları hiçbir şekilde etkilemeyen katkısal bir kısıttır.
alter table public.duty_locations
  add constraint duty_locations_id_campus_uq unique (id, campus_id);

-- ============================================================================
-- 1. teacher_duty_settings — öğretmen başına nöbet planına dahil olma durumu
-- ============================================================================
create table public.teacher_duty_settings (
  id uuid primary key default gen_random_uuid(),
  -- Denormalize: academic_years.campus_id ile composite FK üzerinden
  -- tutarlılığı zorunlu kılınır (bkz. yukarıdaki "KAMPÜS SINIRI" notu).
  campus_id uuid not null,
  academic_year_id uuid not null,
  teacher_source_id text not null check (btrim(teacher_source_id) <> ''),
  -- Yalnız izlenebilirlik/denetim amaçlı — okuma RPC'si asla bu alanı
  -- görüntülemez; güncel öğretmen adı her zaman MEVCUT importtaki
  -- `teachers.name`'den canlı okunur (bkz. get_teacher_duty_matrix).
  teacher_name_snapshot text,
  is_included boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint teacher_duty_settings_year_campus_fk
    foreign key (academic_year_id, campus_id)
    references public.academic_years (id, campus_id)
    on delete cascade,
  -- teacher_duty_availabilities'in composite FK hedefi.
  constraint teacher_duty_settings_id_campus_uq unique (id, campus_id),
  constraint teacher_duty_settings_year_source_uq unique (academic_year_id, teacher_source_id)
);

comment on table public.teacher_duty_settings is
  'Bir öğretmenin (eğitim yılı kapsamında kalıcı source_id ile) nöbet planına dahil olma durumu. Eğitim yılı silinirse CASCADE ile temizlenir.';
comment on column public.teacher_duty_settings.teacher_source_id is
  'aSc XML <teacher id="..."> kaynak kimliği — academic_year_id kapsamında kalıcı öğretmen anahtarı (bkz. migration dosyası başlığındaki gerekçe). teachers.id (import-snapshot) DEĞİLDİR.';
comment on column public.teacher_duty_settings.is_included is
  'false olduğunda öğretmen otomatik nöbet planlamasına dahil edilmez; mevcut hücre seçimleri SİLİNMEZ (bkz. save_teacher_duty_matrix).';

create index teacher_duty_settings_academic_year_id_idx on public.teacher_duty_settings (academic_year_id);
create index teacher_duty_settings_campus_id_idx on public.teacher_duty_settings (campus_id);

create trigger set_updated_at
  before update on public.teacher_duty_settings
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 2. teacher_duty_availabilities — seçili (gün, nöbet yeri) hücreleri
-- ============================================================================
create table public.teacher_duty_availabilities (
  id uuid primary key default gen_random_uuid(),
  -- Denormalize: duty_locations.campus_id ile composite FK üzerinden
  -- tutarlılığı zorunlu kılınır — farklı kampüse ait bir nöbet yeri asla
  -- bağlanamaz (bkz. yukarıdaki "KAMPÜS SINIRI" notu).
  campus_id uuid not null,
  teacher_duty_setting_id uuid not null,
  duty_location_id uuid not null,
  -- 1=Pazartesi .. 5=Cuma (bkz. migration başlığındaki "GÜN ANAHTARI" notu).
  -- timetable_days.id'ye KASITLI OLARAK bağlanmaz.
  day_order smallint not null check (day_order between 1 and 5),
  created_at timestamptz not null default timezone('utc', now()),
  constraint teacher_duty_availabilities_setting_campus_fk
    foreign key (teacher_duty_setting_id, campus_id)
    references public.teacher_duty_settings (id, campus_id)
    on delete cascade,
  -- duty_locations FİZİKSEL olarak neredeyse hiç silinmez (uygulama yalnız
  -- soft-delete yapar — bkz. server/services/dutyLocations.ts
  -- softDeleteDutyLocation). Bu CASCADE, mevcut duty_locations.campus_id
  -- FK'sindeki "yetim satır bırakmama güvenlik ağı" gerekçesiyle aynıdır —
  -- aktif bir silme akışı değil, savunma amaçlıdır. Soft-delete/pasif bir
  -- nöbet yerinin GEÇMİŞ tercihi bu satırda FİZİKSEL olarak KORUNUR — yalnız
  -- okuma RPC'si o yeri artık göstermez (bkz. get_teacher_duty_matrix); yer
  -- yeniden aktif edilirse ilişki zaten bozulmadığından seçim otomatik
  -- olarak yeniden görünür (kullanıcının tercih ettiği davranış).
  constraint teacher_duty_availabilities_location_campus_fk
    foreign key (duty_location_id, campus_id)
    references public.duty_locations (id, campus_id)
    on delete cascade,
  constraint teacher_duty_availabilities_unique_cell
    unique (teacher_duty_setting_id, duty_location_id, day_order)
);

comment on table public.teacher_duty_availabilities is
  'Bir öğretmenin seçili (gün, nöbet yeri) uygunluk hücreleri. Gerçek nöbet ataması DEĞİLDİR — yalnız otomatik planlama için tercih. Soft-delete/pasif nöbet yerine ait geçmiş satır fiziksel olarak korunur, yalnız okuma RPC''sinde gizlenir.';

create index teacher_duty_availabilities_setting_id_idx on public.teacher_duty_availabilities (teacher_duty_setting_id);
create index teacher_duty_availabilities_duty_location_id_idx on public.teacher_duty_availabilities (duty_location_id);
create index teacher_duty_availabilities_campus_id_idx on public.teacher_duty_availabilities (campus_id);

-- ============================================================================
-- Row Level Security — mevcut projedeki desenle birebir aynı
-- ============================================================================
-- RLS AÇIK, hiçbir policy YOK. Yalnızca service_role (RLS'yi bypass eder) bu
-- tablolara erişebilir. Kimlik doğrulama/üyelik modeli netleştiğinde
-- policy'ler ayrı bir migration ile eklenecek.
alter table public.teacher_duty_settings enable row level security;
alter table public.teacher_duty_availabilities enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.teacher_duty_settings from anon;
    revoke all on public.teacher_duty_availabilities from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.teacher_duty_settings from authenticated;
    revoke all on public.teacher_duty_availabilities from authenticated;
  end if;
end
$$;

-- ============================================================================
-- 3. get_teacher_duty_matrix — salt okunur, tek tutarlı snapshot
-- ============================================================================
-- STABLE, SECURITY INVOKER, sabit search_path, dinamik SQL yok. Yalnızca
-- service_role çağırabilir (bkz. dosya sonundaki GRANT/REVOKE bloğu).
-- Mevcut get_teacher_timetable_snapshot ile AYNI "kontrollü not-found"
-- deseni: hata fırlatmaz, hasImport/teacherFound alanlarıyla durumu bildirir.
create or replace function public.get_teacher_duty_matrix(
  p_campus_name text,
  p_academic_year_name text,
  p_teacher_id uuid
)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_import record;
  v_teacher record;
  v_setting record;
  v_days jsonb;
  v_locations jsonb;
  v_cells jsonb;
begin
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;
  if p_teacher_id is null then
    raise exception 'teacher_id zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then
    return jsonb_build_object('hasImport', false, 'teacherFound', false);
  end if;

  select id into v_year_id
    from public.academic_years
    where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then
    return jsonb_build_object('hasImport', false, 'teacherFound', false);
  end if;

  select * into v_import
    from public.timetable_imports
    where campus_id = v_campus_id
      and academic_year_id = v_year_id
      and status = 'imported'
    order by imported_at desc nulls last, created_at desc
    limit 1;
  if not found then
    return jsonb_build_object('hasImport', false, 'teacherFound', false);
  end if;

  -- Öğretmen MEVCUT (en güncel) importa ait değilse (stale/bilinmeyen uuid),
  -- kasıtlı olarak veri döndürülmez — bkz. get_teacher_timetable_snapshot
  -- ile aynı desen.
  select id, source_id, name into v_teacher
    from public.teachers
    where id = p_teacher_id and timetable_import_id = v_import.id;
  if not found then
    return jsonb_build_object('hasImport', true, 'teacherFound', false, 'importedAt', v_import.imported_at);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('order', d.day_order, 'name', d.name) order by d.day_order), '[]'::jsonb)
    into v_days
    from public.timetable_days d
    where d.timetable_import_id = v_import.id
      and d.day_order between 1 and 5;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', dl.id, 'name', dl.name, 'shortCode', dl.short_code,
      'category', dl.category, 'capacity', dl.capacity, 'sortOrder', dl.sort_order
      ) order by dl.sort_order, dl.name), '[]'::jsonb)
    into v_locations
    from public.duty_locations dl
    where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null;

  -- Ayar (teacher_duty_settings) satırı olabilir/olmayabilir — olmaması hata
  -- değildir, varsayılan isIncluded=true ve boş seçim kümesi anlamına gelir.
  select id, is_included, updated_at into v_setting
    from public.teacher_duty_settings
    where academic_year_id = v_year_id and teacher_source_id = v_teacher.source_id;

  if v_setting.id is null then
    v_cells := '[]'::jsonb;
  else
    -- Yalnız hâlâ aktif + silinmemiş nöbet yerlerine ait hücreler döner;
    -- pasif/soft-delete yerin geçmiş seçimi fiziksel olarak KORUNUR ama
    -- burada gizlenir (bkz. tablo yorumu).
    select coalesce(jsonb_agg(jsonb_build_object('dutyLocationId', a.duty_location_id, 'dayOrder', a.day_order)), '[]'::jsonb)
      into v_cells
      from public.teacher_duty_availabilities a
      join public.duty_locations dl on dl.id = a.duty_location_id
      where a.teacher_duty_setting_id = v_setting.id
        and dl.is_active and dl.deleted_at is null;
  end if;

  return jsonb_build_object(
    'hasImport', true,
    'teacherFound', true,
    'teacher', jsonb_build_object('id', v_teacher.id, 'sourceId', v_teacher.source_id, 'name', v_teacher.name),
    'isIncluded', coalesce(v_setting.is_included, true),
    'days', v_days,
    'dutyLocations', v_locations,
    'selectedCells', v_cells,
    'updatedAt', v_setting.updated_at
  );
end;
$$;

comment on function public.get_teacher_duty_matrix(text, text, uuid) is
  'Salt okunur: verilen teacher_id MEVCUT importa aitse, nöbet uygunluk matrisinin tek tutarlı snapshot''ını döner (günler, aktif nöbet yerleri, seçili hücreler, isIncluded, updatedAt). Ayar yoksa hata saymaz. Yalnız service_role çağırabilir.';

-- ============================================================================
-- 4. save_teacher_duty_matrix — atomik upsert + tam değiştirme (replace)
-- ============================================================================
-- VOLATILE (satır kilidi için SELECT ... FOR UPDATE kullanır), SECURITY
-- INVOKER, sabit search_path, dinamik SQL yok. Girdi kısıtlarla (day_order,
-- duty_location kampüs/aktiflik) DOĞRULANIR — DB constraint'lerini
-- TEKRARLAMAZ ama iş kuralı ihlallerini raw Postgres hatası olarak değil,
-- kontrollü {status:"invalid_cells"|"not_found"|"conflict"} jsonb ile
-- bildirir (bkz. dosya başlığındaki "KAYDETME RPC'Sİ" notu ve
-- server/services/teacherDutyAvailability.ts'deki eşleme). Fonksiyon çağrısı
-- kendi başına tek bir atomik birimdir: herhangi bir noktada exception
-- fırlatılırsa (ör. beklenmeyen DB hatası) o ana kadarki TÜM değişiklikler
-- otomatik geri alınır — kısmi durum kalmaz.
create or replace function public.save_teacher_duty_matrix(
  p_campus_name text,
  p_academic_year_name text,
  p_teacher_id uuid,
  p_is_included boolean,
  p_cells jsonb,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
volatile
set search_path = pg_catalog, public
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_import record;
  v_teacher record;
  v_cells jsonb := coalesce(p_cells, '[]'::jsonb);
  v_invalid_day boolean;
  v_invalid_location boolean;
  v_setting_id uuid;
  v_current_updated_at timestamptz;
  v_found boolean;
  v_final_updated_at timestamptz;
begin
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;
  if p_teacher_id is null then
    raise exception 'teacher_id zorunludur.' using errcode = '22023';
  end if;
  if p_is_included is null then
    raise exception 'is_included zorunludur.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_cells) <> 'array' then
    raise exception 'cells bir jsonb dizisi olmalıdır.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select id into v_year_id
    from public.academic_years
    where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select * into v_import
    from public.timetable_imports
    where campus_id = v_campus_id
      and academic_year_id = v_year_id
      and status = 'imported'
    order by imported_at desc nulls last, created_at desc
    limit 1;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select id, source_id, name into v_teacher
    from public.teachers
    where id = p_teacher_id and timetable_import_id = v_import.id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- day_order aralığı: DB CHECK'i tekrarlamak yerine, hatayı kontrollü
  -- biçimde önceden yakalıyoruz.
  select exists (
    select 1 from jsonb_to_recordset(v_cells) as x(duty_location_id uuid, day_order int)
    where x.day_order is null or x.day_order < 1 or x.day_order > 5
  ) into v_invalid_day;
  if v_invalid_day then
    return jsonb_build_object('status', 'invalid_cells', 'reason', 'day_order_out_of_range');
  end if;

  -- Gönderilen nöbet yerleri: aynı kampüse ait, aktif ve silinmemiş olmalı.
  select exists (
    select 1 from jsonb_to_recordset(v_cells) as x(duty_location_id uuid, day_order int)
    where x.duty_location_id is null or x.duty_location_id not in (
      select id from public.duty_locations
      where campus_id = v_campus_id and is_active and deleted_at is null
    )
  ) into v_invalid_location;
  if v_invalid_location then
    return jsonb_build_object('status', 'invalid_cells', 'reason', 'duty_location_not_available');
  end if;

  -- Mevcut ayar satırını kilitle (varsa) — eşzamanlı iki kaydetme isteğini
  -- serileştirir; ikinci istek birincinin COMMIT'ini bekler, ardından
  -- expectedUpdatedAt karşılaştırmasını GÜNCEL değerle yapar.
  select id, updated_at into v_setting_id, v_current_updated_at
    from public.teacher_duty_settings
    where academic_year_id = v_year_id and teacher_source_id = v_teacher.source_id
    for update;
  v_found := found;

  if v_found then
    -- BULGU B DÜZELTMESİ: expected_updated_at NULL olsa BİLE, satır zaten
    -- VARSA bu bir çatışmadır — istemci "ilk kayıt" sanıyordu (kendi local
    -- state'inde updatedAt yoktu) ama başka bir istek arada satırı zaten
    -- oluşturmuş/güncellemiş. Bu kontrol olmadan (eski davranış) iki
    -- eşzamanlı ilk-kayıt isteği ikisi de "ok" alıp sessizce last-write-wins
    -- üretiyordu — yerel olarak iki gerçek eşzamanlı bağlantıyla doğrulandı.
    if v_current_updated_at is distinct from p_expected_updated_at then
      return jsonb_build_object('status', 'conflict', 'currentUpdatedAt', v_current_updated_at);
    end if;
    update public.teacher_duty_settings
      set is_included = p_is_included, teacher_name_snapshot = v_teacher.name
      where id = v_setting_id;
  else
    if p_expected_updated_at is not null then
      -- İstemci bir kaydın var olduğunu varsayıyordu ama yok — güvensiz
      -- varsayımla sessizce oluşturmak yerine çatışma olarak bildir.
      return jsonb_build_object('status', 'conflict', 'currentUpdatedAt', null);
    end if;
    begin
      insert into public.teacher_duty_settings (campus_id, academic_year_id, teacher_source_id, teacher_name_snapshot, is_included)
        values (v_campus_id, v_year_id, v_teacher.source_id, v_teacher.name, p_is_included)
        returning id into v_setting_id;
    exception when unique_violation then
      -- Eşzamanlı ilk-kayıt yarışı: başka bir istek araya girdi.
      return jsonb_build_object('status', 'conflict', 'currentUpdatedAt', null);
    end;
  end if;

  -- BULGU A DÜZELTMESİ: replace artık YALNIZ o an aynı kampüste aktif VE
  -- silinmemiş nöbet yerlerine ait satırları hedefler. Pasif/soft-delete bir
  -- yere ait geçmiş satır bu DELETE'in kapsamı DIŞINDA kalır — istemci onu
  -- göremediği/gönderemediği için (bkz. get_teacher_duty_matrix filtre)
  -- "ilgisiz" bir kaydetme artık o satırı silmez. isIncluded=false olsa BİLE
  -- bu adım aynı şekilde çalışır (görünür + gizli seçimler aynı kurala tabi).
  delete from public.teacher_duty_availabilities a
    using public.duty_locations dl
    where a.teacher_duty_setting_id = v_setting_id
      and a.duty_location_id = dl.id
      and dl.campus_id = v_campus_id
      and dl.is_active
      and dl.deleted_at is null;

  -- Gönderilen tam liste (yalnız aktif+silinmemiş yerler — yukarıda zaten
  -- doğrulandı) o hücreler için yeniden yazılır. Pasif/silinmiş yerlere ait
  -- satırlar yukarıdaki DELETE'e hiç girmediği için burada da dokunulmamış
  -- olarak kalır.
  insert into public.teacher_duty_availabilities (campus_id, teacher_duty_setting_id, duty_location_id, day_order)
    select distinct v_campus_id, v_setting_id, x.duty_location_id, x.day_order::smallint
    from jsonb_to_recordset(v_cells) as x(duty_location_id uuid, day_order int);

  select updated_at into v_final_updated_at from public.teacher_duty_settings where id = v_setting_id;

  return jsonb_build_object('status', 'ok', 'updatedAt', v_final_updated_at);
end;
$$;

comment on function public.save_teacher_duty_matrix(text, text, uuid, boolean, jsonb, timestamptz) is
  'Nöbet uygunluk matrisini tek transaction içinde atomik olarak upsert+replace eder. Optimistic concurrency: expected_updated_at uyuşmazsa {status:"conflict"} döner. Girdi iş-kuralı ihlalleri {status:"invalid_cells"} olarak, bilinmeyen/stale öğretmen veya import {status:"not_found"} olarak döner — raw Postgres hatası sızdırmaz. Yalnız service_role çağırabilir.';

-- ============================================================================
-- Yetkilendirme — yalnız service_role
-- ============================================================================
revoke all on function public.get_teacher_duty_matrix(text, text, uuid) from public;
revoke all on function public.save_teacher_duty_matrix(text, text, uuid, boolean, jsonb, timestamptz) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.get_teacher_duty_matrix(text, text, uuid) from anon;
    revoke all on function public.save_teacher_duty_matrix(text, text, uuid, boolean, jsonb, timestamptz) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.get_teacher_duty_matrix(text, text, uuid) from authenticated;
    revoke all on function public.save_teacher_duty_matrix(text, text, uuid, boolean, jsonb, timestamptz) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.get_teacher_duty_matrix(text, text, uuid) to service_role;
    grant execute on function public.save_teacher_duty_matrix(text, text, uuid, boolean, jsonb, timestamptz) to service_role;
  end if;
end
$$;

-- Bu migration hiçbir RLS policy eklemez, gerçek/seed veri barındırmaz ve
-- mevcut policy'siz durumu değiştirmez.

-- ============================================================================
-- Yerel doğrulama — save_teacher_duty_matrix (2 düzeltme turu)
-- ============================================================================
-- Bu fonksiyon uzak Supabase'e hiç uygulanmadan, yerel PostgreSQL 17'de
-- geçici bir veritabanında (nobet2027_migration_check) iki tur halinde
-- fonksiyonel olarak test edildi; her iki turda da tespit edilen sorunlar bu
-- migration dosyası UZAK'A UYGULANMADAN, aynı dosya içinde düzeltildi (ayrı
-- bir "fix" migration'ı OLUŞTURULMADI). Test veritabanı her turun sonunda
-- silindi.
--
-- 1. TUR — 2 gerçek hata tespit edildi:
--   a) Replace işlemi (eski hali), pasif/soft-delete bir nöbet yerine ait
--      GEÇMİŞ seçimi bir SONRAKİ (ilgisiz) kaydetmede FİZİKSEL olarak
--      SİLİYORDU — çünkü DELETE, duty_location'ın aktiflik durumuna
--      bakmadan setting'in TÜM satırlarını siliyor, istemci de görmediği
--      (pasif) yeri asla yeniden göndermiyordu. Ampirik olarak: aktif 2 yer
--      üzerinde seçim yapıldı → biri soft-delete edildi → istemci yalnız
--      gördüğü (görünür) yeri içeren bir kaydetme daha yaptı → soft-delete
--      edilen yerin satırı 0'a düştü → yeniden aktif edilince seçim geri
--      GELMEDİ.
--   b) `expected_updated_at = null` ile YAPILAN eşzamanlı "ilk kayıt"
--      isteklerinde, satır zaten VARSA (ikinci istek satırı SELECT ... FOR
--      UPDATE ile bulduğunda) çakışma hiç kontrol edilmiyordu — iki gerçek
--      eşzamanlı bağlantıyla doğrulandı: HER İKİ istek de {status:"ok"}
--      döndü, ikincinin verisi birincininkini SESSİZCE ezdi (last-write-wins).
--
-- DÜZELTME (bu dosyanın kendi içinde, satır ~410-459):
--   a) DELETE artık yalnız o an aynı kampüste `is_active` VE `deleted_at is
--      null` olan nöbet yerlerine ait satırları hedefler (`using
--      public.duty_locations dl ... and dl.is_active and dl.deleted_at is
--      null`). Pasif/silinmiş yere ait satır bu DELETE'e hiç girmez.
--   b) `if v_found then` dalındaki koşul `p_expected_updated_at is not
--      null and ...` iken → `v_current_updated_at is distinct from
--      p_expected_updated_at` oldu (NULL kontrolü kaldırıldı) — satır VARSA
--      ve istemci `null` gönderdiyse (mevcut `v_current_updated_at` de NULL
--      olmadıkça) artık HER ZAMAN çakışma sayılır.
--
-- 2. TUR — düzeltme sonrası yeniden doğrulama (hepsi geçti):
--   1. Aktif hücre replace: eski değer silinir, yeni değer yazılır (normal
--      davranış korunuyor).
--   2. Pasif (yalnız is_active=false) yerin seçimi, ilgisiz bir kaydetmede
--      artık SİLİNMİYOR.
--   3. Soft-delete (deleted_at doldurulmuş) yerin seçimi de aynı şekilde
--      korunuyor.
--   4. Yeniden aktif edilince (is_active=true, deleted_at=null) önceki
--      seçim `get_teacher_duty_matrix`'in `selectedCells`'inde tekrar
--      görünüyor.
--   5. `isIncluded=false` ile kaydetmede hem görünür hem gizli (pasif) seçim
--      birlikte korunuyor; `is_included` doğru biçimde false yazılıyor.
--   6. İlk kayıt için gerçek eşzamanlı 2 bağlantı (`expected_updated_at =
--      null`, aynı academic_year_id+teacher_source_id) 5 kez tekrarlandı:
--      HER SEFERİNDE tam olarak biri {status:"ok"}, diğeri
--      {status:"conflict"} döndü — hiçbir turda ikisi de "ok" olmadı.
--   7. Mevcut kayıt + doğru `expected_updated_at` → ok; hemen ardından aynı
--      kayda eski/yanlış `expected_updated_at` → conflict, satır DEĞİŞMEDEN
--      kaldı.
--   8. Transaction bütünlüğü: farklı kampüs yeri veya `day_order` aralık
--      dışı içeren bir payload gönderildiğinde {status:"invalid_cells"}
--      döner ve satır ÖNCEKİ haliyle (kısmi yazma YOK) kalır — validasyon
--      kilit/DELETE/INSERT adımlarından ÖNCE çalıştığı için doğal olarak
--      atomik.
--   9. Duplicate hücre normalize (DISTINCT), stale/bilinmeyen teacher →
--      not_found, academic_year silinince CASCADE, RLS policy'siz
--      varsayılan-red — bu davranışlar fonksiyonun düzeltmeden etkilenmeyen
--      kısımlarında olduğundan yeniden doğrulandı, hepsi hâlâ doğru.
--
-- Kalıcı iz bırakılmadı; uzak Supabase'e bu doğrulamalar sırasında hiçbir
-- REST/RPC çağrısı yapılmadı.
