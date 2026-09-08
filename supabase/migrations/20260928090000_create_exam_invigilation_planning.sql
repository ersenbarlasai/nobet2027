-- ============================================================================
-- Deneme sınavı gözetmen planlama
-- ============================================================================
-- Ortaokul ve Lise kapsamları bağımsız tamamlanır; öğretmen havuzu ortaktır.
-- Ders çakışması ve diğer kapsamdaki rezervasyon kesin engeldir. Aynı gün
-- nöbeti bulunan öğretmen aday kalır, ancak açık idari devir onayı gerekir.

create table public.exam_invigilation_plans (
  id uuid primary key default gen_random_uuid(),
  campus_id uuid not null references public.campuses(id) on delete restrict,
  academic_year_id uuid not null references public.academic_years(id) on delete restrict,
  timetable_import_id uuid not null references public.timetable_imports(id) on delete restrict,
  duty_plan_id uuid not null references public.duty_plans(id) on delete restrict,
  name text not null check (btrim(name) <> ''),
  week_start_date date not null check (extract(isodow from week_start_date) = 1),
  exam_date date not null,
  source_fingerprint text not null check (btrim(source_fingerprint) <> ''),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint exam_invigilation_plan_date_ck check (exam_date between week_start_date and week_start_date + 4),
  constraint exam_invigilation_plan_scope_uq unique (campus_id, academic_year_id, name, exam_date)
);

create table public.exam_invigilation_scopes (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.exam_invigilation_plans(id) on delete cascade,
  scope_code text not null check (scope_code in ('MIDDLE_SCHOOL','HIGH_SCHOOL')),
  status text not null default 'draft' check (status in ('draft','completed')),
  version integer not null default 1 check (version > 0),
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint exam_invigilation_scope_uq unique (plan_id, scope_code),
  constraint exam_invigilation_scope_completed_ck check ((status='completed') = (completed_at is not null))
);

create table public.exam_invigilation_sessions (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.exam_invigilation_plans(id) on delete cascade,
  scope_id uuid not null references public.exam_invigilation_scopes(id) on delete cascade,
  lesson_period_id uuid not null references public.lesson_periods(id) on delete restrict,
  period_order integer not null check (period_order > 0),
  period_name_snapshot text not null check (btrim(period_name_snapshot) <> ''),
  starts_at_snapshot time,
  ends_at_snapshot time,
  required_invigilator_count integer not null default 1 check (required_invigilator_count between 1 and 20),
  created_at timestamptz not null default timezone('utc', now()),
  constraint exam_invigilation_session_uq unique (scope_id, period_order)
);

create table public.exam_invigilation_assignments (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.exam_invigilation_plans(id) on delete cascade,
  scope_id uuid not null references public.exam_invigilation_scopes(id) on delete cascade,
  session_id uuid not null references public.exam_invigilation_sessions(id) on delete cascade,
  campus_id uuid not null references public.campuses(id) on delete restrict,
  exam_date date not null,
  period_order integer not null check (period_order > 0),
  slot_number integer not null check (slot_number between 1 and 20),
  teacher_source_id text not null check (btrim(teacher_source_id) <> ''),
  teacher_name_snapshot text not null check (btrim(teacher_name_snapshot) <> ''),
  duty_warning jsonb,
  duty_coverage_acknowledged boolean not null default false,
  duty_coverage_note text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint exam_invigilation_assignment_slot_uq unique (session_id, slot_number),
  constraint exam_invigilation_assignment_teacher_period_uq unique (campus_id, exam_date, period_order, teacher_source_id),
  constraint exam_invigilation_assignment_warning_ck check (
    (duty_warning is null and not duty_coverage_acknowledged and duty_coverage_note is null)
    or duty_warning is not null
  )
);

create index exam_invigilation_plans_week_idx on public.exam_invigilation_plans(campus_id, academic_year_id, week_start_date desc);
create index exam_invigilation_assignments_teacher_idx on public.exam_invigilation_assignments(campus_id, teacher_source_id, exam_date);

