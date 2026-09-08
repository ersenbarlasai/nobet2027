-- ============================================================================
-- Nöbet2027 — sınıf öğretmeni (class_teacher) ilişkisi
-- ============================================================================
-- Kaynak XML <class id name short teacherid classroomids grade /> kaydındaki
-- teacherid özniteliği sınıfın SINIF ÖĞRETMENİ'ne referanstır (bkz. gerçek
-- sınıf ders programı çıktılarındaki "Sınıf Öğretmeni: ..." başlığı). Bu
-- migration'dan önce bu ilişki hiç ayrıştırılmıyor/saklanmıyordu.
--
-- Bu migration:
--   1) school_classes.class_teacher_id sütununu ekler.
--   2) public.import_timetable_snapshot(jsonb) fonksiyonunu CREATE OR REPLACE
--      ile günceller (yeni import'larda class_teacher_id çözülsün diye).
--   3) public.get_class_timetable_snapshot(...) fonksiyonunu CREATE OR REPLACE
--      ile günceller (sınıf öğretmeni adını dönsün diye).
--   4) public.backfill_class_teacher_relationships(...) — yalnız server-side
--      yönetim scripti tarafından, bir kerelik kontrollü bakım işlemi için
--      çağrılan, sha256 doğrulamalı, tek-transaction'lı fonksiyon ekler (bkz.
--      server/scripts/README.md).
--
-- Mevcut migration dosyaları DEĞİŞTİRİLMEDİ.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. school_classes.class_teacher_id
-- ----------------------------------------------------------------------------
alter table public.school_classes
  add column class_teacher_id uuid null;

comment on column public.school_classes.class_teacher_id is
  'Kaynak XML <class teacherid> referansı — sınıfın SINIF ÖĞRETMENİ. NULL = XML''de teacherid boş (geçerli durum, ör. anaokulu/kulüp şubeleri). RESTRICT: bir öğretmen yalnızca tüm import CASCADE ile silinirken gider, tek başına silinemez.';

-- Çapraz-import bütünlüğü: bir sınıfın sınıf öğretmeni AYNI importa ait
-- olmalı (bkz. şemadaki diğer tüm *_import_fk kısıtlarıyla aynı desen).
-- ON DELETE RESTRICT (SET NULL DEĞİL) — composite FK'de "SET NULL"
-- PostgreSQL'de FK'yi oluşturan HER İKİ sütunu (class_teacher_id VE
-- timetable_import_id) NULL yapmaya çalışır; timetable_import_id NOT NULL
-- olduğundan bu patlar (bkz. ilk migration'daki lessons_subject_import_fk
-- yorumu — aynı gerekçe). Snapshot modelinde zaten bir öğretmenin kendi
-- importundan BAĞIMSIZ tek başına silinmesine ihtiyaç yoktur.
alter table public.school_classes
  add constraint school_classes_class_teacher_import_fk
  foreign key (class_teacher_id, timetable_import_id)
  references public.teachers (id, timetable_import_id)
  on delete restrict;

-- Sınıf öğretmeni adını read RPC'lerinde join ile getirmek için.
create index school_classes_import_class_teacher_idx
  on public.school_classes (timetable_import_id, class_teacher_id);

-- ----------------------------------------------------------------------------
-- 2. import_timetable_snapshot(jsonb) — CREATE OR REPLACE
-- ----------------------------------------------------------------------------
-- Yalnız "=== 8. school_classes ===" adımı değişti (class_teacher_source_id
-- çözümü eklendi); geri kalan tüm adımlar orijinal migrationla birebir aynı.
create or replace function public.import_timetable_snapshot(p_payload jsonb)
returns jsonb
language plpgsql
volatile
set search_path = pg_catalog, public
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_year_was_active boolean;
  v_import_id uuid;
  v_existing_import record;
  v_source_sha256 text := nullif(btrim(p_payload->>'source_sha256'), '');
  v_declared_card_count integer := coalesce((p_payload->>'source_card_count')::integer, -1);
  v_declared_assignment_count integer := coalesce((p_payload->>'normalized_assignment_count')::integer, -1);

  v_teacher_map jsonb := '{}'::jsonb;
  v_class_map jsonb := '{}'::jsonb;
  v_day_map jsonb := '{}'::jsonb;
  v_period_map jsonb := '{}'::jsonb;
  v_subject_map jsonb := '{}'::jsonb;
  v_lesson_map jsonb := '{}'::jsonb;
  v_card_map jsonb := '{}'::jsonb;

  v_new_id uuid;
  rec record;
  v_teacher_count integer := 0;
  v_class_count integer := 0;
  v_day_count integer := 0;
  v_period_count integer := 0;
  v_card_count integer := 0;
  v_assignment_count integer := 0;
  v_imported_at timestamptz;
