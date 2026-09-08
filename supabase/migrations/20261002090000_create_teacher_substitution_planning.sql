-- ============================================================================
-- Öğretmen yokluğu ve ders yerine görevlendirme
-- ============================================================================
-- Her görev gerçek XML importuna bağlanır. Nöbet zamanları ders saatlerinden
-- ayrı olduğu için aday uygunluğunu ETKİLEMEZ. Aynı saatte ders, sınav
-- gözetmenliği, başka görevlendirme veya aktif yokluk kesin engeldir.

create table public.teacher_absences (
  id uuid primary key default gen_random_uuid(),
  campus_id uuid not null references public.campuses(id) on delete restrict,
  academic_year_id uuid not null references public.academic_years(id) on delete restrict,
  timetable_import_id uuid not null references public.timetable_imports(id) on delete restrict,
  teacher_source_id text not null check (btrim(teacher_source_id) <> ''),
  teacher_name_snapshot text not null check (btrim(teacher_name_snapshot) <> ''),
  date_from date not null,
  date_to date not null,
  absence_scope text not null default 'selected_lessons' check (absence_scope in ('all_day','selected_lessons')),
  reason_code text not null check (reason_code in ('medical_report','leave','official_duty','other')),
  note text,
  created_at timestamptz not null default timezone('utc',now()),
  updated_at timestamptz not null default timezone('utc',now()),
  constraint teacher_absences_date_ck check (date_to >= date_from)
);

create table public.substitution_day_lists (
  id uuid primary key default gen_random_uuid(),
  campus_id uuid not null references public.campuses(id) on delete restrict,
  academic_year_id uuid not null references public.academic_years(id) on delete restrict,
  timetable_import_id uuid not null references public.timetable_imports(id) on delete restrict,
  assignment_date date not null,
  status text not null default 'draft' check (status in ('draft','completed')),
  version integer not null default 1 check (version > 0),
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc',now()),
  updated_at timestamptz not null default timezone('utc',now()),
  constraint substitution_day_lists_status_ck check ((status='completed')=(completed_at is not null)),
  constraint substitution_day_lists_date_uq unique(campus_id,academic_year_id,assignment_date)
);

create table public.substitution_tasks (
  id uuid primary key default gen_random_uuid(),
  day_list_id uuid not null references public.substitution_day_lists(id) on delete cascade,
  absence_id uuid not null references public.teacher_absences(id) on delete cascade,
  campus_id uuid not null references public.campuses(id) on delete restrict,
  timetable_import_id uuid not null references public.timetable_imports(id) on delete restrict,
  timetable_card_id uuid not null references public.timetable_cards(id) on delete restrict,
  assignment_date date not null,
  period_order integer not null check (period_order > 0),
  period_name_snapshot text not null,
  starts_at_snapshot time,
  ends_at_snapshot time,
  absent_teacher_source_id text not null,
  absent_teacher_name_snapshot text not null,
  subject_source_id text,
  subject_name_snapshot text not null,
  class_source_ids text[] not null default '{}',
  class_names_snapshot text not null,
  resolution_status text not null default 'open' check (resolution_status in ('open','assigned','unfilled')),
  substitute_teacher_source_id text,
  substitute_teacher_name_snapshot text,
  daily_limit_override boolean not null default false,
  override_note text,
  unfilled_note text,
  created_at timestamptz not null default timezone('utc',now()),
  updated_at timestamptz not null default timezone('utc',now()),
  constraint substitution_tasks_card_date_uq unique(absence_id,assignment_date,timetable_card_id),
  constraint substitution_tasks_resolution_ck check (
    (resolution_status='open' and substitute_teacher_source_id is null and substitute_teacher_name_snapshot is null and unfilled_note is null)
    or (resolution_status='assigned' and substitute_teacher_source_id is not null and substitute_teacher_name_snapshot is not null and unfilled_note is null)
    or (resolution_status='unfilled' and substitute_teacher_source_id is null and substitute_teacher_name_snapshot is null and nullif(btrim(unfilled_note),'') is not null)
  ),
  constraint substitution_tasks_override_ck check (not daily_limit_override or nullif(btrim(override_note),'') is not null)
);

create unique index substitution_teacher_period_uq on public.substitution_tasks
  (campus_id,assignment_date,period_order,substitute_teacher_source_id)
  where resolution_status='assigned';
create unique index substitution_absent_teacher_lesson_uq on public.substitution_tasks
  (campus_id,assignment_date,timetable_card_id,absent_teacher_source_id);
create index substitution_tasks_day_idx on public.substitution_tasks(day_list_id,period_order);
create index substitution_tasks_teacher_idx on public.substitution_tasks(campus_id,substitute_teacher_source_id,assignment_date);
create index teacher_absences_teacher_date_idx on public.teacher_absences(campus_id,teacher_source_id,date_from,date_to);

create trigger set_updated_at before update on public.teacher_absences for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.substitution_day_lists for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.substitution_tasks for each row execute function public.set_updated_at();

alter table public.teacher_absences enable row level security;
alter table public.substitution_day_lists enable row level security;
alter table public.substitution_tasks enable row level security;
revoke all on public.teacher_absences,public.substitution_day_lists,public.substitution_tasks from public,anon,authenticated;
grant select,insert,update,delete on public.teacher_absences,public.substitution_day_lists,public.substitution_tasks to service_role;

-- Günlük varsayılan sınır. Tek kampüs uygulamasında ayar kampüs bazında tutulur.
alter table public.campuses add column substitution_daily_soft_limit integer not null default 5
  check (substitution_daily_soft_limit between 1 and 20);

