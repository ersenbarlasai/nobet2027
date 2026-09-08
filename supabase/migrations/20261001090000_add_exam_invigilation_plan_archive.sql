-- ============================================================================
-- Deneme sınavı gözetmen planı arşivi / kayıt listesi
-- ============================================================================
-- Amaç: taslak ve tamamlanmış planları tek listeleme RPC'sinden filtreleyerek
-- sunmak. Plan durumu, görev sayıları ve nöbet devri uyarı sayısı BURADA
-- hesaplanır; frontend kendi kural motorunu kurmaz.
--
-- Tarihsel bütünlük: bu dosyadaki hiçbir sorgu güncel `teachers`,
-- `school_classes` veya `lesson_periods` tablolarına JOIN yapmaz. Listeleme
-- yalnız plan/kapsam/oturum/atama tablolarındaki snapshot alanlarını okur, bu
-- yüzden sonraki bir XML importu eski planı görünmez veya bozuk yapmaz.
--
-- 20260928/20260929/20260930 uygulanmış olduğundan geriye dönük dosyalar
-- DEĞİŞTİRİLMEZ; her şey ileri tarihli bu migration içindedir.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tamamlanmış planın plan satırı da değişmez olur
-- ----------------------------------------------------------------------------
-- Oturum, atama ve kapsam satırları 20260928 tetikleyicileriyle zaten
-- korunuyordu. Plan başlığının (ad, tarih, hafta) tamamlanmış bir listede
-- sonradan değiştirilmesi çıktıyı sessizce tahrif ederdi; bu da DB seviyesinde
-- kapatılır. Yalnız buton gizlemek güvenlik sayılmaz.
create or replace function public.prevent_completed_exam_invigilation_plan_change()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if exists (select 1 from public.exam_invigilation_scopes s
             where s.plan_id = old.id and s.status = 'completed') then
    raise exception 'Tamamlanmış gözetmen planı değiştirilemez.' using errcode = '55000';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists exam_invigilation_plan_immutable on public.exam_invigilation_plans;
create trigger exam_invigilation_plan_immutable
  before update or delete on public.exam_invigilation_plans
  for each row execute function public.prevent_completed_exam_invigilation_plan_change();

-- ----------------------------------------------------------------------------
-- Plan kayıtları listesi (filtreli)
-- ----------------------------------------------------------------------------
-- Eski `list_exam_invigilation_plans(text,text)` imzası KORUNUR (overload
-- oluşturmamak için yeni ad kullanılır).
--
-- Genel tamamlanma kuralı: bir plan, YALNIZ oturumu bulunan okul gruplarının
-- tamamı 'completed' ise "Tamamlandı" sayılır. Hiç oturumu olmayan okul grubu
-- şarta dâhil edilmez ve kendi durumu 'not_planned' olarak raporlanır.
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
  v_campus_id uuid;
  v_year_id uuid;
  v_status text;
  v_sort text;
  v_scope text;
  v_search text;
  v_items jsonb;
