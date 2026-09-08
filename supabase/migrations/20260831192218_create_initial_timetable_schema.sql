-- ============================================================================
-- Nöbet2027 — Başlangıç ders programı (timetable) şeması
-- ============================================================================
-- Bu migration, mevcut src/lib/timetableXml/* ayrıştırıcısının çıkardığı
-- aSc Timetables XML verisini ileride kayıpsız biçimde saklayabilecek bir
-- PostgreSQL şeması kurar. Bu aşamada YALNIZCA şema oluşturulur:
--   - Frontend bu tablolara henüz bağlı değil.
--   - Gerçek veri/seed eklenmez.
--   - RLS açıktır ancak policy tanımlanmaz (bkz. aşağıdaki RLS bölümü).
--
-- Kaynak XML gerçekleri (bkz. src/lib/timetableXml/ascAdapter.ts):
--   - Kök eleman <timetable>.
--   - Öğretmen kaynağı <teacher id name .../>.
--   - Sınıf kaynağı <class id name grade .../>.
--   - Gün kaynağı tek-bitli <daysdef id name days="10000".../>; çok-bitli
--     tanımlar ("Herhangi Bir Gün", "Her Gün") gerçek gün değildir.
--   - Ders saati kaynağı <period period name starttime endtime .../>.
--   - Ders tanımı <lesson id subjectid classids teacherids .../>; classids
--     ve teacherids virgülle ayrılmış birden çok değer içerebilir.
--   - Yerleşim <card lessonid period days .../>; card'ın XML'de kendi id'si
--     yoktur — ayrıştırıcı "card-{sıraNo}" sentetik kaynak anahtarı üretir.
--   - Ham <card> sayısı ile normalize öğretmen×sınıf atama satırı sayısı
--     AYNI ŞEY DEĞİLDİR (bkz. timetable_cards vs. timetable_assignments).
--   - teacherIds×classIds her ikisi de >1 olduğunda (ör. kulüp/ortak
--     etkinlik saatleri) kartezyen çarpım varsayımı XML'den kesin
--     doğrulanamaz (bkz. timetable_assignments.mapping_status).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Uzantılar
-- ----------------------------------------------------------------------------
-- gen_random_uuid() PostgreSQL 16+ çekirdekte yerleşiktir; Supabase'in
-- hedefleyebileceği daha eski sürümlerle uyumluluk için pgcrypto'yu Supabase
-- kuralına uygun biçimde "extensions" şemasında, koşullu olarak etkinleştiriyoruz.
-- Barındırılan bir Supabase projesinde "extensions" şeması zaten mevcuttur;
-- "if not exists" burada yalnızca salt-yerel/vanilla PostgreSQL ile
-- doğrulamayı mümkün kılmak için idempotent bir güvenlik önlemidir.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ----------------------------------------------------------------------------
-- Ortak trigger: updated_at sütununu her UPDATE'te UTC "now()" ile günceller.
-- search_path bilinçli olarak sabitlendi (yalnız pg_catalog + public) —
-- fonksiyonun, çağıran oturumun değiştirilebilir search_path'ine güvenerek
-- yanlış bir "now()"/şema nesnesine yönlenmesini engeller.
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'updated_at sütununu UTC şimdiki zamana ayarlayan ortak BEFORE UPDATE trigger fonksiyonu.';

-- ============================================================================
-- 1. campuses — kampüs (okul/şube)
-- ============================================================================
create table public.campuses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  code text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

comment on table public.campuses is 'Nöbet planlamasının yapıldığı kampüs/şube.';

-- code doluysa global olarak benzersiz olmalı; NULL değerler PostgreSQL'de
-- UNIQUE kısıtında birbirine eşit sayılmadığı için normal bir UNIQUE
-- kısıt, birden çok NULL'a izin verir. Burada niyeti açık kılmak için
-- kısmi (partial) unique index kullanıyoruz: yalnız code IS NOT NULL olan
-- satırlar arasında benzersizlik garanti edilir.
create unique index campuses_code_unique_idx
  on public.campuses (code)
  where code is not null;

create trigger set_updated_at
  before update on public.campuses
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 2. academic_years — eğitim yılı (kampüse bağlı)
-- ============================================================================
create table public.academic_years (
  id uuid primary key default gen_random_uuid(),
  campus_id uuid not null references public.campuses (id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  starts_on date,
  ends_on date,
  is_active boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint academic_years_date_range_chk
    check (starts_on is null or ends_on is null or ends_on >= starts_on),
  -- Aşağıdaki composite FK'ların hedefi olabilmesi için (id, campus_id)
  -- üzerinde ek bir UNIQUE kısıt gerekir (id zaten PK ile benzersiz).
  constraint academic_years_id_campus_uq unique (id, campus_id)
);

comment on table public.academic_years is
  'Bir kampüse ait eğitim yılı (ör. "2026-2027"). Aynı kampüste ada göre benzersizdir.';

create unique index academic_years_campus_name_unique_idx
  on public.academic_years (campus_id, name);

-- Bir kampüste aynı anda yalnız bir "aktif" eğitim yılı olabilir.
create unique index academic_years_one_active_per_campus_idx
  on public.academic_years (campus_id)
  where is_active;

create index academic_years_campus_id_idx on public.academic_years (campus_id);

create trigger set_updated_at
  before update on public.academic_years
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 3. timetable_imports — her XML yükleme/sürüm girişimi
-- ============================================================================
create table public.timetable_imports (
  id uuid primary key default gen_random_uuid(),
  campus_id uuid not null references public.campuses (id) on delete cascade,
  academic_year_id uuid not null,
  source_format text not null check (btrim(source_format) <> ''),
  source_filename text,
  source_encoding text,
  source_sha256 text check (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'),
  source_card_count integer not null default 0 check (source_card_count >= 0),
  normalized_assignment_count integer not null default 0 check (normalized_assignment_count >= 0),
  status text not null default 'pending'
    check (status in ('pending', 'validated', 'imported', 'failed', 'superseded')),
  imported_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  -- academic_year_id'nin, aynı satırdaki campus_id ile aynı kampüse ait
  -- olduğunu veritabanı seviyesinde garanti eder (bir yılın başka bir
  -- kampüsün import'una yanlışlıkla bağlanmasını engeller).
  constraint timetable_imports_year_campus_fk
    foreign key (academic_year_id, campus_id)
    references public.academic_years (id, campus_id)
    on delete cascade,
  -- Aşağıdaki tüm çocuk tablolardaki composite FK'ların hedefi.
  constraint timetable_imports_id_campus_year_uq unique (id, campus_id, academic_year_id)
);

comment on table public.timetable_imports is
  'Tek bir XML içe aktarma denemesi/sürümü. Ham XML içeriği burada SAKLANMAZ; yalnız meta veriler ve sayımlar tutulur.';
comment on column public.timetable_imports.source_sha256 is
  'Yüklenen XML dosyasının SHA-256 özeti (istemcide hesaplanabilir); aynı yıl içinde yanlışlıkla tekrar içe aktarımı engellemek için kullanılır. NULL olabilir.';
comment on column public.timetable_imports.status is
  'pending: yüklendi, henüz doğrulanmadı. validated: doğrulama tamamlandı (kritik hata yok). imported: kullanıcı onayladı/işlendi. failed: kritik hata var. superseded: yerine yeni bir import geldi.';

-- Aynı eğitim yılı içinde aynı SHA-256'nın tekrar içe aktarılmasını engeller.
-- source_sha256 NULL olduğunda partial index bu satırları hiç kapsamadığından
-- sorun çıkarmaz (istenen davranış).
create unique index timetable_imports_year_sha256_unique_idx
  on public.timetable_imports (academic_year_id, source_sha256)
  where source_sha256 is not null;

create index timetable_imports_campus_id_idx on public.timetable_imports (campus_id);
create index timetable_imports_academic_year_id_idx on public.timetable_imports (academic_year_id);
create index timetable_imports_status_idx on public.timetable_imports (status);
create index timetable_imports_imported_at_idx on public.timetable_imports (imported_at);

create trigger set_updated_at
  before update on public.timetable_imports
  for each row execute function public.set_updated_at();

-- ============================================================================
-- Import-snapshot yaklaşımı
-- ============================================================================
-- Aşağıdaki tüm tablolar (teachers, school_classes, timetable_days,
-- lesson_periods, subjects, lessons, timetable_cards, timetable_assignments)
-- BİR importa ait anlık görüntüdür. Farklı importlardaki aynı source_id
-- değerleri (ör. iki ayrı XML yüklemesindeki "teacher id=T1") kasıtlı olarak
-- BİRLEŞTİRİLMEZ/genel bir öğretmen kaydına eşlenmez — her import kendi
-- bağımsız kayıt kümesini taşır. Bu, XML'in gerçek kaynağıyla bire bir
-- izlenebilirliği korur ve importlar arası tutarsız/erken normalize
-- işleminden kaynaklanacak veri bozulmasını önler.
--
-- Her çocuk tablo hem "id" hem "timetable_import_id" üzerinde bir UNIQUE
-- kısıt taşır (constraint adı: *_id_import_uq). Bu, aşağıdaki join
-- tablolarının composite foreign key kullanarak "iki taraf da aynı importa
-- ait olmalı" kuralını yalnızca uygulama koduna değil, veritabanına
-- yaptırmasını sağlar.
-- ============================================================================

-- ============================================================================
-- 4. teachers
-- ============================================================================
create table public.teachers (
  id uuid primary key default gen_random_uuid(),
  timetable_import_id uuid not null references public.timetable_imports (id) on delete cascade,
  source_id text not null check (btrim(source_id) <> ''),
  name text not null check (btrim(name) <> ''),
  branch text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint teachers_id_import_uq unique (id, timetable_import_id),
  constraint teachers_import_source_uq unique (timetable_import_id, source_id)
);

comment on table public.teachers is 'Bir import kapsamında ayrıştırılmış öğretmen (<teacher>) kaydı.';

create index teachers_timetable_import_id_idx on public.teachers (timetable_import_id);

create trigger set_updated_at
  before update on public.teachers
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 5. school_classes
-- ============================================================================
-- "classes" adı hem SQL'de gürültülü hem uygulama tarafında belirsiz
-- olduğundan (frontend'deki genel "Sınıf" kavramıyla karışabilir)
-- "school_classes" tercih edildi.
create table public.school_classes (
  id uuid primary key default gen_random_uuid(),
  timetable_import_id uuid not null references public.timetable_imports (id) on delete cascade,
  source_id text not null check (btrim(source_id) <> ''),
  name text not null check (btrim(name) <> ''),
  grade text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint school_classes_id_import_uq unique (id, timetable_import_id),
  constraint school_classes_import_source_uq unique (timetable_import_id, source_id)
);

comment on table public.school_classes is 'Bir import kapsamında ayrıştırılmış sınıf (<class>) kaydı.';

create index school_classes_timetable_import_id_idx on public.school_classes (timetable_import_id);

create trigger set_updated_at
  before update on public.school_classes
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 6. timetable_days
-- ============================================================================
create table public.timetable_days (
  id uuid primary key default gen_random_uuid(),
  timetable_import_id uuid not null references public.timetable_imports (id) on delete cascade,
  source_id text not null check (btrim(source_id) <> ''),
  name text not null check (btrim(name) <> ''),
  day_order integer not null check (day_order > 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint timetable_days_id_import_uq unique (id, timetable_import_id),
  constraint timetable_days_import_source_uq unique (timetable_import_id, source_id),
  constraint timetable_days_import_order_uq unique (timetable_import_id, day_order)
);

comment on table public.timetable_days is
  'Tek-bitli <daysdef> kaydından türetilen gerçek gün (ör. Pazartesi). Çok-bitli meta tanımlar ("Herhangi Bir Gün") buraya alınmaz.';

create index timetable_days_timetable_import_id_idx on public.timetable_days (timetable_import_id);

create trigger set_updated_at
  before update on public.timetable_days
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 7. lesson_periods
-- ============================================================================
create table public.lesson_periods (
  id uuid primary key default gen_random_uuid(),
  timetable_import_id uuid not null references public.timetable_imports (id) on delete cascade,
  source_id text not null check (btrim(source_id) <> ''),
  name text not null check (btrim(name) <> ''),
  period_order integer not null check (period_order > 0),
  starts_at time,
  ends_at time,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint lesson_periods_id_import_uq unique (id, timetable_import_id),
  constraint lesson_periods_import_source_uq unique (timetable_import_id, source_id),
  constraint lesson_periods_import_order_uq unique (timetable_import_id, period_order),
  constraint lesson_periods_time_range_chk
    check (starts_at is null or ends_at is null or ends_at > starts_at)
);

comment on table public.lesson_periods is 'Bir import kapsamında ayrıştırılmış ders saati (<period>) kaydı.';

create index lesson_periods_timetable_import_id_idx on public.lesson_periods (timetable_import_id);

create trigger set_updated_at
  before update on public.lesson_periods
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 8. subjects
-- ============================================================================
create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  timetable_import_id uuid not null references public.timetable_imports (id) on delete cascade,
  source_id text not null check (btrim(source_id) <> ''),
  name text not null check (btrim(name) <> ''),
  short_name text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint subjects_id_import_uq unique (id, timetable_import_id),
  constraint subjects_import_source_uq unique (timetable_import_id, source_id)
);

comment on table public.subjects is 'Bir import kapsamında ayrıştırılmış ders/branş (<subject>) kaydı.';

create index subjects_timetable_import_id_idx on public.subjects (timetable_import_id);

create trigger set_updated_at
  before update on public.subjects
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 9. lessons — ham <lesson> kaydı
-- ============================================================================
create table public.lessons (
  id uuid primary key default gen_random_uuid(),
  timetable_import_id uuid not null references public.timetable_imports (id) on delete cascade,
  source_id text not null check (btrim(source_id) <> ''),
  subject_id uuid,
  -- Ham <lesson groupids="..."> değeri kayıpsız saklanır. groupids, aSc
  -- şemasında ayrı bir ilişkisel tabloyla (örn. <groups>) tam olarak
  -- modellenebilir, ama bu tablo henüz ayrıştırılmıyor/tüketilmiyor
  -- (bkz. src/lib/timetableXml/ascAdapter.ts). Bu aşamada ilişkisel bir
  -- groups tablosu kurmak yerine, veri kaybını önlemek için ham kaynak
  -- kimliklerini bir text[] içinde tutmayı tercih ettik; groups modeli
  -- netleştiğinde ayrı bir migration ile normalize edilebilir.
  source_group_ids text[] not null default '{}',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint lessons_id_import_uq unique (id, timetable_import_id),
  constraint lessons_import_source_uq unique (timetable_import_id, source_id),
  -- ON DELETE RESTRICT (kasıtlı — SET NULL DEĞİL): composite FK'de
  -- "ON DELETE SET NULL" PostgreSQL'de FK'nin İKİ sütununu da (subject_id
  -- VE timetable_import_id) NULL yapmaya çalışır. timetable_import_id
  -- NOT NULL olduğundan bu, kullanımdaki bir subject silinmeye çalışıldığında
  -- "null value in column timetable_import_id violates not-null constraint"
  -- hatasıyla PATLAR — yerel PostgreSQL'de fonksiyonel testle doğrulandı.
  -- PostgreSQL'in sütun listeli "ON DELETE SET NULL (subject_id)" biçimi
  -- (yalnız belirtilen sütunu NULL yapar) PG 15+'ta mevcut, ama hedef
  -- Supabase PostgreSQL sürümüne bağımlılık yaratmamak için RESTRICT tercih
  -- edildi: snapshot/import modelinde zaten bir subject'in kendi importundan
  -- BAĞIMSIZ tek başına silinmesine ihtiyaç yok — subject yalnızca tüm
  -- import CASCADE ile silinirken gider (bkz. aşağıdaki fonksiyonel test notu).
  constraint lessons_subject_import_fk
    foreign key (subject_id, timetable_import_id)
    references public.subjects (id, timetable_import_id)
    on delete restrict
);

comment on table public.lessons is
  'Ham XML <lesson> kaydı. teacherIds/classIds çoklu değer içerebildiği için gerçek öğretmen-sınıf ilişkisi lesson_teachers/lesson_classes tablolarında tutulur.';

create index lessons_timetable_import_id_idx on public.lessons (timetable_import_id);
create index lessons_subject_id_idx on public.lessons (subject_id);

create trigger set_updated_at
  before update on public.lessons
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 10. lesson_teachers — ham lesson ↔ öğretmen (çoktan-çoğa)
-- ============================================================================
create table public.lesson_teachers (
  timetable_import_id uuid not null,
  lesson_id uuid not null,
  teacher_id uuid not null,
  source_order integer not null check (source_order > 0),
  created_at timestamptz not null default timezone('utc', now()),
  primary key (lesson_id, teacher_id),
  -- Tek bir timetable_import_id sütunu her iki composite FK'da da
  -- kullanıldığından, lesson_id ve teacher_id'nin AYNI importa ait olması
  -- veritabanı seviyesinde zorunlu kılınır (çapraz-import bütünlüğü).
  constraint lesson_teachers_lesson_import_fk
    foreign key (lesson_id, timetable_import_id)
    references public.lessons (id, timetable_import_id)
    on delete cascade,
  constraint lesson_teachers_teacher_import_fk
    foreign key (teacher_id, timetable_import_id)
    references public.teachers (id, timetable_import_id)
    on delete cascade
);

comment on table public.lesson_teachers is
  'Ham <lesson teacherids="..."> listesinin açılmış hali; source_order XML''deki virgülle ayrılmış sıradır.';

create index lesson_teachers_teacher_id_idx on public.lesson_teachers (teacher_id);
create index lesson_teachers_timetable_import_id_idx on public.lesson_teachers (timetable_import_id);

-- ============================================================================
-- 11. lesson_classes — ham lesson ↔ sınıf (çoktan-çoğa)
-- ============================================================================
create table public.lesson_classes (
  timetable_import_id uuid not null,
  lesson_id uuid not null,
  school_class_id uuid not null,
  source_order integer not null check (source_order > 0),
  created_at timestamptz not null default timezone('utc', now()),
  primary key (lesson_id, school_class_id),
  constraint lesson_classes_lesson_import_fk
    foreign key (lesson_id, timetable_import_id)
    references public.lessons (id, timetable_import_id)
    on delete cascade,
  constraint lesson_classes_class_import_fk
    foreign key (school_class_id, timetable_import_id)
    references public.school_classes (id, timetable_import_id)
    on delete cascade
);

comment on table public.lesson_classes is
  'Ham <lesson classids="..."> listesinin açılmış hali; source_order XML''deki virgülle ayrılmış sıradır.';

create index lesson_classes_school_class_id_idx on public.lesson_classes (school_class_id);
create index lesson_classes_timetable_import_id_idx on public.lesson_classes (timetable_import_id);

-- ============================================================================
-- 12. timetable_cards — ham <card> kaydı
-- ============================================================================
create table public.timetable_cards (
  id uuid primary key default gen_random_uuid(),
  timetable_import_id uuid not null references public.timetable_imports (id) on delete cascade,
  lesson_id uuid not null,
  source_index integer not null check (source_index > 0),
  -- Kaynak XML'de <card> için gerçek bir id alanı yoktur. Ayrıştırıcı
  -- (ascAdapter.ts) "card-{sıraNo}" biçiminde sentetik/kararlı bir anahtar
  -- üretir; burada aynı sözleşmeyi izleyerek saklıyoruz.
  source_card_key text not null check (btrim(source_card_key) <> ''),
  timetable_day_id uuid not null,
  lesson_period_id uuid not null,
  -- Ham <card classroomids="..."> (virgülle ayrılmış olabilir) kayıpsız saklanır.
  classroom_source_ids text[] not null default '{}',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint timetable_cards_id_import_uq unique (id, timetable_import_id),
  constraint timetable_cards_import_index_uq unique (timetable_import_id, source_index),
  constraint timetable_cards_import_key_uq unique (timetable_import_id, source_card_key),
  constraint timetable_cards_lesson_import_fk
    foreign key (lesson_id, timetable_import_id)
    references public.lessons (id, timetable_import_id)
    on delete cascade,
  constraint timetable_cards_day_import_fk
    foreign key (timetable_day_id, timetable_import_id)
    references public.timetable_days (id, timetable_import_id)
    on delete cascade,
  constraint timetable_cards_period_import_fk
    foreign key (lesson_period_id, timetable_import_id)
    references public.lesson_periods (id, timetable_import_id)
    on delete cascade
);

comment on table public.timetable_cards is
  'Ham XML <card> kaydı: bir lesson''ın belirli gün+ders saatine yerleşimi. Bu tablonun satır sayısı = ham "Plan Kartı" sayısıdır (bkz. TimetableImportStats.sourceCardCount).';

create index timetable_cards_timetable_import_id_idx on public.timetable_cards (timetable_import_id);
create index timetable_cards_lesson_id_idx on public.timetable_cards (lesson_id);
create index timetable_cards_day_period_idx on public.timetable_cards (timetable_day_id, lesson_period_id);

create trigger set_updated_at
  before update on public.timetable_cards
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 13. timetable_assignments — normalize öğretmen–sınıf atama satırı
-- ============================================================================
create table public.timetable_assignments (
  id uuid primary key default gen_random_uuid(),
  timetable_import_id uuid not null references public.timetable_imports (id) on delete cascade,
  timetable_card_id uuid not null,
  lesson_id uuid not null,
  teacher_id uuid not null,
  school_class_id uuid not null,
  timetable_day_id uuid not null,
  lesson_period_id uuid not null,
  subject_id uuid,
  classroom text,
  -- exact: lesson'da tek öğretmen + tek sınıf (1×1, belirsizlik yok).
  -- expanded: lesson'da öğretmen veya sınıftan yalnız biri çoklu (1×N ya da
  --   N×1) — kartezyen açılım makul kabul edilir (ör. ortak öğretim).
  -- ambiguous: lesson'da HEM öğretmen HEM sınıf çoklu (N×M, ör. kulüp/ortak
  --   etkinlik saatleri) — kartezyen çarpımın gerçek eşleşmeyi yansıttığı
  --   XML'den kesin doğrulanamaz (bkz. ascAdapter.ts AMBIGUOUS_CARTESIAN_MAPPING).
  mapping_status text not null check (mapping_status in ('exact', 'expanded', 'ambiguous')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint timetable_assignments_card_import_fk
    foreign key (timetable_card_id, timetable_import_id)
    references public.timetable_cards (id, timetable_import_id)
    on delete cascade,
  constraint timetable_assignments_lesson_import_fk
    foreign key (lesson_id, timetable_import_id)
    references public.lessons (id, timetable_import_id)
    on delete cascade,
  constraint timetable_assignments_teacher_import_fk
    foreign key (teacher_id, timetable_import_id)
    references public.teachers (id, timetable_import_id)
    on delete cascade,
  constraint timetable_assignments_class_import_fk
    foreign key (school_class_id, timetable_import_id)
    references public.school_classes (id, timetable_import_id)
    on delete cascade,
  constraint timetable_assignments_day_import_fk
    foreign key (timetable_day_id, timetable_import_id)
    references public.timetable_days (id, timetable_import_id)
    on delete cascade,
  constraint timetable_assignments_period_import_fk
    foreign key (lesson_period_id, timetable_import_id)
    references public.lesson_periods (id, timetable_import_id)
    on delete cascade,
  -- ON DELETE RESTRICT (kasıtlı — SET NULL DEĞİL): gerekçe için yukarıda
  -- lessons_subject_import_fk kısıtının yanındaki yoruma bakın.
  constraint timetable_assignments_subject_import_fk
    foreign key (subject_id, timetable_import_id)
    references public.subjects (id, timetable_import_id)
    on delete restrict,
  -- Aynı kartın aynı öğretmen+sınıf kombinasyonu için tekrar kaydedilmesini engeller.
  constraint timetable_assignments_card_teacher_class_uq
    unique (timetable_card_id, teacher_id, school_class_id)
);

comment on table public.timetable_assignments is
  'Normalize edilmiş öğretmen×sınıf atama satırı. Bir timetable_card, ilişkili lesson''ın teacherIds×classIds kombinasyonuna göre birden çok atamaya açılabildiği için bu tablonun satır sayısı timetable_cards satır sayısından BÜYÜK OLABİLİR — "Atama Kaydı" ile "Plan Kartı" sayılarını karıştırma (bkz. TimetableImportStats.scheduleEntryCount vs. sourceCardCount).';

create index timetable_assignments_timetable_import_id_idx on public.timetable_assignments (timetable_import_id);
create index timetable_assignments_timetable_card_id_idx on public.timetable_assignments (timetable_card_id);
create index timetable_assignments_lesson_id_idx on public.timetable_assignments (lesson_id);
create index timetable_assignments_teacher_id_idx on public.timetable_assignments (teacher_id);
create index timetable_assignments_school_class_id_idx on public.timetable_assignments (school_class_id);
-- Öğretmenin haftalık programı için: import + öğretmen + gün + saat.
create index timetable_assignments_teacher_schedule_idx
  on public.timetable_assignments (timetable_import_id, teacher_id, timetable_day_id, lesson_period_id);
-- Sınıfın haftalık programı için: import + sınıf + gün + saat.
create index timetable_assignments_class_schedule_idx
  on public.timetable_assignments (timetable_import_id, school_class_id, timetable_day_id, lesson_period_id);

create trigger set_updated_at
  before update on public.timetable_assignments
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 14. import_validation_issues — içe aktarma doğrulama sonuçları
-- ============================================================================
create table public.import_validation_issues (
  id uuid primary key default gen_random_uuid(),
  timetable_import_id uuid not null references public.timetable_imports (id) on delete cascade,
  severity text not null check (severity in ('error', 'warning', 'info')),
  code text not null check (btrim(code) <> ''),
  message text not null check (btrim(message) <> ''),
  -- Benzersiz hatalı kaynak kimliği sayısı ile bundan etkilenen kayıt
  -- sayısının karıştırılmaması için ayrı sütunlar (bkz. ascAdapter.ts
  -- RefIssueTracker: uniqueCount vs. recordCount).
  affected_count integer check (affected_count is null or affected_count >= 0),
  distinct_reference_count integer check (distinct_reference_count is null or distinct_reference_count >= 0),
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  created_at timestamptz not null default timezone('utc', now())
);

comment on table public.import_validation_issues is
  'Bir import için üretilen doğrulama hata/uyarı/bilgi kayıtları (bkz. TimetableImportResult.validationErrors/Warnings).';
comment on column public.import_validation_issues.affected_count is
  'Bu sorundan etkilenen kayıt/kart sayısı (ör. atlanan atama sayısı) — benzersiz kaynak kimliği sayısıyla KARIŞTIRILMAMALI.';
comment on column public.import_validation_issues.distinct_reference_count is
  'Bu soruna yol açan benzersiz geçersiz kaynak kimliği sayısı (ör. tekrar eden aynı tanımsız öğretmen id''si tek sayılır).';

create index import_validation_issues_timetable_import_id_idx
  on public.import_validation_issues (timetable_import_id);
create index import_validation_issues_severity_idx
  on public.import_validation_issues (severity);

-- ============================================================================
-- Row Level Security
-- ============================================================================
-- RLS bu aşamada BİLİNÇLİ olarak, POLİTİKASIZ biçimde etkinleştiriliyor.
-- Postgres'te bir tabloda RLS açıkken hiç policy yoksa, tablo sahibi
-- dışındaki hiçbir rol (Supabase'in "anon" ve "authenticated" rolleri dahil)
-- SELECT/INSERT/UPDATE/DELETE yapamaz — varsayılan davranış "erişim yok"tur.
-- Kimlik doğrulama ve kullanıcı↔kampüs üyelik modeli henüz tasarlanmadığı
-- için erişim politikaları BİLEREK bu migration'a eklenmedi; ayrı bir
-- migration'da, o model netleştiğinde tanımlanacak.
-- Service role anahtarı (RLS'yi bypass eder) hiçbir koşulda frontend
-- kodunda kullanılmamalıdır.
-- ============================================================================
alter table public.campuses enable row level security;
alter table public.academic_years enable row level security;
alter table public.timetable_imports enable row level security;
alter table public.teachers enable row level security;
alter table public.school_classes enable row level security;
alter table public.timetable_days enable row level security;
alter table public.lesson_periods enable row level security;
alter table public.subjects enable row level security;
alter table public.lessons enable row level security;
alter table public.lesson_teachers enable row level security;
alter table public.lesson_classes enable row level security;
alter table public.timetable_cards enable row level security;
alter table public.timetable_assignments enable row level security;
alter table public.import_validation_issues enable row level security;
