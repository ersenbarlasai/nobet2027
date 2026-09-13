-- ============================================================================
-- Deneme kaydı temizleme: pending trigger event düzeltmesi
-- ============================================================================
-- 20261012090000 trigger'ları ALTER TABLE ile transaction içinde kapatıp
-- yeniden açıyordu. Cascade/FK işlemleri deferred trigger event oluşturduğu
-- için PostgreSQL yeniden açma adımını 55006 ile reddeder. Bu migration DDL
-- aç/kapa yaklaşımını kaldırır; yalnız clear_trial_records transaction'ında
-- etkin olan GUC bayrağını immutability trigger'larında tanır.

create or replace function public.prevent_duty_teacher_score_ledger_change()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if current_setting('nobet2027.bypass_duty_history_lock', true) = 'on' then
    return old;
  end if;
  raise exception 'Yayımlanmış nöbet puanı değiştirilemez.' using errcode = '55000';
end;
$$;

create or replace function public.enforce_duty_plan_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if current_setting('nobet2027.bypass_duty_history_lock', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'Yeni bir nöbet planı yalnız taslak (draft) olarak oluşturulabilir.' using errcode = '55000';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status in ('published', 'archived') then
      raise exception 'Yayımlanmış veya arşivlenmiş bir plan silinemez.' using errcode = '55000';
    end if;
    return old;
  end if;

  if old.status = 'archived' then
    raise exception 'Arşivlenmiş bir plan değiştirilemez.' using errcode = '55000';
  end if;
  if old.status = 'published' then
    if new.status is distinct from 'archived' then
      raise exception 'Yayımlanmış bir plan yalnız arşivlenebilir, başka biçimde değiştirilemez.' using errcode = '55000';
    end if;
    if new.campus_id is distinct from old.campus_id
       or new.academic_year_id is distinct from old.academic_year_id
       or new.timetable_import_id is distinct from old.timetable_import_id
       or new.source_fingerprint is distinct from old.source_fingerprint
       or new.algorithm_version is distinct from old.algorithm_version
       or new.generation_seed is distinct from old.generation_seed
       or new.generation_options is distinct from old.generation_options
       or new.summary is distinct from old.summary
       or new.version is distinct from old.version
       or new.created_at is distinct from old.created_at
    then
      raise exception 'Yayımlanmış bir plan arşivlenirken yalnız durum değişebilir; başka alan değiştirilemez.' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.enforce_duty_plan_assignment_write_rules()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_plan_status text;
  v_is_fixed_link_clear boolean := false;
begin
  if current_setting('nobet2027.bypass_duty_history_lock', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  select status into v_plan_status
    from public.duty_plans
    where id = coalesce(new.plan_id, old.plan_id);

  if tg_op = 'UPDATE' then
    v_is_fixed_link_clear := (
      old.assignment_kind = 'fixed'
      and new.assignment_kind = 'fixed'
      and old.fixed_duty_assignment_id is not null
      and new.fixed_duty_assignment_id is null
      and new.plan_id is not distinct from old.plan_id
      and new.campus_id is not distinct from old.campus_id
      and new.day_order is not distinct from old.day_order
      and new.duty_location_id is not distinct from old.duty_location_id
      and new.duty_block_id is not distinct from old.duty_block_id
      and new.teacher_source_id is not distinct from old.teacher_source_id
      and new.teacher_name_snapshot is not distinct from old.teacher_name_snapshot
      and new.duty_location_name_snapshot is not distinct from old.duty_location_name_snapshot
      and new.duty_block_name_snapshot is not distinct from old.duty_block_name_snapshot
      and new.score_details is not distinct from old.score_details
      and new.created_at is not distinct from old.created_at
    );
  end if;

  if v_plan_status in ('published', 'archived') and not v_is_fixed_link_clear then
    raise exception 'Yayımlanmış veya arşivlenmiş bir planın atamaları değiştirilemez.' using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if tg_op = 'UPDATE' and old.assignment_kind = 'fixed' and not v_is_fixed_link_clear and (
       new.assignment_kind is distinct from old.assignment_kind
    or new.teacher_source_id is distinct from old.teacher_source_id
    or new.duty_location_id is distinct from old.duty_location_id
    or new.duty_block_id is distinct from old.duty_block_id
    or new.day_order is distinct from old.day_order
  ) then
    raise exception 'Sabit görev hücreleri düzenlenemez.' using errcode = '55000';
  end if;

  return new;
end;
$$;

create or replace function public.enforce_duty_plan_package_write_rules()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_plan_status text;
  v_is_fixed_link_clear boolean := false;
begin
  if current_setting('nobet2027.bypass_duty_history_lock', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  select status into v_plan_status from public.duty_plans where id = coalesce(new.plan_id, old.plan_id);
  if tg_op = 'UPDATE' then
    v_is_fixed_link_clear := (
      old.assignment_kind = 'fixed' and new.assignment_kind = 'fixed'
      and old.fixed_duty_assignment_id is not null and new.fixed_duty_assignment_id is null
      and new.plan_id is not distinct from old.plan_id
      and new.campus_id is not distinct from old.campus_id
      and new.day_order is not distinct from old.day_order
      and new.duty_location_id is not distinct from old.duty_location_id
      and new.teacher_source_id is not distinct from old.teacher_source_id
      and new.teacher_name_snapshot is not distinct from old.teacher_name_snapshot
      and new.coverage_mode is not distinct from old.coverage_mode
      and new.created_at is not distinct from old.created_at
    );
  end if;
  if v_plan_status in ('published', 'archived') and not v_is_fixed_link_clear then
    raise exception 'Yayımlanmış veya arşivlenmiş bir planın görev paketleri değiştirilemez.' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'UPDATE' and old.assignment_kind = 'fixed' and not v_is_fixed_link_clear and (
       new.assignment_kind is distinct from old.assignment_kind
    or new.teacher_source_id is distinct from old.teacher_source_id
    or new.duty_location_id is distinct from old.duty_location_id
    or new.day_order is distinct from old.day_order
    or new.coverage_mode is distinct from old.coverage_mode
  ) then
    raise exception 'Sabit görev paketleri düzenlenemez.' using errcode = '55000';
  end if;
  return new;
end;
$$;

create or replace function public.clear_trial_records(
  p_campus_name text,
  p_academic_year_name text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_exam_plan_id uuid;
  v_duty_plans integer;
  v_exam_plans integer;
  v_assignment_lists integer;
  v_payroll_records integer;
  v_closed_periods integer;
begin
  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  select id into v_year_id from public.academic_years
    where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then return jsonb_build_object('status', 'not_found'); end if;

  select count(*) into v_duty_plans from public.duty_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id;
  select count(*) into v_exam_plans from public.exam_invigilation_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id;
  select count(*) into v_assignment_lists from public.substitution_day_lists
    where campus_id = v_campus_id and academic_year_id = v_year_id;
  select
    (select count(*) from public.manual_payroll_entries
      where campus_id = v_campus_id and academic_year_id = v_year_id)
    + (select count(*) from public.payroll_period_lines l
      join public.payroll_periods p on p.id = l.payroll_period_id
      where p.campus_id = v_campus_id and p.academic_year_id = v_year_id)
    into v_payroll_records;
  select count(*) into v_closed_periods from public.payroll_periods
    where campus_id = v_campus_id and academic_year_id = v_year_id and status = 'closed';

  for v_exam_plan_id in select id from public.exam_invigilation_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id order by id
  loop
    perform public.delete_exam_invigilation_plan(v_exam_plan_id);
  end loop;

  perform set_config('nobet2027.bypass_duty_history_lock', 'on', true);
  delete from public.duty_teacher_score_ledger where plan_id in (
    select id from public.duty_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id
  );
  delete from public.duty_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id;

  delete from public.payroll_period_lines where payroll_period_id in (
    select id from public.payroll_periods
    where campus_id = v_campus_id and academic_year_id = v_year_id
  );
  delete from public.payroll_period_teacher_totals where payroll_period_id in (
    select id from public.payroll_periods
    where campus_id = v_campus_id and academic_year_id = v_year_id
  );
  delete from public.payroll_periods
    where campus_id = v_campus_id and academic_year_id = v_year_id;
  delete from public.manual_payroll_entries
    where campus_id = v_campus_id and academic_year_id = v_year_id;

  perform set_config('nobet2027.bypass_history_lock', 'on', true);
  delete from public.teacher_absences
    where campus_id = v_campus_id and academic_year_id = v_year_id;
  delete from public.substitution_day_lists
    where campus_id = v_campus_id and academic_year_id = v_year_id;

  return jsonb_build_object('status', 'ok', 'deleted', jsonb_build_object(
    'dutyPlanCount', v_duty_plans,
    'examInvigilationPlanCount', v_exam_plans,
    'assignmentListCount', v_assignment_lists,
    'payrollRecordCount', v_payroll_records,
    'closedPeriodCount', v_closed_periods
  ));
end;
$$;

revoke all on function public.clear_trial_records(text, text) from public;
grant execute on function public.clear_trial_records(text, text) to service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.clear_trial_records(text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.clear_trial_records(text, text) from authenticated;
  end if;
end;
$$;