begin
  -- === 0. Temel payload şekli ===
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Geçersiz payload: JSON nesnesi bekleniyor.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_payload->>'campus_name'), '') = '' then
    raise exception 'campus_name zorunludur.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_payload->>'academic_year_name'), '') = '' then
    raise exception 'academic_year_name zorunludur.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_payload->>'source_format'), '') = '' then
    raise exception 'source_format zorunludur.' using errcode = '22023';
  end if;
  if v_declared_card_count < 0 then
    raise exception 'source_card_count negatif olamaz.' using errcode = '22023';
  end if;
  if v_declared_assignment_count < 0 then
    raise exception 'normalized_assignment_count negatif olamaz.' using errcode = '22023';
  end if;

  -- === 1. Kritik doğrulama hatası varsa reddet ===
  if exists (
    select 1 from jsonb_to_recordset(coalesce(p_payload->'validation_issues', '[]'::jsonb)) as x(severity text)
    where x.severity = 'error'
  ) then
    raise exception 'Kritik doğrulama hatası içeren XML kaydedilemez.' using errcode = '22023';
  end if;

  -- === 2. Kampüsü bul ya da oluştur ===
  select id into v_campus_id from public.campuses where name = p_payload->>'campus_name';
  if not found then
    insert into public.campuses (name) values (p_payload->>'campus_name') returning id into v_campus_id;
  end if;

  -- === 3. Eğitim yılını bul ya da oluştur; tek-aktif-yıl kuralını koru ===
  select id, is_active into v_year_id, v_year_was_active
    from public.academic_years
    where campus_id = v_campus_id and name = p_payload->>'academic_year_name';

  if not found then
    if exists (select 1 from public.academic_years where campus_id = v_campus_id and is_active) then
      raise exception 'Kampüste zaten aktif bir eğitim yılı var; önce onu pasif hale getirin.' using errcode = '23505';
    end if;
    insert into public.academic_years (campus_id, name, is_active)
      values (v_campus_id, p_payload->>'academic_year_name', true)
      returning id into v_year_id;
  elsif not v_year_was_active then
    if exists (
      select 1 from public.academic_years
      where campus_id = v_campus_id and is_active and id <> v_year_id
    ) then
      raise exception 'Kampüste zaten farklı bir aktif eğitim yılı var.' using errcode = '23505';
    end if;
    update public.academic_years set is_active = true where id = v_year_id;
  end if;

  -- === 4. Aynı (academic_year_id, source_sha256) daha önce içe aktarıldıysa ===
  if v_source_sha256 is not null then
    select id, status, imported_at into v_existing_import
      from public.timetable_imports
      where academic_year_id = v_year_id and source_sha256 = v_source_sha256
      limit 1;
    if found then
      return jsonb_build_object(
        'importId', v_existing_import.id,
        'status', v_existing_import.status,
        'campusName', p_payload->>'campus_name',
        'academicYearName', p_payload->>'academic_year_name',
        'teacherCount', (select count(*) from public.teachers where timetable_import_id = v_existing_import.id),
        'classCount', (select count(*) from public.school_classes where timetable_import_id = v_existing_import.id),
        'dayCount', (select count(*) from public.timetable_days where timetable_import_id = v_existing_import.id),
        'periodCount', (select count(*) from public.lesson_periods where timetable_import_id = v_existing_import.id),
        'sourceCardCount', (
          select source_card_count from public.timetable_imports where id = v_existing_import.id
        ),
        'normalizedAssignmentCount', (
          select count(*) from public.timetable_assignments where timetable_import_id = v_existing_import.id
        ),
        'alreadyImported', true,
        'importedAt', v_existing_import.imported_at
      );
    end if;
  end if;

  -- === 5. timetable_imports satırı ===
  insert into public.timetable_imports (
    campus_id, academic_year_id, source_format, source_filename,
    source_encoding, source_sha256, source_card_count, normalized_assignment_count, status
  ) values (
    v_campus_id, v_year_id, p_payload->>'source_format', p_payload->>'source_filename',
    p_payload->>'source_encoding', v_source_sha256, v_declared_card_count, v_declared_assignment_count, 'pending'
  ) returning id into v_import_id;

  -- === 6. subjects ===
  for rec in
    select * from jsonb_to_recordset(coalesce(p_payload->'subjects', '[]'::jsonb))
      as x(source_id text, name text, short_name text)
  loop
    if coalesce(btrim(rec.source_id), '') = '' or coalesce(btrim(rec.name), '') = '' then
      raise exception 'subjects: source_id/name boş olamaz.' using errcode = '22023';
    end if;
    if v_subject_map ? rec.source_id then
      raise exception 'subjects: yinelenen source_id: %', rec.source_id using errcode = '23505';
    end if;
    insert into public.subjects (timetable_import_id, source_id, name, short_name)
      values (v_import_id, rec.source_id, rec.name, rec.short_name)
      returning id into v_new_id;
    v_subject_map := v_subject_map || jsonb_build_object(rec.source_id, v_new_id);
  end loop;

  -- === 7. teachers ===
  for rec in
    select * from jsonb_to_recordset(coalesce(p_payload->'teachers', '[]'::jsonb))
      as x(source_id text, name text, branch text)
  loop
    if coalesce(btrim(rec.source_id), '') = '' or coalesce(btrim(rec.name), '') = '' then
      raise exception 'teachers: source_id/name boş olamaz.' using errcode = '22023';
    end if;
    if v_teacher_map ? rec.source_id then
      raise exception 'teachers: yinelenen source_id: %', rec.source_id using errcode = '23505';
    end if;
    insert into public.teachers (timetable_import_id, source_id, name, branch)
      values (v_import_id, rec.source_id, rec.name, rec.branch)
      returning id into v_new_id;
    v_teacher_map := v_teacher_map || jsonb_build_object(rec.source_id, v_new_id);
    v_teacher_count := v_teacher_count + 1;
  end loop;

  -- === 8. school_classes (class_teacher_source_id → class_teacher_id çözümü DAHİL — bu migration'ın tek davranış değişikliği) ===
  for rec in
    select * from jsonb_to_recordset(coalesce(p_payload->'classes', '[]'::jsonb))
      as x(source_id text, name text, grade text, class_teacher_source_id text)
  loop
    if coalesce(btrim(rec.source_id), '') = '' or coalesce(btrim(rec.name), '') = '' then
      raise exception 'classes: source_id/name boş olamaz.' using errcode = '22023';
    end if;
    if v_class_map ? rec.source_id then
      raise exception 'classes: yinelenen source_id: %', rec.source_id using errcode = '23505';
    end if;
    if rec.class_teacher_source_id is not null and not (v_teacher_map ? rec.class_teacher_source_id) then
      raise exception 'classes: tanımsız sınıf öğretmeni (teacher) referansı: %', rec.class_teacher_source_id using errcode = '23503';
    end if;
    insert into public.school_classes (timetable_import_id, source_id, name, grade, class_teacher_id)
      values (
        v_import_id, rec.source_id, rec.name, rec.grade,
        case when rec.class_teacher_source_id is null then null else (v_teacher_map->>rec.class_teacher_source_id)::uuid end
      )
      returning id into v_new_id;
    v_class_map := v_class_map || jsonb_build_object(rec.source_id, v_new_id);
    v_class_count := v_class_count + 1;
  end loop;

  -- === 9. timetable_days ===
  for rec in
    select * from jsonb_to_recordset(coalesce(p_payload->'days', '[]'::jsonb))
      as x(source_id text, name text, sort_order integer)
  loop
    if coalesce(btrim(rec.source_id), '') = '' or coalesce(btrim(rec.name), '') = '' then
      raise exception 'days: source_id/name boş olamaz.' using errcode = '22023';
    end if;
    if rec.sort_order is null or rec.sort_order <= 0 then
      raise exception 'days: sort_order pozitif olmalı (source_id=%).', rec.source_id using errcode = '22023';
    end if;
    if v_day_map ? rec.source_id then
      raise exception 'days: yinelenen source_id: %', rec.source_id using errcode = '23505';
    end if;
    insert into public.timetable_days (timetable_import_id, source_id, name, day_order)
      values (v_import_id, rec.source_id, rec.name, rec.sort_order)
      returning id into v_new_id;
    v_day_map := v_day_map || jsonb_build_object(rec.source_id, v_new_id);
    v_day_count := v_day_count + 1;
  end loop;

  -- === 10. lesson_periods ===
  for rec in
    select * from jsonb_to_recordset(coalesce(p_payload->'periods', '[]'::jsonb))
      as x(source_id text, name text, sort_order integer, starts_at text, ends_at text)
  loop
    if coalesce(btrim(rec.source_id), '') = '' or coalesce(btrim(rec.name), '') = '' then
      raise exception 'periods: source_id/name boş olamaz.' using errcode = '22023';
    end if;
    if rec.sort_order is null or rec.sort_order <= 0 then
      raise exception 'periods: sort_order pozitif olmalı (source_id=%).', rec.source_id using errcode = '22023';
    end if;
    if v_period_map ? rec.source_id then
      raise exception 'periods: yinelenen source_id: %', rec.source_id using errcode = '23505';
    end if;
    insert into public.lesson_periods (timetable_import_id, source_id, name, period_order, starts_at, ends_at)
      values (
        v_import_id, rec.source_id, rec.name, rec.sort_order,
        nullif(rec.starts_at, '')::time, nullif(rec.ends_at, '')::time
      )
      returning id into v_new_id;
    v_period_map := v_period_map || jsonb_build_object(rec.source_id, v_new_id);
    v_period_count := v_period_count + 1;
  end loop;

  -- === 11. lessons ===
  for rec in
    select * from jsonb_to_recordset(coalesce(p_payload->'lessons', '[]'::jsonb))
      as x(source_id text, subject_source_id text, source_group_ids jsonb)
  loop
    if coalesce(btrim(rec.source_id), '') = '' then
      raise exception 'lessons: source_id boş olamaz.' using errcode = '22023';
    end if;
    if v_lesson_map ? rec.source_id then
      raise exception 'lessons: yinelenen source_id: %', rec.source_id using errcode = '23505';
    end if;
    if rec.subject_source_id is not null and not (v_subject_map ? rec.subject_source_id) then
      raise exception 'lessons: tanımsız subject referansı: %', rec.subject_source_id using errcode = '23503';
    end if;
    insert into public.lessons (timetable_import_id, source_id, subject_id, source_group_ids)
      values (
        v_import_id,
        rec.source_id,
        case when rec.subject_source_id is null then null else (v_subject_map->>rec.subject_source_id)::uuid end,
        coalesce(
          (select array_agg(elem #>> '{}') from jsonb_array_elements(coalesce(rec.source_group_ids, '[]'::jsonb)) as elem),
          '{}'
        )
      )
      returning id into v_new_id;
    v_lesson_map := v_lesson_map || jsonb_build_object(rec.source_id, v_new_id);
  end loop;

  -- === 12. lesson_teachers ===
  for rec in
    select * from jsonb_to_recordset(coalesce(p_payload->'lesson_teachers', '[]'::jsonb))
      as x(lesson_source_id text, teacher_source_id text, source_order integer)
  loop
    if rec.source_order is null or rec.source_order <= 0 then
      raise exception 'lesson_teachers: source_order pozitif olmalı.' using errcode = '22023';
    end if;
    if not (v_lesson_map ? rec.lesson_source_id) then
      raise exception 'lesson_teachers: tanımsız lesson referansı: %', rec.lesson_source_id using errcode = '23503';
    end if;
    if not (v_teacher_map ? rec.teacher_source_id) then
      raise exception 'lesson_teachers: tanımsız teacher referansı: %', rec.teacher_source_id using errcode = '23503';
    end if;
    insert into public.lesson_teachers (timetable_import_id, lesson_id, teacher_id, source_order)
      values (
        v_import_id,
        (v_lesson_map->>rec.lesson_source_id)::uuid,
        (v_teacher_map->>rec.teacher_source_id)::uuid,
        rec.source_order
      );
  end loop;

  -- === 13. lesson_classes ===
  for rec in
    select * from jsonb_to_recordset(coalesce(p_payload->'lesson_classes', '[]'::jsonb))
      as x(lesson_source_id text, class_source_id text, source_order integer)
  loop
    if rec.source_order is null or rec.source_order <= 0 then
      raise exception 'lesson_classes: source_order pozitif olmalı.' using errcode = '22023';
    end if;
    if not (v_lesson_map ? rec.lesson_source_id) then
      raise exception 'lesson_classes: tanımsız lesson referansı: %', rec.lesson_source_id using errcode = '23503';
    end if;
    if not (v_class_map ? rec.class_source_id) then
      raise exception 'lesson_classes: tanımsız class referansı: %', rec.class_source_id using errcode = '23503';
    end if;
    insert into public.lesson_classes (timetable_import_id, lesson_id, school_class_id, source_order)
      values (
        v_import_id,
        (v_lesson_map->>rec.lesson_source_id)::uuid,
        (v_class_map->>rec.class_source_id)::uuid,
        rec.source_order
      );
  end loop;

  -- === 14. timetable_cards ===
  for rec in
    select * from jsonb_to_recordset(coalesce(p_payload->'cards', '[]'::jsonb))
      as x(
        source_index integer, source_card_key text, lesson_source_id text,
        day_source_id text, period_source_id text, classroom_source_ids jsonb
      )
  loop
    if rec.source_index is null or rec.source_index <= 0 then
      raise exception 'cards: source_index pozitif olmalı.' using errcode = '22023';
    end if;
    if coalesce(btrim(rec.source_card_key), '') = '' then
      raise exception 'cards: source_card_key boş olamaz.' using errcode = '22023';
    end if;
    if v_card_map ? rec.source_card_key then
      raise exception 'cards: yinelenen source_card_key: %', rec.source_card_key using errcode = '23505';
    end if;
    if not (v_lesson_map ? rec.lesson_source_id) then
      raise exception 'cards: tanımsız lesson referansı: %', rec.lesson_source_id using errcode = '23503';
    end if;
    if not (v_day_map ? rec.day_source_id) then
      raise exception 'cards: tanımsız day referansı: %', rec.day_source_id using errcode = '23503';
    end if;
    if not (v_period_map ? rec.period_source_id) then
      raise exception 'cards: tanımsız period referansı: %', rec.period_source_id using errcode = '23503';
    end if;
    insert into public.timetable_cards (
      timetable_import_id, lesson_id, source_index, source_card_key,
      timetable_day_id, lesson_period_id, classroom_source_ids
    ) values (
      v_import_id,
      (v_lesson_map->>rec.lesson_source_id)::uuid,
      rec.source_index,
      rec.source_card_key,
      (v_day_map->>rec.day_source_id)::uuid,
      (v_period_map->>rec.period_source_id)::uuid,
      coalesce(
        (select array_agg(elem #>> '{}') from jsonb_array_elements(coalesce(rec.classroom_source_ids, '[]'::jsonb)) as elem),
        '{}'
      )
    ) returning id into v_new_id;
    v_card_map := v_card_map || jsonb_build_object(rec.source_card_key, v_new_id);
    v_card_count := v_card_count + 1;
  end loop;

  if v_card_count > v_declared_card_count then
    raise exception 'source_card_count (%) gerçekten eklenen kart sayısından (%) küçük olamaz.',
      v_declared_card_count, v_card_count using errcode = '22023';
  end if;

  -- === 15. timetable_assignments ===
  for rec in
    select * from jsonb_to_recordset(coalesce(p_payload->'assignments', '[]'::jsonb))
      as x(
        source_card_key text, lesson_source_id text, teacher_source_id text, class_source_id text,
        day_source_id text, period_source_id text, subject_source_id text, classroom text, mapping_status text
      )
  loop
    if rec.mapping_status not in ('exact', 'expanded', 'ambiguous') then
      raise exception 'assignments: geçersiz mapping_status: %', rec.mapping_status using errcode = '22023';
    end if;
    if not (v_card_map ? rec.source_card_key) then
      raise exception 'assignments: tanımsız card referansı: %', rec.source_card_key using errcode = '23503';
    end if;
    if not (v_lesson_map ? rec.lesson_source_id) then
      raise exception 'assignments: tanımsız lesson referansı: %', rec.lesson_source_id using errcode = '23503';
    end if;
    if not (v_teacher_map ? rec.teacher_source_id) then
      raise exception 'assignments: tanımsız teacher referansı: %', rec.teacher_source_id using errcode = '23503';
    end if;
    if not (v_class_map ? rec.class_source_id) then
      raise exception 'assignments: tanımsız class referansı: %', rec.class_source_id using errcode = '23503';
    end if;
    if not (v_day_map ? rec.day_source_id) then
      raise exception 'assignments: tanımsız day referansı: %', rec.day_source_id using errcode = '23503';
    end if;
    if not (v_period_map ? rec.period_source_id) then
      raise exception 'assignments: tanımsız period referansı: %', rec.period_source_id using errcode = '23503';
    end if;
    if rec.subject_source_id is not null and not (v_subject_map ? rec.subject_source_id) then
      raise exception 'assignments: tanımsız subject referansı: %', rec.subject_source_id using errcode = '23503';
    end if;
    insert into public.timetable_assignments (
      timetable_import_id, timetable_card_id, lesson_id, teacher_id, school_class_id,
      timetable_day_id, lesson_period_id, subject_id, classroom, mapping_status
    ) values (
      v_import_id,
      (v_card_map->>rec.source_card_key)::uuid,
      (v_lesson_map->>rec.lesson_source_id)::uuid,
      (v_teacher_map->>rec.teacher_source_id)::uuid,
      (v_class_map->>rec.class_source_id)::uuid,
      (v_day_map->>rec.day_source_id)::uuid,
      (v_period_map->>rec.period_source_id)::uuid,
      case when rec.subject_source_id is null then null else (v_subject_map->>rec.subject_source_id)::uuid end,
      rec.classroom,
      rec.mapping_status
    );
    v_assignment_count := v_assignment_count + 1;
  end loop;

  if v_assignment_count <> v_declared_assignment_count then
    raise exception 'normalized_assignment_count (%) gerçek atama sayısıyla (%) uyuşmuyor.',
      v_declared_assignment_count, v_assignment_count using errcode = '22023';
  end if;

  -- === 16. import_validation_issues ===
  for rec in
    select * from jsonb_to_recordset(coalesce(p_payload->'validation_issues', '[]'::jsonb))
      as x(severity text, code text, message text, affected_count integer, distinct_reference_count integer)
  loop
    if rec.severity not in ('error', 'warning', 'info') then
      raise exception 'validation_issues: geçersiz severity: %', rec.severity using errcode = '22023';
    end if;
    insert into public.import_validation_issues (
      timetable_import_id, severity, code, message, affected_count, distinct_reference_count
    ) values (
      v_import_id, rec.severity, rec.code, rec.message, rec.affected_count, rec.distinct_reference_count
    );
  end loop;

  -- === 17. Tamamla, ardından önceki başarılı importları superseded yap ===
  update public.timetable_imports
    set status = 'imported', imported_at = timezone('utc', now())
    where id = v_import_id
    returning imported_at into v_imported_at;

  update public.timetable_imports
    set status = 'superseded'
    where campus_id = v_campus_id
      and academic_year_id = v_year_id
      and id <> v_import_id
      and status = 'imported';

  return jsonb_build_object(
    'importId', v_import_id,
    'status', 'imported',
    'campusName', p_payload->>'campus_name',
    'academicYearName', p_payload->>'academic_year_name',
    'teacherCount', v_teacher_count,
    'classCount', v_class_count,
    'dayCount', v_day_count,
    'periodCount', v_period_count,
    'sourceCardCount', v_declared_card_count,
    'normalizedAssignmentCount', v_assignment_count,
    'importedAt', v_imported_at,
    'alreadyImported', false
  );
end;
$$;

comment on function public.import_timetable_snapshot(jsonb) is
  'Yerel backend tarafından (yalnız service_role) çağrılan, doğrulanmış XML sonucunu tek transaction içinde kalıcı kaydeden RPC. class_teacher_source_id çözümü dahil (bkz. 20260902100000 migration). Tarayıcıdan asla doğrudan çağrılmamalıdır.';

revoke all on function public.import_timetable_snapshot(jsonb) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.import_timetable_snapshot(jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.import_timetable_snapshot(jsonb) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.import_timetable_snapshot(jsonb) to service_role;
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- 3. get_class_timetable_snapshot(...) — CREATE OR REPLACE
-- ----------------------------------------------------------------------------
-- Tek değişiklik: dönen 'class' nesnesine 'classTeacher' (id+name veya null)
-- eklendi — bir ders hücresindeki öğretmenlerle KARIŞTIRILMAMALI, bu yalnız
-- school_classes.class_teacher_id → teachers join'idir.
create or replace function public.get_class_timetable_snapshot(
  p_campus_name text,
  p_academic_year_name text,
  p_class_id uuid
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
  v_class record;
  v_days jsonb;
  v_periods jsonb;
  v_rows jsonb;
begin
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;
  if p_class_id is null then
    raise exception 'class_id zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then
    return jsonb_build_object('hasImport', false, 'classFound', false);
  end if;

  select id into v_year_id
    from public.academic_years
    where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then
    return jsonb_build_object('hasImport', false, 'classFound', false);
  end if;

  select * into v_import
    from public.timetable_imports
    where campus_id = v_campus_id
      and academic_year_id = v_year_id
      and status = 'imported'
    order by imported_at desc nulls last, created_at desc
    limit 1;

  if not found then
    return jsonb_build_object('hasImport', false, 'classFound', false);
  end if;

  select sc.id, sc.source_id, sc.name, sc.grade, sc.class_teacher_id, ct.name as class_teacher_name
    into v_class
    from public.school_classes sc
    left join public.teachers ct on ct.id = sc.class_teacher_id
    where sc.id = p_class_id and sc.timetable_import_id = v_import.id;

  if not found then
    return jsonb_build_object('hasImport', true, 'classFound', false, 'importedAt', v_import.imported_at);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id, 'sourceId', d.source_id, 'name', d.name, 'order', d.day_order
      ) order by d.day_order), '[]'::jsonb)
    into v_days
    from public.timetable_days d
    where d.timetable_import_id = v_import.id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'sourceId', p.source_id, 'name', p.name, 'order', p.period_order,
      'startTime', p.starts_at, 'endTime', p.ends_at
      ) order by p.period_order), '[]'::jsonb)
    into v_periods
    from public.lesson_periods p
    where p.timetable_import_id = v_import.id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'cardId', tc.id,
      'sourceCardKey', tc.source_card_key,
      'dayId', a.timetable_day_id,
      'periodId', a.lesson_period_id,
      'subjectName', s.name,
      'teacherName', t.name,
      'classroom', a.classroom,
      'mappingStatus', a.mapping_status
    )), '[]'::jsonb)
    into v_rows
    from public.timetable_assignments a
    join public.timetable_cards tc on tc.id = a.timetable_card_id
    join public.teachers t on t.id = a.teacher_id
    left join public.subjects s on s.id = a.subject_id
    where a.timetable_import_id = v_import.id
      and a.school_class_id = p_class_id;

  return jsonb_build_object(
    'hasImport', true,
    'classFound', true,
    'class', jsonb_build_object(
      'id', v_class.id, 'sourceId', v_class.source_id, 'name', v_class.name, 'grade', v_class.grade,
      'classTeacher', case
        when v_class.class_teacher_id is null then null
        else jsonb_build_object('id', v_class.class_teacher_id, 'name', v_class.class_teacher_name)
      end
    ),
    'importedAt', v_import.imported_at,
    'days', v_days,
    'periods', v_periods,
    'rows', v_rows
  );
