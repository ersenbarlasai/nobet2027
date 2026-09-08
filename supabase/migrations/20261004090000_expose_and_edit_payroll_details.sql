-- Puantaj ayrıntısında ders yerine görevlendirmenin iki tarafını gösterir ve
-- açık dönemdeki manuel satırların gerçek bir düzenleme işlemi olmasını sağlar.

create or replace function public.update_manual_payroll_entry(
  p_campus_name text,
  p_academic_year_name text,
  p_entry_id uuid,
  p_teacher_source_id text,
  p_duty_date date,
  p_type_id uuid,
  p_quantity numeric,
  p_note text
)
returns jsonb
language plpgsql
security invoker
set search_path=pg_catalog,public
as $$
declare
  v_campus uuid;
  v_year uuid;
  v_teacher record;
  v_bounds record;
  v_updated integer;
begin
  select c.id,y.id into v_campus,v_year
  from public.campuses c
  join public.academic_years y on y.campus_id=c.id
  where c.name=p_campus_name and y.name=p_academic_year_name;

  select source_id,name into v_teacher
  from public.teachers t
  where t.source_id=p_teacher_source_id
    and t.timetable_import_id=(
      select id from public.timetable_imports
      where campus_id=v_campus and academic_year_id=v_year and status='imported'
      order by imported_at desc nulls last,created_at desc limit 1
    );

  if not found or p_quantity=0 or not exists(
    select 1 from public.compensation_types
    where id=p_type_id and campus_id=v_campus and entry_mode='manual' and is_active
  ) then
    return jsonb_build_object('status','validation_error');
  end if;

  select * into v_bounds from public.payroll_period_bounds(p_duty_date);
  if exists(
    select 1 from public.payroll_periods
    where campus_id=v_campus and academic_year_id=v_year
      and period_start=v_bounds.period_start and period_end=v_bounds.period_end
      and status='closed'
  ) then
    return jsonb_build_object('status','period_closed');
  end if;

  update public.manual_payroll_entries
  set teacher_source_id=v_teacher.source_id,
      teacher_name_snapshot=v_teacher.name,
      duty_date=p_duty_date,
      compensation_type_id=p_type_id,
      quantity=p_quantity,
      note=nullif(btrim(p_note),'')
  where id=p_entry_id and campus_id=v_campus and academic_year_id=v_year;
  get diagnostics v_updated=row_count;
  return jsonb_build_object('status',case when v_updated=1 then 'ok' else 'not_found' end);
exception when sqlstate '55000' then
  return jsonb_build_object('status','period_closed');
end;
$$;