create or replace function public.substitution_import_is_current(p_import_id uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
  select exists(select 1 from public.timetable_imports i where i.id=p_import_id and i.status='imported'
    and not exists(select 1 from public.timetable_imports n where n.campus_id=i.campus_id and n.academic_year_id=i.academic_year_id
      and n.status='imported' and (n.imported_at,n.created_at,n.id)>(i.imported_at,i.created_at,i.id)));
$$;

-- XML yüklemeden önce kullanıcıya gösterilecek yetkili engel listesi.
create or replace function public.get_timetable_import_blockers(p_campus_name text,p_academic_year_name text)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid; v_year uuid; v_items jsonb;v_current_sha text;
begin
  select id into v_campus from public.campuses where name=p_campus_name;
  select id into v_year from public.academic_years where campus_id=v_campus and name=p_academic_year_name;
  if v_year is null then return jsonb_build_object('blocked',false,'items','[]'::jsonb,'currentSourceSha256',null); end if;
  select source_sha256 into v_current_sha from public.timetable_imports where campus_id=v_campus and academic_year_id=v_year and status='imported' order by imported_at desc nulls last,created_at desc limit 1;
  select coalesce(jsonb_agg(x order by x->>'type',x->>'name'),'[]'::jsonb) into v_items from (
    select jsonb_build_object('type','duty_plan','id',p.id,'name',coalesce(p.week_start_date::text,'Nöbet taslağı')) x
      from public.duty_plans p where p.campus_id=v_campus and p.academic_year_id=v_year and p.status='draft'
    union all
    select jsonb_build_object('type','exam_plan','id',p.id,'name',p.name) from public.exam_invigilation_plans p
      where p.campus_id=v_campus and p.academic_year_id=v_year and exists(select 1 from public.exam_invigilation_scopes s where s.plan_id=p.id and s.status='draft' and exists(select 1 from public.exam_invigilation_sessions x where x.scope_id=s.id))
    union all
    select jsonb_build_object('type','substitution_list','id',l.id,'name',l.assignment_date::text) from public.substitution_day_lists l
      where l.campus_id=v_campus and l.academic_year_id=v_year and l.status='draft'
  ) q;
  return jsonb_build_object('blocked',jsonb_array_length(v_items)>0,'items',v_items,'currentSourceSha256',v_current_sha);
end; $$;

create or replace function public.prevent_timetable_import_with_open_work()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if exists(select 1 from public.duty_plans p where p.campus_id=new.campus_id and p.academic_year_id=new.academic_year_id and p.status='draft')
    or exists(select 1 from public.exam_invigilation_plans p join public.exam_invigilation_scopes s on s.plan_id=p.id and s.status='draft'
      where p.campus_id=new.campus_id and p.academic_year_id=new.academic_year_id and exists(select 1 from public.exam_invigilation_sessions x where x.scope_id=s.id))
    or exists(select 1 from public.substitution_day_lists l where l.campus_id=new.campus_id and l.academic_year_id=new.academic_year_id and l.status='draft') then
    raise exception 'XML yüklenemedi: XML kaynağına bağlı açık çalışmalar var.' using errcode='55000';
  end if;
  return new;
end; $$;
create trigger timetable_import_open_work_guard before insert on public.timetable_imports
  for each row execute function public.prevent_timetable_import_with_open_work();

-- Yokluk formu için öğretmen ve o öğretmenin tarih aralığındaki gerçek dersleri.
create or replace function public.get_substitution_preparation(p_campus_name text,p_academic_year_name text,p_teacher_source_id text default null,p_date_from date default null,p_date_to date default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid; v_year uuid; v_import uuid; v_teachers jsonb; v_lessons jsonb;
begin
  select id into v_campus from public.campuses where name=p_campus_name;
  select id into v_year from public.academic_years where campus_id=v_campus and name=p_academic_year_name;
  select id into v_import from public.timetable_imports where campus_id=v_campus and academic_year_id=v_year and status='imported' order by imported_at desc nulls last,created_at desc limit 1;
  if v_import is null then return jsonb_build_object('hasImport',false,'teachers','[]'::jsonb,'lessons','[]'::jsonb); end if;
  select coalesce(jsonb_agg(jsonb_build_object('sourceId',t.source_id,'name',t.name,'branch',t.branch) order by t.name),'[]'::jsonb) into v_teachers from public.teachers t where t.timetable_import_id=v_import;
  with dates as (select d::date assignment_date from generate_series(p_date_from,p_date_to,interval '1 day') d where extract(isodow from d) between 1 and 5), rows as (
    select dt.assignment_date,c.id card_id,lp.id period_id,lp.period_order,lp.name period_name,lp.starts_at,lp.ends_at,
      coalesce(s.source_id,'') subject_source_id,coalesce(s.name,'Ders') subject_name,
      array_agg(distinct sc.source_id order by sc.source_id) class_source_ids,string_agg(distinct sc.name,', ' order by sc.name) class_names
    from dates dt join public.timetable_days td on td.timetable_import_id=v_import and td.day_order=extract(isodow from dt.assignment_date)::int
    join public.timetable_cards c on c.timetable_import_id=v_import and c.timetable_day_id=td.id
    join public.lesson_periods lp on lp.id=c.lesson_period_id
    join public.timetable_assignments ta on ta.timetable_card_id=c.id
    join public.teachers t on t.id=ta.teacher_id and t.source_id=p_teacher_source_id
    join public.school_classes sc on sc.id=ta.school_class_id
    left join public.subjects s on s.id=ta.subject_id
    group by dt.assignment_date,c.id,lp.id,lp.period_order,lp.name,lp.starts_at,lp.ends_at,s.source_id,s.name)
  select coalesce(jsonb_agg(jsonb_build_object('key',assignment_date::text||':'||card_id::text,'assignmentDate',assignment_date,'timetableCardId',card_id,'periodOrder',period_order,'periodName',period_name,'startsAt',starts_at,'endsAt',ends_at,'subjectName',subject_name,'classNames',class_names) order by assignment_date,period_order),'[]'::jsonb) into v_lessons from rows;
  return jsonb_build_object('hasImport',true,'timetableImportId',v_import,'dailySoftLimit',(select substitution_daily_soft_limit from public.campuses where id=v_campus),'teachers',v_teachers,'lessons',coalesce(v_lessons,'[]'::jsonb));
end; $$;

create or replace function public.create_teacher_absence(p_campus_name text,p_academic_year_name text,p_teacher_source_id text,p_date_from date,p_date_to date,p_reason_code text,p_note text,p_lesson_keys jsonb,p_absence_scope text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid;v_year uuid;v_import uuid;v_teacher record;v_absence uuid;v_item jsonb;v_date date;v_card uuid;v_list uuid;v_inserted int:=0;
begin
  if p_date_from is null or p_date_to<p_date_from or p_reason_code not in ('medical_report','leave','official_duty','other') or p_absence_scope not in ('all_day','selected_lessons') or jsonb_typeof(p_lesson_keys)<>'array' or jsonb_array_length(p_lesson_keys)=0 then return jsonb_build_object('status','validation_error'); end if;
  select id into v_campus from public.campuses where name=p_campus_name; select id into v_year from public.academic_years where campus_id=v_campus and name=p_academic_year_name;
  select id into v_import from public.timetable_imports where campus_id=v_campus and academic_year_id=v_year and status='imported' order by imported_at desc nulls last,created_at desc limit 1;
  select source_id,name into v_teacher from public.teachers where timetable_import_id=v_import and source_id=p_teacher_source_id;
  if not found then return jsonb_build_object('status','teacher_not_found'); end if;
  -- Tam gün seçildiyse istemcinin eksik gönderdiği ders kabul edilmez. Böylece
  -- aday dışlama ve görevlendirme görevleri aynı yetkili kapsamdan türetilir.
  if p_absence_scope='all_day' and exists(
    select 1 from generate_series(p_date_from,p_date_to,interval '1 day') d
    join public.timetable_days td on td.timetable_import_id=v_import and td.day_order=extract(isodow from d)::int
    join public.timetable_cards c on c.timetable_import_id=v_import and c.timetable_day_id=td.id
    join public.timetable_assignments ta on ta.timetable_card_id=c.id
    join public.teachers t on t.id=ta.teacher_id and t.source_id=p_teacher_source_id
    where not exists(select 1 from jsonb_array_elements(p_lesson_keys) x where (x->>'assignmentDate')::date=d::date and (x->>'timetableCardId')::uuid=c.id)
  ) then return jsonb_build_object('status','all_day_lessons_incomplete'); end if;
  insert into public.teacher_absences(campus_id,academic_year_id,timetable_import_id,teacher_source_id,teacher_name_snapshot,date_from,date_to,absence_scope,reason_code,note)
    values(v_campus,v_year,v_import,v_teacher.source_id,v_teacher.name,p_date_from,p_date_to,p_absence_scope,p_reason_code,nullif(btrim(p_note),'')) returning id into v_absence;
  for v_item in select value from jsonb_array_elements(p_lesson_keys) loop
    v_date:=(v_item->>'assignmentDate')::date; v_card:=(v_item->>'timetableCardId')::uuid;
    if v_date not between p_date_from and p_date_to then raise exception 'Seçilen ders yokluk tarih aralığında değil.' using errcode='22023'; end if;
    insert into public.substitution_day_lists(campus_id,academic_year_id,timetable_import_id,assignment_date) values(v_campus,v_year,v_import,v_date)
      on conflict(campus_id,academic_year_id,assignment_date) do update set status='draft',completed_at=null,version=public.substitution_day_lists.version+1,updated_at=excluded.updated_at
      where public.substitution_import_is_current(public.substitution_day_lists.timetable_import_id)
      returning id into v_list;
    if v_list is null then raise exception 'Geçmiş XML kaynağına bağlı liste değiştirilemez.' using errcode='55000'; end if;
    insert into public.substitution_tasks(day_list_id,absence_id,campus_id,timetable_import_id,timetable_card_id,assignment_date,period_order,period_name_snapshot,starts_at_snapshot,ends_at_snapshot,absent_teacher_source_id,absent_teacher_name_snapshot,subject_source_id,subject_name_snapshot,class_source_ids,class_names_snapshot)
    select v_list,v_absence,v_campus,v_import,c.id,v_date,lp.period_order,lp.name,lp.starts_at,lp.ends_at,v_teacher.source_id,v_teacher.name,s.source_id,coalesce(s.name,'Ders'),array_agg(distinct sc.source_id),string_agg(distinct sc.name,', ' order by sc.name)
      from public.timetable_cards c join public.lesson_periods lp on lp.id=c.lesson_period_id join public.timetable_assignments ta on ta.timetable_card_id=c.id
      join public.school_classes sc on sc.id=ta.school_class_id left join public.subjects s on s.id=ta.subject_id
      where c.id=v_card and c.timetable_import_id=v_import and ta.teacher_id=(select id from public.teachers where timetable_import_id=v_import and source_id=p_teacher_source_id)
      and exists(select 1 from public.timetable_days td where td.id=c.timetable_day_id and td.day_order=extract(isodow from v_date)::int)
      group by c.id,lp.period_order,lp.name,lp.starts_at,lp.ends_at,s.source_id,s.name;
    if not found then raise exception 'Seçilen ders öğretmenin programında bulunamadı.' using errcode='22023'; end if; v_inserted:=v_inserted+1;
  end loop;
  return jsonb_build_object('status','ok','absenceId',v_absence,'taskCount',v_inserted);
exception when unique_violation then return jsonb_build_object('status','duplicate_absence_lesson');
end; $$;

-- Aday sırası lexicographic: aynı ders, aynı sınıf, aynı kademe, az puan,
-- o gün az ders. Nöbet bilinçli olarak sorguya dahil edilmez.
create or replace function public.substitution_class_stage(p_grade text,p_name text)
returns text language sql immutable security invoker set search_path=pg_catalog as $$
 select case
  when lower(coalesce(p_grade,'')||' '||coalesce(p_name,'')) similar to '%(anaokul|anasınıf|okul öncesi|preschool)%' then 'PRESCHOOL'
  when coalesce(substring(coalesce(p_grade,'') from '([0-9]{1,2})'),substring(coalesce(p_name,'') from '([0-9]{1,2})'))::int between 1 and 4 then 'PRIMARY'
  when coalesce(substring(coalesce(p_grade,'') from '([0-9]{1,2})'),substring(coalesce(p_name,'') from '([0-9]{1,2})'))::int between 5 and 8 then 'MIDDLE'
  when coalesce(substring(coalesce(p_grade,'') from '([0-9]{1,2})'),substring(coalesce(p_name,'') from '([0-9]{1,2})'))::int between 9 and 12 then 'HIGH'
 end;
$$;

create or replace function public.get_substitution_task_candidates(p_task_id uuid,p_campus_name text,p_academic_year_name text)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_task public.substitution_tasks%rowtype;v_year uuid;v_limit int;v_items jsonb;
begin
  select y.id into v_year from public.academic_years y join public.campuses c on c.id=y.campus_id where c.name=p_campus_name and y.name=p_academic_year_name;
  select * into v_task from public.substitution_tasks where id=p_task_id and campus_id=(select campus_id from public.academic_years where id=v_year);
  if not found then return jsonb_build_object('found',false); end if; select substitution_daily_soft_limit into v_limit from public.campuses where id=v_task.campus_id;
  with candidate as (
    select t.source_id,t.name,t.branch,
      exists(select 1 from public.timetable_assignments ta join public.subjects s on s.id=ta.subject_id where ta.timetable_import_id=v_task.timetable_import_id and ta.teacher_id=t.id and s.source_id=v_task.subject_source_id) same_subject,
      (nullif(btrim(t.branch),'') is not null and (lower(btrim(t.branch))=lower(btrim(v_task.subject_name_snapshot)) or lower(v_task.subject_name_snapshot) like '%'||lower(btrim(t.branch))||'%')) branch_support,
      exists(select 1 from public.timetable_assignments ta join public.school_classes sc on sc.id=ta.school_class_id where ta.timetable_import_id=v_task.timetable_import_id and ta.teacher_id=t.id and sc.source_id=any(v_task.class_source_ids)) same_class,
      exists(select 1 from public.timetable_assignments ta join public.school_classes sc on sc.id=ta.school_class_id where ta.timetable_import_id=v_task.timetable_import_id and ta.teacher_id=t.id and public.substitution_class_stage(sc.grade,sc.name) in
        (select public.substitution_class_stage(x.grade,x.name) from public.school_classes x where x.timetable_import_id=v_task.timetable_import_id and x.source_id=any(v_task.class_source_ids) and public.substitution_class_stage(x.grade,x.name) is not null)) same_stage,
      (select count(*) from public.substitution_tasks st where st.campus_id=v_task.campus_id and st.substitute_teacher_source_id=t.source_id and st.resolution_status='assigned') substitution_points,
      (select count(*) from public.timetable_assignments ta join public.timetable_days d on d.id=ta.timetable_day_id where ta.timetable_import_id=v_task.timetable_import_id and ta.teacher_id=t.id and d.day_order=extract(isodow from v_task.assignment_date)::int) scheduled_today,
      (select count(*) from public.substitution_tasks st where st.campus_id=v_task.campus_id and st.assignment_date=v_task.assignment_date and st.substitute_teacher_source_id=t.source_id and st.resolution_status='assigned') assigned_today
    from public.teachers t where t.timetable_import_id=v_task.timetable_import_id and t.source_id<>v_task.absent_teacher_source_id
      and not exists(select 1 from public.timetable_assignments ta join public.timetable_days d on d.id=ta.timetable_day_id where ta.timetable_import_id=v_task.timetable_import_id and ta.teacher_id=t.id and d.day_order=extract(isodow from v_task.assignment_date)::int and ta.lesson_period_id=(select id from public.lesson_periods where timetable_import_id=v_task.timetable_import_id and period_order=v_task.period_order))
      and not exists(select 1 from public.teacher_absences a where a.campus_id=v_task.campus_id and a.teacher_source_id=t.source_id and v_task.assignment_date between a.date_from and a.date_to and (a.absence_scope='all_day' or exists(select 1 from public.substitution_tasks at where at.absence_id=a.id and at.assignment_date=v_task.assignment_date and at.period_order=v_task.period_order)))
      and not exists(select 1 from public.substitution_tasks st where st.campus_id=v_task.campus_id and st.assignment_date=v_task.assignment_date and st.period_order=v_task.period_order and st.substitute_teacher_source_id=t.source_id and st.id<>v_task.id)
      and not exists(select 1 from public.exam_invigilation_assignments ea where ea.campus_id=v_task.campus_id and ea.exam_date=v_task.assignment_date and ea.period_order=v_task.period_order and ea.teacher_source_id=t.source_id)
  ) select coalesce(jsonb_agg(jsonb_build_object('teacherSourceId',source_id,'teacherName',name,'branch',branch,'sameSubject',same_subject,'branchSupportsSubject',branch_support,'sameClass',same_class,'sameStage',same_stage,'substitutionPoints',substitution_points,'scheduledLessonCount',scheduled_today,'assignedToday',assigned_today,'dailyLimit',v_limit,'limitExceeded',assigned_today>=v_limit)
      order by same_subject desc,branch_support desc,same_class desc,same_stage desc,substitution_points,scheduled_today+assigned_today,name),'[]'::jsonb) into v_items from candidate;
  return jsonb_build_object('found',true,'taskId',v_task.id,'items',v_items);
end; $$;

create or replace function public.set_substitution_task_resolution(p_task_id uuid,p_teacher_source_id text,p_unfilled_note text,p_expected_version integer,p_override_ack boolean default false,p_override_note text default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_task public.substitution_tasks%rowtype;v_list public.substitution_day_lists%rowtype;v_candidate jsonb;v_teacher_name text;v_exceeded boolean;
begin
  select * into v_task from public.substitution_tasks where id=p_task_id; if not found then return jsonb_build_object('status','task_not_found'); end if;
  select * into v_list from public.substitution_day_lists where id=v_task.day_list_id for update;
  if not public.substitution_import_is_current(v_list.timetable_import_id) then return jsonb_build_object('status','historical_locked'); end if;
  if v_list.version<>p_expected_version then return jsonb_build_object('status','version_conflict','currentVersion',v_list.version); end if;
  if p_teacher_source_id is null then
    if nullif(btrim(p_unfilled_note),'') is null then
      update public.substitution_tasks set resolution_status='open',substitute_teacher_source_id=null,substitute_teacher_name_snapshot=null,daily_limit_override=false,override_note=null,unfilled_note=null where id=v_task.id;
    else update public.substitution_tasks set resolution_status='unfilled',substitute_teacher_source_id=null,substitute_teacher_name_snapshot=null,daily_limit_override=false,override_note=null,unfilled_note=btrim(p_unfilled_note) where id=v_task.id; end if;
  else
    select x into v_candidate from jsonb_array_elements((public.get_substitution_task_candidates(v_task.id,(select name from public.campuses where id=v_task.campus_id),(select name from public.academic_years where id=v_list.academic_year_id))->'items')) x where x->>'teacherSourceId'=p_teacher_source_id;
    if v_candidate is null then return jsonb_build_object('status','teacher_not_eligible'); end if;
    v_exceeded:=coalesce((v_candidate->>'limitExceeded')::boolean,false);
    if v_exceeded and (not coalesce(p_override_ack,false) or nullif(btrim(p_override_note),'') is null) then return jsonb_build_object('status','daily_limit_acknowledgement_required','candidate',v_candidate); end if;
    v_teacher_name:=v_candidate->>'teacherName';
    update public.substitution_tasks set resolution_status='assigned',substitute_teacher_source_id=p_teacher_source_id,substitute_teacher_name_snapshot=v_teacher_name,daily_limit_override=v_exceeded,override_note=case when v_exceeded then btrim(p_override_note) else null end,unfilled_note=null where id=v_task.id;
  end if;
  update public.substitution_day_lists set
    status=case when exists(select 1 from public.substitution_tasks where day_list_id=v_list.id and resolution_status='open') then 'draft' else status end,
    completed_at=case when exists(select 1 from public.substitution_tasks where day_list_id=v_list.id and resolution_status='open') then null else completed_at end,
    version=version+1 where id=v_list.id returning version into v_list.version;
  return jsonb_build_object('status','ok','version',v_list.version);
exception when unique_violation then return jsonb_build_object('status','teacher_period_conflict'); end; $$;

create or replace function public.complete_substitution_day_list(p_list_id uuid,p_expected_version integer)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_list public.substitution_day_lists%rowtype;
begin select * into v_list from public.substitution_day_lists where id=p_list_id for update; if not found then return jsonb_build_object('status','not_found'); end if;
  if not public.substitution_import_is_current(v_list.timetable_import_id) then return jsonb_build_object('status','historical_locked'); end if;
  if v_list.version<>p_expected_version then return jsonb_build_object('status','version_conflict','currentVersion',v_list.version); end if;
  if exists(select 1 from public.substitution_tasks where day_list_id=v_list.id and resolution_status='open') then return jsonb_build_object('status','open_tasks'); end if;
  update public.substitution_day_lists set status='completed',completed_at=timezone('utc',now()),version=version+1 where id=v_list.id returning version into v_list.version;
  return jsonb_build_object('status','ok','version',v_list.version); end; $$;

create or replace function public.list_substitution_day_lists(p_campus_name text,p_academic_year_name text)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
with ctx as(select y.id year_id from public.academic_years y join public.campuses c on c.id=y.campus_id where c.name=p_campus_name and y.name=p_academic_year_name)
select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object('id',l.id,'assignmentDate',l.assignment_date,'status',l.status,'version',l.version,'isHistorical',not public.substitution_import_is_current(l.timetable_import_id),'taskCount',(select count(*) from public.substitution_tasks t where t.day_list_id=l.id),'assignedCount',(select count(*) from public.substitution_tasks t where t.day_list_id=l.id and t.resolution_status='assigned'),'unfilledCount',(select count(*) from public.substitution_tasks t where t.day_list_id=l.id and t.resolution_status='unfilled')) order by l.assignment_date desc),'[]'::jsonb)) from public.substitution_day_lists l join ctx on ctx.year_id=l.academic_year_id;
$$;

create or replace function public.get_substitution_day_list(p_list_id uuid,p_campus_name text,p_academic_year_name text)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
select coalesce((select jsonb_build_object('found',true,'id',l.id,'assignmentDate',l.assignment_date,'status',l.status,'version',l.version,'isHistorical',not public.substitution_import_is_current(l.timetable_import_id),'tasks',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'absenceId',t.absence_id,'periodOrder',t.period_order,'periodName',t.period_name_snapshot,'startsAt',t.starts_at_snapshot,'endsAt',t.ends_at_snapshot,'absentTeacherSourceId',t.absent_teacher_source_id,'absentTeacherName',t.absent_teacher_name_snapshot,'subjectName',t.subject_name_snapshot,'classNames',t.class_names_snapshot,'resolutionStatus',t.resolution_status,'substituteTeacherSourceId',t.substitute_teacher_source_id,'substituteTeacherName',t.substitute_teacher_name_snapshot,'dailyLimitOverride',t.daily_limit_override,'overrideNote',t.override_note,'unfilledNote',t.unfilled_note) order by t.period_order,t.absent_teacher_name_snapshot) from public.substitution_tasks t where t.day_list_id=l.id),'[]'::jsonb)) from public.substitution_day_lists l join public.academic_years y on y.id=l.academic_year_id join public.campuses c on c.id=l.campus_id where l.id=p_list_id and c.name=p_campus_name and y.name=p_academic_year_name),jsonb_build_object('found',false));
$$;

