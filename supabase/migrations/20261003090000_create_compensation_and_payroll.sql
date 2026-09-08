-- ============================================================================
-- Tarih-sürümlü ücret türleri ve haftaları bölmeyen aylık puantaj
-- ============================================================================

create table public.compensation_types (
  id uuid primary key default gen_random_uuid(),
  campus_id uuid not null references public.campuses(id) on delete cascade,
  name text not null check (btrim(name)<>''),
  system_code text check (system_code is null or system_code in ('SUBSTITUTION')),
  entry_mode text not null check (entry_mode in ('automatic','manual')),
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc',now()),
  updated_at timestamptz not null default timezone('utc',now())
);
create unique index compensation_types_name_uq on public.compensation_types(campus_id,lower(name));
create unique index compensation_types_system_uq on public.compensation_types(campus_id,system_code) where system_code is not null;

create table public.compensation_rate_versions (
  id uuid primary key default gen_random_uuid(),
  compensation_type_id uuid not null references public.compensation_types(id) on delete cascade,
  effective_from date not null,
  unit_rate numeric(12,2) not null check (unit_rate>=0),
  created_at timestamptz not null default timezone('utc',now()),
  constraint compensation_rate_effective_uq unique(compensation_type_id,effective_from)
);

create table public.manual_payroll_entries (
  id uuid primary key default gen_random_uuid(),
  campus_id uuid not null references public.campuses(id) on delete restrict,
  academic_year_id uuid not null references public.academic_years(id) on delete restrict,
  teacher_source_id text not null check (btrim(teacher_source_id)<>''),
  teacher_name_snapshot text not null check (btrim(teacher_name_snapshot)<>''),
  duty_date date not null,
  compensation_type_id uuid not null references public.compensation_types(id) on delete restrict,
  quantity numeric(8,2) not null check (quantity<>0),
  note text,
  created_at timestamptz not null default timezone('utc',now()),
  updated_at timestamptz not null default timezone('utc',now()),
  constraint manual_payroll_negative_note_ck check(quantity>0 or nullif(btrim(note),'') is not null)
);

