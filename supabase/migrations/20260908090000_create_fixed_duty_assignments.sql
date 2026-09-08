-- Nöbet2027 — sabit nöbet atamaları
-- Öğretmen kimliği import-snapshot UUID yerine eğitim yılı içindeki kararlı
-- aSc source_id ile saklanır; yeni XML importunda atama kaybolmaz.

create table public.fixed_duty_assignments (
  id uuid primary key default gen_random_uuid(),
  campus_id uuid not null references public.campuses (id) on delete cascade,
  academic_year_id uuid not null,
  teacher_source_id text not null check (btrim(teacher_source_id) <> ''),
  teacher_name_snapshot text not null check (btrim(teacher_name_snapshot) <> ''),
  duty_location_id uuid not null,
  day_order smallint not null check (day_order between 1 and 5),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),

  constraint fixed_duty_assignments_year_campus_fk
    foreign key (academic_year_id, campus_id)
    references public.academic_years (id, campus_id) on delete cascade,
  constraint fixed_duty_assignments_location_campus_fk
    foreign key (duty_location_id, campus_id)
    references public.duty_locations (id, campus_id) on delete restrict,

  -- Bir gün ve nöbet yerinde yalnız bir sabit öğretmen olabilir.
  constraint fixed_duty_assignments_location_day_uq
    unique (academic_year_id, day_order, duty_location_id),
  -- Bir öğretmen aynı gün yalnız bir nöbet yerinde sabitlenebilir.
  constraint fixed_duty_assignments_teacher_day_uq
    unique (academic_year_id, day_order, teacher_source_id)
);

create index fixed_duty_assignments_campus_year_idx
  on public.fixed_duty_assignments (campus_id, academic_year_id);
create index fixed_duty_assignments_teacher_idx
  on public.fixed_duty_assignments (academic_year_id, teacher_source_id);

create trigger set_updated_at
  before update on public.fixed_duty_assignments
  for each row execute function public.set_updated_at();

alter table public.fixed_duty_assignments enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.fixed_duty_assignments from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.fixed_duty_assignments from authenticated;
  end if;
end
$$;

-- Tek snapshot: güncel importun öğretmen/gün listesi, aktif nöbet yerleri ve
-- mevcut sabit atamalar. Ayar yokluğu hata değildir.
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
    'dutyLocations', coalesce((
      select jsonb_agg(jsonb_build_object('id', dl.id, 'name', dl.name, 'shortCode', dl.short_code)
                       order by dl.sort_order, dl.name)
      from public.duty_locations dl
      where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null
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

  if not exists (
    select 1 from public.duty_locations dl
    where dl.id = p_duty_location_id and dl.campus_id = v_campus_id
      and dl.is_active and dl.deleted_at is null
  ) then return jsonb_build_object('status', 'location_not_found'); end if;

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

create or replace function public.delete_fixed_duty_assignment(
  p_campus_name text,
  p_academic_year_name text,
  p_assignment_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_deleted_id uuid;
begin
  delete from public.fixed_duty_assignments a
  using public.campuses c, public.academic_years ay
  where a.id = p_assignment_id
    and c.id = a.campus_id and c.name = p_campus_name
    and ay.id = a.academic_year_id and ay.campus_id = c.id
    and ay.name = p_academic_year_name
  returning a.id into v_deleted_id;

  if v_deleted_id is null then return jsonb_build_object('status', 'not_found'); end if;
  return jsonb_build_object('status', 'ok');
end;
$$;

revoke all on function public.get_fixed_duty_assignments(text, text) from public;
revoke all on function public.create_fixed_duty_assignment(text, text, uuid, integer, uuid) from public;
revoke all on function public.delete_fixed_duty_assignment(text, text, uuid) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.get_fixed_duty_assignments(text, text) from anon;
    revoke all on function public.create_fixed_duty_assignment(text, text, uuid, integer, uuid) from anon;
    revoke all on function public.delete_fixed_duty_assignment(text, text, uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.get_fixed_duty_assignments(text, text) from authenticated;
    revoke all on function public.create_fixed_duty_assignment(text, text, uuid, integer, uuid) from authenticated;
    revoke all on function public.delete_fixed_duty_assignment(text, text, uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.get_fixed_duty_assignments(text, text) to service_role;
    grant execute on function public.create_fixed_duty_assignment(text, text, uuid, integer, uuid) to service_role;
    grant execute on function public.delete_fixed_duty_assignment(text, text, uuid) to service_role;
  end if;
end
$$;