-- Geçmiş import veya kapanmış puantaj satırları ilerideki migration'da ayrıca
-- kilitlenir; bu trigger en azından geçmiş XML'e bağlı görevi şimdi korur.
create or replace function public.enforce_substitution_history_lock() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_import uuid;
begin v_import:=case when tg_table_name='teacher_absences' then old.timetable_import_id when tg_table_name='substitution_day_lists' then old.timetable_import_id else old.timetable_import_id end;
  if not public.substitution_import_is_current(v_import) then raise exception 'Geçmiş XML kaynağına bağlı görevlendirme değiştirilemez.' using errcode='55000'; end if;
  return case when tg_op='DELETE' then old else new end; end; $$;
create trigger substitution_absence_history_lock before update or delete on public.teacher_absences for each row execute function public.enforce_substitution_history_lock();
create trigger substitution_list_history_lock before update or delete on public.substitution_day_lists for each row execute function public.enforce_substitution_history_lock();
create trigger substitution_task_history_lock before update or delete on public.substitution_tasks for each row execute function public.enforce_substitution_history_lock();

create or replace function public.enforce_exam_substitution_period_exclusivity()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if tg_table_name='substitution_tasks' then
  if new.resolution_status='assigned' and exists(select 1 from public.exam_invigilation_assignments a where a.campus_id=new.campus_id and a.exam_date=new.assignment_date and a.period_order=new.period_order and a.teacher_source_id=new.substitute_teacher_source_id) then
   raise exception 'Öğretmen aynı ders saatinde sınav gözetmeni olarak görevlidir.' using errcode='23505';
  end if;
 else
  if exists(select 1 from public.substitution_tasks t where t.campus_id=new.campus_id and t.assignment_date=new.exam_date and t.period_order=new.period_order and t.resolution_status='assigned' and t.substitute_teacher_source_id=new.teacher_source_id) then
   raise exception 'Öğretmen aynı ders saatinde ders yerine görevlidir.' using errcode='23505';
  end if;
  if exists(select 1 from public.teacher_absences a where a.campus_id=new.campus_id and a.teacher_source_id=new.teacher_source_id and new.exam_date between a.date_from and a.date_to and (a.absence_scope='all_day' or exists(select 1 from public.substitution_tasks t where t.absence_id=a.id and t.assignment_date=new.exam_date and t.period_order=new.period_order))) then
   raise exception 'Yokluğu bulunan öğretmen sınav gözetmeni olarak atanamaz.' using errcode='23514';
  end if;
 end if;
 return new;