create table public.payroll_periods (
  id uuid primary key default gen_random_uuid(),
  campus_id uuid not null references public.campuses(id) on delete restrict,
  academic_year_id uuid not null references public.academic_years(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  status text not null default 'open' check(status in ('open','pending_rate','closed')),
  closed_at timestamptz,
  created_at timestamptz not null default timezone('utc',now()),
  updated_at timestamptz not null default timezone('utc',now()),
  constraint payroll_period_range_ck check(period_end>=period_start and extract(isodow from period_end)=7),
  constraint payroll_period_status_ck check((status='closed')=(closed_at is not null)),
  constraint payroll_period_uq unique(campus_id,academic_year_id,period_start,period_end)
);

create table public.payroll_period_lines (
  id uuid primary key default gen_random_uuid(),
  payroll_period_id uuid not null references public.payroll_periods(id) on delete restrict,
  source_kind text not null check(source_kind in ('substitution','manual')),
  source_id uuid not null,
  compensation_type_id uuid not null references public.compensation_types(id) on delete restrict,
  rate_version_id uuid not null references public.compensation_rate_versions(id) on delete restrict,
  teacher_source_id text not null,
  teacher_name_snapshot text not null,
  duty_date date not null,
  compensation_type_name_snapshot text not null,
  quantity numeric(8,2) not null,
  unit_rate_snapshot numeric(12,2) not null,
  amount_snapshot numeric(14,2) not null,
  detail_snapshot text,
  created_at timestamptz not null default timezone('utc',now()),
  constraint payroll_period_line_source_uq unique(payroll_period_id,source_kind,source_id)
);

create table public.payroll_period_teacher_totals (
  payroll_period_id uuid not null references public.payroll_periods(id) on delete restrict,
  teacher_source_id text not null,
  teacher_name_snapshot text not null,
  total_quantity numeric(10,2) not null,
  total_amount numeric(14,2) not null,
  breakdown jsonb not null,
  primary key(payroll_period_id,teacher_source_id)
);

create trigger set_updated_at before update on public.compensation_types for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.manual_payroll_entries for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.payroll_periods for each row execute function public.set_updated_at();

alter table public.compensation_types enable row level security;
alter table public.compensation_rate_versions enable row level security;
alter table public.manual_payroll_entries enable row level security;
alter table public.payroll_periods enable row level security;
alter table public.payroll_period_lines enable row level security;
alter table public.payroll_period_teacher_totals enable row level security;
revoke all on public.compensation_types,public.compensation_rate_versions,public.manual_payroll_entries,public.payroll_periods,public.payroll_period_lines,public.payroll_period_teacher_totals from public,anon,authenticated;
grant select,insert,update,delete on public.compensation_types,public.compensation_rate_versions,public.manual_payroll_entries,public.payroll_periods,public.payroll_period_lines,public.payroll_period_teacher_totals to service_role;

-- Mevcut kampüsler için başlangıç türleri; yeni kampüsler ayar RPC'sinde oluşur.
insert into public.compensation_types(campus_id,name,system_code,entry_mode)
select id,'Ders yerine görevlendirme','SUBSTITUTION','automatic' from public.campuses on conflict do nothing;
insert into public.compensation_types(campus_id,name,entry_mode)
select c.id,x.name,'manual' from public.campuses c cross join (values('Sabah Nöbeti'),('Akşam Nöbeti'),('Akşam Etütü')) x(name) on conflict do nothing;

create or replace function public.payroll_period_bounds(p_date date,out period_start date,out period_end date)
returns record language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare month_end date; this_last_sunday date; target_month date;
begin
  month_end:=(date_trunc('month',p_date)+interval '1 month'-interval '1 day')::date;
  this_last_sunday:=month_end-((extract(isodow from month_end)::int)%7);
  target_month:=case when p_date<=this_last_sunday then date_trunc('month',p_date)::date else (date_trunc('month',p_date)+interval '1 month')::date end;
  month_end:=(target_month+interval '1 month'-interval '1 day')::date;
  period_end:=month_end-((extract(isodow from month_end)::int)%7);
  month_end:=(target_month-interval '1 day')::date;
  period_start:=(month_end-((extract(isodow from month_end)::int)%7))+1;
end; $$;

create or replace function public.ensure_default_compensation_types(p_campus uuid)
returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 insert into public.compensation_types(campus_id,name,system_code,entry_mode) values(p_campus,'Ders yerine görevlendirme','SUBSTITUTION','automatic') on conflict do nothing;
 insert into public.compensation_types(campus_id,name,entry_mode) values(p_campus,'Sabah Nöbeti','manual'),(p_campus,'Akşam Nöbeti','manual'),(p_campus,'Akşam Etütü','manual') on conflict do nothing;
end; $$;

create or replace function public.initialize_campus_compensation_types()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin perform public.ensure_default_compensation_types(new.id);return new;end; $$;
create trigger initialize_campus_compensation_types after insert on public.campuses
for each row execute function public.initialize_campus_compensation_types();

create or replace function public.list_compensation_settings(p_campus_name text)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid;v_items jsonb;
begin select id into v_campus from public.campuses where name=p_campus_name;if v_campus is null then return jsonb_build_object('items','[]'::jsonb);end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'systemCode',t.system_code,'entryMode',t.entry_mode,'isActive',t.is_active,'rates',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'effectiveFrom',r.effective_from,'unitRate',r.unit_rate) order by r.effective_from desc) from public.compensation_rate_versions r where r.compensation_type_id=t.id),'[]'::jsonb)) order by t.name),'[]'::jsonb) into v_items from public.compensation_types t where t.campus_id=v_campus;
 return jsonb_build_object('items',v_items);end; $$;