create trigger set_updated_at before update on public.exam_invigilation_plans
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.exam_invigilation_scopes
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.exam_invigilation_assignments
  for each row execute function public.set_updated_at();

alter table public.exam_invigilation_plans enable row level security;
alter table public.exam_invigilation_scopes enable row level security;
alter table public.exam_invigilation_sessions enable row level security;
alter table public.exam_invigilation_assignments enable row level security;
revoke all on public.exam_invigilation_plans, public.exam_invigilation_scopes,
  public.exam_invigilation_sessions, public.exam_invigilation_assignments from public, anon, authenticated;
grant select, insert, update, delete on public.exam_invigilation_plans, public.exam_invigilation_scopes,
  public.exam_invigilation_sessions, public.exam_invigilation_assignments to service_role;

create or replace function public.exam_invigilation_current_fingerprint(
  p_timetable_import_id uuid, p_duty_plan_id uuid
) returns text language sql stable security invoker
set search_path = pg_catalog, public, extensions as $$
  select encode(extensions.digest(
    coalesce(p_timetable_import_id::text,'') || '|' || coalesce(p_duty_plan_id::text,'') || '|' ||
    coalesce((select ti.id::text from public.duty_plans dp
      join public.timetable_imports ti on ti.campus_id=dp.campus_id and ti.academic_year_id=dp.academic_year_id
      where dp.id=p_duty_plan_id and ti.status='imported'
      order by ti.imported_at desc limit 1),'missing-current-import') || '|' ||
    coalesce((select version::text from public.duty_plans where id=p_duty_plan_id),'missing') || '|' ||
    coalesce((select status from public.duty_plans where id=p_duty_plan_id),'missing'), 'sha256'), 'hex');
$$;

create or replace function public.create_exam_invigilation_plan(
  p_campus_name text,
  p_academic_year_name text,
  p_name text,
  p_week_start_date date,
  p_exam_date date,
  p_period_orders integer[],
  p_middle_required integer default 1,
  p_high_required integer default 1
) returns jsonb language plpgsql security invoker
set search_path = pg_catalog, public, extensions as $$
declare
  v_campus_id uuid; v_year_id uuid; v_import_id uuid; v_duty_plan_id uuid;
  v_plan_id uuid; v_middle_id uuid; v_high_id uuid; v_period_count integer;