end; $$;
create trigger substitution_exam_period_guard before insert or update on public.substitution_tasks for each row execute function public.enforce_exam_substitution_period_exclusivity();
create trigger exam_substitution_period_guard before insert or update on public.exam_invigilation_assignments for each row execute function public.enforce_exam_substitution_period_exclusivity();

-- Önceden bağımsız FK'lerle kurulmuş gözetmen satırlarında plan/kapsam/oturum
-- kimliklerinin birbirinden kopması mümkünydü. Bileşik bağlar hem mevcut
-- veriyi doğrular hem de immutability trigger'ının başka kapsama taşınarak
-- aşılmasını kapatır.
alter table public.exam_invigilation_scopes add constraint exam_scope_id_plan_uq unique(id,plan_id);
alter table public.exam_invigilation_sessions add constraint exam_session_id_scope_plan_date_period_uq unique(id,scope_id,plan_id,exam_date,period_order);
alter table public.exam_invigilation_sessions add constraint exam_session_scope_plan_fk foreign key(scope_id,plan_id) references public.exam_invigilation_scopes(id,plan_id) not valid;
alter table public.exam_invigilation_assignments add constraint exam_assignment_scope_plan_fk foreign key(scope_id,plan_id) references public.exam_invigilation_scopes(id,plan_id) not valid;
alter table public.exam_invigilation_assignments add constraint exam_assignment_session_context_fk foreign key(session_id,scope_id,plan_id,exam_date,period_order) references public.exam_invigilation_sessions(id,scope_id,plan_id,exam_date,period_order) not valid;
alter table public.exam_invigilation_sessions validate constraint exam_session_scope_plan_fk;
alter table public.exam_invigilation_assignments validate constraint exam_assignment_scope_plan_fk;
alter table public.exam_invigilation_assignments validate constraint exam_assignment_session_context_fk;