create or replace function public.save_compensation_type(p_campus_name text,p_type_id uuid,p_name text,p_is_active boolean)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid;v_id uuid;
begin select id into v_campus from public.campuses where name=p_campus_name;if v_campus is null or nullif(btrim(p_name),'') is null then return jsonb_build_object('status','validation_error');end if;
 perform public.ensure_default_compensation_types(v_campus);
 if p_type_id is null then insert into public.compensation_types(campus_id,name,entry_mode,is_active) values(v_campus,btrim(p_name),'manual',coalesce(p_is_active,true)) returning id into v_id;
 else update public.compensation_types set name=btrim(p_name),is_active=coalesce(p_is_active,is_active) where id=p_type_id and campus_id=v_campus returning id into v_id;end if;
 if v_id is null then return jsonb_build_object('status','not_found');end if;return jsonb_build_object('status','ok','id',v_id);
exception when unique_violation then return jsonb_build_object('status','duplicate_name');end; $$;

create or replace function public.add_compensation_rate(p_campus_name text,p_type_id uuid,p_effective_from date,p_unit_rate numeric)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_id uuid;
begin if p_effective_from is null or p_unit_rate<0 or not exists(select 1 from public.compensation_types t join public.campuses c on c.id=t.campus_id where t.id=p_type_id and c.name=p_campus_name) then return jsonb_build_object('status','validation_error');end if;
 insert into public.compensation_rate_versions(compensation_type_id,effective_from,unit_rate) values(p_type_id,p_effective_from,round(p_unit_rate,2)) returning id into v_id;
 return jsonb_build_object('status','ok','id',v_id);exception when unique_violation then return jsonb_build_object('status','duplicate_effective_date');end; $$;

