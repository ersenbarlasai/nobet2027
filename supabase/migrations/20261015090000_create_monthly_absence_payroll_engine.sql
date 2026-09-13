-- ============================================================================
-- Aylık yokluk borcu + 28 saat eşiği + otomatik puantaj motoru (veri altyapısı)
-- ============================================================================
-- Gerçek tahsis algoritması server/services/monthlyPayrollEngine.ts içinde
-- saf TS olarak çalışır (deterministik, test edilebilir). Bu migration o
-- motorun ihtiyaç duyduğu HAM VERİYİ toplayan ve sonucu TRANSACTION içinde,
-- idempotent biçimde donduran SQL katmanını kurar. Var olan haftalık manuel
-- puantaj (compensation_types/payroll_periods/manual_payroll_entries) hiç
-- değiştirilmez; bu, ayrı/ek bir aylık modüldür.

-- --------------------------------------------------------------------------
-- Kulüp dersi birleştirme (ders birleştirme) — substitution_tasks genişletme
-- --------------------------------------------------------------------------
alter table public.substitution_tasks add column assignment_kind text not null default 'normal' check(assignment_kind in ('normal','lesson_merge'));
alter table public.substitution_tasks add column merge_conflict_note text;
alter table public.substitution_tasks add constraint substitution_tasks_merge_ck
  check (assignment_kind='normal' or (resolution_status='assigned' and nullif(btrim(merge_conflict_note),'') is not null));
comment on column public.substitution_tasks.assignment_kind is
  'lesson_merge: öğretmen kendi Kulüp saatiyle çakışan başka bir Kulüp görevine yönetici onayıyla atandı. Bu görev puantaja (borç/eşik/ücret) HİÇ girmez.';

-- Aday listesi: öğretmenin aynı saatteki KENDİ dersi varsa normalde tam
-- dışlanır. Tek istisna: hem hedef görev hem öğretmenin kendi çakışan dersi
-- Kulüp ise — bu durumda aday listelenir ve ownKulupConflict=true işaretlenir;
-- nihai atama yönetici onayı (merge ack) gerektirir.
create or replace function public.get_substitution_task_candidates(p_task_id uuid,p_campus_name text,p_academic_year_name text)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_task public.substitution_tasks%rowtype;v_year uuid;v_limit int;v_items jsonb;v_task_is_club boolean;
begin
  select y.id into v_year from public.academic_years y join public.campuses c on c.id=y.campus_id where c.name=p_campus_name and y.name=p_academic_year_name;
  select * into v_task from public.substitution_tasks where id=p_task_id and campus_id=(select campus_id from public.academic_years where id=v_year);
  if not found then return jsonb_build_object('found',false); end if; select substitution_daily_soft_limit into v_limit from public.campuses where id=v_task.campus_id;
  v_task_is_club:=lower(v_task.subject_name_snapshot) like 'kulüp%';
  with candidate as (
    select t.source_id,t.name,t.branch,
      exists(select 1 from public.timetable_assignments ta join public.subjects s on s.id=ta.subject_id where ta.timetable_import_id=v_task.timetable_import_id and ta.teacher_id=t.id and s.source_id=v_task.subject_source_id) same_subject,
      (nullif(btrim(t.branch),'') is not null and (lower(btrim(t.branch))=lower(btrim(v_task.subject_name_snapshot)) or lower(v_task.subject_name_snapshot) like '%'||lower(btrim(t.branch))||'%')) branch_support,
      exists(select 1 from public.timetable_assignments ta join public.school_classes sc on sc.id=ta.school_class_id where ta.timetable_import_id=v_task.timetable_import_id and ta.teacher_id=t.id and sc.source_id=any(v_task.class_source_ids)) same_class,
      exists(select 1 from public.timetable_assignments ta join public.school_classes sc on sc.id=ta.school_class_id where ta.timetable_import_id=v_task.timetable_import_id and ta.teacher_id=t.id and public.substitution_class_stage(sc.grade,sc.name) in
        (select public.substitution_class_stage(x.grade,x.name) from public.school_classes x where x.timetable_import_id=v_task.timetable_import_id and x.source_id=any(v_task.class_source_ids) and public.substitution_class_stage(x.grade,x.name) is not null)) same_stage,
      (select count(*) from public.substitution_tasks st where st.campus_id=v_task.campus_id and st.substitute_teacher_source_id=t.source_id and st.resolution_status='assigned') substitution_points,
      (select count(*) from public.timetable_assignments ta join public.timetable_days d on d.id=ta.timetable_day_id where ta.timetable_import_id=v_task.timetable_import_id and ta.teacher_id=t.id and d.day_order=extract(isodow from v_task.assignment_date)::int) scheduled_today,
      (select count(*) from public.substitution_tasks st where st.campus_id=v_task.campus_id and st.assignment_date=v_task.assignment_date and st.substitute_teacher_source_id=t.source_id and st.resolution_status='assigned') assigned_today,
      own.subject_name own_conflict_subject
    from public.teachers t
    left join lateral(
      select s2.name subject_name from public.timetable_assignments ta2
      join public.timetable_days d2 on d2.id=ta2.timetable_day_id
      left join public.subjects s2 on s2.id=ta2.subject_id
      where ta2.timetable_import_id=v_task.timetable_import_id and ta2.teacher_id=t.id
        and d2.day_order=extract(isodow from v_task.assignment_date)::int
        and ta2.lesson_period_id=(select id from public.lesson_periods where timetable_import_id=v_task.timetable_import_id and period_order=v_task.period_order)
      limit 1
    ) own on true
    where t.timetable_import_id=v_task.timetable_import_id and t.source_id<>v_task.absent_teacher_source_id
      and (own.subject_name is null or (v_task_is_club and lower(own.subject_name) like 'kulüp%'))
      and not exists(select 1 from public.teacher_absences a where a.campus_id=v_task.campus_id and a.teacher_source_id=t.source_id and v_task.assignment_date between a.date_from and a.date_to and (a.absence_scope='all_day' or exists(select 1 from public.substitution_tasks at where at.absence_id=a.id and at.assignment_date=v_task.assignment_date and at.period_order=v_task.period_order)))
      and not exists(select 1 from public.substitution_tasks st where st.campus_id=v_task.campus_id and st.assignment_date=v_task.assignment_date and st.period_order=v_task.period_order and st.substitute_teacher_source_id=t.source_id and st.id<>v_task.id)
      and not exists(select 1 from public.exam_invigilation_assignments ea where ea.campus_id=v_task.campus_id and ea.exam_date=v_task.assignment_date and ea.period_order=v_task.period_order and ea.teacher_source_id=t.source_id)
  ) select coalesce(jsonb_agg(jsonb_build_object('teacherSourceId',source_id,'teacherName',name,'branch',branch,'sameSubject',same_subject,'branchSupportsSubject',branch_support,'sameClass',same_class,'sameStage',same_stage,'substitutionPoints',substitution_points,'scheduledLessonCount',scheduled_today,'assignedToday',assigned_today,'dailyLimit',v_limit,'limitExceeded',assigned_today>=v_limit,'ownKulupConflict',own_conflict_subject is not null)
      order by same_subject desc,branch_support desc,same_class desc,same_stage desc,substitution_points,scheduled_today+assigned_today,name),'[]'::jsonb) into v_items from candidate;
  return jsonb_build_object('found',true,'taskId',v_task.id,'items',v_items);
