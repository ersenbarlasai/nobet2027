-- ============================================================================
-- Nöbet2027 — "Öğretmen Ders Programı" ekranı için salt-okunur RPC'ler
-- ============================================================================
-- Bu migration iki fonksiyon ekler:
--   1) public.get_current_import_teachers: mevcut (en güncel başarılı)
--      importa ait öğretmen listesini döner (açılır liste için).
--   2) public.get_teacher_timetable_snapshot: seçilen bir öğretmenin
--      haftalık programını (gün, ders saati, ham atama satırları) tek bir
--      tutarlı MVCC snapshot içinde döner.
--
-- Aynen get_current_import_classes/get_class_timetable_snapshot deseni
-- (bkz. 20260901090000_create_class_timetable_read_rpcs.sql): STABLE,
-- SECURITY INVOKER, sabit search_path, dinamik SQL yok, yalnız service_role
-- çağırabilir. Gruplama (aynı timetable_card_id için birden çok sınıf
-- atamasının tek hücrede gösterilmesi) BİLEREK burada yapılmaz — ham atama
-- satırları olduğu gibi döndürülür, gruplama
-- server/services/teacherTimetables.ts içinde saf ve test edilebilir bir
-- fonksiyonla yapılır.
-- ============================================================================

create or replace function public.get_current_import_teachers(
  p_campus_name text,
  p_academic_year_name text
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
  v_teachers jsonb;
begin
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then
    return jsonb_build_object('hasImport', false, 'importedAt', null, 'teachers', '[]'::jsonb);
  end if;

  select id into v_year_id
    from public.academic_years
    where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then
    return jsonb_build_object('hasImport', false, 'importedAt', null, 'teachers', '[]'::jsonb);
  end if;

  select * into v_import
    from public.timetable_imports
    where campus_id = v_campus_id
      and academic_year_id = v_year_id
      and status = 'imported'
    order by imported_at desc nulls last, created_at desc
    limit 1;

  if not found then
    return jsonb_build_object('hasImport', false, 'importedAt', null, 'teachers', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id,
      'sourceId', t.source_id,
      'name', t.name,
      'branch', t.branch
    )), '[]'::jsonb)
    into v_teachers
    from public.teachers t
    where t.timetable_import_id = v_import.id;

  return jsonb_build_object(
    'hasImport', true,
    'importedAt', v_import.imported_at,
    'teachers', v_teachers
  );
end;
$$;

comment on function public.get_current_import_teachers(text, text) is
  'Salt okunur: mevcut (en güncel status=imported) importa ait öğretmen listesini döner. Sıralama yapmaz — bkz. server/services/teacherTimetables.ts Türkçe/numeric-aware/case-insensitive sıralama. Yalnız service_role çağırabilir.';

revoke all on function public.get_current_import_teachers(text, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.get_current_import_teachers(text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.get_current_import_teachers(text, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.get_current_import_teachers(text, text) to service_role;
  end if;
end
$$;

-- ============================================================================
-- get_teacher_timetable_snapshot
-- ============================================================================
create or replace function public.get_teacher_timetable_snapshot(
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
  v_days jsonb;
  v_periods jsonb;
  v_rows jsonb;
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

  -- teacher_id, MEVCUT (en güncel) importa ait DEĞİLSE — eski/superseded bir
  -- importtan geliyorsa veya hiç yoksa — kasıtlı olarak veri DÖNDÜRÜLMEZ.
  select id, source_id, name, branch into v_teacher
    from public.teachers
    where id = p_teacher_id and timetable_import_id = v_import.id;

  if not found then
    return jsonb_build_object('hasImport', true, 'teacherFound', false, 'importedAt', v_import.imported_at);
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

  -- Ham atama satırları (gruplama YOK — bkz. yukarıdaki dosya başlığı notu).
  select coalesce(jsonb_agg(jsonb_build_object(
      'cardId', tc.id,
      'sourceCardKey', tc.source_card_key,
      'dayId', a.timetable_day_id,
      'periodId', a.lesson_period_id,
      'subjectName', s.name,
      'className', sc.name,
      'classroom', a.classroom,
      'mappingStatus', a.mapping_status
    )), '[]'::jsonb)
    into v_rows
    from public.timetable_assignments a
    join public.timetable_cards tc on tc.id = a.timetable_card_id
    join public.school_classes sc on sc.id = a.school_class_id
    left join public.subjects s on s.id = a.subject_id
    where a.timetable_import_id = v_import.id
      and a.teacher_id = p_teacher_id;

  return jsonb_build_object(
    'hasImport', true,
    'teacherFound', true,
    'teacher', jsonb_build_object(
      'id', v_teacher.id, 'sourceId', v_teacher.source_id, 'name', v_teacher.name, 'branch', v_teacher.branch
    ),
    'importedAt', v_import.imported_at,
    'days', v_days,
    'periods', v_periods,
    'rows', v_rows
  );
end;
$$;

comment on function public.get_teacher_timetable_snapshot(text, text, uuid) is
  'Salt okunur: verilen teacher_id MEVCUT (en güncel status=imported) importa aitse, o öğretmenin gün/ders saati/ham atama satırlarını döner. Eski/bilinmeyen teacher_id için teacherFound=false (güvenli 404 kaynağı). Yalnız service_role çağırabilir.';

revoke all on function public.get_teacher_timetable_snapshot(text, text, uuid) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.get_teacher_timetable_snapshot(text, text, uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.get_teacher_timetable_snapshot(text, text, uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.get_teacher_timetable_snapshot(text, text, uuid) to service_role;
  end if;
end
$$;

-- Bu migration hiçbir RLS policy eklemez ve mevcut policy'siz durumu değiştirmez.