create or replace function public.prevent_completed_exam_invigilation_change()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_old_status text;v_new_status text;
begin
 if tg_op<>'INSERT' then select status into v_old_status from public.exam_invigilation_scopes where id=old.scope_id;end if;
 if tg_op<>'DELETE' then select status into v_new_status from public.exam_invigilation_scopes where id=new.scope_id;end if;
 if v_old_status='completed' or v_new_status='completed' then raise exception 'Tamamlanmış gözetmen listesi değiştirilemez.' using errcode='55000';end if;
 return case when tg_op='DELETE' then old else new end;
end; $$;

-- Çok tarihli planlarda iki ayrı EXISTS yanlışlıkla farklı günleri alt ve üst
-- sınıra eşleyebiliyordu. Eski RPC'yi tarihsiz çalıştırıp aynı sınav tarihinin
-- istenen aralığa düşmesini zorunlu kılan sarmalayıcı bu hatayı ileri yönde kapatır.
alter function public.list_exam_invigilation_plans_v2(text,text,text,text,text,date,date,text)
  rename to list_exam_invigilation_plans_v2_before_date_intersection;
create or replace function public.list_exam_invigilation_plans_v2(
 p_campus_name text,p_academic_year_name text,p_status text default 'all',p_scope_code text default null,
 p_search text default null,p_date_from date default null,p_date_to date default null,p_sort text default 'newest'
) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_result jsonb;v_items jsonb;
begin
 if p_date_from is not null and p_date_to is not null and p_date_from>p_date_to then return jsonb_build_object('status','validation_error','items','[]'::jsonb);end if;
 v_result:=public.list_exam_invigilation_plans_v2_before_date_intersection(p_campus_name,p_academic_year_name,p_status,p_scope_code,p_search,null,null,p_sort);
 if v_result->>'status'<>'ok' then return v_result;end if;
 select coalesce(jsonb_agg(item order by ord),'[]'::jsonb) into v_items from jsonb_array_elements(coalesce(v_result->'items','[]'::jsonb)) with ordinality x(item,ord)
 where exists(select 1 from jsonb_array_elements_text(coalesce(item->'examDates','[]'::jsonb)) d where (p_date_from is null or d::date>=p_date_from) and (p_date_to is null or d::date<=p_date_to));
 return jsonb_build_object('status','ok','items',v_items);