end; $$;

-- Yeni parametreler (p_merge_ack/p_merge_note) eklendiği için imza değişti;
-- CREATE OR REPLACE aynı imzayı gerektirir, aksi halde eski 6 parametreli
-- fonksiyon aşırı yüklenmiş (overload) olarak kalır. Önce açıkça düşürülür.
drop function if exists public.set_substitution_task_resolution(uuid,text,text,integer,boolean,text);

create or replace function public.set_substitution_task_resolution(p_task_id uuid,p_teacher_source_id text,p_unfilled_note text,p_expected_version integer,p_override_ack boolean default false,p_override_note text default null,p_merge_ack boolean default false,p_merge_note text default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_task public.substitution_tasks%rowtype;v_list public.substitution_day_lists%rowtype;v_candidate jsonb;v_teacher_name text;v_exceeded boolean;v_is_merge boolean;
begin
  select * into v_task from public.substitution_tasks where id=p_task_id; if not found then return jsonb_build_object('status','task_not_found'); end if;
  select * into v_list from public.substitution_day_lists where id=v_task.day_list_id for update;
  if not public.substitution_import_is_current(v_list.timetable_import_id) then return jsonb_build_object('status','historical_locked'); end if;
  if v_list.version<>p_expected_version then return jsonb_build_object('status','version_conflict','currentVersion',v_list.version); end if;
  if p_teacher_source_id is null then
    if nullif(btrim(p_unfilled_note),'') is null then
      update public.substitution_tasks set resolution_status='open',substitute_teacher_source_id=null,substitute_teacher_name_snapshot=null,daily_limit_override=false,override_note=null,unfilled_note=null,assignment_kind='normal',merge_conflict_note=null where id=v_task.id;
    else update public.substitution_tasks set resolution_status='unfilled',substitute_teacher_source_id=null,substitute_teacher_name_snapshot=null,daily_limit_override=false,override_note=null,unfilled_note=btrim(p_unfilled_note),assignment_kind='normal',merge_conflict_note=null where id=v_task.id; end if;
  else
    select x into v_candidate from jsonb_array_elements((public.get_substitution_task_candidates(v_task.id,(select name from public.campuses where id=v_task.campus_id),(select name from public.academic_years where id=v_list.academic_year_id))->'items')) x where x->>'teacherSourceId'=p_teacher_source_id;
    if v_candidate is null then return jsonb_build_object('status','teacher_not_eligible'); end if;
    v_exceeded:=coalesce((v_candidate->>'limitExceeded')::boolean,false);
    v_is_merge:=coalesce((v_candidate->>'ownKulupConflict')::boolean,false);
    if v_exceeded and (not coalesce(p_override_ack,false) or nullif(btrim(p_override_note),'') is null) then return jsonb_build_object('status','daily_limit_acknowledgement_required','candidate',v_candidate); end if;
    if v_is_merge and (not coalesce(p_merge_ack,false) or nullif(btrim(p_merge_note),'') is null) then return jsonb_build_object('status','lesson_merge_acknowledgement_required','candidate',v_candidate); end if;
    v_teacher_name:=v_candidate->>'teacherName';
    update public.substitution_tasks set resolution_status='assigned',substitute_teacher_source_id=p_teacher_source_id,substitute_teacher_name_snapshot=v_teacher_name,
      daily_limit_override=v_exceeded,override_note=case when v_exceeded then btrim(p_override_note) else null end,unfilled_note=null,
      assignment_kind=case when v_is_merge then 'lesson_merge' else 'normal' end,
      merge_conflict_note=case when v_is_merge then btrim(p_merge_note) else null end
      where id=v_task.id;
  end if;
  update public.substitution_day_lists set
    status=case when exists(select 1 from public.substitution_tasks where day_list_id=v_list.id and resolution_status='open') then 'draft' else status end,
    completed_at=case when exists(select 1 from public.substitution_tasks where day_list_id=v_list.id and resolution_status='open') then null else completed_at end,
    version=version+1 where id=v_list.id returning version into v_list.version;
  return jsonb_build_object('status','ok','version',v_list.version);
exception when unique_violation then return jsonb_build_object('status','teacher_period_conflict'); end; $$;

revoke all on function public.get_substitution_task_candidates(uuid,text,text) from public,anon,authenticated;
grant execute on function public.get_substitution_task_candidates(uuid,text,text) to service_role;
revoke all on function public.set_substitution_task_resolution(uuid,text,text,integer,boolean,text,boolean,text) from public,anon,authenticated;
grant execute on function public.set_substitution_task_resolution(uuid,text,text,integer,boolean,text,boolean,text) to service_role;

-- --------------------------------------------------------------------------
-- Ders yerine görevlendirmede kullanılacak ücret türü (ayar)
-- --------------------------------------------------------------------------
alter table public.compensation_types add constraint compensation_types_id_campus_uq unique(id,campus_id);
alter table public.campuses add column substitution_payroll_compensation_type_id uuid references public.compensation_types(id) on delete set null;

create or replace function public.set_substitution_payroll_compensation_type(p_campus_name text,p_type_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid;
begin
  select id into v_campus from public.campuses where name=p_campus_name; if v_campus is null then return jsonb_build_object('status','not_found'); end if;
  if p_type_id is not null and not exists(select 1 from public.compensation_types where id=p_type_id and campus_id=v_campus and is_active) then return jsonb_build_object('status','type_not_found'); end if;
  update public.campuses set substitution_payroll_compensation_type_id=p_type_id where id=v_campus;
  return jsonb_build_object('status','ok');
end; $$;

-- --------------------------------------------------------------------------
-- Aylık puantaj dönemleri, öğretmen bazında dondurulmuş snapshot, görev
-- tahsisleri ve yönetici düzeltmeleri
-- --------------------------------------------------------------------------
create table public.teacher_monthly_payroll_periods (
  id uuid primary key default gen_random_uuid(),
  campus_id uuid not null references public.campuses(id) on delete restrict,
  academic_year_id uuid not null references public.academic_years(id) on delete restrict,
  month_start date not null check(extract(day from month_start)=1),
  status text not null default 'open' check(status in ('open','closed')),
  closed_at timestamptz,
  created_at timestamptz not null default timezone('utc',now()),
  updated_at timestamptz not null default timezone('utc',now()),
  constraint teacher_monthly_payroll_periods_status_ck check((status='closed')=(closed_at is not null)),
  constraint teacher_monthly_payroll_periods_uq unique(campus_id,academic_year_id,month_start)
);

create table public.teacher_monthly_payroll_snapshots (
  id uuid primary key default gen_random_uuid(),
  payroll_period_id uuid not null references public.teacher_monthly_payroll_periods(id) on delete restrict,
  teacher_source_id text not null,
  teacher_name_snapshot text not null,
  active_week_count integer not null,
  normal_monthly_load integer not null,
  monthly_threshold integer not null,
  monthly_completion_gap integer not null,
  debt_carry_in integer not null,
  debt_created_this_month integer not null,
  debt_offset_count integer not null,
  threshold_fill_count integer not null,
  paid_lesson_count integer not null,
  debt_carry_out integer not null,
  gross_amount_cents bigint not null,
  correction_debt_delta integer not null default 0,
  correction_paid_count_delta integer not null default 0,
  correction_paid_count_amount_cents bigint not null default 0,
  correction_payment_amount_delta_cents bigint not null default 0,
  financial_offset_carry_in_cents bigint not null default 0,
  financial_offset_applied_cents bigint not null default 0,
  financial_offset_carry_out_cents bigint not null default 0,
  net_amount_cents bigint not null,
  created_at timestamptz not null default timezone('utc',now()),
  constraint teacher_monthly_payroll_snapshots_uq unique(payroll_period_id,teacher_source_id)
);

create table public.payroll_task_allocations (
  id uuid primary key default gen_random_uuid(),
  payroll_period_id uuid not null references public.teacher_monthly_payroll_periods(id) on delete restrict,
  source_task_id uuid not null references public.substitution_tasks(id) on delete restrict,
  teacher_source_id text not null,
  assignment_date date not null,
  period_order integer not null,
  disposition text not null check(disposition in ('debt_offset','threshold_fill','paid','rate_missing')),
  amount_cents bigint,
  created_at timestamptz not null default timezone('utc',now()),
  constraint payroll_task_allocations_task_uq unique(source_task_id)
);
comment on table public.payroll_task_allocations is
  'Her substitution_task en fazla BİR aylık puantaj kapanışında tahsis edilebilir (unique source_task_id) — mükerrer sayımı veritabanı seviyesinde engeller.';

create index payroll_task_allocations_period_idx on public.payroll_task_allocations(payroll_period_id,teacher_source_id);

create table public.payroll_corrections (
  id uuid primary key default gen_random_uuid(),
  campus_id uuid not null references public.campuses(id) on delete restrict,
  academic_year_id uuid not null references public.academic_years(id) on delete restrict,
  teacher_source_id text not null check(btrim(teacher_source_id)<>''),
  teacher_name_snapshot text not null,
  applies_to_period_id uuid not null references public.teacher_monthly_payroll_periods(id) on delete restrict,
  correction_type text not null check(correction_type in ('debt_adjust','paid_count_adjust','payment_amount_adjust')),
  amount numeric(10,2) not null check(amount<>0),
  unit_rate_cents_snapshot bigint,
  reason text not null check(btrim(reason)<>''),
  references_period_id uuid references public.teacher_monthly_payroll_periods(id),
  references_task_id uuid references public.substitution_tasks(id),
  created_by text,
  created_at timestamptz not null default timezone('utc',now())
);
comment on table public.payroll_corrections is
  'Yönetici düzeltmeleri. Ana otomatik hesap satırı ÜZERİNE YAZILMAZ — motor bu düzeltmeleri ayrı bir hareket olarak okur ve sonuca ekler.';

create index payroll_corrections_period_idx on public.payroll_corrections(applies_to_period_id,teacher_source_id);

create table public.absence_debt_year_end_clearances (
  id uuid primary key default gen_random_uuid(),
  campus_id uuid not null references public.campuses(id) on delete restrict,
  academic_year_id uuid not null references public.academic_years(id) on delete restrict,
  teacher_source_id text not null,
  teacher_name_snapshot text not null,
  cleared_amount integer not null check(cleared_amount>0),
  reason text not null check(btrim(reason)<>''),
  created_by text,
  created_at timestamptz not null default timezone('utc',now())
);
comment on table public.absence_debt_year_end_clearances is
  'Eğitim yılı sonu borç kapatma denetim kaydı. Geçmişi SİLMEZ — yalnız sonraki ayın devreden borcunu bu miktar kadar düşüren gerekçeli bir hareket olarak saklanır.';

alter table public.teacher_monthly_payroll_periods enable row level security;
alter table public.teacher_monthly_payroll_snapshots enable row level security;
alter table public.payroll_task_allocations enable row level security;
alter table public.payroll_corrections enable row level security;
alter table public.absence_debt_year_end_clearances enable row level security;
revoke all on public.teacher_monthly_payroll_periods,public.teacher_monthly_payroll_snapshots,public.payroll_task_allocations,public.payroll_corrections,public.absence_debt_year_end_clearances from public,anon,authenticated;
grant select,insert,update,delete on public.teacher_monthly_payroll_periods,public.teacher_monthly_payroll_snapshots,public.payroll_task_allocations,public.payroll_corrections,public.absence_debt_year_end_clearances to service_role;

create trigger set_updated_at before update on public.teacher_monthly_payroll_periods for each row execute function public.set_updated_at();

-- Kapanmış dönemin snapshot/tahsis satırları değiştirilemez.
create or replace function public.enforce_monthly_payroll_closed_lock() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if exists(select 1 from public.teacher_monthly_payroll_periods p where p.id=old.payroll_period_id and p.status='closed') then
    raise exception 'Kapanmış aylık puantaj kaydı değiştirilemez.' using errcode='55000';
  end if;
  return case when tg_op='DELETE' then old else new end;
end; $$;
create trigger monthly_payroll_snapshot_lock before update or delete on public.teacher_monthly_payroll_snapshots for each row execute function public.enforce_monthly_payroll_closed_lock();
create trigger monthly_payroll_allocation_lock before update or delete on public.payroll_task_allocations for each row execute function public.enforce_monthly_payroll_closed_lock();

-- Kapanmış aylık puantajda tahsis edilmiş bir substitution_task'ın KAYNAĞI da
-- değiştirilemez (yalnız snapshot/tahsis satırlarını kilitlemek yetmez —
-- "kapanmış dönemin kaynak kayıtları ... değiştirilemesin" kuralı).
create or replace function public.enforce_monthly_payroll_source_lock() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if exists(
    select 1 from public.payroll_task_allocations a
    join public.teacher_monthly_payroll_periods p on p.id=a.payroll_period_id and p.status='closed'
    where a.source_task_id=old.id
  ) then
    raise exception 'Kapanmış aylık puantaja bağlı görev değiştirilemez.' using errcode='55000';
  end if;
  return case when tg_op='DELETE' then old else new end;
end; $$;
create trigger substitution_monthly_payroll_lock before update or delete on public.substitution_tasks for each row execute function public.enforce_monthly_payroll_source_lock();

-- --------------------------------------------------------------------------
-- Belirli bir tarihte "geçerli" XML sürümü (o tarihte fiilen kullanılan
-- program). Tarihten önceki en son import; hiçbiri yoksa en eski import
-- (bilinmiyor/doğrulama gerekli olarak işaretlenmek üzere).
-- --------------------------------------------------------------------------
create or replace function public.get_xml_import_for_date(p_campus uuid,p_year uuid,p_date date)
returns uuid language sql stable security invoker set search_path=pg_catalog,public as $$
  select coalesce(
    (select id from public.timetable_imports where campus_id=p_campus and academic_year_id=p_year and status='imported' and imported_at::date<=p_date order by imported_at desc,created_at desc limit 1),
    (select id from public.timetable_imports where campus_id=p_campus and academic_year_id=p_year and status='imported' order by imported_at asc nulls last,created_at asc limit 1)
  );
$$;

-- Bir XML importunda bir öğretmenin Kulüp HARİÇ haftalık ders saati toplamı.
create or replace function public.get_teacher_weekly_normal_load(p_import_id uuid,p_teacher_source_id text)
returns integer language sql stable security invoker set search_path=pg_catalog,public as $$
  select count(*)::int from public.timetable_assignments ta
  join public.teachers t on t.id=ta.teacher_id
  left join public.subjects s on s.id=ta.subject_id
  where ta.timetable_import_id=p_import_id and t.source_id=p_teacher_source_id
    and lower(coalesce(s.name,'')) not like 'kulüp%';
$$;

-- --------------------------------------------------------------------------
-- Bir öğretmenin belirli aydaki HAM girdilerini toplar (motor bunu tüketir).
-- --------------------------------------------------------------------------
create or replace function public.get_teacher_monthly_payroll_inputs(p_campus_name text,p_academic_year_name text,p_teacher_source_id text,p_month_start date)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid;v_year uuid;v_month_end date;v_active_weeks jsonb;v_debt_this_month int;v_lessons jsonb;
  v_prev_start date;v_prev_period uuid;v_prev_snapshot record;v_carry_debt int:=0;v_carry_offset bigint:=0;
  v_rate_type uuid;v_corrections jsonb;v_teacher_name text;
begin
  select c.id,y.id into v_campus,v_year from public.campuses c join public.academic_years y on y.campus_id=c.id where c.name=p_campus_name and y.name=p_academic_year_name;
  select name into v_teacher_name from public.teachers where source_id=p_teacher_source_id and timetable_import_id=(select id from public.timetable_imports where campus_id=v_campus and academic_year_id=v_year and status='imported' order by imported_at desc nulls last,created_at desc limit 1);
  v_month_end:=(date_trunc('month',p_month_start)+interval '1 month'-interval '1 day')::date;
  select coalesce(jsonb_agg(jsonb_build_object('weekMonday',w.week_monday,'timetableImportId',imp.import_id,'normalWeeklyLoad',coalesce(public.get_teacher_weekly_normal_load(imp.import_id,p_teacher_source_id),0)) order by w.week_monday),'[]'::jsonb)
  into v_active_weeks
  from public.get_active_calendar_weeks_in_month(p_campus_name,p_academic_year_name,p_month_start) w
  cross join lateral(select public.get_xml_import_for_date(v_campus,v_year,w.week_monday) import_id) imp;

  select count(*) into v_debt_this_month from public.substitution_tasks t join public.teacher_absences a on a.id=t.absence_id
  where a.campus_id=v_campus and a.teacher_source_id=p_teacher_source_id and a.absence_creates_debt_snapshot=true
    and t.assignment_date between p_month_start and v_month_end;

  v_prev_start:=(date_trunc('month',p_month_start)-interval '1 month')::date;
  select id into v_prev_period from public.teacher_monthly_payroll_periods where campus_id=v_campus and academic_year_id=v_year and month_start=v_prev_start and status='closed';
  if v_prev_period is not null then
    select debt_carry_out,financial_offset_carry_out_cents into v_carry_debt,v_carry_offset from public.teacher_monthly_payroll_snapshots where payroll_period_id=v_prev_period and teacher_source_id=p_teacher_source_id;
    v_carry_debt:=coalesce(v_carry_debt,0); v_carry_offset:=coalesce(v_carry_offset,0);
  end if;

  select substitution_payroll_compensation_type_id into v_rate_type from public.campuses where id=v_campus;

  select coalesce(jsonb_agg(jsonb_build_object(
    'taskId',t.id,'assignmentDate',t.assignment_date,'periodOrder',t.period_order,
    'unitRateCents',case when v_rate_type is null then null else (select round(r.unit_rate*100)::bigint from public.compensation_rate_versions r where r.compensation_type_id=v_rate_type and r.effective_from<=t.assignment_date order by r.effective_from desc limit 1) end
  ) order by t.assignment_date,t.period_order),'[]'::jsonb) into v_lessons
  from public.substitution_tasks t
  where t.campus_id=v_campus and t.substitute_teacher_source_id=p_teacher_source_id and t.resolution_status='assigned'
    and t.assignment_kind='normal' and t.assignment_date between p_month_start and v_month_end
    and not exists(select 1 from public.payroll_task_allocations pa where pa.source_task_id=t.id);

  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'type',c.correction_type,'amount',c.amount,'unitRateCentsAtCorrection',c.unit_rate_cents_snapshot)),'[]'::jsonb) into v_corrections
  from public.payroll_corrections c join public.teacher_monthly_payroll_periods p on p.id=c.applies_to_period_id
  where p.campus_id=v_campus and p.academic_year_id=v_year and p.month_start=p_month_start and p.status='open' and c.teacher_source_id=p_teacher_source_id;

  return jsonb_build_object(
    'teacherSourceId',p_teacher_source_id,'teacherNameSnapshot',coalesce(v_teacher_name,p_teacher_source_id),'monthStart',p_month_start,
    'activeWeeks',v_active_weeks,'carryInDebt',v_carry_debt,'debtCreatedThisMonth',v_debt_this_month,
    'qualifyingLessons',v_lessons,'carryInFinancialOffsetCents',v_carry_offset,'corrections',v_corrections,
    'hasEducationCalendar',exists(select 1 from public.education_terms where campus_id=v_campus and academic_year_id=v_year),
    'hasCompensationType',v_rate_type is not null
  );
