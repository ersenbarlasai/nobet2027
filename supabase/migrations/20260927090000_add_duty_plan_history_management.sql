-- ============================================================================
-- Haftalık nöbet planı geçmişi: liste, detay, güvenli revizyon ve arşivleme
-- ============================================================================
-- Yayımlanmış/arşivlenmiş planlar fiziksel olarak değiştirilmez veya silinmez.
-- Düzenleme, tarihsel planın atamalarını yeni bir draft'a kopyalayarak yapılır;
-- yayımlandığında aynı haftanın önceki published sürümü mevcut lifecycle
-- kurallarıyla archived olur. "Silme" yayımlanmış planda arşivlemedir; gerçek
-- DELETE yalnız mevcut delete_duty_plan_draft RPC'siyle draft için mümkündür.

create or replace function public.list_duty_plan_history(
  p_campus_name text,
  p_academic_year_name text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_plans jsonb;
begin
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then return jsonb_build_object('plans', '[]'::jsonb); end if;

  select id into v_year_id
    from public.academic_years
   where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then return jsonb_build_object('plans', '[]'::jsonb); end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', x.id,
    'weekStartDate', x.week_start_date,
    'activeDayOrders', x.active_day_orders,
    'status', x.status,
    'version', x.version,
    'algorithmVersion', x.algorithm_version,
    'createdAt', x.created_at,
    'updatedAt', x.updated_at,
    'packageCount', x.package_count,
    'assignedTeacherCount', x.assigned_teacher_count,
    'priorPointTotal', x.prior_point_total,
    'weekPointTotal', x.week_point_total,
    'projectedWeekPointTotal', x.package_count,
    'cumulativePointTotal', x.prior_point_total + case when x.status = 'draft' then x.package_count else x.week_point_total end,
    'normalCoveredCount', coalesce((x.summary ->> 'normalCoveredCount')::integer, 0),
    'uncoveredCount', coalesce((x.summary ->> 'uncoveredCount')::integer, 0)
  ) order by x.week_start_date desc, case x.status when 'draft' then 0 when 'published' then 1 else 2 end, x.updated_at desc), '[]'::jsonb)
    into v_plans
    from (
      select dp.*,
             coalesce(pkg.package_count, 0)::integer package_count,
             coalesce(pkg.assigned_teacher_count, 0)::integer assigned_teacher_count,
             coalesce(prior.prior_point_total, 0)::numeric prior_point_total,
             coalesce(score.week_point_total, 0)::numeric week_point_total
        from public.duty_plans dp
        left join lateral (
          select count(*) package_count,
                 count(distinct p.teacher_source_id) assigned_teacher_count
            from public.duty_plan_assignment_packages p
           where p.plan_id = dp.id
             and p.day_order = any(dp.active_day_orders)
        ) pkg on true
        left join lateral (
          select coalesce(sum(e.value::numeric), 0) prior_point_total
            from jsonb_each_text(dp.prior_score_snapshot) e
        ) prior on true
        left join lateral (
          select coalesce(sum(l.points), 0) week_point_total
            from public.duty_teacher_score_ledger l
           where l.plan_id = dp.id
        ) score on true
       where dp.campus_id = v_campus_id
         and dp.academic_year_id = v_year_id
    ) x;

  return jsonb_build_object('plans', v_plans);
end;
$$;

comment on function public.list_duty_plan_history(text, text) is
  'Salt okunur: kampüs+eğitim yılındaki draft/published/archived haftalık planları; hafta, kapsam ve önceki/bu hafta/kümülatif puan özetleriyle listeler. Yalnız service_role çağırabilir.';

