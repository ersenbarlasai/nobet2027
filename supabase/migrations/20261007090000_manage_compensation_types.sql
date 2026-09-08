-- Özel ücret türlerini yeniden adlandırma ve geçmiş puantajı bozmadan silme.
-- Kullanılmış türler fiziksel olarak silinmez, pasifleştirilir. Hiç
-- kullanılmamış özel türler ücret sürümleriyle birlikte silinebilir.

create or replace function public.save_compensation_type(
  p_campus_name text,p_type_id uuid,p_name text,p_is_active boolean
) returns jsonb language plpgsql security invoker
set search_path=pg_catalog,public as $$
declare
  v_campus uuid;
  v_id uuid;
  v_existing public.compensation_types%rowtype;
begin
  select id into v_campus from public.campuses where name=p_campus_name;
  if v_campus is null or nullif(btrim(p_name),'') is null then
    return jsonb_build_object('status','validation_error');
  end if;
  perform public.ensure_default_compensation_types(v_campus);

  if p_type_id is null then
    select * into v_existing from public.compensation_types
     where campus_id=v_campus and lower(name)=lower(btrim(p_name));
    if found then
      if v_existing.system_code is not null then return jsonb_build_object('status','duplicate_name'); end if;
      if v_existing.is_active then return jsonb_build_object('status','duplicate_name'); end if;
      update public.compensation_types set name=btrim(p_name),is_active=true
       where id=v_existing.id returning id into v_id;
      return jsonb_build_object('status','ok','id',v_id,'action','reactivated');
    end if;
    insert into public.compensation_types(campus_id,name,entry_mode,is_active)
    values(v_campus,btrim(p_name),'manual',coalesce(p_is_active,true)) returning id into v_id;
  else
    select * into v_existing from public.compensation_types
     where id=p_type_id and campus_id=v_campus for update;
    if not found then return jsonb_build_object('status','not_found'); end if;
    if v_existing.system_code is not null or v_existing.entry_mode<>'manual' then
      return jsonb_build_object('status','system_type_locked');
    end if;
    update public.compensation_types
       set name=btrim(p_name),is_active=coalesce(p_is_active,is_active)
     where id=p_type_id returning id into v_id;
  end if;
  return jsonb_build_object('status','ok','id',v_id,'action','saved');
exception when unique_violation then
  return jsonb_build_object('status','duplicate_name');
end;
$$;

create or replace function public.delete_compensation_type(
  p_campus_name text,p_type_id uuid
) returns jsonb language plpgsql security invoker
set search_path=pg_catalog,public as $$
declare
  v_campus uuid;
  v_type public.compensation_types%rowtype;
  v_in_use boolean;
begin
  select id into v_campus from public.campuses where name=p_campus_name;
  select * into v_type from public.compensation_types
   where id=p_type_id and campus_id=v_campus for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if v_type.system_code is not null or v_type.entry_mode<>'manual' then
    return jsonb_build_object('status','system_type_locked');
  end if;

  select exists(select 1 from public.manual_payroll_entries where compensation_type_id=p_type_id)
      or exists(select 1 from public.payroll_period_lines where compensation_type_id=p_type_id)
    into v_in_use;
  if v_in_use then
    update public.compensation_types set is_active=false where id=p_type_id;
    return jsonb_build_object('status','ok','action','deactivated');
  end if;

  delete from public.compensation_types where id=p_type_id;
  return jsonb_build_object('status','ok','action','deleted');
end;
$$;

comment on function public.delete_compensation_type(text,uuid) is
  'Özel ücret türünü kullanılmamışsa siler, geçmiş/puantaj kaydı varsa pasifleştirir.';

do $$ declare f regprocedure; begin
  foreach f in array array[
    'public.save_compensation_type(text,uuid,text,boolean)'::regprocedure,
    'public.delete_compensation_type(text,uuid)'::regprocedure
  ] loop
    execute format('revoke all on function %s from public,anon,authenticated',f);
    execute format('grant execute on function %s to service_role',f);
  end loop;
end $$;
