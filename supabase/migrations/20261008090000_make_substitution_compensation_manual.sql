-- Ders yerine görevlendirme puantajını otomatik görev listesinden ayırır.
-- Bundan sonra bu tür, diğer manuel ücret türleri gibi yönetici tarafından
-- puantaja eklenir. Daha önce kapanmış dönemlerin snapshot satırları korunur.

update public.compensation_types
set entry_mode = 'manual'
where system_code = 'SUBSTITUTION';

create or replace function public.ensure_default_compensation_types(p_campus uuid)
returns void
language plpgsql
security invoker
set search_path=pg_catalog,public
as $$
begin
  insert into public.compensation_types(campus_id,name,system_code,entry_mode)
  values(p_campus,'Ders yerine görevlendirme','SUBSTITUTION','manual')
  on conflict do nothing;

  insert into public.compensation_types(campus_id,name,entry_mode)
  values
    (p_campus,'Sabah Nöbeti','manual'),
    (p_campus,'Akşam Nöbeti','manual'),
    (p_campus,'Akşam Etütü','manual')
  on conflict do nothing;
end;
$$;

create or replace function public.close_payroll_period(
  p_campus_name text,
  p_academic_year_name text,
  p_anchor_date date,
  p_force boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path=pg_catalog,public
as $$
declare
  v_campus uuid;
  v_year uuid;
  v_bounds record;
  v_period uuid;
  v_missing integer;
begin
  select c.id,y.id into v_campus,v_year
  from public.campuses c
  join public.academic_years y on y.campus_id=c.id
  where c.name=p_campus_name and y.name=p_academic_year_name;

  select * into v_bounds from public.payroll_period_bounds(p_anchor_date);
  insert into public.payroll_periods(campus_id,academic_year_id,period_start,period_end)
  values(v_campus,v_year,v_bounds.period_start,v_bounds.period_end)
  on conflict(campus_id,academic_year_id,period_start,period_end)
  do update set updated_at=excluded.updated_at
  returning id into v_period;

  if (select status from public.payroll_periods where id=v_period)='closed' then
    return jsonb_build_object('status','already_closed','periodId',v_period);
  end if;
  if not p_force and timezone('Europe/Istanbul',now())<v_bounds.period_end::timestamp+interval '23 hours 59 minutes' then
    return jsonb_build_object('status','not_due','periodId',v_period);
  end if;

  select count(*) into v_missing
  from public.manual_payroll_entries m
  where m.campus_id=v_campus
    and m.academic_year_id=v_year
    and m.duty_date between v_bounds.period_start and v_bounds.period_end
    and not exists(
      select 1 from public.compensation_rate_versions r
      where r.compensation_type_id=m.compensation_type_id
        and r.effective_from<=m.duty_date
    );

  if v_missing>0 then
    update public.payroll_periods set status='pending_rate' where id=v_period;
    return jsonb_build_object('status','pending_rate','periodId',v_period,'missingRateCount',v_missing);
  end if;

  delete from public.payroll_period_lines where payroll_period_id=v_period;
  delete from public.payroll_period_teacher_totals where payroll_period_id=v_period;

  insert into public.payroll_period_lines(
    payroll_period_id,source_kind,source_id,compensation_type_id,rate_version_id,
    teacher_source_id,teacher_name_snapshot,duty_date,
    compensation_type_name_snapshot,quantity,unit_rate_snapshot,
    amount_snapshot,detail_snapshot
  )
  select
    v_period,'manual',m.id,ct.id,r.id,m.teacher_source_id,
    m.teacher_name_snapshot,m.duty_date,ct.name,m.quantity,r.unit_rate,
    round(m.quantity*r.unit_rate,2),m.note
  from public.manual_payroll_entries m
  join public.compensation_types ct on ct.id=m.compensation_type_id
  join lateral(
    select id,unit_rate
    from public.compensation_rate_versions
    where compensation_type_id=ct.id and effective_from<=m.duty_date
    order by effective_from desc
    limit 1
  ) r on true
  where m.campus_id=v_campus
    and m.academic_year_id=v_year
    and m.duty_date between v_bounds.period_start and v_bounds.period_end;

  insert into public.payroll_period_teacher_totals(
    payroll_period_id,teacher_source_id,teacher_name_snapshot,
    total_quantity,total_amount,breakdown
  )
  select
    v_period,l.teacher_source_id,max(l.teacher_name_snapshot),sum(l.quantity),
    sum(l.amount_snapshot),
    (
      select jsonb_agg(
        jsonb_build_object('type',q.compensation_type_name_snapshot,'quantity',q.qty,'amount',q.amount)
        order by q.compensation_type_name_snapshot
      )
      from (
        select compensation_type_name_snapshot,sum(quantity) qty,sum(amount_snapshot) amount
        from public.payroll_period_lines x
        where x.payroll_period_id=v_period and x.teacher_source_id=l.teacher_source_id
        group by compensation_type_name_snapshot
      ) q
    )
  from public.payroll_period_lines l
  where l.payroll_period_id=v_period
  group by l.teacher_source_id;

  update public.payroll_periods
  set status='closed',closed_at=timezone('utc',now())
  where id=v_period;
  return jsonb_build_object('status','ok','periodId',v_period);
end;
$$;

create or replace function public.close_due_payroll_periods(
  p_campus_name text,
  p_academic_year_name text
)
returns jsonb
language plpgsql
security invoker
set search_path=pg_catalog,public
as $$
declare
  v_campus uuid;
  v_year uuid;
  v_first date;
  v_anchor date;
  v_bounds record;
  v_result jsonb;
  v_processed integer:=0;
begin
  select c.id,y.id into v_campus,v_year
  from public.campuses c
  join public.academic_years y on y.campus_id=c.id
  where c.name=p_campus_name and y.name=p_academic_year_name;

  select min(m.duty_date) into v_first
  from public.manual_payroll_entries m
  where m.campus_id=v_campus and m.academic_year_id=v_year;

  if v_first is null then
    return jsonb_build_object('processed',0);
  end if;
  v_anchor:=v_first;
  loop
    select * into v_bounds from public.payroll_period_bounds(v_anchor);
    exit when timezone('Europe/Istanbul',now())<v_bounds.period_end::timestamp+interval '23 hours 59 minutes';
    v_result:=public.close_payroll_period(p_campus_name,p_academic_year_name,v_anchor,false);
    v_processed:=v_processed+1;
    v_anchor:=v_bounds.period_end+1;
    exit when v_processed>=120;
  end loop;
  return jsonb_build_object('processed',v_processed);
end;
$$;

create or replace function public.get_payroll_overview(
  p_campus_name text,
  p_academic_year_name text,
  p_anchor_date date
)
returns jsonb
language plpgsql
security invoker
set search_path=pg_catalog,public
as $$
declare
  v_campus uuid;
  v_year uuid;
  v_bounds record;
  v_period public.payroll_periods%rowtype;
  v_lines jsonb;
  v_totals jsonb;
begin
  select c.id,y.id into v_campus,v_year
  from public.campuses c
  join public.academic_years y on y.campus_id=c.id
  where c.name=p_campus_name and y.name=p_academic_year_name;
  select * into v_bounds from public.payroll_period_bounds(p_anchor_date);
  perform public.close_due_payroll_periods(p_campus_name,p_academic_year_name);
  if timezone('Europe/Istanbul',now())>=v_bounds.period_end::timestamp+interval '23 hours 59 minutes' then
    perform public.close_payroll_period(p_campus_name,p_academic_year_name,p_anchor_date,false);
  end if;
  select * into v_period
  from public.payroll_periods
  where campus_id=v_campus and academic_year_id=v_year
    and period_start=v_bounds.period_start and period_end=v_bounds.period_end;

  if v_period.status='closed' then
    -- Eski kapanış snapshot'larında otomatik substitution satırları bulunabilir;
    -- kapanmış mali kayıtlar değiştirilemez ve aynen görüntülenir.
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

    select coalesce(jsonb_agg(to_jsonb(x) order by x.teacher_name_snapshot),'[]'::jsonb)
    into v_totals
    from public.payroll_period_teacher_totals x
    where x.payroll_period_id=v_period.id;
  else
    with source_rows as (
      select
        m.id source_id,'manual'::text source_kind,m.teacher_source_id,
        m.teacher_name_snapshot,null::text replaced_teacher_name_snapshot,
        m.duty_date,ct.id compensation_type_id,ct.name compensation_type_name_snapshot,
        m.quantity,r.unit_rate,
        case when r.unit_rate is null then null else round(m.quantity*r.unit_rate,2) end amount_snapshot,
        m.note detail_snapshot,null::uuid day_list_id,null::integer list_version,
        false is_historical
      from public.manual_payroll_entries m
      join public.compensation_types ct on ct.id=m.compensation_type_id
      left join lateral(
        select unit_rate
        from public.compensation_rate_versions
        where compensation_type_id=ct.id and effective_from<=m.duty_date
        order by effective_from desc
        limit 1
      ) r on true
      where m.campus_id=v_campus
        and m.academic_year_id=v_year
        and m.duty_date between v_bounds.period_start and v_bounds.period_end
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'source_id',source_id,'source_kind',source_kind,
      'teacher_source_id',teacher_source_id,'teacher_name_snapshot',teacher_name_snapshot,
      'replaced_teacher_name_snapshot',replaced_teacher_name_snapshot,'duty_date',duty_date,
      'compensation_type_id',compensation_type_id,
      'compensation_type_name_snapshot',compensation_type_name_snapshot,
      'quantity',quantity,'unit_rate_snapshot',unit_rate,
      'amount_snapshot',amount_snapshot,'detail_snapshot',detail_snapshot,
      'rate_missing',unit_rate is null,'day_list_id',day_list_id,
      'list_version',list_version,'is_historical',is_historical
    ) order by duty_date,teacher_name_snapshot),'[]'::jsonb)
    into v_lines
    from source_rows;

    with x as (
      select * from jsonb_to_recordset(v_lines) as r(
        teacher_source_id text,teacher_name_snapshot text,quantity numeric,
        amount_snapshot numeric,compensation_type_name_snapshot text
      )
    ), teachers as (
      select teacher_source_id,max(teacher_name_snapshot) teacher_name_snapshot,
        sum(quantity) total_quantity,sum(coalesce(amount_snapshot,0)) total_amount
      from x group by teacher_source_id
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'teacher_source_id',t.teacher_source_id,
      'teacher_name_snapshot',t.teacher_name_snapshot,
      'total_quantity',t.total_quantity,'total_amount',t.total_amount,
      'breakdown',(
        select coalesce(jsonb_agg(jsonb_build_object(
          'type',q.compensation_type_name_snapshot,'quantity',q.quantity,'amount',q.amount
        ) order by q.compensation_type_name_snapshot),'[]'::jsonb)
        from (
          select compensation_type_name_snapshot,sum(quantity) quantity,
            sum(coalesce(amount_snapshot,0)) amount
          from x where teacher_source_id=t.teacher_source_id
          group by compensation_type_name_snapshot
        ) q
      )
    ) order by t.teacher_name_snapshot),'[]'::jsonb)
    into v_totals from teachers t;
  end if;

  return jsonb_build_object(
    'periodStart',v_bounds.period_start,'periodEnd',v_bounds.period_end,
    'status',coalesce(v_period.status,case
      when timezone('Europe/Istanbul',now())>=v_bounds.period_end::timestamp+interval '23 hours 59 minutes'
      then 'pending_rate' else 'open' end),
    'periodId',v_period.id,'totals',v_totals,'lines',v_lines
  );
end;
$$;

comment on function public.close_payroll_period(text,text,date,boolean) is
  'Yalnız manuel puantaj kayıtlarını tarihindeki ücretle snapshot olarak kapatır.';