create or replace function public.get_duty_plan_history_detail(
  p_plan_id uuid,
  p_campus_name text,
  p_academic_year_name text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_plan record;
  v_assignments jsonb;
  v_packages jsonb;
  v_teacher_points jsonb;
  v_current_fingerprint text;
begin
  if p_plan_id is null then
    raise exception 'plan_id zorunludur.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then return jsonb_build_object('found', false); end if;
  select id into v_year_id from public.academic_years
   where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then return jsonb_build_object('found', false); end if;

  select * into v_plan from public.duty_plans
   where id = p_plan_id and campus_id = v_campus_id and academic_year_id = v_year_id;
  if not found then return jsonb_build_object('found', false); end if;

  v_current_fingerprint := public.compute_duty_plan_source_fingerprint(p_campus_name, p_academic_year_name);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'dayOrder', a.day_order,
    'dutyLocationId', a.duty_location_id, 'dutyLocationName', a.duty_location_name_snapshot,
    'dutyBlockId', a.duty_block_id, 'dutyBlockName', a.duty_block_name_snapshot,
    'teacherSourceId', a.teacher_source_id, 'teacherName', a.teacher_name_snapshot,
    'assignmentKind', a.assignment_kind, 'packageId', a.package_id
  ) order by a.day_order, a.duty_location_name_snapshot, a.duty_block_name_snapshot), '[]'::jsonb)
    into v_assignments
    from public.duty_plan_assignments a where a.plan_id = v_plan.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'dayOrder', p.day_order,
    'dutyLocationId', p.duty_location_id,
    'dutyLocationName', coalesce((select min(a.duty_location_name_snapshot) from public.duty_plan_assignments a where a.package_id = p.id), dl.name),
    'teacherSourceId', p.teacher_source_id, 'teacherName', p.teacher_name_snapshot,
    'coverageMode', p.coverage_mode, 'assignmentKind', p.assignment_kind,
    'coveredBlockCodes', (
      select coalesce(jsonb_agg(b.code order by b.block_order), '[]'::jsonb)
        from public.duty_plan_assignments a2
        join public.duty_blocks b on b.id = a2.duty_block_id
       where a2.package_id = p.id
    )
  ) order by p.day_order, p.teacher_name_snapshot), '[]'::jsonb)
    into v_packages
    from public.duty_plan_assignment_packages p
    join public.duty_locations dl on dl.id = p.duty_location_id
   where p.plan_id = v_plan.id;

  with teacher_ids as (
    select key teacher_source_id from jsonb_each_text(v_plan.prior_score_snapshot)
    union
    select p.teacher_source_id from public.duty_plan_assignment_packages p where p.plan_id = v_plan.id
    union
    select l.teacher_source_id from public.duty_teacher_score_ledger l where l.plan_id = v_plan.id
  ), point_rows as (
    select t.teacher_source_id,
           coalesce(
             (select min(p.teacher_name_snapshot) from public.duty_plan_assignment_packages p
               where p.plan_id = v_plan.id and p.teacher_source_id = t.teacher_source_id),
             (select l.teacher_name_snapshot from public.duty_teacher_score_ledger l
               where l.campus_id = v_campus_id and l.academic_year_id = v_year_id
                 and l.teacher_source_id = t.teacher_source_id
               order by l.duty_date desc limit 1),
             t.teacher_source_id
           ) teacher_name,
           coalesce((v_plan.prior_score_snapshot ->> t.teacher_source_id)::numeric, 0) prior_points,
           coalesce((select sum(l.points) from public.duty_teacher_score_ledger l
                      where l.plan_id = v_plan.id and l.teacher_source_id = t.teacher_source_id), 0) recorded_week_points,
           coalesce((select count(*) from public.duty_plan_assignment_packages p
                      where p.plan_id = v_plan.id and p.teacher_source_id = t.teacher_source_id
                        and p.day_order = any(v_plan.active_day_orders)), 0) projected_week_points
      from teacher_ids t
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'teacherSourceId', teacher_source_id,
    'teacherName', teacher_name,
    'priorPoints', prior_points,
    'weekPoints', case when v_plan.status = 'draft' then projected_week_points else recorded_week_points end,
    'totalPoints', prior_points + case when v_plan.status = 'draft' then projected_week_points else recorded_week_points end,
    'isProjected', v_plan.status = 'draft'
  ) order by prior_points + case when v_plan.status = 'draft' then projected_week_points else recorded_week_points end desc, teacher_name), '[]'::jsonb)
    into v_teacher_points
    from point_rows;

  return jsonb_build_object(
    'found', true,
    'id', v_plan.id,
    'status', v_plan.status,
    'algorithmVersion', v_plan.algorithm_version,
    'generationOptions', v_plan.generation_options,
    'summary', v_plan.summary,
    'version', v_plan.version,
    'createdAt', v_plan.created_at,
    'updatedAt', v_plan.updated_at,
    'weekStartDate', v_plan.week_start_date,
    'activeDayOrders', v_plan.active_day_orders,
    'priorScoreSnapshot', v_plan.prior_score_snapshot,
    'isStale', v_current_fingerprint is distinct from v_plan.source_fingerprint,
    'assignments', v_assignments,
    'packages', v_packages,
    'teacherPoints', v_teacher_points
  );
end;
$$;

