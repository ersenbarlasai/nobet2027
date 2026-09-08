-- Deneme sınavlarında XML'deki bütün sınıf kademelerini destekle ve
-- tamamlanmamış planların kayıt ekranından silinebilmesini sağla.
-- Önceki migration'lar değiştirilmez; tamamlanmış planların tarihsel
-- bütünlüğü korunur.

alter table public.exam_invigilation_scopes
  drop constraint if exists exam_invigilation_scopes_scope_code_check;
alter table public.exam_invigilation_scopes
  add constraint exam_invigilation_scopes_scope_code_check
  check (scope_code in ('PRESCHOOL','PRIMARY_SCHOOL','MIDDLE_SCHOOL','HIGH_SCHOOL','OTHER'));

create or replace function public.exam_scope_for_class(p_grade text, p_name text)
returns text language sql immutable security invoker
set search_path = pg_catalog, public as $$
  select case
    when lower(coalesce(p_grade,'') || ' ' || coalesce(p_name,'')) similar to '%(anaokul|anasınıf|ana sınıf|okul öncesi|preschool|yas|yaş)%'
      then 'PRESCHOOL'
    when coalesce(substring(coalesce(p_grade,'') from '([0-9]{1,2})'), substring(coalesce(p_name,'') from '([0-9]{1,2})'))::integer between 1 and 4
      then 'PRIMARY_SCHOOL'
    when coalesce(substring(coalesce(p_grade,'') from '([0-9]{1,2})'), substring(coalesce(p_name,'') from '([0-9]{1,2})'))::integer between 5 and 8
      then 'MIDDLE_SCHOOL'
    when coalesce(substring(coalesce(p_grade,'') from '([0-9]{1,2})'), substring(coalesce(p_name,'') from '([0-9]{1,2})'))::integer between 9 and 12
      then 'HIGH_SCHOOL'
    else 'OTHER'
  end
$$;

create or replace function public.create_exam_invigilation_plan_v2(
  p_campus_name text,
  p_academic_year_name text,
  p_name text,
  p_week_start_date date,
  p_session_specs jsonb
) returns jsonb language plpgsql security invoker
set search_path = pg_catalog, public, extensions as $$
declare
  v_campus_id uuid; v_year_id uuid; v_import_id uuid; v_duty_plan_id uuid;
  v_plan_id uuid; v_scope_id uuid;
  v_spec jsonb; v_class_value jsonb; v_class_id uuid; v_class record; v_period record;
  v_exam_date date; v_scope_code text; v_period_order integer; v_required integer;
  v_primary_exam_date date;