end; $$;

create or replace function public.discard_exam_invigilation_scope(p_plan_id uuid,p_scope_code text,p_expected_version integer)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_scope public.exam_invigilation_scopes%rowtype;
begin
 select * into v_scope from public.exam_invigilation_scopes where plan_id=p_plan_id and scope_code=p_scope_code for update;
 if not found then return jsonb_build_object('status','scope_not_found');end if;
 if v_scope.status='completed' then return jsonb_build_object('status','scope_completed');end if;
 if v_scope.version<>p_expected_version then return jsonb_build_object('status','version_conflict','currentVersion',v_scope.version);end if;
 delete from public.exam_invigilation_sessions where scope_id=v_scope.id;
 update public.exam_invigilation_scopes set version=version+1 where id=v_scope.id returning version into v_scope.version;
 return jsonb_build_object('status','ok','version',v_scope.version);
end; $$;

-- Sınav ve ders-yerine görevlendirme aynı ders saatinde çift görev
-- oluşturamaz. Önceki gözetmen RPC'leri korunup, yeni modülü bilen yetkili
-- sarmalayıcılarla hem aday listesi hem yazma yolu simetrik hale getirilir.
alter function public.get_exam_invigilation_candidates(uuid,uuid,text,text)
  rename to get_exam_invigilation_candidates_before_substitution;