comment on function public.get_duty_plan_history_detail(uuid, text, text) is
  'Salt okunur: seçilen haftalık planın tarihsel atama/paket snapshotını ve öğretmen bazında önceki, bu hafta ve plan-sonrası toplam puanlarını döner. Yalnız service_role çağırabilir.';

create or replace function public.create_duty_plan_revision(
  p_plan_id uuid,
  p_campus_name text,
  p_academic_year_name text,
  p_expected_plan_version integer
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_source public.duty_plans%rowtype;
  v_existing_draft uuid;
  v_current_fingerprint text;
  v_new_plan_id uuid;
  v_new_package_id uuid;
  v_package record;
begin
  if p_plan_id is null or p_expected_plan_version is null then
    raise exception 'plan_id ve expected_plan_version zorunludur.' using errcode = '22023';
  end if;
  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then return jsonb_build_object('status', 'plan_not_found'); end if;
  select id into v_year_id from public.academic_years
   where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then return jsonb_build_object('status', 'plan_not_found'); end if;

  perform pg_advisory_xact_lock(hashtext('duty-plan-draft:' || v_year_id::text));

  select * into v_source from public.duty_plans
   where id = p_plan_id and campus_id = v_campus_id and academic_year_id = v_year_id
   for update;
  if not found then return jsonb_build_object('status', 'plan_not_found'); end if;
  if v_source.version is distinct from p_expected_plan_version then
    return jsonb_build_object('status', 'version_conflict', 'currentVersion', v_source.version);
  end if;
  if v_source.status = 'draft' then
    return jsonb_build_object('status', 'already_draft', 'planId', v_source.id, 'version', v_source.version);
  end if;

  select id into v_existing_draft from public.duty_plans
   where campus_id = v_campus_id and academic_year_id = v_year_id and status = 'draft'
   limit 1;
  if found then
    return jsonb_build_object('status', 'active_draft_exists', 'planId', v_existing_draft);
  end if;

  v_current_fingerprint := public.compute_duty_plan_source_fingerprint(p_campus_name, p_academic_year_name);
  if v_current_fingerprint is distinct from v_source.source_fingerprint then
    return jsonb_build_object('status', 'source_stale', 'currentSourceFingerprint', v_current_fingerprint);
  end if;

  insert into public.duty_plans (
    campus_id, academic_year_id, timetable_import_id, status,
    source_fingerprint, algorithm_version, generation_seed,
    generation_options, summary, version, week_start_date,
    active_day_orders, prior_score_snapshot
  ) values (
    v_source.campus_id, v_source.academic_year_id, v_source.timetable_import_id, 'draft',
    v_source.source_fingerprint, v_source.algorithm_version, v_source.generation_seed,
    v_source.generation_options, v_source.summary, 1, v_source.week_start_date,
    v_source.active_day_orders, v_source.prior_score_snapshot
  ) returning id into v_new_plan_id;

  for v_package in
    select * from public.duty_plan_assignment_packages where plan_id = v_source.id order by created_at, id
  loop
    insert into public.duty_plan_assignment_packages (
      plan_id, campus_id, day_order, duty_location_id,
      teacher_source_id, teacher_name_snapshot, coverage_mode,
      assignment_kind, fixed_duty_assignment_id
    ) values (
      v_new_plan_id, v_package.campus_id, v_package.day_order, v_package.duty_location_id,
      v_package.teacher_source_id, v_package.teacher_name_snapshot, v_package.coverage_mode,
      v_package.assignment_kind, v_package.fixed_duty_assignment_id
    ) returning id into v_new_package_id;

    insert into public.duty_plan_assignments (
      plan_id, campus_id, day_order, duty_location_id, duty_block_id,
      teacher_source_id, teacher_name_snapshot, duty_location_name_snapshot,
      duty_block_name_snapshot, assignment_kind, fixed_duty_assignment_id,
      score_details, package_id
    )
    select v_new_plan_id, a.campus_id, a.day_order, a.duty_location_id, a.duty_block_id,
           a.teacher_source_id, a.teacher_name_snapshot, a.duty_location_name_snapshot,
           a.duty_block_name_snapshot, a.assignment_kind, a.fixed_duty_assignment_id,
           a.score_details, v_new_package_id
      from public.duty_plan_assignments a
     where a.plan_id = v_source.id and a.package_id = v_package.id;
  end loop;

  insert into public.duty_plan_assignments (
    plan_id, campus_id, day_order, duty_location_id, duty_block_id,
    teacher_source_id, teacher_name_snapshot, duty_location_name_snapshot,
    duty_block_name_snapshot, assignment_kind, fixed_duty_assignment_id,
    score_details, package_id
  )
  select v_new_plan_id, a.campus_id, a.day_order, a.duty_location_id, a.duty_block_id,
         a.teacher_source_id, a.teacher_name_snapshot, a.duty_location_name_snapshot,
         a.duty_block_name_snapshot, a.assignment_kind, a.fixed_duty_assignment_id,
         a.score_details, null
    from public.duty_plan_assignments a
   where a.plan_id = v_source.id and a.package_id is null;

  return jsonb_build_object('status', 'ok', 'planId', v_new_plan_id, 'version', 1, 'weekStartDate', v_source.week_start_date);
end;
$$;

comment on function public.create_duty_plan_revision(uuid, text, text, integer) is
  'Yayımlanmış/arşivlenmiş planı değiştirmez; kaynak güncelse aynı hafta ve atamaların düzenlenebilir draft kopyasını atomik oluşturur. Tek aktif draft/advisory lock ve optimistic version kontrolü uygular. Yalnız service_role çağırabilir.';

create or replace function public.archive_published_duty_plan(
  p_plan_id uuid,
  p_campus_name text,
  p_academic_year_name text,
  p_expected_plan_version integer
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_plan public.duty_plans%rowtype;
  v_archived_at timestamptz := timezone('utc', now());
begin
  if p_plan_id is null or p_expected_plan_version is null then
    raise exception 'plan_id ve expected_plan_version zorunludur.' using errcode = '22023';
  end if;
  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then return jsonb_build_object('status', 'plan_not_found'); end if;
  select id into v_year_id from public.academic_years
   where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then return jsonb_build_object('status', 'plan_not_found'); end if;

  perform pg_advisory_xact_lock(hashtext('duty-plan-draft:' || v_year_id::text));
  select * into v_plan from public.duty_plans
   where id = p_plan_id and campus_id = v_campus_id and academic_year_id = v_year_id
   for update;
  if not found then return jsonb_build_object('status', 'plan_not_found'); end if;
  if v_plan.version is distinct from p_expected_plan_version then
    return jsonb_build_object('status', 'version_conflict', 'currentVersion', v_plan.version);
  end if;
  if v_plan.status = 'archived' then
    return jsonb_build_object('status', 'already_archived', 'archivedAt', v_plan.updated_at);
  end if;
  if v_plan.status <> 'published' then
    return jsonb_build_object('status', 'plan_not_published');
  end if;

  update public.duty_plans
     set status = 'archived', updated_at = v_archived_at
   where id = v_plan.id;

  return jsonb_build_object('status', 'ok', 'planId', v_plan.id, 'archivedAt', v_archived_at);
end;
$$;

comment on function public.archive_published_duty_plan(uuid, text, text, integer) is
  'Yayımlanmış haftalık planı fiziksel silmeden archived yapar. Puan ledger satırları değişmez; gelecekteki puan snapshotları yalnız published planları saydığı için arşivlenen hafta aktif adalet hesabından çıkar. Yalnız service_role çağırabilir.';

revoke all on function public.list_duty_plan_history(text, text) from public;
revoke all on function public.get_duty_plan_history_detail(uuid, text, text) from public;
revoke all on function public.create_duty_plan_revision(uuid, text, text, integer) from public;
revoke all on function public.archive_published_duty_plan(uuid, text, text, integer) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.list_duty_plan_history(text, text) from anon;
    revoke all on function public.get_duty_plan_history_detail(uuid, text, text) from anon;
    revoke all on function public.create_duty_plan_revision(uuid, text, text, integer) from anon;
    revoke all on function public.archive_published_duty_plan(uuid, text, text, integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.list_duty_plan_history(text, text) from authenticated;
    revoke all on function public.get_duty_plan_history_detail(uuid, text, text) from authenticated;
    revoke all on function public.create_duty_plan_revision(uuid, text, text, integer) from authenticated;
    revoke all on function public.archive_published_duty_plan(uuid, text, text, integer) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.list_duty_plan_history(text, text) to service_role;
    grant execute on function public.get_duty_plan_history_detail(uuid, text, text) to service_role;
    grant execute on function public.create_duty_plan_revision(uuid, text, text, integer) to service_role;
    grant execute on function public.archive_published_duty_plan(uuid, text, text, integer) to service_role;
  end if;
end;
$$;