create or replace function public.add_manual_payroll_entry(p_campus_name text,p_academic_year_name text,p_teacher_source_id text,p_duty_date date,p_type_id uuid,p_quantity numeric,p_note text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid;v_year uuid;v_teacher record;v_bounds record;v_id uuid;
begin select c.id,y.id into v_campus,v_year from public.campuses c join public.academic_years y on y.campus_id=c.id where c.name=p_campus_name and y.name=p_academic_year_name;
 select source_id,name into v_teacher from public.teachers t where t.source_id=p_teacher_source_id and t.timetable_import_id=(select id from public.timetable_imports where campus_id=v_campus and academic_year_id=v_year and status='imported' order by imported_at desc nulls last,created_at desc limit 1);
 if not found or p_quantity=0 or not exists(select 1 from public.compensation_types where id=p_type_id and campus_id=v_campus and entry_mode='manual' and is_active) then return jsonb_build_object('status','validation_error');end if;
 select * into v_bounds from public.payroll_period_bounds(p_duty_date);if exists(select 1 from public.payroll_periods where campus_id=v_campus and academic_year_id=v_year and period_start=v_bounds.period_start and period_end=v_bounds.period_end and status='closed') then return jsonb_build_object('status','period_closed');end if;
 insert into public.manual_payroll_entries(campus_id,academic_year_id,teacher_source_id,teacher_name_snapshot,duty_date,compensation_type_id,quantity,note) values(v_campus,v_year,v_teacher.source_id,v_teacher.name,p_duty_date,p_type_id,p_quantity,nullif(btrim(p_note),'')) returning id into v_id;
 return jsonb_build_object('status','ok','id',v_id);end; $$;

create or replace function public.delete_manual_payroll_entry(p_campus_name text,p_entry_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_deleted int;
begin
 delete from public.manual_payroll_entries m using public.campuses c where m.id=p_entry_id and c.id=m.campus_id and c.name=p_campus_name;
 get diagnostics v_deleted=row_count;
 return jsonb_build_object('status',case when v_deleted=1 then 'ok' else 'not_found' end);
exception when sqlstate '55000' then return jsonb_build_object('status','period_closed');end; $$;

-- Dönem kapanışı: görev tarihindeki son geçerli fiyatı seçer; eksik fiyat varsa
-- pending_rate olur. Satırlar ve öğretmen toplamları snapshot olarak dondurulur.
create or replace function public.close_payroll_period(p_campus_name text,p_academic_year_name text,p_anchor_date date,p_force boolean default false)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid;v_year uuid;v_bounds record;v_period uuid;v_missing int;
begin select c.id,y.id into v_campus,v_year from public.campuses c join public.academic_years y on y.campus_id=c.id where c.name=p_campus_name and y.name=p_academic_year_name;
 select * into v_bounds from public.payroll_period_bounds(p_anchor_date);
 insert into public.payroll_periods(campus_id,academic_year_id,period_start,period_end) values(v_campus,v_year,v_bounds.period_start,v_bounds.period_end) on conflict(campus_id,academic_year_id,period_start,period_end) do update set updated_at=excluded.updated_at returning id into v_period;
 if (select status from public.payroll_periods where id=v_period)='closed' then return jsonb_build_object('status','already_closed','periodId',v_period);end if;
 if not p_force and timezone('Europe/Istanbul',now())<v_bounds.period_end::timestamp+interval '23 hours 59 minutes' then return jsonb_build_object('status','not_due','periodId',v_period);end if;
 with sources as (
  select t.assignment_date duty_date,(select id from public.compensation_types where campus_id=v_campus and system_code='SUBSTITUTION') type_id from public.substitution_tasks t join public.substitution_day_lists l on l.id=t.day_list_id where t.campus_id=v_campus and l.academic_year_id=v_year and t.resolution_status='assigned' and t.assignment_date between v_bounds.period_start and v_bounds.period_end
  union all select m.duty_date,m.compensation_type_id from public.manual_payroll_entries m where m.campus_id=v_campus and m.academic_year_id=v_year and m.duty_date between v_bounds.period_start and v_bounds.period_end)
 select count(*) into v_missing from sources s where not exists(select 1 from public.compensation_rate_versions r where r.compensation_type_id=s.type_id and r.effective_from<=s.duty_date);
 if v_missing>0 then update public.payroll_periods set status='pending_rate' where id=v_period;return jsonb_build_object('status','pending_rate','periodId',v_period,'missingRateCount',v_missing);end if;
 delete from public.payroll_period_lines where payroll_period_id=v_period;delete from public.payroll_period_teacher_totals where payroll_period_id=v_period;
 insert into public.payroll_period_lines(payroll_period_id,source_kind,source_id,compensation_type_id,rate_version_id,teacher_source_id,teacher_name_snapshot,duty_date,compensation_type_name_snapshot,quantity,unit_rate_snapshot,amount_snapshot,detail_snapshot)
 select v_period,'substitution',t.id,ct.id,r.id,t.substitute_teacher_source_id,t.substitute_teacher_name_snapshot,t.assignment_date,ct.name,1,r.unit_rate,round(r.unit_rate,2),t.class_names_snapshot||' · '||t.subject_name_snapshot||' · '||t.period_name_snapshot
 from public.substitution_tasks t join public.substitution_day_lists l on l.id=t.day_list_id join public.compensation_types ct on ct.campus_id=t.campus_id and ct.system_code='SUBSTITUTION'
 join lateral(select id,unit_rate from public.compensation_rate_versions where compensation_type_id=ct.id and effective_from<=t.assignment_date order by effective_from desc limit 1) r on true
 where t.campus_id=v_campus and l.academic_year_id=v_year and t.resolution_status='assigned' and t.assignment_date between v_bounds.period_start and v_bounds.period_end;
 insert into public.payroll_period_lines(payroll_period_id,source_kind,source_id,compensation_type_id,rate_version_id,teacher_source_id,teacher_name_snapshot,duty_date,compensation_type_name_snapshot,quantity,unit_rate_snapshot,amount_snapshot,detail_snapshot)
 select v_period,'manual',m.id,ct.id,r.id,m.teacher_source_id,m.teacher_name_snapshot,m.duty_date,ct.name,m.quantity,r.unit_rate,round(m.quantity*r.unit_rate,2),m.note
 from public.manual_payroll_entries m join public.compensation_types ct on ct.id=m.compensation_type_id join lateral(select id,unit_rate from public.compensation_rate_versions where compensation_type_id=ct.id and effective_from<=m.duty_date order by effective_from desc limit 1) r on true
 where m.campus_id=v_campus and m.academic_year_id=v_year and m.duty_date between v_bounds.period_start and v_bounds.period_end;
 insert into public.payroll_period_teacher_totals(payroll_period_id,teacher_source_id,teacher_name_snapshot,total_quantity,total_amount,breakdown)
 select v_period,teacher_source_id,max(teacher_name_snapshot),sum(quantity),sum(amount_snapshot),(select jsonb_agg(jsonb_build_object('type',q.compensation_type_name_snapshot,'quantity',q.qty,'amount',q.amount) order by q.compensation_type_name_snapshot) from(select compensation_type_name_snapshot,sum(quantity) qty,sum(amount_snapshot) amount from public.payroll_period_lines x where x.payroll_period_id=v_period and x.teacher_source_id=l.teacher_source_id group by compensation_type_name_snapshot)q)
 from public.payroll_period_lines l where payroll_period_id=v_period group by teacher_source_id;
 update public.payroll_periods set status='closed',closed_at=timezone('utc',now()) where id=v_period;
 return jsonb_build_object('status','ok','periodId',v_period);end; $$;

-- Uygulama kapanış anında çalışmıyorsa ilk puantaj okuması, görev bulunan tüm
-- geçmiş dönemleri kronolojik olarak geriye dönük kapatmayı dener. Eksik ücret
-- olan dönem pending_rate olarak kalır; diğer dönemlerin kapanmasını engellemez.
create or replace function public.close_due_payroll_periods(p_campus_name text,p_academic_year_name text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid;v_year uuid;v_first date;v_anchor date;v_bounds record;v_result jsonb;v_processed int:=0;
begin
 select c.id,y.id into v_campus,v_year from public.campuses c join public.academic_years y on y.campus_id=c.id where c.name=p_campus_name and y.name=p_academic_year_name;
 select min(d) into v_first from(
  select min(t.assignment_date) d from public.substitution_tasks t join public.substitution_day_lists l on l.id=t.day_list_id where t.campus_id=v_campus and l.academic_year_id=v_year and t.resolution_status='assigned'
  union all select min(m.duty_date) from public.manual_payroll_entries m where m.campus_id=v_campus and m.academic_year_id=v_year
 )q;
 if v_first is null then return jsonb_build_object('processed',0);end if;
 v_anchor:=v_first;
 loop
  select * into v_bounds from public.payroll_period_bounds(v_anchor);
  exit when timezone('Europe/Istanbul',now())<v_bounds.period_end::timestamp+interval '23 hours 59 minutes';
  v_result:=public.close_payroll_period(p_campus_name,p_academic_year_name,v_anchor,false);v_processed:=v_processed+1;
  v_anchor:=v_bounds.period_end+1;exit when v_processed>=120;
 end loop;
 return jsonb_build_object('processed',v_processed);
end; $$;

create or replace function public.get_payroll_overview(p_campus_name text,p_academic_year_name text,p_anchor_date date)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid;v_year uuid;v_bounds record;v_period public.payroll_periods%rowtype;v_lines jsonb;v_totals jsonb;
begin select c.id,y.id into v_campus,v_year from public.campuses c join public.academic_years y on y.campus_id=c.id where c.name=p_campus_name and y.name=p_academic_year_name;select * into v_bounds from public.payroll_period_bounds(p_anchor_date);
 perform public.close_due_payroll_periods(p_campus_name,p_academic_year_name);
 if timezone('Europe/Istanbul',now())>=v_bounds.period_end::timestamp+interval '23 hours 59 minutes' then
  perform public.close_payroll_period(p_campus_name,p_academic_year_name,p_anchor_date,false);
 end if;
 select * into v_period from public.payroll_periods where campus_id=v_campus and academic_year_id=v_year and period_start=v_bounds.period_start and period_end=v_bounds.period_end;
 if v_period.status='closed' then
  select coalesce(jsonb_agg(to_jsonb(x) order by x.teacher_name_snapshot),'[]'::jsonb) into v_totals from public.payroll_period_teacher_totals x where x.payroll_period_id=v_period.id;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.duty_date,x.teacher_name_snapshot),'[]'::jsonb) into v_lines from public.payroll_period_lines x where x.payroll_period_id=v_period.id;
 else
  with source_rows as (
   select t.id source_id,'substitution'::text source_kind,t.substitute_teacher_source_id teacher_source_id,t.substitute_teacher_name_snapshot teacher_name_snapshot,
    t.assignment_date duty_date,ct.name compensation_type_name_snapshot,1::numeric quantity,r.unit_rate,
    case when r.unit_rate is null then null else round(r.unit_rate,2) end amount_snapshot,
    t.class_names_snapshot||' · '||t.subject_name_snapshot||' · '||t.period_name_snapshot detail_snapshot
   from public.substitution_tasks t join public.substitution_day_lists l on l.id=t.day_list_id
   join public.compensation_types ct on ct.campus_id=t.campus_id and ct.system_code='SUBSTITUTION'
   left join lateral(select unit_rate from public.compensation_rate_versions where compensation_type_id=ct.id and effective_from<=t.assignment_date order by effective_from desc limit 1) r on true
   where t.campus_id=v_campus and l.academic_year_id=v_year and t.resolution_status='assigned' and t.assignment_date between v_bounds.period_start and v_bounds.period_end
   union all
   select m.id,'manual',m.teacher_source_id,m.teacher_name_snapshot,m.duty_date,ct.name,m.quantity,r.unit_rate,
    case when r.unit_rate is null then null else round(m.quantity*r.unit_rate,2) end,m.note
   from public.manual_payroll_entries m join public.compensation_types ct on ct.id=m.compensation_type_id
   left join lateral(select unit_rate from public.compensation_rate_versions where compensation_type_id=ct.id and effective_from<=m.duty_date order by effective_from desc limit 1) r on true
   where m.campus_id=v_campus and m.academic_year_id=v_year and m.duty_date between v_bounds.period_start and v_bounds.period_end
  ) select coalesce(jsonb_agg(jsonb_build_object('source_id',source_id,'source_kind',source_kind,'teacher_source_id',teacher_source_id,'teacher_name_snapshot',teacher_name_snapshot,'duty_date',duty_date,'compensation_type_name_snapshot',compensation_type_name_snapshot,'quantity',quantity,'unit_rate_snapshot',unit_rate,'amount_snapshot',amount_snapshot,'detail_snapshot',detail_snapshot,'rate_missing',unit_rate is null) order by duty_date,teacher_name_snapshot),'[]'::jsonb) into v_lines from source_rows;
  with x as(select * from jsonb_to_recordset(v_lines) as r(teacher_source_id text,teacher_name_snapshot text,quantity numeric,amount_snapshot numeric,compensation_type_name_snapshot text)), teachers as(
   select teacher_source_id,max(teacher_name_snapshot) teacher_name_snapshot,sum(quantity) total_quantity,sum(coalesce(amount_snapshot,0)) total_amount from x group by teacher_source_id)
  select coalesce(jsonb_agg(jsonb_build_object('teacher_source_id',t.teacher_source_id,'teacher_name_snapshot',t.teacher_name_snapshot,'total_quantity',t.total_quantity,'total_amount',t.total_amount,'breakdown',(select coalesce(jsonb_agg(jsonb_build_object('type',q.compensation_type_name_snapshot,'quantity',q.quantity,'amount',q.amount) order by q.compensation_type_name_snapshot),'[]'::jsonb) from(select compensation_type_name_snapshot,sum(quantity) quantity,sum(coalesce(amount_snapshot,0)) amount from x where teacher_source_id=t.teacher_source_id group by compensation_type_name_snapshot)q)) order by t.teacher_name_snapshot),'[]'::jsonb) into v_totals from teachers t;
 end if;
 return jsonb_build_object('periodStart',v_bounds.period_start,'periodEnd',v_bounds.period_end,'status',coalesce(v_period.status,case when timezone('Europe/Istanbul',now())>=v_bounds.period_end::timestamp+interval '23 hours 59 minutes' then 'pending_rate' else 'open' end),'periodId',v_period.id,'totals',v_totals,'lines',v_lines);end; $$;

-- Kapanmış puantajdaki kaynak satırlarını değiştirme/silme.
create or replace function public.enforce_payroll_source_lock() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin if exists(select 1 from public.payroll_period_lines l join public.payroll_periods p on p.id=l.payroll_period_id and p.status='closed' where l.source_id=old.id and l.source_kind=case when tg_table_name='substitution_tasks' then 'substitution' else 'manual' end) then raise exception 'Kapanmış puantaja bağlı görev değiştirilemez.' using errcode='55000';end if;return case when tg_op='DELETE' then old else new end;end; $$;
create trigger substitution_payroll_lock before update or delete on public.substitution_tasks for each row execute function public.enforce_payroll_source_lock();
create trigger manual_payroll_lock before update or delete on public.manual_payroll_entries for each row execute function public.enforce_payroll_source_lock();

-- Kapanışta kullanılmış fiyat sürümleri tarihsel mali kayıttır. Gelecekteki ve
-- henüz hiçbir kapanışta kullanılmamış sürümler düzenlenebilir/silinebilir.
create or replace function public.enforce_used_compensation_rate_lock() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if exists(select 1 from public.payroll_period_lines l join public.payroll_periods p on p.id=l.payroll_period_id and p.status='closed' where l.rate_version_id=old.id) then
  raise exception 'Kapanmış puantajda kullanılan ücret sürümü değiştirilemez.' using errcode='55000';
 end if;
 return case when tg_op='DELETE' then old else new end;
end; $$;
create trigger used_compensation_rate_lock before update or delete on public.compensation_rate_versions for each row execute function public.enforce_used_compensation_rate_lock();

do $$ declare f regprocedure;begin foreach f in array array[
 'public.payroll_period_bounds(date)'::regprocedure,'public.ensure_default_compensation_types(uuid)'::regprocedure,
 'public.initialize_campus_compensation_types()'::regprocedure,
 'public.list_compensation_settings(text)'::regprocedure,'public.save_compensation_type(text,uuid,text,boolean)'::regprocedure,
 'public.add_compensation_rate(text,uuid,date,numeric)'::regprocedure,'public.add_manual_payroll_entry(text,text,text,date,uuid,numeric,text)'::regprocedure,
 'public.delete_manual_payroll_entry(text,uuid)'::regprocedure,
 'public.close_payroll_period(text,text,date,boolean)'::regprocedure,'public.get_payroll_overview(text,text,date)'::regprocedure,
 'public.close_due_payroll_periods(text,text)'::regprocedure,
 'public.enforce_payroll_source_lock()'::regprocedure
 ,'public.enforce_used_compensation_rate_lock()'::regprocedure
]loop execute format('revoke all on function %s from public,anon,authenticated',f);execute format('grant execute on function %s to service_role',f);end loop;end $$;