create or replace function public.get_exam_invigilation_candidates(
  p_plan_id uuid,p_session_id uuid,p_campus_name text,p_academic_year_name text
) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_result jsonb;v_plan public.exam_invigilation_plans%rowtype;v_session public.exam_invigilation_sessions%rowtype;v_filtered jsonb;v_sub_count int;v_abs_count int;
begin
 v_result:=public.get_exam_invigilation_candidates_before_substitution(p_plan_id,p_session_id,p_campus_name,p_academic_year_name);
 if coalesce((v_result->>'found')::boolean,false)=false or coalesce((v_result->>'sessionFound')::boolean,false)=false then return v_result;end if;
 select * into v_plan from public.exam_invigilation_plans where id=p_plan_id;
 select * into v_session from public.exam_invigilation_sessions where id=p_session_id and plan_id=p_plan_id;
 select coalesce(jsonb_agg(c order by n),'[]'::jsonb) into v_filtered
 from jsonb_array_elements(coalesce(v_result->'candidates','[]'::jsonb)) with ordinality x(c,n)
 where not exists(select 1 from public.substitution_tasks st where st.campus_id=v_plan.campus_id and st.assignment_date=v_session.exam_date and st.period_order=v_session.period_order and st.resolution_status='assigned' and st.substitute_teacher_source_id=c->>'teacherSourceId')
 and not exists(select 1 from public.teacher_absences a where a.campus_id=v_plan.campus_id and a.teacher_source_id=c->>'teacherSourceId' and v_session.exam_date between a.date_from and a.date_to and (a.absence_scope='all_day' or exists(select 1 from public.substitution_tasks st where st.absence_id=a.id and st.assignment_date=v_session.exam_date and st.period_order=v_session.period_order)));
 select count(distinct substitute_teacher_source_id) into v_sub_count from public.substitution_tasks where campus_id=v_plan.campus_id and assignment_date=v_session.exam_date and period_order=v_session.period_order and resolution_status='assigned';
 select count(distinct a.teacher_source_id) into v_abs_count from public.teacher_absences a where a.campus_id=v_plan.campus_id and v_session.exam_date between a.date_from and a.date_to and (a.absence_scope='all_day' or exists(select 1 from public.substitution_tasks st where st.absence_id=a.id and st.assignment_date=v_session.exam_date and st.period_order=v_session.period_order));
 return jsonb_set(jsonb_set(v_result,'{candidates}',v_filtered,true),'{excludedCounts}',coalesce(v_result->'excludedCounts','{}'::jsonb)||jsonb_build_object('substitutionConflict',v_sub_count,'activeAbsence',v_abs_count),true);
end; $$;

alter function public.set_exam_invigilation_assignment(uuid,uuid,integer,text,integer,boolean,text)
  rename to set_exam_invigilation_assignment_before_substitution;
create or replace function public.set_exam_invigilation_assignment(
 p_plan_id uuid,p_session_id uuid,p_slot_number integer,p_teacher_source_id text,
 p_expected_scope_version integer,p_duty_coverage_acknowledged boolean default false,p_duty_coverage_note text default null
) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_plan public.exam_invigilation_plans%rowtype;v_session public.exam_invigilation_sessions%rowtype;v_conflict record;
begin
 if p_teacher_source_id is not null then
  select * into v_plan from public.exam_invigilation_plans where id=p_plan_id;
  select * into v_session from public.exam_invigilation_sessions where id=p_session_id and plan_id=p_plan_id;
  select st.id,st.class_names_snapshot,st.period_name_snapshot into v_conflict from public.substitution_tasks st where st.campus_id=v_plan.campus_id and st.assignment_date=v_session.exam_date and st.period_order=v_session.period_order and st.resolution_status='assigned' and st.substitute_teacher_source_id=p_teacher_source_id limit 1;
  if found then return jsonb_build_object('status','substitution_conflict','conflictingTask',jsonb_build_object('id',v_conflict.id,'classNames',v_conflict.class_names_snapshot,'periodName',v_conflict.period_name_snapshot));end if;
  if exists(select 1 from public.teacher_absences a where a.campus_id=v_plan.campus_id and a.teacher_source_id=p_teacher_source_id and v_session.exam_date between a.date_from and a.date_to and (a.absence_scope='all_day' or exists(select 1 from public.substitution_tasks st where st.absence_id=a.id and st.assignment_date=v_session.exam_date and st.period_order=v_session.period_order))) then return jsonb_build_object('status','teacher_absent');end if;
 end if;
 return public.set_exam_invigilation_assignment_before_substitution(p_plan_id,p_session_id,p_slot_number,p_teacher_source_id,p_expected_scope_version,p_duty_coverage_acknowledged,p_duty_coverage_note);
end; $$;