end; $$;

-- Bu ay içinde en az bir yokluk/görev bulunan tüm öğretmenlerin kimliği.
create or replace function public.list_monthly_payroll_relevant_teachers(p_campus_name text,p_academic_year_name text,p_month_start date)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  with ctx as(select c.id campus_id,y.id year_id from public.campuses c join public.academic_years y on y.campus_id=c.id where c.name=p_campus_name and y.name=p_academic_year_name),
  bounds as(select p_month_start s,(date_trunc('month',p_month_start)+interval '1 month'-interval '1 day')::date e)
  select coalesce(jsonb_agg(jsonb_build_object('sourceId',x.source_id,'name',x.name) order by x.name),'[]'::jsonb) from (
    select distinct a.teacher_source_id source_id,a.teacher_name_snapshot name from public.teacher_absences a join ctx on ctx.campus_id=a.campus_id, bounds
      where a.date_from<=bounds.e and a.date_to>=bounds.s
    union
    select distinct t.substitute_teacher_source_id,t.substitute_teacher_name_snapshot from public.substitution_tasks t join ctx on ctx.campus_id=t.campus_id, bounds
      where t.resolution_status='assigned' and t.assignment_date between bounds.s and bounds.e
  ) x where x.source_id is not null;
$$;

-- --------------------------------------------------------------------------
-- Kapanış: TS motorunun ürettiği sonucu (jsonb) transaction içinde,
-- idempotent biçimde dondurur. Aynı dönem+öğretmen için ikinci çağrı,
-- var olan satırları SİLİP YENİDEN yazar (dönem henüz 'open' iken); dönem
-- 'closed' ise no-op döner (mükerrer kapanış korumalı).
-- --------------------------------------------------------------------------
create or replace function public.persist_monthly_payroll_snapshot(p_campus_name text,p_academic_year_name text,p_month_start date,p_result jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid;v_year uuid;v_period uuid;v_status text;v_teacher text;v_alloc jsonb;
begin
  select c.id,y.id into v_campus,v_year from public.campuses c join public.academic_years y on y.campus_id=c.id where c.name=p_campus_name and y.name=p_academic_year_name;
  insert into public.teacher_monthly_payroll_periods(campus_id,academic_year_id,month_start) values(v_campus,v_year,p_month_start)
    on conflict(campus_id,academic_year_id,month_start) do update set updated_at=excluded.updated_at returning id,status into v_period,v_status;
  if v_status='closed' then return jsonb_build_object('status','already_closed','periodId',v_period); end if;
  v_teacher:=p_result->>'teacherSourceId';
  delete from public.payroll_task_allocations where payroll_period_id=v_period and teacher_source_id=v_teacher;
  delete from public.teacher_monthly_payroll_snapshots where payroll_period_id=v_period and teacher_source_id=v_teacher;
  insert into public.teacher_monthly_payroll_snapshots(
    payroll_period_id,teacher_source_id,teacher_name_snapshot,active_week_count,normal_monthly_load,monthly_threshold,monthly_completion_gap,
    debt_carry_in,debt_created_this_month,debt_offset_count,threshold_fill_count,paid_lesson_count,debt_carry_out,gross_amount_cents,
    correction_debt_delta,correction_paid_count_delta,correction_paid_count_amount_cents,correction_payment_amount_delta_cents,
    financial_offset_carry_in_cents,financial_offset_applied_cents,financial_offset_carry_out_cents,net_amount_cents
  ) values (
    v_period,v_teacher,p_result->>'teacherNameSnapshot',(p_result->>'activeWeekCount')::int,(p_result->>'normalMonthlyLoad')::int,(p_result->>'monthlyThreshold')::int,(p_result->>'monthlyCompletionGap')::int,
    (p_result->>'debtCarryIn')::int,(p_result->>'debtCreatedThisMonth')::int,(p_result->>'debtOffsetCount')::int,(p_result->>'thresholdFillCount')::int,(p_result->>'paidLessonCount')::int,(p_result->>'debtCarryOut')::int,(p_result->>'grossAmountCents')::bigint,
    coalesce((p_result->>'correctionDebtDelta')::int,0),coalesce((p_result->>'correctionPaidCountDelta')::int,0),coalesce((p_result->>'correctionPaidCountAmountCents')::bigint,0),coalesce((p_result->>'correctionPaymentAmountDeltaCents')::bigint,0),
    coalesce((p_result->>'financialOffsetCarryIn')::bigint,0),coalesce((p_result->>'financialOffsetApplied')::bigint,0),coalesce((p_result->>'financialOffsetCarryOut')::bigint,0),(p_result->>'netAmountCents')::bigint
  );
  for v_alloc in select value from jsonb_array_elements(coalesce(p_result->'taskAllocations','[]'::jsonb)) loop
    insert into public.payroll_task_allocations(payroll_period_id,source_task_id,teacher_source_id,assignment_date,period_order,disposition,amount_cents)
      values(v_period,(v_alloc->>'taskId')::uuid,v_teacher,(v_alloc->>'assignmentDate')::date,(v_alloc->>'periodOrder')::int,v_alloc->>'disposition',
        case when v_alloc->>'amountCents' is null then null else (v_alloc->>'amountCents')::bigint end)
      on conflict(source_task_id) do nothing;
  end loop;
  return jsonb_build_object('status','ok','periodId',v_period);
end; $$;

create or replace function public.close_monthly_payroll_period(p_campus_name text,p_academic_year_name text,p_month_start date)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid;v_year uuid;v_period uuid;
begin
  select c.id,y.id into v_campus,v_year from public.campuses c join public.academic_years y on y.campus_id=c.id where c.name=p_campus_name and y.name=p_academic_year_name;
  select id into v_period from public.teacher_monthly_payroll_periods where campus_id=v_campus and academic_year_id=v_year and month_start=p_month_start;
  if v_period is null then return jsonb_build_object('status','not_found'); end if;
  update public.teacher_monthly_payroll_periods set status='closed',closed_at=timezone('utc',now()) where id=v_period and status='open';
  return jsonb_build_object('status','ok','periodId',v_period);
end; $$;

create or replace function public.list_monthly_payroll_periods(p_campus_name text,p_academic_year_name text)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'monthStart',p.month_start,'status',p.status,'closedAt',p.closed_at) order by p.month_start desc),'[]'::jsonb)
  from public.teacher_monthly_payroll_periods p join public.campuses c on c.id=p.campus_id join public.academic_years y on y.id=p.academic_year_id
  where c.name=p_campus_name and y.name=p_academic_year_name;