begin
  v_status := coalesce(nullif(btrim(lower(p_status)), ''), 'all');
  v_sort := coalesce(nullif(btrim(lower(p_sort)), ''), 'newest');
  v_scope := nullif(btrim(upper(p_scope_code)), '');
  v_search := nullif(btrim(p_search), '');

  if v_status not in ('all', 'draft', 'completed', 'stale')
     or v_sort not in ('newest', 'oldest')
     or (v_scope is not null and v_scope not in ('MIDDLE_SCHOOL', 'HIGH_SCHOOL'))
     or (p_date_from is not null and p_date_to is not null and p_date_from > p_date_to) then
    return jsonb_build_object('status', 'validation_error', 'items', '[]'::jsonb);
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  select id into v_year_id from public.academic_years where campus_id = v_campus_id and name = p_academic_year_name;
  if v_campus_id is null or v_year_id is null then
    return jsonb_build_object('status', 'ok', 'items', '[]'::jsonb);
  end if;

  with plan_rows as (
    select p.*
    from public.exam_invigilation_plans p
    where p.campus_id = v_campus_id and p.academic_year_id = v_year_id
  ), scope_rows as (
    select s.plan_id, s.id scope_id, s.scope_code, s.status, s.version, s.completed_at,
           coalesce(sess.session_count, 0) session_count,
           coalesce(sess.required_count, 0) required_count,
           coalesce(asg.assigned_count, 0) assigned_count,
           coalesce(asg.warning_count, 0) warning_count
    from public.exam_invigilation_scopes s
    join plan_rows p on p.id = s.plan_id
    left join lateral (
      select count(*) session_count, coalesce(sum(x.required_invigilator_count), 0) required_count
      from public.exam_invigilation_sessions x where x.scope_id = s.id
    ) sess on true
    left join lateral (
      select count(*) assigned_count, count(*) filter (where a.duty_warning is not null) warning_count
      from public.exam_invigilation_assignments a where a.scope_id = s.id
    ) asg on true
  ), plan_facts as (
    select p.id plan_id,
      -- Oturum tarihleri snapshot alanından gelir; sınıfsız eski planlarda
      -- oturum yoksa plan tarihine düşülür (tarih listesi hiç boş kalmaz).
      coalesce(
        (select array_agg(d order by d)
           from (select distinct x.exam_date d from public.exam_invigilation_sessions x where x.plan_id = p.id) q),
        array[p.exam_date]::date[]
      ) exam_dates,
      coalesce((select sum(sr.required_count) from scope_rows sr where sr.plan_id = p.id), 0) required_count,
      coalesce((select sum(sr.assigned_count) from scope_rows sr where sr.plan_id = p.id), 0) assigned_count,
      coalesce((select sum(sr.warning_count) from scope_rows sr where sr.plan_id = p.id), 0) warning_count,
      coalesce((select bool_or(sr.session_count > 0) from scope_rows sr where sr.plan_id = p.id), false) has_planned_scope,
      coalesce((select bool_and(sr.status = 'completed') from scope_rows sr where sr.plan_id = p.id and sr.session_count > 0), false) all_planned_completed,
      p.source_fingerprint is distinct from public.exam_invigilation_current_fingerprint(p.timetable_import_id, p.duty_plan_id) is_stale
    from plan_rows p
  ), enriched as (
    select p.*, f.exam_dates, f.required_count, f.assigned_count, f.warning_count, f.is_stale,
      case when f.has_planned_scope and f.all_planned_completed then 'completed' else 'draft' end overall_status
    from plan_rows p join plan_facts f on f.plan_id = p.id
  ), filtered as (
    select * from enriched e
    where (v_status = 'all'
           or (v_status = 'stale' and e.is_stale)
           or (v_status = 'completed' and e.overall_status = 'completed')
           or (v_status = 'draft' and e.overall_status = 'draft'))
      and (v_scope is null or exists (
            select 1 from scope_rows sr
            where sr.plan_id = e.id and sr.scope_code = v_scope and sr.session_count > 0))
      and (v_search is null or e.name ilike '%' || v_search || '%')
      and (p_date_from is null or exists (select 1 from unnest(e.exam_dates) d where d >= p_date_from))
      and (p_date_to is null or exists (select 1 from unnest(e.exam_dates) d where d <= p_date_to))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', f.id,
    'name', f.name,
    'weekStartDate', f.week_start_date,
    'examDate', f.exam_date,
    'examDates', to_jsonb(f.exam_dates),
    'createdAt', f.created_at,
    'updatedAt', f.updated_at,
    'isStale', f.is_stale,
    'overallStatus', f.overall_status,
    'requiredCount', f.required_count,
    'assignedCount', f.assigned_count,
    'openCount', greatest(f.required_count - f.assigned_count, 0),
    'dutyWarningCount', f.warning_count,
    'scopes', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'scopeCode', sr.scope_code,
        'status', case when sr.session_count = 0 then 'not_planned' else sr.status end,
        'rawStatus', sr.status,
        'planned', sr.session_count > 0,
        'version', sr.version,
        'completedAt', sr.completed_at,
        'sessionCount', sr.session_count,
        'requiredCount', sr.required_count,
        'assignedCount', sr.assigned_count,
        'openCount', greatest(sr.required_count - sr.assigned_count, 0),
        'warningCount', sr.warning_count
      ) order by sr.scope_code), '[]'::jsonb)
      from scope_rows sr where sr.plan_id = f.id)
  ) order by
      case when v_sort = 'oldest' then f.created_at end asc,
      case when v_sort = 'newest' then f.created_at end desc,
      f.id
  ), '[]'::jsonb)
  into v_items from filtered f;

  return jsonb_build_object('status', 'ok', 'items', v_items);
end;
$$;

comment on function public.list_exam_invigilation_plans_v2(text, text, text, text, text, date, date, text) is
  'Deneme sınavı gözetmen plan kayıtlarını durum/okul grubu/arama/tarih süzgeçleriyle listeler. Yalnız snapshot alanlarını okur.';

