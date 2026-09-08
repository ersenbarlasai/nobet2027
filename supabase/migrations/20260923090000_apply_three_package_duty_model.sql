-- Nöbet2027 — Üçlü normal görev modeli
-- Normal bir öğretmenin günlük görevi yalnız şu üç atomik paketten biridir:
--   TENEFFÜS = MORNING_BREAKS + AFTERNOON_BREAKS
--   ÖĞLE_1   = LONG_BREAK_1
--   ÖĞLE_2   = LONG_BREAK_2
-- FULL_DAY ve iki öğle bloğunu birleştiren paketler yeni v4 planlarda yasaktır.

-- Mevcut okul kuralı: İLKOKUL1/2 yalnız sabit teneffüs görevlerini taşır;
-- öğle bloklarında artık görev üretmez. Tarihsel tercih/plan satırlarına
-- dokunulmaz; yalnız güncel yer×blok gereksinimi değiştirilir.
delete from public.duty_location_blocks lb
using public.duty_locations dl, public.duty_blocks b
where lb.duty_location_id = dl.id
  and lb.duty_block_id = b.id
  and dl.deleted_at is null
  and upper(dl.short_code) in ('ILKOKUL1', 'ILKOKUL2')
  and b.code in ('LONG_BREAK_1', 'LONG_BREAK_2');

insert into public.duty_location_blocks (campus_id, duty_location_id, duty_block_id, assignment_mode)
select dl.campus_id, dl.id, b.id, 'fixed_only'
from public.duty_locations dl
cross join public.duty_blocks b
where dl.deleted_at is null
  and upper(dl.short_code) in ('ILKOKUL1', 'ILKOKUL2')
  and b.code in ('MORNING_BREAKS', 'AFTERNOON_BREAKS')
on conflict (duty_location_id, duty_block_id)
do update set assignment_mode = excluded.assignment_mode;

-- --------------------------------------------------------------------------
-- Yer×blok politikasını atomik ve optimistic-concurrency güvenli güncelleme
-- --------------------------------------------------------------------------
create or replace function public.set_duty_location_block_policies(
  p_campus_id uuid,
  p_duty_location_id uuid,
  p_policies jsonb,
  p_expected_updated_at timestamptz default null
)
returns public.duty_locations
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_location public.duty_locations;
  v_active_count integer;
  v_policy_count integer;
  v_morning_mode text;
  v_afternoon_mode text;
begin
  perform pg_advisory_xact_lock(hashtext('duty-location-policy:' || p_duty_location_id::text));

  select * into v_location
  from public.duty_locations
  where id = p_duty_location_id and campus_id = p_campus_id and deleted_at is null
  for update;
  if not found then
    raise exception 'duty_location_not_found' using errcode = 'P0002';
  end if;
  -- JSON/JavaScript ISO tarihleri milisaniye hassasiyetindedir; Postgres'in
  -- mikro-saniye artığını sahte version conflict sayma.
  if p_expected_updated_at is not null
     and date_trunc('milliseconds', v_location.updated_at) is distinct from date_trunc('milliseconds', p_expected_updated_at)
  then
    raise exception 'duty_location_version_conflict' using errcode = '40001';
  end if;
  if jsonb_typeof(p_policies) <> 'array' then
    raise exception 'block_policies_array_required' using errcode = '22023';
  end if;

  select count(*) into v_active_count from public.duty_blocks where is_active;
  with supplied as (
    select x.duty_block_id, x.assignment_mode
    from jsonb_to_recordset(p_policies) as x(duty_block_id uuid, assignment_mode text)
  )
  select count(*) into v_policy_count from supplied;

  if v_policy_count <> v_active_count
     or (select count(distinct x.duty_block_id)
         from jsonb_to_recordset(p_policies) as x(duty_block_id uuid, assignment_mode text)) <> v_active_count
     or exists (
       select 1
       from jsonb_to_recordset(p_policies) as x(duty_block_id uuid, assignment_mode text)
       left join public.duty_blocks b on b.id = x.duty_block_id and b.is_active
       where b.id is null or x.assignment_mode not in ('normal', 'fixed_only', 'off')
     )
  then
    raise exception 'invalid_block_policy_set' using errcode = '22023';
  end if;

  select
    max(x.assignment_mode) filter (where b.code = 'MORNING_BREAKS'),
    max(x.assignment_mode) filter (where b.code = 'AFTERNOON_BREAKS')
  into v_morning_mode, v_afternoon_mode
  from jsonb_to_recordset(p_policies) as x(duty_block_id uuid, assignment_mode text)
  join public.duty_blocks b on b.id = x.duty_block_id;

  if v_morning_mode is distinct from v_afternoon_mode then
    raise exception 'morning_afternoon_policy_must_match' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_policies) as x(duty_block_id uuid, assignment_mode text)
    join public.duty_blocks b on b.id = x.duty_block_id
    where b.code in ('LONG_BREAK_1', 'LONG_BREAK_2') and x.assignment_mode = 'fixed_only'
  ) then
    raise exception 'lunch_blocks_cannot_be_fixed_only' using errcode = '22023';
  end if;

  delete from public.duty_location_blocks where duty_location_id = p_duty_location_id;
  insert into public.duty_location_blocks (campus_id, duty_location_id, duty_block_id, assignment_mode)
  select p_campus_id, p_duty_location_id, x.duty_block_id, x.assignment_mode
  from jsonb_to_recordset(p_policies) as x(duty_block_id uuid, assignment_mode text)
  where x.assignment_mode <> 'off';

  update public.duty_locations
  set allows_fixed_assignment = (v_morning_mode = 'fixed_only'),
      updated_at = timezone('utc', now())
  where id = p_duty_location_id
  returning * into v_location;
  return v_location;