$$;

create or replace function public.get_monthly_payroll_snapshot(p_campus_name text,p_academic_year_name text,p_month_start date,p_teacher_source_id text)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  select coalesce((select to_jsonb(s)||jsonb_build_object('allocations',(select coalesce(jsonb_agg(to_jsonb(a) order by a.assignment_date,a.period_order),'[]'::jsonb) from public.payroll_task_allocations a where a.payroll_period_id=s.payroll_period_id and a.teacher_source_id=s.teacher_source_id))
    from public.teacher_monthly_payroll_snapshots s
    join public.teacher_monthly_payroll_periods p on p.id=s.payroll_period_id
    join public.campuses c on c.id=p.campus_id join public.academic_years y on y.id=p.academic_year_id
    where c.name=p_campus_name and y.name=p_academic_year_name and p.month_start=p_month_start and s.teacher_source_id=p_teacher_source_id),
    jsonb_build_object('found',false));
$$;

-- --------------------------------------------------------------------------
-- Yönetici düzeltmeleri
-- --------------------------------------------------------------------------
create or replace function public.add_payroll_correction(p_campus_name text,p_academic_year_name text,p_teacher_source_id text,p_month_start date,p_correction_type text,p_amount numeric,p_unit_rate_cents numeric,p_reason text,p_created_by text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid;v_year uuid;v_period uuid;v_status text;v_teacher_name text;v_id uuid;
begin
  select c.id,y.id into v_campus,v_year from public.campuses c join public.academic_years y on y.campus_id=c.id where c.name=p_campus_name and y.name=p_academic_year_name;
  if p_correction_type not in ('debt_adjust','paid_count_adjust','payment_amount_adjust') or p_amount=0 or nullif(btrim(p_reason),'') is null then return jsonb_build_object('status','validation_error'); end if;
  insert into public.teacher_monthly_payroll_periods(campus_id,academic_year_id,month_start) values(v_campus,v_year,p_month_start)
    on conflict(campus_id,academic_year_id,month_start) do update set updated_at=excluded.updated_at returning id,status into v_period,v_status;
  if v_status='closed' then return jsonb_build_object('status','period_closed'); end if;
  select coalesce(max(teacher_name_snapshot),p_teacher_source_id) into v_teacher_name from public.teacher_absences where teacher_source_id=p_teacher_source_id;
  insert into public.payroll_corrections(campus_id,academic_year_id,teacher_source_id,teacher_name_snapshot,applies_to_period_id,correction_type,amount,unit_rate_cents_snapshot,reason,created_by)
    values(v_campus,v_year,p_teacher_source_id,v_teacher_name,v_period,p_correction_type,p_amount,case when p_correction_type='paid_count_adjust' then round(p_unit_rate_cents) else null end,btrim(p_reason),p_created_by)
    returning id into v_id;
  return jsonb_build_object('status','ok','id',v_id,'periodId',v_period);
end; $$;

create or replace function public.list_payroll_corrections(p_campus_name text,p_academic_year_name text,p_month_start date,p_teacher_source_id text)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'type',c.correction_type,'amount',c.amount,'reason',c.reason,'createdAt',c.created_at,'createdBy',c.created_by) order by c.created_at),'[]'::jsonb)
  from public.payroll_corrections c
  join public.teacher_monthly_payroll_periods p on p.id=c.applies_to_period_id
  join public.campuses cp on cp.id=p.campus_id join public.academic_years y on y.id=p.academic_year_id
  where cp.name=p_campus_name and y.name=p_academic_year_name and p.month_start=p_month_start and c.teacher_source_id=p_teacher_source_id;