begin
  if coalesce(btrim(p_name),'')='' or extract(isodow from p_week_start_date)<>1
     or coalesce(jsonb_typeof(p_session_specs),'null')<>'array' or jsonb_array_length(p_session_specs)<1
     or jsonb_array_length(p_session_specs)>100 then
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

  begin
    for v_spec in select value from jsonb_array_elements(p_session_specs) loop
      v_scope_code := coalesce(v_spec->>'scopeCode','');
      if jsonb_typeof(v_spec)<>'object'
         or v_scope_code not in ('PRESCHOOL','PRIMARY_SCHOOL','MIDDLE_SCHOOL','HIGH_SCHOOL','OTHER')
         or jsonb_typeof(v_spec->'schoolClassIds')<>'array'
         or jsonb_array_length(v_spec->'schoolClassIds')<1
         or jsonb_array_length(v_spec->'schoolClassIds')>100 then
        return jsonb_build_object('status','validation_error');
      end if;
      v_exam_date := (v_spec->>'examDate')::date;
      v_period_order := (v_spec->>'periodOrder')::integer;
      v_required := (v_spec->>'requiredCount')::integer;
      if v_exam_date is null or v_period_order is null or v_required<>1
         or v_exam_date not between p_week_start_date and p_week_start_date+4
         or v_period_order not between 1 and 20 then
        return jsonb_build_object('status','validation_error');
      end if;
      select * into v_period from public.lesson_periods
       where timetable_import_id=v_import_id and period_order=v_period_order;
      if not found then return jsonb_build_object('status','period_not_found','periodOrder',v_period_order); end if;
      for v_class_value in select value from jsonb_array_elements(v_spec->'schoolClassIds') loop
        v_class_id := (v_class_value#>>'{}')::uuid;
        select id,source_id,name,grade into v_class from public.school_classes
         where id=v_class_id and timetable_import_id=v_import_id;
        if not found then return jsonb_build_object('status','class_not_found','schoolClassId',v_class_id); end if;
        if public.exam_scope_for_class(v_class.grade,v_class.name)<>v_scope_code then
          return jsonb_build_object('status','class_scope_mismatch','schoolClassId',v_class_id);
        end if;
      end loop;
    end loop;
  exception when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then
    return jsonb_build_object('status','validation_error');
  end;

  if exists(
    with expanded as (
      select (s.value->>'examDate')::date exam_date,
        (s.value->>'periodOrder')::integer period_order, c.value#>>'{}' class_id
      from jsonb_array_elements(p_session_specs) s(value)
      cross join lateral jsonb_array_elements(s.value->'schoolClassIds') c(value)
    ) select 1 from expanded group by exam_date,period_order,class_id having count(*)>1
  ) then return jsonb_build_object('status','duplicate_session'); end if;

  select min((value->>'examDate')::date) into v_primary_exam_date from jsonb_array_elements(p_session_specs);
  insert into public.exam_invigilation_plans(campus_id,academic_year_id,timetable_import_id,duty_plan_id,name,week_start_date,exam_date,source_fingerprint)
  values(v_campus_id,v_year_id,v_import_id,v_duty_plan_id,btrim(p_name),p_week_start_date,v_primary_exam_date,
         public.exam_invigilation_current_fingerprint(v_import_id,v_duty_plan_id)) returning id into v_plan_id;

  insert into public.exam_invigilation_scopes(plan_id,scope_code)
  select v_plan_id, scope_code from (
    select distinct value->>'scopeCode' scope_code from jsonb_array_elements(p_session_specs)
  ) scopes order by scope_code;

  for v_spec in select value from jsonb_array_elements(p_session_specs) loop
    v_scope_code := v_spec->>'scopeCode'; v_exam_date := (v_spec->>'examDate')::date;
    v_period_order := (v_spec->>'periodOrder')::integer; v_required := (v_spec->>'requiredCount')::integer;
    select id into v_scope_id from public.exam_invigilation_scopes where plan_id=v_plan_id and scope_code=v_scope_code;
    select * into v_period from public.lesson_periods where timetable_import_id=v_import_id and period_order=v_period_order;
    for v_class_value in select value from jsonb_array_elements(v_spec->'schoolClassIds') loop
      v_class_id := (v_class_value#>>'{}')::uuid;
      select id,source_id,name into v_class from public.school_classes where id=v_class_id and timetable_import_id=v_import_id;
      insert into public.exam_invigilation_sessions(
        plan_id,scope_id,timetable_import_id,exam_date,lesson_period_id,period_order,
        period_name_snapshot,starts_at_snapshot,ends_at_snapshot,school_class_id,
        school_class_source_id_snapshot,school_class_name_snapshot,required_invigilator_count)
      values(v_plan_id,v_scope_id,v_import_id,v_exam_date,v_period.id,v_period.period_order,
        v_period.name,v_period.starts_at,v_period.ends_at,v_class.id,v_class.source_id,v_class.name,v_required);
    end loop;
  end loop;
  return jsonb_build_object('status','ok','planId',v_plan_id);
exception when unique_violation then
  return jsonb_build_object('status','duplicate_plan');
end;
$$;

create or replace function public.delete_exam_invigilation_plan_draft(p_plan_id uuid)
returns jsonb language plpgsql security invoker
set search_path = pg_catalog, public as $$
begin
  if not exists(select 1 from public.exam_invigilation_plans where id=p_plan_id) then
    return jsonb_build_object('status','plan_not_found');
  end if;
  if exists(select 1 from public.exam_invigilation_scopes where plan_id=p_plan_id and status='completed') then
    return jsonb_build_object('status','plan_completed');
  end if;
  delete from public.exam_invigilation_plans where id=p_plan_id;
  return jsonb_build_object('status','ok');
end;
$$;

-- 20261002090000 tarih araligi sarmalayicisi kademe filtresini eski
-- MIDDLE_SCHOOL/HIGH_SCHOOL dogrulamasina iletiyordu. Eski listeleyiciyi
-- kademesiz calistirip dinamik kademe filtresini sonuc uzerinde uygula.
create or replace function public.list_exam_invigilation_plans_v2(
  p_campus_name text,
  p_academic_year_name text,
  p_status text default 'all',
  p_scope_code text default null,
  p_search text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_sort text default 'newest'
) returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public as $$
declare
  v_result jsonb;
  v_items jsonb;
begin
  if p_scope_code is not null
     and p_scope_code not in ('PRESCHOOL','PRIMARY_SCHOOL','MIDDLE_SCHOOL','HIGH_SCHOOL','OTHER') then
    return jsonb_build_object('status','validation_error','items','[]'::jsonb);
  end if;
  if p_date_from is not null and p_date_to is not null and p_date_from>p_date_to then
    return jsonb_build_object('status','validation_error','items','[]'::jsonb);
  end if;

  v_result := public.list_exam_invigilation_plans_v2_before_date_intersection(
    p_campus_name,p_academic_year_name,p_status,null,p_search,null,null,p_sort
  );
  if v_result->>'status'<>'ok' then return v_result; end if;

  select coalesce(jsonb_agg(item order by ord),'[]'::jsonb)
    into v_items
    from jsonb_array_elements(coalesce(v_result->'items','[]'::jsonb))
      with ordinality x(item,ord)
   where (p_scope_code is null or exists(
           select 1 from jsonb_array_elements(coalesce(item->'scopes','[]'::jsonb)) scope_item
            where scope_item->>'scopeCode'=p_scope_code
              and coalesce((scope_item->>'planned')::boolean,false)
         ))
     and exists(
           select 1 from jsonb_array_elements_text(coalesce(item->'examDates','[]'::jsonb)) exam_date
            where (p_date_from is null or exam_date::date>=p_date_from)
              and (p_date_to is null or exam_date::date<=p_date_to)
         );
  return jsonb_build_object('status','ok','items',v_items);
end;
$$;

comment on function public.exam_scope_for_class(text,text) is 'XML sınıf adı ve sınıf düzeyinden gözetmen planı kademesini üretir.';
comment on function public.create_exam_invigilation_plan_v2(text,text,text,date,jsonb) is 'XML sınıflarının dinamik kademeleri için sınıf, tarih ve ders saati bazlı gözetmen planı oluşturur.';
comment on function public.delete_exam_invigilation_plan_draft(uuid) is 'Yalnız hiçbir kademesi tamamlanmamış gözetmen planını siler.';
comment on function public.list_exam_invigilation_plans_v2(text,text,text,text,text,date,date,text) is 'Gözetmen planlarını dinamik XML kademesi ve kesişen sınav tarihiyle listeler.';

do $$ declare f regprocedure; begin
  foreach f in array array[
    'public.exam_scope_for_class(text,text)'::regprocedure,
    'public.create_exam_invigilation_plan_v2(text,text,text,date,jsonb)'::regprocedure,
    'public.delete_exam_invigilation_plan_draft(uuid)'::regprocedure,
    'public.list_exam_invigilation_plans_v2(text,text,text,text,text,date,date,text)'::regprocedure
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated',f);
    execute format('grant execute on function %s to service_role',f);
  end loop;
end $$;
