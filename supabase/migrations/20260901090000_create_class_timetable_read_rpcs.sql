-- ============================================================================
-- Nöbet2027 — "Sınıf Ders Programı" ekranı için salt-okunur RPC'ler
-- ============================================================================
-- Bu migration iki fonksiyon ekler:
--   1) public.get_current_import_classes: mevcut (en güncel başarılı) importa
--      ait sınıf listesini döner (açılır liste için).
--   2) public.get_class_timetable_snapshot: seçilen bir sınıfın haftalık
--      programını (gün, ders saati, ham atama satırları) tek bir tutarlı
--      MVCC snapshot içinde döner.
--
-- Her iki fonksiyon da SALT OKUNUR (yalnız SELECT), STABLE, SECURITY INVOKER,
-- sabit search_path, dinamik SQL yok. Yalnız service_role çağırabilir — bkz.
-- 20260831203539_create_current_import_snapshot_rpc.sql'deki gerekçe (aynı
-- desen burada tekrarlanır).
--
-- Gruplama (aynı timetable_card_id için birden çok öğretmen×sınıf atama
-- satırının tek hücrede gösterilmesi) BİLEREK burada yapılmaz — ham atama
-- satırları olduğu gibi döndürülür, gruplama server/services/classTimetables.ts
-- içinde saf ve test edilebilir bir fonksiyonla yapılır.
-- ============================================================================

create or replace function public.get_current_import_classes(
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
  v_classes jsonb;
begin
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then
    return jsonb_build_object('hasImport', false, 'importedAt', null, 'classes', '[]'::jsonb);
  end if;

  select id into v_year_id
    from public.academic_years
    where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then
    return jsonb_build_object('hasImport', false, 'importedAt', null, 'classes', '[]'::jsonb);
  end if;

  select * into v_import
    from public.timetable_imports
    where campus_id = v_campus_id
      and academic_year_id = v_year_id
      and status = 'imported'
    order by imported_at desc nulls last, created_at desc
    limit 1;

  if not found then
    return jsonb_build_object('hasImport', false, 'importedAt', null, 'classes', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', sc.id,
      'sourceId', sc.source_id,
      'name', sc.name,
      'grade', sc.grade
    )), '[]'::jsonb)
    into v_classes
    from public.school_classes sc
    where sc.timetable_import_id = v_import.id;

  return jsonb_build_object(
    'hasImport', true,
    'importedAt', v_import.imported_at,
    'classes', v_classes
  );
end;
$$;

comment on function public.get_current_import_classes(text, text) is
  'Salt okunur: mevcut (en güncel status=imported) importa ait sınıf listesini döner. Sıralama yapmaz — bkz. server/services/classTimetables.ts numeric-aware sıralama. Yalnız service_role çağırabilir.';

revoke all on function public.get_current_import_classes(text, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.get_current_import_classes(text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.get_current_import_classes(text, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.get_current_import_classes(text, text) to service_role;
  end if;
end
$$;

-- ============================================================================
-- get_class_timetable_snapshot
-- ============================================================================
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

  -- class_id, MEVCUT (en güncel) importa ait DEĞİLSE — eski/superseded bir
  -- importtan geliyorsa veya hiç yoksa — kasıtlı olarak veri DÖNDÜRÜLMEZ.
  select id, source_id, name, grade into v_class
    from public.school_classes
    where id = p_class_id and timetable_import_id = v_import.id;

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

  -- Ham atama satırları (gruplama YOK — bkz. yukarıdaki dosya başlığı notu).
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
      'id', v_class.id, 'sourceId', v_class.source_id, 'name', v_class.name, 'grade', v_class.grade
    ),
    'importedAt', v_import.imported_at,
    'days', v_days,
    'periods', v_periods,
    'rows', v_rows
  );
end;
$$;

comment on function public.get_class_timetable_snapshot(text, text, uuid) is
  'Salt okunur: verilen class_id MEVCUT (en güncel status=imported) importa aitse, o sınıfın gün/ders saati/ham atama satırlarını döner. Eski/bilinmeyen class_id için classFound=false (güvenli 404 kaynağı). Yalnız service_role çağırabilir.';

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

-- Bu migration hiçbir RLS policy eklemez ve mevcut policy'siz durumu değiştirmez.