$$;

-- --------------------------------------------------------------------------
-- Eğitim yılı sonu borç kapatma. Geçmişi silmez; devreden borcu bir sonraki
-- açık ay için "negatif düzeltme" (debt_adjust, negatif miktar) olarak yazar
-- ve ayrı bir denetim kaydı (absence_debt_year_end_clearances) tutar.
-- --------------------------------------------------------------------------
create or replace function public.clear_teacher_absence_debt(p_campus_name text,p_academic_year_name text,p_teacher_source_id text,p_debt_amount integer,p_reason text,p_created_by text,p_target_month_start date)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid;v_year uuid;v_teacher_name text;
begin
  select c.id,y.id into v_campus,v_year from public.campuses c join public.academic_years y on y.campus_id=c.id where c.name=p_campus_name and y.name=p_academic_year_name;
  if p_debt_amount is null or p_debt_amount<=0 or nullif(btrim(p_reason),'') is null then return jsonb_build_object('status','validation_error'); end if;
  select coalesce(max(teacher_name_snapshot),p_teacher_source_id) into v_teacher_name from public.teacher_absences where teacher_source_id=p_teacher_source_id;
  insert into public.absence_debt_year_end_clearances(campus_id,academic_year_id,teacher_source_id,teacher_name_snapshot,cleared_amount,reason,created_by)
    values(v_campus,v_year,p_teacher_source_id,v_teacher_name,p_debt_amount,btrim(p_reason),p_created_by);
  perform public.add_payroll_correction(p_campus_name,p_academic_year_name,p_teacher_source_id,p_target_month_start,'debt_adjust',-p_debt_amount,null,'Eğitim yılı sonu borç kapatma: '||btrim(p_reason),p_created_by);
  return jsonb_build_object('status','ok');