begin
  if coalesce(btrim(p_name),'')='' or extract(isodow from p_week_start_date)<>1
     or p_exam_date not between p_week_start_date and p_week_start_date+4
     or cardinality(p_period_orders)<1 or p_middle_required not between 1 and 20
     or p_high_required not between 1 and 20 then
    return jsonb_build_object('status','validation_error');
  end if;
  if p_period_orders <> (select array_agg(x order by x) from (select distinct unnest(p_period_orders) x) q) then
    return jsonb_build_object('status','validation_error');
  end if;
  select id into v_campus_id from public.campuses where name=p_campus_name;
  select id into v_year_id from public.academic_years where campus_id=v_campus_id and name=p_academic_year_name;
  if v_campus_id is null or v_year_id is null then return jsonb_build_object('status','context_not_found'); end if;
  select id into v_import_id from public.timetable_imports
   where campus_id=v_campus_id and academic_year_id=v_year_id and status='imported'
   order by imported_at desc limit 1;
  if v_import_id is null then return jsonb_build_object('status','no_import'); end if;
  select id into v_duty_plan_id from public.duty_plans
   where campus_id=v_campus_id and academic_year_id=v_year_id
     and week_start_date=p_week_start_date and status='published';
  if v_duty_plan_id is null then return jsonb_build_object('status','published_duty_plan_not_found'); end if;
  select count(*) into v_period_count from public.lesson_periods
   where timetable_import_id=v_import_id and period_order=any(p_period_orders);
  if v_period_count<>cardinality(p_period_orders) then return jsonb_build_object('status','period_not_found'); end if;

  insert into public.exam_invigilation_plans(campus_id,academic_year_id,timetable_import_id,duty_plan_id,name,week_start_date,exam_date,source_fingerprint)
  values(v_campus_id,v_year_id,v_import_id,v_duty_plan_id,btrim(p_name),p_week_start_date,p_exam_date,
         public.exam_invigilation_current_fingerprint(v_import_id,v_duty_plan_id)) returning id into v_plan_id;
  insert into public.exam_invigilation_scopes(plan_id,scope_code) values(v_plan_id,'MIDDLE_SCHOOL') returning id into v_middle_id;
  insert into public.exam_invigilation_scopes(plan_id,scope_code) values(v_plan_id,'HIGH_SCHOOL') returning id into v_high_id;
  insert into public.exam_invigilation_sessions(plan_id,scope_id,lesson_period_id,period_order,period_name_snapshot,starts_at_snapshot,ends_at_snapshot,required_invigilator_count)
  select v_plan_id,v_middle_id,id,period_order,name,starts_at,ends_at,p_middle_required
    from public.lesson_periods where timetable_import_id=v_import_id and period_order=any(p_period_orders);
  insert into public.exam_invigilation_sessions(plan_id,scope_id,lesson_period_id,period_order,period_name_snapshot,starts_at_snapshot,ends_at_snapshot,required_invigilator_count)
  select v_plan_id,v_high_id,id,period_order,name,starts_at,ends_at,p_high_required
    from public.lesson_periods where timetable_import_id=v_import_id and period_order=any(p_period_orders);
  return jsonb_build_object('status','ok','planId',v_plan_id);
exception when unique_violation then
  return jsonb_build_object('status','duplicate_plan');
end;
$$;

create or replace function public.list_exam_invigilation_plans(
  p_campus_name text, p_academic_year_name text
) returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public as $$
declare v_campus_id uuid; v_year_id uuid; v_items jsonb;
begin
  select id into v_campus_id from public.campuses where name=p_campus_name;
  select id into v_year_id from public.academic_years where campus_id=v_campus_id and name=p_academic_year_name;
  if v_campus_id is null or v_year_id is null then return jsonb_build_object('items','[]'::jsonb); end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'name',p.name,'weekStartDate',p.week_start_date,'examDate',p.exam_date,
    'createdAt',p.created_at,'updatedAt',p.updated_at,'scopes',(
      select jsonb_agg(jsonb_build_object('scopeCode',s.scope_code,'status',s.status,'version',s.version,
        'requiredCount',(select coalesce(sum(x.required_invigilator_count),0) from public.exam_invigilation_sessions x where x.scope_id=s.id),
        'assignedCount',(select count(*) from public.exam_invigilation_assignments a where a.scope_id=s.id)) order by s.scope_code)
      from public.exam_invigilation_scopes s where s.plan_id=p.id)) order by p.exam_date desc,p.created_at desc),'[]'::jsonb)
  into v_items from public.exam_invigilation_plans p where p.campus_id=v_campus_id and p.academic_year_id=v_year_id;
  return jsonb_build_object('items',v_items);
end;
$$;