end;
$$;

comment on function public.get_class_timetable_snapshot(text, text, uuid) is
  'Salt okunur: verilen class_id MEVCUT (en güncel status=imported) importa aitse, o sınıfın gün/ders saati/ham atama satırlarını VE sınıf öğretmenini (class_teacher_id → teachers join) döner. Eski/bilinmeyen class_id için classFound=false. Yalnız service_role çağırabilir.';

revoke all on function public.get_class_timetable_snapshot(text, text, uuid) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.get_class_timetable_snapshot(text, text, uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.get_class_timetable_snapshot(text, text, uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.get_class_timetable_snapshot(text, text, uuid) to service_role;
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- 4. backfill_class_teacher_relationships(...) — kontrollü, tek transaction'lı
--    bakım fonksiyonu. Yeni import/veri satırı OLUŞTURMAZ; yalnız MEVCUT bir
--    importtaki school_classes.class_teacher_id değerlerini günceller.
--    Yalnız server/scripts/backfillClassTeachers.ts tarafından, service_role
--    ile çağrılması amaçlanmıştır (bkz. server/scripts/README.md).
-- ----------------------------------------------------------------------------
create or replace function public.backfill_class_teacher_relationships(
  p_campus_name text,
  p_academic_year_name text,
  p_source_sha256 text,
  p_class_teachers jsonb
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
  v_teacher_map jsonb := '{}'::jsonb;
  rec record;
  v_required_source_ids text[];
  v_payload_source_ids text[];
  v_teacher_assigned_count integer := 0;
  v_class_count integer := 0;
begin
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_source_sha256), '') = '' then
    raise exception 'source_sha256 zorunludur.' using errcode = '22023';
  end if;
  if p_class_teachers is null or jsonb_typeof(p_class_teachers) <> 'array' then
    raise exception 'class_teachers bir JSON dizisi olmalı.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then
    raise exception 'Kampüs bulunamadı.' using errcode = 'P0002';
  end if;

  select id into v_year_id from public.academic_years where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then
    raise exception 'Eğitim yılı bulunamadı.' using errcode = 'P0002';
  end if;

  -- Yalnız EN GÜNCEL başarılı (status=imported) import VE yalnız verilen
  -- source_sha256 ile birebir eşleşiyorsa güncellenir. Bu, yanlış importun
  -- veya yanlışlıkla farklı bir XML dosyasının sessizce uygulanmasını
  -- veritabanı seviyesinde engeller.
  select * into v_import
    from public.timetable_imports
    where campus_id = v_campus_id
      and academic_year_id = v_year_id
      and status = 'imported'
      and source_sha256 = p_source_sha256
    order by imported_at desc nulls last, created_at desc
    limit 1;

  if not found then
    raise exception 'Mevcut başarılı import bulunamadı veya source_sha256 uyuşmuyor.' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_object_agg(t.source_id, t.id), '{}'::jsonb)
    into v_teacher_map
    from public.teachers t
    where t.timetable_import_id = v_import.id;

  -- Payload'daki sınıf kümesi importtaki TÜM sınıflarla BİREBİR eşleşmeli.
  -- array_agg + IS DISTINCT FROM: eksik, fazla VEYA yinelenen herhangi bir
  -- sınıf varsa (sıralı diziler eşit uzunlukta/elemanlı olmayacağından)
  -- reddedilir.
  select array_agg(source_id order by source_id) into v_required_source_ids
    from public.school_classes where timetable_import_id = v_import.id;

  select array_agg(x.class_source_id order by x.class_source_id)
    into v_payload_source_ids
    from jsonb_to_recordset(p_class_teachers) as x(class_source_id text, teacher_source_id text);

  if v_required_source_ids is distinct from v_payload_source_ids then
    raise exception 'class_teachers listesi importtaki sınıf kümesiyle birebir eşleşmiyor (eksik/fazla/yinelenen sınıf).' using errcode = '22023';
  end if;

  for rec in
    select * from jsonb_to_recordset(p_class_teachers) as x(class_source_id text, teacher_source_id text)
  loop
    if rec.teacher_source_id is not null and not (v_teacher_map ? rec.teacher_source_id) then
      raise exception 'backfill: tanımsız teacher referansı: %', rec.teacher_source_id using errcode = '23503';
    end if;

    update public.school_classes
      set class_teacher_id = case when rec.teacher_source_id is null then null else (v_teacher_map->>rec.teacher_source_id)::uuid end
      where timetable_import_id = v_import.id and source_id = rec.class_source_id;

    v_class_count := v_class_count + 1;
    if rec.teacher_source_id is not null then
      v_teacher_assigned_count := v_teacher_assigned_count + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'updated', true,
    'importId', v_import.id,
    'classCount', v_class_count,
    'teacherAssignedCount', v_teacher_assigned_count
  );
end;
$$;

comment on function public.backfill_class_teacher_relationships(text, text, text, jsonb) is
  'Salt server-side bakım fonksiyonu: mevcut (source_sha256 ile doğrulanmış) başarılı importtaki school_classes.class_teacher_id değerlerini, XML''den yeniden ayrıştırılan class_teachers listesiyle TEK transaction içinde günceller. Yeni import/veri satırı OLUŞTURMAZ. Yalnız service_role çağırabilir (bkz. server/scripts/backfillClassTeachers.ts).';

revoke all on function public.backfill_class_teacher_relationships(text, text, text, jsonb) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.backfill_class_teacher_relationships(text, text, text, jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.backfill_class_teacher_relationships(text, text, text, jsonb) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.backfill_class_teacher_relationships(text, text, text, jsonb) to service_role;
  end if;
end
$$;

-- Bu migration hiçbir RLS policy eklemez ve mevcut policy'siz durumu değiştirmez.