end; $$;

create or replace function public.list_absence_debt_year_end_clearances(p_campus_name text,p_academic_year_name text)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'teacherName',x.teacher_name_snapshot,'clearedAmount',x.cleared_amount,'reason',x.reason,'createdAt',x.created_at,'createdBy',x.created_by) order by x.created_at desc),'[]'::jsonb)
  from public.absence_debt_year_end_clearances x join public.campuses c on c.id=x.campus_id join public.academic_years y on y.id=x.academic_year_id
  where c.name=p_campus_name and y.name=p_academic_year_name;
$$;

do $$ declare f regprocedure; begin foreach f in array array[
 'public.set_substitution_payroll_compensation_type(text,uuid)'::regprocedure,
 'public.get_xml_import_for_date(uuid,uuid,date)'::regprocedure,
 'public.get_teacher_weekly_normal_load(uuid,text)'::regprocedure,
 'public.get_teacher_monthly_payroll_inputs(text,text,text,date)'::regprocedure,
 'public.list_monthly_payroll_relevant_teachers(text,text,date)'::regprocedure,
 'public.persist_monthly_payroll_snapshot(text,text,date,jsonb)'::regprocedure,
 'public.close_monthly_payroll_period(text,text,date)'::regprocedure,
 'public.list_monthly_payroll_periods(text,text)'::regprocedure,
 'public.get_monthly_payroll_snapshot(text,text,date,text)'::regprocedure,
 'public.add_payroll_correction(text,text,text,date,text,numeric,numeric,text,text)'::regprocedure,
 'public.list_payroll_corrections(text,text,date,text)'::regprocedure,
 'public.clear_teacher_absence_debt(text,text,text,integer,text,text,date)'::regprocedure,
 'public.list_absence_debt_year_end_clearances(text,text)'::regprocedure,
 'public.enforce_monthly_payroll_closed_lock()'::regprocedure,
 'public.enforce_monthly_payroll_source_lock()'::regprocedure
] loop execute format('revoke all on function %s from public,anon,authenticated',f); execute format('grant execute on function %s to service_role',f); end loop; end $$;