create or replace function public.get_exam_invigilation_preparation(
  p_campus_name text, p_academic_year_name text
) returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public as $$
declare v_campus_id uuid; v_year_id uuid; v_import_id uuid; v_periods jsonb; v_weeks jsonb; v_teacher_count integer;
begin
  select id into v_campus_id from public.campuses where name=p_campus_name;
  select id into v_year_id from public.academic_years where campus_id=v_campus_id and name=p_academic_year_name;
  if v_campus_id is null or v_year_id is null then return jsonb_build_object('hasImport',false,'periods','[]'::jsonb,'publishedWeeks','[]'::jsonb); end if;
  select id into v_import_id from public.timetable_imports where campus_id=v_campus_id and academic_year_id=v_year_id and status='imported' order by imported_at desc limit 1;
  if v_import_id is null then return jsonb_build_object('hasImport',false,'periods','[]'::jsonb,'publishedWeeks','[]'::jsonb); end if;
  select coalesce(jsonb_agg(jsonb_build_object('periodOrder',period_order,'name',name,'startsAt',starts_at,'endsAt',ends_at) order by period_order),'[]'::jsonb)
    into v_periods from public.lesson_periods where timetable_import_id=v_import_id;
  select coalesce(jsonb_agg(jsonb_build_object('planId',id,'weekStartDate',week_start_date,'version',version) order by week_start_date desc),'[]'::jsonb)
    into v_weeks from public.duty_plans where campus_id=v_campus_id and academic_year_id=v_year_id and status='published';
  select count(*) into v_teacher_count from public.teachers where timetable_import_id=v_import_id;
  return jsonb_build_object('hasImport',true,'teacherCount',v_teacher_count,'periods',v_periods,'publishedWeeks',v_weeks);
end;
$$;

create or replace function public.get_exam_invigilation_plan(
  p_plan_id uuid, p_campus_name text, p_academic_year_name text
) returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public as $$
declare v_plan public.exam_invigilation_plans%rowtype; v_campus_id uuid; v_year_id uuid; v_scopes jsonb;
begin
  select id into v_campus_id from public.campuses where name=p_campus_name;
  select id into v_year_id from public.academic_years where campus_id=v_campus_id and name=p_academic_year_name;
  select * into v_plan from public.exam_invigilation_plans where id=p_plan_id and campus_id=v_campus_id and academic_year_id=v_year_id;
  if not found then return jsonb_build_object('found',false); end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',s.id,'scopeCode',s.scope_code,'status',s.status,'version',s.version,'completedAt',s.completed_at,
    'sessions',(select coalesce(jsonb_agg(jsonb_build_object(
      'id',x.id,'periodOrder',x.period_order,'periodName',x.period_name_snapshot,
      'startsAt',x.starts_at_snapshot,'endsAt',x.ends_at_snapshot,'requiredCount',x.required_invigilator_count,
      'assignments',(select coalesce(jsonb_agg(jsonb_build_object(
        'id',a.id,'slotNumber',a.slot_number,'teacherSourceId',a.teacher_source_id,'teacherName',a.teacher_name_snapshot,
        'dutyWarning',a.duty_warning,'dutyCoverageAcknowledged',a.duty_coverage_acknowledged,
        'dutyCoverageNote',a.duty_coverage_note) order by a.slot_number),'[]'::jsonb)
        from public.exam_invigilation_assignments a where a.session_id=x.id)
      ) order by x.period_order),'[]'::jsonb) from public.exam_invigilation_sessions x where x.scope_id=s.id)
  ) order by s.scope_code),'[]'::jsonb) into v_scopes from public.exam_invigilation_scopes s where s.plan_id=v_plan.id;
  return jsonb_build_object('found',true,'id',v_plan.id,'name',v_plan.name,'weekStartDate',v_plan.week_start_date,
    'examDate',v_plan.exam_date,'timetableImportId',v_plan.timetable_import_id,'dutyPlanId',v_plan.duty_plan_id,
    'sourceFingerprint',v_plan.source_fingerprint,
    'isStale',v_plan.source_fingerprint is distinct from public.exam_invigilation_current_fingerprint(v_plan.timetable_import_id,v_plan.duty_plan_id),
    'createdAt',v_plan.created_at,'updatedAt',v_plan.updated_at,'scopes',v_scopes);
end;
$$;

create or replace function public.get_exam_invigilation_candidates(
  p_plan_id uuid, p_session_id uuid, p_campus_name text, p_academic_year_name text
) returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public as $$
declare v_plan public.exam_invigilation_plans%rowtype; v_session public.exam_invigilation_sessions%rowtype;
  v_scope public.exam_invigilation_scopes%rowtype; v_campus_id uuid; v_year_id uuid; v_candidates jsonb; v_excluded jsonb;