end;
$$;

create or replace function public.create_duty_location_with_block_policies(
  p_campus_id uuid,
  p_name text,
  p_short_code text,
  p_category text,
  p_capacity integer,
  p_description text,
  p_is_active boolean,
  p_policies jsonb
)
returns public.duty_locations
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_location public.duty_locations;
begin
  v_location := public.create_duty_location(
    p_campus_id, p_name, p_short_code, p_category, p_capacity, p_description, p_is_active
  );
  return public.set_duty_location_block_policies(
    p_campus_id, v_location.id, p_policies, v_location.updated_at
  );
end;
$$;

create or replace function public.update_duty_location_with_block_policies(
  p_campus_id uuid,
  p_duty_location_id uuid,
  p_name text,
  p_category text,
  p_capacity integer,
  p_description text,
  p_is_active boolean,
  p_policies jsonb,
  p_expected_updated_at timestamptz
)
returns public.duty_locations
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_location public.duty_locations;
begin
  -- İlk çağrı satırı FOR UPDATE ile kilitler ve expectedUpdatedAt değerini
  -- denetler. Aşağıdaki alan güncellemesi aynı transaction içindedir.
  perform public.set_duty_location_block_policies(
    p_campus_id, p_duty_location_id, p_policies, p_expected_updated_at
  );
  update public.duty_locations
  set name = p_name,
      category = p_category,
      capacity = p_capacity,
      description = p_description,
      is_active = p_is_active,
      updated_at = timezone('utc', now())
  where id = p_duty_location_id and campus_id = p_campus_id and deleted_at is null
  returning * into v_location;
  if not found then raise exception 'duty_location_not_found' using errcode = 'P0002'; end if;
  return v_location;
end;
$$;

revoke all on function public.set_duty_location_block_policies(uuid, uuid, jsonb, timestamptz) from public;
revoke all on function public.create_duty_location_with_block_policies(uuid, text, text, text, integer, text, boolean, jsonb) from public;
revoke all on function public.update_duty_location_with_block_policies(uuid, uuid, text, text, integer, text, boolean, jsonb, timestamptz) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.set_duty_location_block_policies(uuid, uuid, jsonb, timestamptz) from anon;
    revoke all on function public.create_duty_location_with_block_policies(uuid, text, text, text, integer, text, boolean, jsonb) from anon;
    revoke all on function public.update_duty_location_with_block_policies(uuid, uuid, text, text, integer, text, boolean, jsonb, timestamptz) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.set_duty_location_block_policies(uuid, uuid, jsonb, timestamptz) from authenticated;
    revoke all on function public.create_duty_location_with_block_policies(uuid, text, text, text, integer, text, boolean, jsonb) from authenticated;
    revoke all on function public.update_duty_location_with_block_policies(uuid, uuid, text, text, integer, text, boolean, jsonb, timestamptz) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.set_duty_location_block_policies(uuid, uuid, jsonb, timestamptz) to service_role;
    grant execute on function public.create_duty_location_with_block_policies(uuid, text, text, text, integer, text, boolean, jsonb) to service_role;
    grant execute on function public.update_duty_location_with_block_policies(uuid, uuid, text, text, integer, text, boolean, jsonb, timestamptz) to service_role;
  end if;
end;
$$;

-- --------------------------------------------------------------------------
-- v4 planları için ertelenmiş bütünlük kontrolü. Paket ve hücreler aynı
-- transaction içinde ayrı INSERT/UPDATE gördüğü için kontrol COMMIT öncesinde
-- çalışır; geçici ara durumlara bakıp yanlış ret üretmez.
-- --------------------------------------------------------------------------
create or replace function public.enforce_duty_plan_teacher_day_rules()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_plan record;
  v_teacher text := coalesce(new.teacher_source_id, old.teacher_source_id);
  v_day smallint := coalesce(new.day_order, old.day_order);
  v_normal_count integer;
  v_has_fixed boolean;
  v_half_day boolean;
