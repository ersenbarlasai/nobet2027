-- ============================================================================
-- Yokluk Türleri (tarih sürümlü) ve Eğitim Takvimi
-- ============================================================================
-- Bu migration, aylık yokluk borcu / 28 saat eşiği hesaplama motorunun
-- ihtiyaç duyduğu iki yönetim ekranının veri temelini kurar. Var olan
-- teacher_absences.reason_code (sabit 4 değerli enum) yeni, yönetici
-- tarafından genişletilebilir absence_types yapısına GÜVENLİ biçimde
-- backfill edilir; reason_code sütunu geriye dönük uyumluluk için silinmez,
-- sadece artık zorunlu/tekil kaynak olmaktan çıkar.

create table public.absence_types (
  id uuid primary key default gen_random_uuid(),
  campus_id uuid not null references public.campuses(id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc',now()),
  updated_at timestamptz not null default timezone('utc',now())
);
comment on table public.absence_types is 'Yokluk türü kimliği. Ad ve borç durumu tarih-sürümlüdür (bkz. absence_type_versions).';

create table public.absence_type_versions (
  id uuid primary key default gen_random_uuid(),
  absence_type_id uuid not null references public.absence_types(id) on delete cascade,
  effective_from date not null,
  name text not null check (btrim(name) <> ''),
  creates_debt boolean not null,
  created_at timestamptz not null default timezone('utc',now()),
  constraint absence_type_version_uq unique(absence_type_id,effective_from)
);
comment on table public.absence_type_versions is
  'Bir yokluk türünün yürürlük tarihine göre adı/borç durumu. Geçmiş sürüm asla güncellenmez; değişiklik yeni satır olarak eklenir.';

create index absence_type_versions_type_idx on public.absence_type_versions(absence_type_id,effective_from desc);

create trigger set_updated_at before update on public.absence_types for each row execute function public.set_updated_at();

alter table public.absence_types enable row level security;
alter table public.absence_type_versions enable row level security;
revoke all on public.absence_types,public.absence_type_versions from public,anon,authenticated;
grant select,insert,update,delete on public.absence_types,public.absence_type_versions to service_role;

-- Yürürlük tarihi olarak, mevcut/geçmiş her kaydı kapsayan sabit bir başlangıç
-- kullanılır; böylece "yalnız yürürlük tarihinden sonraki kayıtlara uygulanır"
-- kuralı geriye dönük kayıtları da bozmadan tutarlı kalır.
create or replace function public.ensure_default_absence_types(p_campus uuid)
returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_epoch date := date '2000-01-01'; v_id uuid;
begin
  if not exists(select 1 from public.absence_types where campus_id=p_campus) then
    insert into public.absence_types(campus_id) values(p_campus) returning id into v_id;
    insert into public.absence_type_versions(absence_type_id,effective_from,name,creates_debt) values(v_id,v_epoch,'Raporlu',false);
    insert into public.absence_types(campus_id) values(p_campus) returning id into v_id;
    insert into public.absence_type_versions(absence_type_id,effective_from,name,creates_debt) values(v_id,v_epoch,'İzinli',false);
    insert into public.absence_types(campus_id) values(p_campus) returning id into v_id;
    insert into public.absence_type_versions(absence_type_id,effective_from,name,creates_debt) values(v_id,v_epoch,'İdari görevli',false);
    insert into public.absence_types(campus_id) values(p_campus) returning id into v_id;
    insert into public.absence_type_versions(absence_type_id,effective_from,name,creates_debt) values(v_id,v_epoch,'Mazeretsiz',true);
  end if;
end; $$;

create or replace function public.initialize_campus_absence_types()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin perform public.ensure_default_absence_types(new.id); return new; end; $$;
create trigger initialize_campus_absence_types after insert on public.campuses
for each row execute function public.initialize_campus_absence_types();

do $$ declare c record; begin
  for c in select id from public.campuses loop perform public.ensure_default_absence_types(c.id); end loop;
end $$;

-- Belirli bir tarihte geçerli ad/borç durumu (en son effective_from<=tarih).
create or replace function public.get_absence_type_at(p_type_id uuid,p_date date,out name text,out creates_debt boolean)
returns record language sql stable security invoker set search_path=pg_catalog,public as $$
  select v.name,v.creates_debt from public.absence_type_versions v
  where v.absence_type_id=p_type_id and v.effective_from<=p_date order by v.effective_from desc limit 1;
$$;

create or replace function public.list_absence_types(p_campus_name text)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid; v_items jsonb;
begin
  select id into v_campus from public.campuses where name=p_campus_name;
  if v_campus is null then return jsonb_build_object('items','[]'::jsonb); end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',t.id,'isActive',t.is_active,
    'currentName',cur.name,'currentCreatesDebt',cur.creates_debt,
    'inUse',exists(select 1 from public.teacher_absences a where a.absence_type_id=t.id),
    'versions',coalesce((select jsonb_agg(jsonb_build_object('effectiveFrom',v.effective_from,'name',v.name,'createsDebt',v.creates_debt) order by v.effective_from desc) from public.absence_type_versions v where v.absence_type_id=t.id),'[]'::jsonb)
  ) order by cur.name),'[]'::jsonb) into v_items
  from public.absence_types t
  left join lateral(select name,creates_debt from public.absence_type_versions v where v.absence_type_id=t.id order by v.effective_from desc limit 1) cur on true
  where t.campus_id=v_campus;
  return jsonb_build_object('items',v_items);