begin
  select id into v_campus_id from public.campuses where name=p_campus_name;
  select id into v_year_id from public.academic_years where campus_id=v_campus_id and name=p_academic_year_name;
  select * into v_plan from public.exam_invigilation_plans where id=p_plan_id and campus_id=v_campus_id and academic_year_id=v_year_id;
  if not found then return jsonb_build_object('found',false); end if;
  select * into v_session from public.exam_invigilation_sessions where id=p_session_id and plan_id=v_plan.id;
  if not found then return jsonb_build_object('found',true,'sessionFound',false); end if;
  select * into v_scope from public.exam_invigilation_scopes where id=v_session.scope_id;

  with teacher_rows as (
    select t.source_id,t.name,t.branch,
      exists(select 1 from public.timetable_assignments ta join public.timetable_days d on d.id=ta.timetable_day_id
        where ta.timetable_import_id=v_plan.timetable_import_id and ta.teacher_id=t.id
          and d.day_order=extract(isodow from v_plan.exam_date)::int and ta.lesson_period_id=v_session.lesson_period_id) lesson_conflict,
      exists(select 1 from public.exam_invigilation_assignments a join public.exam_invigilation_scopes os on os.id=a.scope_id
        where a.plan_id=v_plan.id and a.teacher_source_id=t.source_id and os.id<>v_scope.id) other_scope_conflict,
      exists(select 1 from public.exam_invigilation_assignments a
        where a.campus_id=v_plan.campus_id and a.exam_date=v_plan.exam_date and a.period_order=v_session.period_order
          and a.teacher_source_id=t.source_id) period_conflict,
      (select coalesce(jsonb_agg(jsonb_build_object('packageId',p.id,'locationName',coalesce(mina.location_name,'Nöbet yeri'),
          'coverageMode',p.coverage_mode) order by coalesce(mina.location_name,'Nöbet yeri')),'[]'::jsonb)
       from public.duty_plan_assignment_packages p
       left join lateral (select min(a.duty_location_name_snapshot) location_name from public.duty_plan_assignments a where a.package_id=p.id) mina on true
       where p.plan_id=v_plan.duty_plan_id and p.day_order=extract(isodow from v_plan.exam_date)::int
         and p.teacher_source_id=t.source_id) duty_warnings,
      (select count(*) from public.timetable_assignments ta join public.timetable_days d on d.id=ta.timetable_day_id
        where ta.timetable_import_id=v_plan.timetable_import_id and ta.teacher_id=t.id
          and d.day_order=extract(isodow from v_plan.exam_date)::int) daily_lesson_count,
      (select count(*) from public.exam_invigilation_assignments a join public.exam_invigilation_scopes hs on hs.id=a.scope_id and hs.status='completed'
       join public.exam_invigilation_plans hp on hp.id=a.plan_id where hp.campus_id=v_plan.campus_id and hp.academic_year_id=v_plan.academic_year_id
         and hp.exam_date<v_plan.exam_date and a.teacher_source_id=t.source_id) previous_invigilation_count,
      (select coalesce(sum(l.points),0) from public.duty_teacher_score_ledger l where l.plan_id=v_plan.duty_plan_id and l.teacher_source_id=t.source_id) weekly_duty_points
    from public.teachers t where t.timetable_import_id=v_plan.timetable_import_id
  ), eligible as (
    select * from teacher_rows where not lesson_conflict and not other_scope_conflict and not period_conflict
  )
  select coalesce(jsonb_agg(jsonb_build_object('teacherSourceId',source_id,'teacherName',name,'branch',branch,
    'dailyLessonCount',daily_lesson_count,'previousInvigilationCount',previous_invigilation_count,
    'weeklyDutyPoints',weekly_duty_points,'suitability',case when jsonb_array_length(duty_warnings)>0 then 'duty_coverage_required' else 'direct' end,
    'dutyWarnings',duty_warnings) order by (jsonb_array_length(duty_warnings)>0),previous_invigilation_count,daily_lesson_count,name),'[]'::jsonb)
  into v_candidates from eligible;

  with flags as (
    select t.id,
      exists(select 1 from public.timetable_assignments ta join public.timetable_days d on d.id=ta.timetable_day_id
        where ta.timetable_import_id=v_plan.timetable_import_id and ta.teacher_id=t.id and d.day_order=extract(isodow from v_plan.exam_date)::int and ta.lesson_period_id=v_session.lesson_period_id) lesson,
      exists(select 1 from public.exam_invigilation_assignments a join public.exam_invigilation_scopes os on os.id=a.scope_id
        where a.plan_id=v_plan.id and a.teacher_source_id=t.source_id and os.id<>v_scope.id) other_scope,
      exists(select 1 from public.exam_invigilation_assignments a where a.campus_id=v_plan.campus_id and a.exam_date=v_plan.exam_date
        and a.period_order=v_session.period_order and a.teacher_source_id=t.source_id) other_session
    from public.teachers t where t.timetable_import_id=v_plan.timetable_import_id)
  select jsonb_build_object('lessonConflict',count(*) filter(where lesson),'otherScope',count(*) filter(where other_scope),
    'otherSession',count(*) filter(where other_session)) into v_excluded from flags;
  return jsonb_build_object('found',true,'sessionFound',true,'scopeVersion',v_scope.version,'isStale',
    v_plan.source_fingerprint is distinct from public.exam_invigilation_current_fingerprint(v_plan.timetable_import_id,v_plan.duty_plan_id),
    'candidates',v_candidates,'excludedCounts',v_excluded);