-- Yokluk silme iki aşamalıdır: önce yetkili etki kümesi gösterilir, ardından
-- istemcinin onayladığı görev kimlikleri aynı transaction içinde yeniden
-- karşılaştırılır. Arada değişiklik olduysa hiçbir satır silinmez.
create or replace function public.preview_delete_teacher_absence(p_absence_id uuid,p_campus_name text,p_academic_year_name text)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
select coalesce((select jsonb_build_object(
  'found',true,'absenceId',a.id,'teacherName',a.teacher_name_snapshot,
  'isHistorical',not public.substitution_import_is_current(a.timetable_import_id),
  'affectedTasks',coalesce((select jsonb_agg(jsonb_build_object(
    'id',t.id,'assignmentDate',t.assignment_date,'periodName',t.period_name_snapshot,
    'classNames',t.class_names_snapshot,'subjectName',t.subject_name_snapshot,
    'resolutionStatus',t.resolution_status,'substituteTeacherName',t.substitute_teacher_name_snapshot
  ) order by t.assignment_date,t.period_order) from public.substitution_tasks t where t.absence_id=a.id),'[]'::jsonb)
) from public.teacher_absences a join public.campuses c on c.id=a.campus_id
join public.academic_years y on y.id=a.academic_year_id
where a.id=p_absence_id and c.name=p_campus_name and y.name=p_academic_year_name),jsonb_build_object('found',false));
$$;

create or replace function public.delete_teacher_absence(p_absence_id uuid,p_expected_task_ids jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_absence public.teacher_absences%rowtype;v_actual jsonb;v_lists uuid[];v_deleted int;
begin
 select * into v_absence from public.teacher_absences where id=p_absence_id for update;
 if not found then return jsonb_build_object('status','not_found');end if;
 if not public.substitution_import_is_current(v_absence.timetable_import_id) then return jsonb_build_object('status','historical_locked');end if;
 select coalesce(jsonb_agg(id order by id),'[]'::jsonb),array_agg(distinct day_list_id) into v_actual,v_lists from public.substitution_tasks where absence_id=p_absence_id;
 if v_actual is distinct from (select coalesce(jsonb_agg(value order by value),'[]'::jsonb) from jsonb_array_elements_text(coalesce(p_expected_task_ids,'[]'::jsonb))) then
  return jsonb_build_object('status','stale_affected_set','affectedTaskIds',v_actual);
 end if;
 delete from public.teacher_absences where id=p_absence_id;get diagnostics v_deleted=row_count;
 update public.substitution_day_lists l set version=version+1,updated_at=timezone('utc',now()) where l.id=any(coalesce(v_lists,'{}'::uuid[]));
 delete from public.substitution_day_lists l where l.id=any(coalesce(v_lists,'{}'::uuid[])) and not exists(select 1 from public.substitution_tasks t where t.day_list_id=l.id);
 return jsonb_build_object('status','ok','deleted',v_deleted);
exception when sqlstate '55000' then return jsonb_build_object('status','payroll_or_history_locked');end; $$;

create or replace function public.delete_substitution_day_list(p_list_id uuid,p_expected_version integer)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_list public.substitution_day_lists%rowtype;v_absences uuid[];
begin
 select * into v_list from public.substitution_day_lists where id=p_list_id for update;
 if not found then return jsonb_build_object('status','not_found');end if;
 if not public.substitution_import_is_current(v_list.timetable_import_id) then return jsonb_build_object('status','historical_locked');end if;
 if v_list.version<>p_expected_version then return jsonb_build_object('status','version_conflict','currentVersion',v_list.version);end if;
 select array_agg(distinct absence_id) into v_absences from public.substitution_tasks where day_list_id=p_list_id;
 delete from public.substitution_day_lists where id=p_list_id;
 delete from public.teacher_absences a where a.id=any(coalesce(v_absences,'{}'::uuid[])) and not exists(select 1 from public.substitution_tasks t where t.absence_id=a.id);
 return jsonb_build_object('status','ok');
exception when sqlstate '55000' then return jsonb_build_object('status','payroll_or_history_locked');end; $$;

do $$ declare f regprocedure; begin foreach f in array array[
 'public.substitution_import_is_current(uuid)'::regprocedure,
 'public.get_timetable_import_blockers(text,text)'::regprocedure,
 'public.prevent_timetable_import_with_open_work()'::regprocedure,
 'public.get_substitution_preparation(text,text,text,date,date)'::regprocedure,
 'public.create_teacher_absence(text,text,text,date,date,text,text,jsonb,text)'::regprocedure,
 'public.substitution_class_stage(text,text)'::regprocedure,
 'public.get_substitution_task_candidates(uuid,text,text)'::regprocedure,
 'public.set_substitution_task_resolution(uuid,text,text,integer,boolean,text)'::regprocedure,
 'public.complete_substitution_day_list(uuid,integer)'::regprocedure,
 'public.list_substitution_day_lists(text,text)'::regprocedure,
 'public.get_substitution_day_list(uuid,text,text)'::regprocedure,
 'public.preview_delete_teacher_absence(uuid,text,text)'::regprocedure,
 'public.delete_teacher_absence(uuid,jsonb)'::regprocedure,
 'public.delete_substitution_day_list(uuid,integer)'::regprocedure,
 'public.enforce_substitution_history_lock()'::regprocedure
 ,'public.enforce_exam_substitution_period_exclusivity()'::regprocedure
] loop execute format('revoke all on function %s from public,anon,authenticated',f); execute format('grant execute on function %s to service_role',f); end loop;
revoke all on function public.get_exam_invigilation_candidates(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.get_exam_invigilation_candidates(uuid,uuid,text,text) to service_role;
revoke all on function public.set_exam_invigilation_assignment(uuid,uuid,integer,text,integer,boolean,text) from public,anon,authenticated;
grant execute on function public.set_exam_invigilation_assignment(uuid,uuid,integer,text,integer,boolean,text) to service_role;
revoke all on function public.list_exam_invigilation_plans_v2(text,text,text,text,text,date,date,text) from public,anon,authenticated;
grant execute on function public.list_exam_invigilation_plans_v2(text,text,text,text,text,date,date,text) to service_role;
revoke all on function public.discard_exam_invigilation_scope(uuid,text,integer) from public,anon,authenticated;
grant execute on function public.discard_exam_invigilation_scope(uuid,text,integer) to service_role;
end $$;
