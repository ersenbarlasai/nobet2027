-- Yönetici, kayıt ekranından taslak veya tamamlanmış bir deneme sınavı
-- gözetmen planını tek işlemde silebilir. Normal UPDATE/DELETE yollarındaki
-- tamamlanmış kayıt koruması devam eder; istisna yalnız bu RPC'nin kendi
-- transaction'ında ve yalnız hedef plan kimliği için açılır.

create or replace function public.prevent_completed_exam_invigilation_change()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public as $$
declare
  v_old_status text;
  v_new_status text;
  v_delete_plan_id text := current_setting('app.exam_invigilation_delete_plan_id', true);
begin
  if tg_op='DELETE' and v_delete_plan_id=old.plan_id::text then return old; end if;
  if tg_op<>'INSERT' then
    select status into v_old_status from public.exam_invigilation_scopes where id=old.scope_id;
  end if;
  if tg_op<>'DELETE' then
    select status into v_new_status from public.exam_invigilation_scopes where id=new.scope_id;
  end if;
  if v_old_status='completed' or v_new_status='completed' then
    raise exception 'Tamamlanmış gözetmen listesi değiştirilemez.' using errcode='55000';
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;

create or replace function public.enforce_exam_invigilation_scope_lifecycle()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public as $$
begin
  if tg_op='DELETE'
     and current_setting('app.exam_invigilation_delete_plan_id', true)=old.plan_id::text then
    return old;
  end if;
  if tg_op='DELETE' and old.status='completed' then
    raise exception 'Tamamlanmış gözetmen listesi silinemez.' using errcode='55000';
  end if;
  if tg_op='UPDATE' and old.status='completed' then
    raise exception 'Tamamlanmış gözetmen listesi değiştirilemez.' using errcode='55000';
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;

create or replace function public.prevent_completed_exam_invigilation_plan_change()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public as $$
begin
  if tg_op='DELETE'
     and current_setting('app.exam_invigilation_delete_plan_id', true)=old.id::text then
    return old;
  end if;
  if exists(select 1 from public.exam_invigilation_scopes s
             where s.plan_id=old.id and s.status='completed') then
    raise exception 'Tamamlanmış gözetmen planı değiştirilemez.' using errcode='55000';
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;

create or replace function public.delete_exam_invigilation_plan(p_plan_id uuid)
returns jsonb language plpgsql security invoker
set search_path = pg_catalog, public as $$
declare
  v_deleted integer;
begin
  if not exists(select 1 from public.exam_invigilation_plans where id=p_plan_id) then
    return jsonb_build_object('status','plan_not_found');
  end if;

  perform set_config('app.exam_invigilation_delete_plan_id',p_plan_id::text,true);
  delete from public.exam_invigilation_plans where id=p_plan_id;
  get diagnostics v_deleted=row_count;
  return jsonb_build_object('status','ok','deleted',v_deleted);
end;
$$;

comment on function public.delete_exam_invigilation_plan(uuid) is
  'Bir gözetmen planını oturumları ve atamalarıyla birlikte siler; tamamlanmış kayıt istisnası yalnız hedef plan için transaction-local açılır.';

do $$ declare f regprocedure; begin
  foreach f in array array[
    'public.prevent_completed_exam_invigilation_change()'::regprocedure,
    'public.enforce_exam_invigilation_scope_lifecycle()'::regprocedure,
    'public.prevent_completed_exam_invigilation_plan_change()'::regprocedure,
    'public.delete_exam_invigilation_plan(uuid)'::regprocedure
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated',f);
    execute format('grant execute on function %s to service_role',f);
  end loop;
end $$;