end; $$;

-- Yeni tür oluşturma VEYA var olan türe yeni tarih-sürümlü ad/borç durumu ekleme.
create or replace function public.save_absence_type(p_campus_name text,p_type_id uuid,p_name text,p_creates_debt boolean,p_effective_from date,p_is_active boolean)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid; v_id uuid;
begin
  select id into v_campus from public.campuses where name=p_campus_name;
  if v_campus is null or nullif(btrim(p_name),'') is null or p_effective_from is null then return jsonb_build_object('status','validation_error'); end if;
  if p_type_id is null then
    insert into public.absence_types(campus_id,is_active) values(v_campus,coalesce(p_is_active,true)) returning id into v_id;
    insert into public.absence_type_versions(absence_type_id,effective_from,name,creates_debt) values(v_id,p_effective_from,btrim(p_name),p_creates_debt);
  else
    if not exists(select 1 from public.absence_types where id=p_type_id and campus_id=v_campus) then return jsonb_build_object('status','not_found'); end if;
    v_id:=p_type_id;
    update public.absence_types set is_active=coalesce(p_is_active,is_active) where id=v_id;
    insert into public.absence_type_versions(absence_type_id,effective_from,name,creates_debt) values(v_id,p_effective_from,btrim(p_name),p_creates_debt)
      on conflict(absence_type_id,effective_from) do update set name=excluded.name,creates_debt=excluded.creates_debt;
  end if;
  return jsonb_build_object('status','ok','id',v_id);
end; $$;