end;
$$;

create or replace function public.set_exam_invigilation_assignment(
  p_plan_id uuid, p_session_id uuid, p_slot_number integer, p_teacher_source_id text,
  p_expected_scope_version integer, p_duty_coverage_acknowledged boolean default false,
  p_duty_coverage_note text default null
) returns jsonb language plpgsql security invoker
set search_path = pg_catalog, public as $$
declare v_plan public.exam_invigilation_plans%rowtype; v_session public.exam_invigilation_sessions%rowtype;
  v_scope public.exam_invigilation_scopes%rowtype; v_teacher record; v_warning jsonb; v_conflict record; v_assignment_id uuid;
begin
  select * into v_plan from public.exam_invigilation_plans where id=p_plan_id;
  if not found then return jsonb_build_object('status','plan_not_found'); end if;
  select * into v_session from public.exam_invigilation_sessions where id=p_session_id and plan_id=v_plan.id;
  if not found or p_slot_number not between 1 and v_session.required_invigilator_count then return jsonb_build_object('status','session_not_found'); end if;
  select * into v_scope from public.exam_invigilation_scopes where id=v_session.scope_id for update;
  if v_scope.status<>'draft' then return jsonb_build_object('status','scope_completed'); end if;
  if v_scope.version<>p_expected_scope_version then return jsonb_build_object('status','version_conflict','currentVersion',v_scope.version); end if;
  if v_plan.source_fingerprint is distinct from public.exam_invigilation_current_fingerprint(v_plan.timetable_import_id,v_plan.duty_plan_id) then
    return jsonb_build_object('status','source_stale');
  end if;
  if p_teacher_source_id is null then
    delete from public.exam_invigilation_assignments where session_id=v_session.id and slot_number=p_slot_number;
    update public.exam_invigilation_scopes set version=version+1 where id=v_scope.id returning version into v_scope.version;
    return jsonb_build_object('status','ok','scopeVersion',v_scope.version,'assignmentId',null);
  end if;
  select id,source_id,name into v_teacher from public.teachers where timetable_import_id=v_plan.timetable_import_id and source_id=p_teacher_source_id;
  if not found then return jsonb_build_object('status','teacher_not_found'); end if;
  if exists(select 1 from public.timetable_assignments ta join public.timetable_days d on d.id=ta.timetable_day_id
    where ta.timetable_import_id=v_plan.timetable_import_id and ta.teacher_id=v_teacher.id
      and d.day_order=extract(isodow from v_plan.exam_date)::int and ta.lesson_period_id=v_session.lesson_period_id) then
    return jsonb_build_object('status','lesson_conflict');
  end if;
  select os.scope_code, xs.period_name_snapshot into v_conflict from public.exam_invigilation_assignments a
    join public.exam_invigilation_scopes os on os.id=a.scope_id join public.exam_invigilation_sessions xs on xs.id=a.session_id
   where a.plan_id=v_plan.id and a.teacher_source_id=p_teacher_source_id and os.id<>v_scope.id limit 1;
  if found then return jsonb_build_object('status','teacher_already_assigned_other_scope','assignedScope',v_conflict.scope_code,'periodName',v_conflict.period_name_snapshot); end if;
  if exists(select 1 from public.exam_invigilation_assignments a where a.campus_id=v_plan.campus_id and a.exam_date=v_plan.exam_date
    and a.period_order=v_session.period_order and a.teacher_source_id=p_teacher_source_id and not(a.session_id=v_session.id and a.slot_number=p_slot_number)) then
    return jsonb_build_object('status','invigilation_conflict');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('packageId',p.id,'locationName',coalesce(mina.location_name,'Nöbet yeri'),'coverageMode',p.coverage_mode)),'[]'::jsonb)
    into v_warning from public.duty_plan_assignment_packages p
    left join lateral (select min(a.duty_location_name_snapshot) location_name from public.duty_plan_assignments a where a.package_id=p.id) mina on true
   where p.plan_id=v_plan.duty_plan_id and p.day_order=extract(isodow from v_plan.exam_date)::int and p.teacher_source_id=p_teacher_source_id;
  if jsonb_array_length(v_warning)>0 and not coalesce(p_duty_coverage_acknowledged,false) then
    return jsonb_build_object('status','duty_coverage_acknowledgement_required','dutyWarnings',v_warning);
  end if;
  insert into public.exam_invigilation_assignments(plan_id,scope_id,session_id,campus_id,exam_date,period_order,slot_number,
    teacher_source_id,teacher_name_snapshot,duty_warning,duty_coverage_acknowledged,duty_coverage_note)
  values(v_plan.id,v_scope.id,v_session.id,v_plan.campus_id,v_plan.exam_date,v_session.period_order,p_slot_number,
    v_teacher.source_id,v_teacher.name,case when jsonb_array_length(v_warning)>0 then v_warning else null end,
    jsonb_array_length(v_warning)>0 and p_duty_coverage_acknowledged,
    case when jsonb_array_length(v_warning)>0 then nullif(btrim(p_duty_coverage_note),'') else null end)
  on conflict(session_id,slot_number) do update set teacher_source_id=excluded.teacher_source_id,
    teacher_name_snapshot=excluded.teacher_name_snapshot,duty_warning=excluded.duty_warning,
    duty_coverage_acknowledged=excluded.duty_coverage_acknowledged,duty_coverage_note=excluded.duty_coverage_note
  returning id into v_assignment_id;
  update public.exam_invigilation_scopes set version=version+1 where id=v_scope.id returning version into v_scope.version;
  return jsonb_build_object('status','ok','scopeVersion',v_scope.version,'assignmentId',v_assignment_id);