create or replace function public.get_payroll_overview(p_campus_name text,p_academic_year_name text,p_anchor_date date)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid;v_year uuid;v_bounds record;v_period public.payroll_periods%rowtype;v_lines jsonb;v_totals jsonb;
begin
 select c.id,y.id into v_campus,v_year from public.campuses c join public.academic_years y on y.campus_id=c.id where c.name=p_campus_name and y.name=p_academic_year_name;
 select * into v_bounds from public.payroll_period_bounds(p_anchor_date);
 perform public.close_due_payroll_periods(p_campus_name,p_academic_year_name);
 if timezone('Europe/Istanbul',now())>=v_bounds.period_end::timestamp+interval '23 hours 59 minutes' then perform public.close_payroll_period(p_campus_name,p_academic_year_name,p_anchor_date,false); end if;
 select * into v_period from public.payroll_periods where campus_id=v_campus and academic_year_id=v_year and period_start=v_bounds.period_start and period_end=v_bounds.period_end;

 if v_period.status='closed' then
  select coalesce(jsonb_agg(to_jsonb(x) || jsonb_build_object(
    'replaced_teacher_name_snapshot',case when x.source_kind='substitution' then t.absent_teacher_name_snapshot else null end,
    'day_list_id',case when x.source_kind='substitution' then t.day_list_id else null end,
    'list_version',case when x.source_kind='substitution' then l.version else null end,
    'is_historical',case when x.source_kind='substitution' then not public.substitution_import_is_current(l.timetable_import_id) else false end
  ) order by x.duty_date,x.teacher_name_snapshot),'[]'::jsonb) into v_lines
  from public.payroll_period_lines x
  left join public.substitution_tasks t on x.source_kind='substitution' and t.id=x.source_id
  left join public.substitution_day_lists l on l.id=t.day_list_id
  where x.payroll_period_id=v_period.id;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.teacher_name_snapshot),'[]'::jsonb) into v_totals from public.payroll_period_teacher_totals x where x.payroll_period_id=v_period.id;
 else
  with source_rows as (
   select t.id source_id,'substitution'::text source_kind,t.substitute_teacher_source_id teacher_source_id,t.substitute_teacher_name_snapshot teacher_name_snapshot,
    t.absent_teacher_name_snapshot replaced_teacher_name_snapshot,t.assignment_date duty_date,ct.id compensation_type_id,ct.name compensation_type_name_snapshot,1::numeric quantity,r.unit_rate,
    case when r.unit_rate is null then null else round(r.unit_rate,2) end amount_snapshot,
    t.class_names_snapshot||' · '||t.subject_name_snapshot||' · '||t.period_name_snapshot detail_snapshot,
    l.id day_list_id,l.version list_version,not public.substitution_import_is_current(l.timetable_import_id) is_historical
   from public.substitution_tasks t join public.substitution_day_lists l on l.id=t.day_list_id
   join public.compensation_types ct on ct.campus_id=t.campus_id and ct.system_code='SUBSTITUTION'
   left join lateral(select unit_rate from public.compensation_rate_versions where compensation_type_id=ct.id and effective_from<=t.assignment_date order by effective_from desc limit 1) r on true
   where t.campus_id=v_campus and l.academic_year_id=v_year and t.resolution_status='assigned' and t.assignment_date between v_bounds.period_start and v_bounds.period_end
   union all
   select m.id,'manual',m.teacher_source_id,m.teacher_name_snapshot,null::text,m.duty_date,ct.id,ct.name,m.quantity,r.unit_rate,
    case when r.unit_rate is null then null else round(m.quantity*r.unit_rate,2) end,m.note,null::uuid,null::integer,false
   from public.manual_payroll_entries m join public.compensation_types ct on ct.id=m.compensation_type_id
   left join lateral(select unit_rate from public.compensation_rate_versions where compensation_type_id=ct.id and effective_from<=m.duty_date order by effective_from desc limit 1) r on true
   where m.campus_id=v_campus and m.academic_year_id=v_year and m.duty_date between v_bounds.period_start and v_bounds.period_end
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'source_id',source_id,'source_kind',source_kind,'teacher_source_id',teacher_source_id,'teacher_name_snapshot',teacher_name_snapshot,
    'replaced_teacher_name_snapshot',replaced_teacher_name_snapshot,'duty_date',duty_date,'compensation_type_id',compensation_type_id,
    'compensation_type_name_snapshot',compensation_type_name_snapshot,'quantity',quantity,'unit_rate_snapshot',unit_rate,'amount_snapshot',amount_snapshot,
    'detail_snapshot',detail_snapshot,'rate_missing',unit_rate is null,'day_list_id',day_list_id,'list_version',list_version,'is_historical',is_historical
  ) order by duty_date,teacher_name_snapshot),'[]'::jsonb) into v_lines from source_rows;
  with x as(select * from jsonb_to_recordset(v_lines) as r(teacher_source_id text,teacher_name_snapshot text,quantity numeric,amount_snapshot numeric,compensation_type_name_snapshot text)), teachers as(
   select teacher_source_id,max(teacher_name_snapshot) teacher_name_snapshot,sum(quantity) total_quantity,sum(coalesce(amount_snapshot,0)) total_amount from x group by teacher_source_id)
  select coalesce(jsonb_agg(jsonb_build_object('teacher_source_id',t.teacher_source_id,'teacher_name_snapshot',t.teacher_name_snapshot,'total_quantity',t.total_quantity,'total_amount',t.total_amount,'breakdown',(select coalesce(jsonb_agg(jsonb_build_object('type',q.compensation_type_name_snapshot,'quantity',q.quantity,'amount',q.amount) order by q.compensation_type_name_snapshot),'[]'::jsonb) from(select compensation_type_name_snapshot,sum(quantity) quantity,sum(coalesce(amount_snapshot,0)) amount from x where teacher_source_id=t.teacher_source_id group by compensation_type_name_snapshot)q)) order by t.teacher_name_snapshot),'[]'::jsonb) into v_totals from teachers t;
 end if;
 return jsonb_build_object('periodStart',v_bounds.period_start,'periodEnd',v_bounds.period_end,'status',coalesce(v_period.status,case when timezone('Europe/Istanbul',now())>=v_bounds.period_end::timestamp+interval '23 hours 59 minutes' then 'pending_rate' else 'open' end),'periodId',v_period.id,'totals',v_totals,'lines',v_lines);
end;
$$;

revoke all on function public.update_manual_payroll_entry(text,text,uuid,text,date,uuid,numeric,text) from public,anon,authenticated;
grant execute on function public.update_manual_payroll_entry(text,text,uuid,text,date,uuid,numeric,text) to service_role;