create or replace function public.delete_absence_type(p_campus_name text,p_type_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid; v_deleted int;
begin
  select id into v_campus from public.campuses where name=p_campus_name;
  if exists(select 1 from public.teacher_absences where absence_type_id=p_type_id) then
    update public.absence_types set is_active=false where id=p_type_id and campus_id=v_campus;
    return jsonb_build_object('status','ok','action','deactivated');
  end if;
  delete from public.absence_types where id=p_type_id and campus_id=v_campus;
  get diagnostics v_deleted=row_count;
  return jsonb_build_object('status',case when v_deleted=1 then 'ok' else 'not_found' end,'action','deleted');
end; $$;

-- --------------------------------------------------------------------------
-- teacher_absences: reason_code (sabit 4 değer) -> absence_type_id (genişletilebilir)
-- --------------------------------------------------------------------------
alter table public.teacher_absences add column absence_type_id uuid references public.absence_types(id) on delete restrict;
alter table public.teacher_absences add column absence_type_name_snapshot text;
alter table public.teacher_absences add column absence_creates_debt_snapshot boolean;

-- Geriye dönük backfill: eski 4 sabit reason_code değeri, kampüsün seed
-- edilmiş karşılık gelen türüne (epoch tarihli sürümüyle) bağlanır.
update public.teacher_absences a
set absence_type_id=m.type_id,
    absence_type_name_snapshot=m.name,
    absence_creates_debt_snapshot=m.creates_debt
from (
  select a2.id absence_id, t.id type_id, v.name, v.creates_debt
  from public.teacher_absences a2
  join public.absence_types t on t.campus_id=a2.campus_id
  join public.absence_type_versions v on v.absence_type_id=t.id and v.effective_from=date '2000-01-01'
  where v.name = case a2.reason_code
    when 'medical_report' then 'Raporlu'
    when 'leave' then 'İzinli'
    when 'official_duty' then 'İdari görevli'
    else 'Mazeretsiz'
  end
) m
where a.id=m.absence_id;

alter table public.teacher_absences alter column absence_type_id set not null;
alter table public.teacher_absences alter column absence_type_name_snapshot set not null;
alter table public.teacher_absences alter column absence_creates_debt_snapshot set not null;
alter table public.teacher_absences alter column reason_code drop not null;
alter table public.teacher_absences drop constraint teacher_absences_reason_code_check;
comment on column public.teacher_absences.reason_code is
  'KULLANIMDAN KALDIRILDI (geriye dönük uyumluluk için tutulur). Yeni kayıtlar absence_type_id kullanır.';

-- create_teacher_absence artık p_absence_type_id alır. Var olan RPC imzası
-- (reason_code) uygulama içinde başka bir yerden çağrılmadığından yeniden
-- tanımlanır; eski imzalı fonksiyon bırakılmaz (tek bir gerçek kaynak).
drop function if exists public.create_teacher_absence(text,text,text,date,date,text,text,jsonb,text);

create or replace function public.create_teacher_absence(p_campus_name text,p_academic_year_name text,p_teacher_source_id text,p_date_from date,p_date_to date,p_absence_type_id uuid,p_note text,p_lesson_keys jsonb,p_absence_scope text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid;v_year uuid;v_import uuid;v_teacher record;v_absence uuid;v_item jsonb;v_date date;v_card uuid;v_list uuid;v_inserted int:=0;v_type record;
begin
  if p_date_from is null or p_date_to<p_date_from or p_absence_scope not in ('all_day','selected_lessons') or jsonb_typeof(p_lesson_keys)<>'array' or jsonb_array_length(p_lesson_keys)=0 then return jsonb_build_object('status','validation_error'); end if;
  select id into v_campus from public.campuses where name=p_campus_name; select id into v_year from public.academic_years where campus_id=v_campus and name=p_academic_year_name;
  if not exists(select 1 from public.absence_types where id=p_absence_type_id and campus_id=v_campus) then return jsonb_build_object('status','absence_type_not_found'); end if;
  select name,creates_debt into v_type from public.get_absence_type_at(p_absence_type_id,p_date_from);
  if v_type.name is null then return jsonb_build_object('status','absence_type_not_effective'); end if;
  select id into v_import from public.timetable_imports where campus_id=v_campus and academic_year_id=v_year and status='imported' order by imported_at desc nulls last,created_at desc limit 1;
  select source_id,name into v_teacher from public.teachers where timetable_import_id=v_import and source_id=p_teacher_source_id;
  if not found then return jsonb_build_object('status','teacher_not_found'); end if;
  if p_absence_scope='all_day' and exists(
    select 1 from generate_series(p_date_from,p_date_to,interval '1 day') d
    join public.timetable_days td on td.timetable_import_id=v_import and td.day_order=extract(isodow from d)::int
    join public.timetable_cards c on c.timetable_import_id=v_import and c.timetable_day_id=td.id
    join public.timetable_assignments ta on ta.timetable_card_id=c.id
    join public.teachers t on t.id=ta.teacher_id and t.source_id=p_teacher_source_id
    where not exists(select 1 from jsonb_array_elements(p_lesson_keys) x where (x->>'assignmentDate')::date=d::date and (x->>'timetableCardId')::uuid=c.id)
  ) then return jsonb_build_object('status','all_day_lessons_incomplete'); end if;
  insert into public.teacher_absences(campus_id,academic_year_id,timetable_import_id,teacher_source_id,teacher_name_snapshot,date_from,date_to,absence_scope,reason_code,note,absence_type_id,absence_type_name_snapshot,absence_creates_debt_snapshot)
    values(v_campus,v_year,v_import,v_teacher.source_id,v_teacher.name,p_date_from,p_date_to,p_absence_scope,null,nullif(btrim(p_note),''),p_absence_type_id,v_type.name,v_type.creates_debt) returning id into v_absence;
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

do $$ declare f regprocedure; begin foreach f in array array[
 'public.ensure_default_absence_types(uuid)'::regprocedure,
 'public.initialize_campus_absence_types()'::regprocedure,
 'public.get_absence_type_at(uuid,date)'::regprocedure,
 'public.list_absence_types(text)'::regprocedure,
 'public.save_absence_type(text,uuid,text,boolean,date,boolean)'::regprocedure,
 'public.delete_absence_type(text,uuid)'::regprocedure,
 'public.create_teacher_absence(text,text,text,date,date,uuid,text,jsonb,text)'::regprocedure
] loop execute format('revoke all on function %s from public,anon,authenticated',f); execute format('grant execute on function %s to service_role',f); end loop; end $$;

-- ============================================================================
-- Eğitim Takvimi
-- ============================================================================

create table public.education_terms (
  id uuid primary key default gen_random_uuid(),
  campus_id uuid not null references public.campuses(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  description text,
  created_at timestamptz not null default timezone('utc',now()),
  updated_at timestamptz not null default timezone('utc',now()),
  constraint education_terms_range_ck check(end_date>=start_date),
  constraint education_terms_year_uq unique(campus_id,academic_year_id)
);
comment on table public.education_terms is 'Eğitim döneminin başlangıç/bitiş tarihi. Aylık 28 saat eşiği hesabı bu aralığın dışındaki haftaları saymaz.';

create table public.education_calendar_closures (
  id uuid primary key default gen_random_uuid(),
  campus_id uuid not null references public.campuses(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  closure_type text not null check(closure_type in ('ara_tatil','yariyil_tatili','tam_kapali_hafta','resmi_tatil')),
  date_from date not null,
  date_to date not null,
  description text,
  created_at timestamptz not null default timezone('utc',now()),
  updated_at timestamptz not null default timezone('utc',now()),
  constraint education_calendar_closures_range_ck check(date_to>=date_from)
);
comment on table public.education_calendar_closures is
  'Ara tatil / yarıyıl tatili / tamamen kapalı hafta / resmî tatil aralıkları. Haftanın TÜM iş günlerini (Pzt-Cuma) kapsayan aralık, o haftayı aktif haftalardan düşürür.';

create index education_calendar_closures_year_idx on public.education_calendar_closures(campus_id,academic_year_id,date_from);

create trigger set_updated_at before update on public.education_terms for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.education_calendar_closures for each row execute function public.set_updated_at();

alter table public.education_terms enable row level security;
alter table public.education_calendar_closures enable row level security;
revoke all on public.education_terms,public.education_calendar_closures from public,anon,authenticated;
grant select,insert,update,delete on public.education_terms,public.education_calendar_closures to service_role;

create or replace function public.list_education_calendar(p_campus_name text,p_academic_year_name text)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  with ctx as(select c.id campus_id,y.id year_id from public.campuses c join public.academic_years y on y.campus_id=c.id where c.name=p_campus_name and y.name=p_academic_year_name)
  select jsonb_build_object(
    'term',(select jsonb_build_object('startDate',t.start_date,'endDate',t.end_date,'description',t.description) from public.education_terms t join ctx on ctx.year_id=t.academic_year_id),
    'closures',coalesce((select jsonb_agg(jsonb_build_object('id',cl.id,'closureType',cl.closure_type,'dateFrom',cl.date_from,'dateTo',cl.date_to,'description',cl.description) order by cl.date_from) from public.education_calendar_closures cl join ctx on ctx.year_id=cl.academic_year_id),'[]'::jsonb)
  ) from ctx;
$$;

create or replace function public.save_education_term(p_campus_name text,p_academic_year_name text,p_start_date date,p_end_date date,p_description text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid; v_year uuid;
begin
  select c.id,y.id into v_campus,v_year from public.campuses c join public.academic_years y on y.campus_id=c.id where c.name=p_campus_name and y.name=p_academic_year_name;
  if v_campus is null or p_start_date is null or p_end_date is null or p_end_date<p_start_date then return jsonb_build_object('status','validation_error'); end if;
  insert into public.education_terms(campus_id,academic_year_id,start_date,end_date,description) values(v_campus,v_year,p_start_date,p_end_date,nullif(btrim(p_description),''))
    on conflict(campus_id,academic_year_id) do update set start_date=excluded.start_date,end_date=excluded.end_date,description=excluded.description,updated_at=timezone('utc',now());
  return jsonb_build_object('status','ok');
end; $$;

create or replace function public.add_education_calendar_closure(p_campus_name text,p_academic_year_name text,p_closure_type text,p_date_from date,p_date_to date,p_description text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_campus uuid; v_year uuid; v_id uuid;
begin
  select c.id,y.id into v_campus,v_year from public.campuses c join public.academic_years y on y.campus_id=c.id where c.name=p_campus_name and y.name=p_academic_year_name;
  if v_campus is null or p_closure_type not in ('ara_tatil','yariyil_tatili','tam_kapali_hafta','resmi_tatil') or p_date_from is null or p_date_to is null or p_date_to<p_date_from then return jsonb_build_object('status','validation_error'); end if;
  insert into public.education_calendar_closures(campus_id,academic_year_id,closure_type,date_from,date_to,description)
    values(v_campus,v_year,p_closure_type,p_date_from,p_date_to,nullif(btrim(p_description),'')) returning id into v_id;
  return jsonb_build_object('status','ok','id',v_id);
end; $$;

create or replace function public.delete_education_calendar_closure(p_campus_name text,p_closure_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_deleted int;
begin
  delete from public.education_calendar_closures cl using public.campuses c where cl.id=p_closure_id and c.id=cl.campus_id and c.name=p_campus_name;
  get diagnostics v_deleted=row_count;
  return jsonb_build_object('status',case when v_deleted=1 then 'ok' else 'not_found' end);
end; $$;

-- Bir ayın (p_month_start = ayın 1'i) aktif çalışma haftalarını (pazartesi
-- tarihleri) döner. Bir hafta aktiftir <=> pazartesisi bu aya ait VE eğitim
-- döneminin (education_terms) kapsadığı VE haftanın 5 iş gününden (Pzt-Cuma)
-- en az biri hiçbir kapanış (closure) aralığına tam girmemiş (yani en az bir
-- ders günü kalmış).
create or replace function public.get_active_calendar_weeks_in_month(p_campus_name text,p_academic_year_name text,p_month_start date)
returns table(week_monday date) language sql stable security invoker set search_path=pg_catalog,public as $$
  with ctx as(select c.id campus_id,y.id year_id from public.campuses c join public.academic_years y on y.campus_id=c.id where c.name=p_campus_name and y.name=p_academic_year_name),
  term as(select t.start_date,t.end_date from public.education_terms t join ctx on ctx.year_id=t.academic_year_id),
  mondays as(
    select d::date monday from generate_series(
      date_trunc('month',p_month_start)::date,
      (date_trunc('month',p_month_start)+interval '1 month'-interval '1 day')::date,
      interval '1 day'
    ) d
    where extract(isodow from d)=1
  )
  select m.monday from mondays m, term t
  where m.monday<=t.end_date and (m.monday+4)>=t.start_date
  and exists(
    select 1 from generate_series(0,4) offs
    where (m.monday+offs) between t.start_date and t.end_date
    and not exists(
      select 1 from public.education_calendar_closures cl join ctx on ctx.campus_id=cl.campus_id
      where (m.monday+offs) between cl.date_from and cl.date_to
    )
  );
$$;

do $$ declare f regprocedure; begin foreach f in array array[
 'public.list_education_calendar(text,text)'::regprocedure,
 'public.save_education_term(text,text,date,date,text)'::regprocedure,
 'public.add_education_calendar_closure(text,text,text,date,date,text)'::regprocedure,
 'public.delete_education_calendar_closure(text,uuid)'::regprocedure,
 'public.get_active_calendar_weeks_in_month(text,text,date)'::regprocedure
] loop execute format('revoke all on function %s from public,anon,authenticated',f); execute format('grant execute on function %s to service_role',f); end loop; end $$;