exception when unique_violation then return jsonb_build_object('status','invigilation_conflict');
end;
$$;

create or replace function public.complete_exam_invigilation_scope(
  p_plan_id uuid, p_scope_code text, p_expected_scope_version integer
) returns jsonb language plpgsql security invoker
set search_path = pg_catalog, public as $$
declare v_scope public.exam_invigilation_scopes%rowtype; v_plan public.exam_invigilation_plans%rowtype; v_required integer; v_assigned integer;
begin
  select * into v_plan from public.exam_invigilation_plans where id=p_plan_id;
  if not found then return jsonb_build_object('status','plan_not_found'); end if;
  select * into v_scope from public.exam_invigilation_scopes where plan_id=p_plan_id and scope_code=p_scope_code for update;
  if not found then return jsonb_build_object('status','scope_not_found'); end if;
  if v_scope.status='completed' then return jsonb_build_object('status','already_completed','version',v_scope.version); end if;
  if v_scope.version<>p_expected_scope_version then return jsonb_build_object('status','version_conflict','currentVersion',v_scope.version); end if;
  if v_plan.source_fingerprint is distinct from public.exam_invigilation_current_fingerprint(v_plan.timetable_import_id,v_plan.duty_plan_id) then return jsonb_build_object('status','source_stale'); end if;
  select coalesce(sum(required_invigilator_count),0) into v_required from public.exam_invigilation_sessions where scope_id=v_scope.id;
  select count(*) into v_assigned from public.exam_invigilation_assignments where scope_id=v_scope.id;
  if v_assigned<>v_required then return jsonb_build_object('status','open_slots','requiredCount',v_required,'assignedCount',v_assigned); end if;
  if exists(select 1 from public.exam_invigilation_assignments where scope_id=v_scope.id and duty_warning is not null and not duty_coverage_acknowledged) then
    return jsonb_build_object('status','unacknowledged_duty_warnings');
  end if;
  update public.exam_invigilation_scopes set status='completed',completed_at=timezone('utc',now()),version=version+1 where id=v_scope.id returning version into v_scope.version;
  return jsonb_build_object('status','ok','version',v_scope.version);