do $$ declare f regprocedure; begin
  foreach f in array array[
    'public.prevent_completed_exam_invigilation_plan_change()'::regprocedure,
    'public.list_exam_invigilation_plans_v2(text,text,text,text,text,date,date,text)'::regprocedure
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- Plan detayı: yetkili durum ve kampüs/eğitim yılı başlığı
-- ----------------------------------------------------------------------------
-- Frontend, salt okunur kararını ve başlık bilgisini tahmin etmez; her ikisi
-- de burada üretilir. İmza değişmediği için mevcut GRANT'ler ve çağrılar
-- olduğu gibi geçerli kalır. Sorgu yine YALNIZ snapshot alanlarını okur —
-- güncel teachers/school_classes/lesson_periods tablolarına JOIN yoktur.
create or replace function public.get_exam_invigilation_plan(
  p_plan_id uuid, p_campus_name text, p_academic_year_name text
) returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public as $$
declare
  v_plan public.exam_invigilation_plans%rowtype;
  v_campus_id uuid; v_year_id uuid; v_scopes jsonb;
  v_has_planned boolean; v_all_completed boolean;
begin
  select id into v_campus_id from public.campuses where name = p_campus_name;
  select id into v_year_id from public.academic_years where campus_id = v_campus_id and name = p_academic_year_name;
  select * into v_plan from public.exam_invigilation_plans where id = p_plan_id and campus_id = v_campus_id and academic_year_id = v_year_id;
  if not found then return jsonb_build_object('found', false); end if;

  select coalesce(bool_or(c.session_count > 0), false),
         coalesce(bool_and(c.status = 'completed') filter (where c.session_count > 0), false)
    into v_has_planned, v_all_completed
  from (
    select s.status, (select count(*) from public.exam_invigilation_sessions x where x.scope_id = s.id) session_count
    from public.exam_invigilation_scopes s where s.plan_id = v_plan.id
  ) c;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',s.id,'scopeCode',s.scope_code,'status',s.status,'version',s.version,'completedAt',s.completed_at,
    'sessionCount',(select count(*) from public.exam_invigilation_sessions x where x.scope_id=s.id),
    'listStatus',case when (select count(*) from public.exam_invigilation_sessions x where x.scope_id=s.id)=0
                      then 'not_planned' else s.status end,
    'sessions',(select coalesce(jsonb_agg(jsonb_build_object(
      'id',x.id,'examDate',x.exam_date,'schoolClassId',x.school_class_id,
      'schoolClassSourceId',x.school_class_source_id_snapshot,'schoolClassName',x.school_class_name_snapshot,
      'periodOrder',x.period_order,'periodName',x.period_name_snapshot,
      'startsAt',x.starts_at_snapshot,'endsAt',x.ends_at_snapshot,'requiredCount',x.required_invigilator_count,
      'assignments',(select coalesce(jsonb_agg(jsonb_build_object(
        'id',a.id,'slotNumber',a.slot_number,'teacherSourceId',a.teacher_source_id,'teacherName',a.teacher_name_snapshot,
        'dutyWarning',a.duty_warning,'dutyCoverageAcknowledged',a.duty_coverage_acknowledged,
        'dutyCoverageNote',a.duty_coverage_note) order by a.slot_number),'[]'::jsonb)
        from public.exam_invigilation_assignments a where a.session_id=x.id)
      ) order by x.exam_date,x.period_order,x.school_class_name_snapshot nulls first),'[]'::jsonb)
      from public.exam_invigilation_sessions x where x.scope_id=s.id)
  ) order by s.scope_code),'[]'::jsonb) into v_scopes
  from public.exam_invigilation_scopes s where s.plan_id = v_plan.id;

  return jsonb_build_object('found',true,'id',v_plan.id,'name',v_plan.name,'weekStartDate',v_plan.week_start_date,
    'examDate',v_plan.exam_date,'timetableImportId',v_plan.timetable_import_id,'dutyPlanId',v_plan.duty_plan_id,
    'campusName',p_campus_name,'academicYearName',p_academic_year_name,
    'sourceFingerprint',v_plan.source_fingerprint,
    'isStale',v_plan.source_fingerprint is distinct from public.exam_invigilation_current_fingerprint(v_plan.timetable_import_id,v_plan.duty_plan_id),
    'overallStatus',case when v_has_planned and v_all_completed then 'completed' else 'draft' end,
    'createdAt',v_plan.created_at,'updatedAt',v_plan.updated_at,'scopes',v_scopes);
end;
$$;

do $$ begin
  execute 'revoke all on function public.get_exam_invigilation_plan(uuid,text,text) from public, anon, authenticated';
  execute 'grant execute on function public.get_exam_invigilation_plan(uuid,text,text) to service_role';
end $$;