begin
  if v_teacher is null then return null; end if;
  select p.id, p.status, p.academic_year_id, p.algorithm_version
  into v_plan from public.duty_plans p where p.id = coalesce(new.plan_id, old.plan_id);
  if not found or v_plan.status <> 'draft' then return null; end if;

  if v_plan.algorithm_version like 'duty-plan-solver-v4-three-packages%' then
    -- TENEFFÜS iki hücredir ama BİR görev paketidir. v4'te günlük sınır
    -- half_day toggle'ından bağımsız, her öğretmen için tek normal pakettir.
    select count(distinct a.package_id) into v_normal_count
    from public.duty_plan_assignments a
    where a.plan_id=v_plan.id and a.day_order=v_day and a.teacher_source_id=v_teacher
      and a.assignment_kind in ('generated','manual');
  else
    select count(*) into v_normal_count
    from public.duty_plan_assignments a
    where a.plan_id=v_plan.id and a.day_order=v_day and a.teacher_source_id=v_teacher
      and a.assignment_kind in ('generated','manual');
  end if;
  if v_normal_count=0 then return null; end if;

  select exists (
    select 1 from public.fixed_duty_assignments f
    where f.academic_year_id=v_plan.academic_year_id
      and f.teacher_source_id=v_teacher and f.day_order=v_day
  ) into v_has_fixed;
  if v_has_fixed then
    raise exception 'Öğretmen % gün %: sabit nöbet günüdür, normal görev alamaz.', v_teacher, v_day
      using errcode='23514', constraint='duty_plan_teacher_has_fixed_duty';
  end if;

  if v_plan.algorithm_version like 'duty-plan-solver-v4-three-packages%' then
    if v_normal_count > 1 then
      raise exception 'Öğretmen % gün %: v4 modelinde aynı gün yalnız bir normal paket alabilir.', v_teacher, v_day
        using errcode='23514', constraint='duty_plan_v4_teacher_daily_package_limit';
    end if;
    return null;
  end if;

  select coalesce(s.half_day_rule_enabled,true) into v_half_day
  from public.teacher_duty_settings s
  where s.academic_year_id=v_plan.academic_year_id and s.teacher_source_id=v_teacher;
  if coalesce(v_half_day,true) and v_normal_count>1 then
    raise exception 'Öğretmen % gün %: yarım gün kuralı açık, aynı gün yalnız bir normal görev alabilir.', v_teacher, v_day
      using errcode='23514', constraint='duty_plan_teacher_half_day_rule';
  end if;
  if v_normal_count>4 then
    raise exception 'Öğretmen % gün %: günlük normal görev sayısı dört bloğu aşamaz.', v_teacher, v_day
      using errcode='23514', constraint='duty_plan_teacher_day_block_limit';
  end if;
  return null;
end;
$$;

create or replace function public.enforce_duty_plan_v4_three_package_model()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_plan_id uuid;
  v_algorithm text;
begin
  v_plan_id := case when tg_op = 'DELETE' then old.plan_id else new.plan_id end;
  select algorithm_version into v_algorithm from public.duty_plans where id = v_plan_id;
  if v_algorithm is null or v_algorithm not like 'duty-plan-solver-v4-three-packages%' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if exists (
    select 1 from public.duty_plan_assignment_packages p
    where p.plan_id = v_plan_id and p.coverage_mode not in ('SHORT_BREAKS', 'SINGLE_BLOCK', 'FIXED_SHORT_BREAKS')
  ) then
    raise exception 'v4_unsupported_package_mode' using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.duty_plan_assignment_packages p
    left join public.duty_plan_assignments a on a.plan_id = p.plan_id and a.package_id = p.id
    left join public.duty_blocks b on b.id = a.duty_block_id
    where p.plan_id = v_plan_id and p.assignment_kind <> 'fixed'
    group by p.id, p.coverage_mode
    having (p.coverage_mode = 'SHORT_BREAKS' and (
              count(a.id) <> 2
              or array_agg(distinct b.code order by b.code) <> array['AFTERNOON_BREAKS','MORNING_BREAKS']::text[]
           ))
        or (p.coverage_mode = 'SINGLE_BLOCK' and (
              count(a.id) <> 1
              or min(b.code) not in ('LONG_BREAK_1','LONG_BREAK_2')
           ))
  ) then
    raise exception 'v4_invalid_package_cells' using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.duty_plan_assignment_packages p
    where p.plan_id = v_plan_id and p.assignment_kind <> 'fixed'
    group by p.day_order, p.teacher_source_id
    having count(*) > 1
  ) then
    raise exception 'v4_teacher_daily_package_limit' using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists enforce_duty_plan_v4_packages_on_packages on public.duty_plan_assignment_packages;
create constraint trigger enforce_duty_plan_v4_packages_on_packages
after insert or update or delete on public.duty_plan_assignment_packages
deferrable initially deferred
for each row execute function public.enforce_duty_plan_v4_three_package_model();

drop trigger if exists enforce_duty_plan_v4_packages_on_assignments on public.duty_plan_assignments;
create constraint trigger enforce_duty_plan_v4_packages_on_assignments
after insert or update or delete on public.duty_plan_assignments
deferrable initially deferred
for each row execute function public.enforce_duty_plan_v4_three_package_model();

comment on function public.enforce_duty_plan_v4_three_package_model() is
  'v4 taslaklarında yalnız TENEFFÜS (Sabah+Öğleden Sonra), ÖĞLE_1 ve ÖĞLE_2 normal paketlerine izin verir; normal öğretmeni günde tek pakete sınırlar.';