end;
$$;

create or replace function public.prevent_completed_exam_invigilation_change()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_scope_status text;
begin
  select status into v_scope_status from public.exam_invigilation_scopes where id=coalesce(new.scope_id,old.scope_id);
  if v_scope_status='completed' then raise exception 'Tamamlanmış gözetmen listesi değiştirilemez.' using errcode='55000'; end if;
  return coalesce(new,old);
end; $$;
create trigger exam_invigilation_assignment_immutable before insert or update or delete on public.exam_invigilation_assignments
  for each row execute function public.prevent_completed_exam_invigilation_change();
create trigger exam_invigilation_session_immutable before insert or update or delete on public.exam_invigilation_sessions
  for each row execute function public.prevent_completed_exam_invigilation_change();

create or replace function public.enforce_exam_invigilation_scope_lifecycle()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if tg_op='DELETE' and old.status='completed' then
    raise exception 'Tamamlanmış gözetmen listesi silinemez.' using errcode='55000';
  end if;
  if tg_op='UPDATE' and old.status='completed' then
    raise exception 'Tamamlanmış gözetmen listesi değiştirilemez.' using errcode='55000';
  end if;
  return case when tg_op='DELETE' then old else new end;
end; $$;
create trigger exam_invigilation_scope_lifecycle before update or delete on public.exam_invigilation_scopes
  for each row execute function public.enforce_exam_invigilation_scope_lifecycle();

do $$ declare f regprocedure; begin
  foreach f in array array[
    'public.exam_invigilation_current_fingerprint(uuid,uuid)'::regprocedure,
    'public.create_exam_invigilation_plan(text,text,text,date,date,integer[],integer,integer)'::regprocedure,
    'public.list_exam_invigilation_plans(text,text)'::regprocedure,
    'public.get_exam_invigilation_preparation(text,text)'::regprocedure,
    'public.get_exam_invigilation_plan(uuid,text,text)'::regprocedure,
    'public.get_exam_invigilation_candidates(uuid,uuid,text,text)'::regprocedure,
    'public.set_exam_invigilation_assignment(uuid,uuid,integer,text,integer,boolean,text)'::regprocedure,
    'public.complete_exam_invigilation_scope(uuid,text,integer)'::regprocedure,
    'public.prevent_completed_exam_invigilation_change()'::regprocedure,
    'public.enforce_exam_invigilation_scope_lifecycle()'::regprocedure
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated',f);
    execute format('grant execute on function %s to service_role',f);
  end loop;
end $$;
