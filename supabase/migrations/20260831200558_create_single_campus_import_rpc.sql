-- ============================================================================
-- Nöbet2027 — tek-kampüs XML içe aktarma RPC'si
-- ============================================================================
-- Bu migration, yerel Node backend'inin (bkz. server/) doğrulanmış XML
-- sonucunu TEK BİR atomik transaction içinde kalıcı kaydetmesi için
-- public.import_timetable_snapshot(jsonb) fonksiyonunu ekler.
--
-- Neden bir RPC (PostgREST üzerinden çağrılan bir Postgres fonksiyonu) ve
-- art arda REST INSERT çağrıları değil: ~10 tabloya yazılan bir importun
-- ortasında herhangi bir satır başarısız olursa (tanımsız referans, tekrar
-- eden source_id, vb.) YARIM KALMIŞ VERİ istemiyoruz. Tek bir PL/pgSQL
-- fonksiyon çağrısı = tek bir transaction; içeride RAISE EXCEPTION olursa
-- PostgREST tüm transaction'ı otomatik ROLLBACK eder.
--
-- SECURITY INVOKER (BİLİNÇLİ, DEFINER DEĞİL): Bu fonksiyon yalnızca yerel
-- backend'in `sb_secret_...` anahtarıyla (rol: service_role) çağırması
-- amaçlanmıştır. service_role zaten RLS'yi bypass eder ve bu tablolarda
-- tam DML hakkına sahiptir (Supabase projelerinde varsayılan). Bu nedenle
-- fonksiyona invoker'ın sahip olmadığı ek bir yetki kazandırmaya
-- (SECURITY DEFINER) gerek yok — en az yetki ilkesi gereği INVOKER tercih
-- edildi. Aşağıda PUBLIC/anon/authenticated'in EXECUTE hakkı açıkça
-- kaldırılır; bu fonksiyon tarayıcıdan ASLA çağrılmamalıdır (yalnızca
-- sunucu tarafı service_role anahtarıyla çağırır).
--
-- Dinamik SQL YOKTUR: tüm sorgular sabit metin + bağlı değişkenlerdir.
-- search_path sabittir (yalnız pg_catalog, public).
-- ============================================================================

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

  -- === 1. Kritik doğrulama hatası varsa reddet (bkz. "Kritik doğrulama hatası
  --        bulunan XML'i kaydetme") ===
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

  -- === 4. Aynı (academic_year_id, source_sha256) daha önce içe aktarıldıysa:
  --        yeni kayıt AÇMA, mevcut importu bildir ("alreadyImported") ===
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

  -- === 5. timetable_imports satırı (pending; en sonda 'imported' yapılır) ===
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

  -- === 8. school_classes ===
  for rec in
    select * from jsonb_to_recordset(coalesce(p_payload->'classes', '[]'::jsonb))
      as x(source_id text, name text, grade text)
  loop
    if coalesce(btrim(rec.source_id), '') = '' or coalesce(btrim(rec.name), '') = '' then
      raise exception 'classes: source_id/name boş olamaz.' using errcode = '22023';
    end if;
    if v_class_map ? rec.source_id then
      raise exception 'classes: yinelenen source_id: %', rec.source_id using errcode = '23505';
    end if;
    insert into public.school_classes (timetable_import_id, source_id, name, grade)
      values (v_import_id, rec.source_id, rec.name, rec.grade)
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

  -- === 17. Bu import'u tamamla, ardından AYNI transaction içinde önceki
  --         başarılı importları superseded yap (yalnız bu import tamamen
  --         başarılı olduktan SONRA — yani buraya kadar hiçbir exception
  --         atılmadıysa) ===
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
  'Yerel backend tarafından (yalnız service_role) çağrılan, doğrulanmış XML sonucunu tek transaction içinde kalıcı kaydeden RPC. Tarayıcıdan asla doğrudan çağrılmamalıdır.';

-- PUBLIC/anon/authenticated EXECUTE yetkisi YOK; yalnız service_role çağırabilir.
-- anon/authenticated/service_role rolleri yalnızca barındırılan Supabase
-- projelerinde önceden var olduğundan (salt-yerel/vanilla PostgreSQL'de
-- yoklardır), bu blok DO $$ ... $$ ile rol varlığını kontrol ederek hem
-- Supabase'de hem yerel doğrulamada hatasız çalışır.
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

-- Bu migration hiçbir RLS policy eklemez ve mevcut policy'siz durumu değiştirmez.
-- RPC'nin service_role ile çalışması RLS'yi zaten bypass eder; bu, tabloları
-- genel erişime AÇMAZ (anon/authenticated hâlâ hiçbir satır göremez/yazamaz).
