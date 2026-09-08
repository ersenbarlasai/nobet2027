-- ============================================================================
-- Haftalık nöbet planı kimliği, seçili iş günleri ve kalıcı puan defteri
-- ============================================================================

alter table public.duty_plans
  add column if not exists week_start_date date,
  add column if not exists active_day_orders smallint[] not null default array[1,2,3,4,5]::smallint[],
  add column if not exists prior_score_snapshot jsonb not null default '{}'::jsonb;

-- 20260917090000 ile yayımlanmış/arşivlenmiş planlar DB seviyesinde
-- değiştirilemez. Hafta alanı bu migration'da ilk kez eklendiği için mevcut
-- tarihsel satırları doldururken yalnız ilgili lifecycle tetikleyicisini dar
-- bir aralıkta kapatırız. ALTER TABLE ve UPDATE aynı migration transaction'ı
-- içindedir; herhangi bir hata tüm işlemleri (tetikleyici durumu dahil) geri
-- alır. Atama/package immutability tetikleyicilerine dokunulmaz.
alter table public.duty_plans disable trigger enforce_duty_plan_lifecycle;

update public.duty_plans
   set week_start_date = date_trunc('week', created_at at time zone 'Europe/Istanbul')::date
 where week_start_date is null;

alter table public.duty_plans enable trigger enforce_duty_plan_lifecycle;

alter table public.duty_plans alter column week_start_date set not null;

create or replace function public.is_valid_duty_plan_day_orders(p_days smallint[])
returns boolean language sql immutable security invoker
set search_path = pg_catalog, public
as $$
  select cardinality(p_days) between 1 and 5
     and p_days <@ array[1,2,3,4,5]::smallint[]
     and p_days = (select array_agg(x order by x) from (select distinct unnest(p_days) x) s);
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'duty_plans_week_start_monday_ck') then
    alter table public.duty_plans add constraint duty_plans_week_start_monday_ck
      check (extract(isodow from week_start_date) = 1);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'duty_plans_active_days_ck') then
    alter table public.duty_plans add constraint duty_plans_active_days_ck
      check (public.is_valid_duty_plan_day_orders(active_day_orders));
  end if;
end;
$$;

-- generation_options mevcut save RPC'sinin atomik girdisidir. Hafta bağlamını
-- aynı transaction içinde plan satırına yansıtarak ikinci, yarışa açık bir
-- UPDATE ihtiyacını ortadan kaldırırız.
create or replace function public.sync_duty_plan_week_context()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_days smallint[];
begin
  if new.generation_options ? 'activeDayOrders' then
    select array_agg(v::smallint order by v::integer)
      into v_days
      from jsonb_array_elements_text(new.generation_options -> 'activeDayOrders') q(v);
    new.active_day_orders := v_days;
  end if;

  if new.generation_options ? 'weekStartDate' then
    new.week_start_date := (new.generation_options ->> 'weekStartDate')::date;
  elsif new.week_start_date is null then
    new.week_start_date := date_trunc('week', timezone('Europe/Istanbul', now()))::date;
  end if;

  if new.generation_options ? 'priorScoreSnapshot' then
    new.prior_score_snapshot := coalesce(new.generation_options -> 'priorScoreSnapshot', '{}'::jsonb);
  end if;
  return new;
end;
$$;

drop trigger if exists sync_duty_plan_week_context on public.duty_plans;
create trigger sync_duty_plan_week_context
  before insert or update of generation_options, week_start_date, active_day_orders
  on public.duty_plans
  for each row execute function public.sync_duty_plan_week_context();

drop index if exists public.duty_plans_one_active_published_uq;
create unique index duty_plans_one_published_per_week_uq
  on public.duty_plans (campus_id, academic_year_id, week_start_date)
  where status = 'published';
create index duty_plans_week_history_idx
  on public.duty_plans (campus_id, academic_year_id, week_start_date desc, status);

create table public.duty_teacher_score_ledger (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.duty_plans (id) on delete restrict,
  package_id uuid not null references public.duty_plan_assignment_packages (id) on delete restrict,
  campus_id uuid not null,
  academic_year_id uuid not null,
  teacher_source_id text not null check (btrim(teacher_source_id) <> ''),
  teacher_name_snapshot text not null check (btrim(teacher_name_snapshot) <> ''),
  week_start_date date not null,
  duty_date date not null,
  day_order smallint not null check (day_order between 1 and 5),
  coverage_mode text not null,
  assignment_kind text not null,
  duty_location_id uuid not null,
  duty_location_name_snapshot text not null,
  points numeric(8,2) not null default 1 check (points > 0),
  created_at timestamptz not null default timezone('utc', now()),
  constraint duty_teacher_score_ledger_plan_package_uq unique (plan_id, package_id),
  constraint duty_teacher_score_ledger_week_date_ck
    check (duty_date = week_start_date + (day_order - 1))
);

comment on table public.duty_teacher_score_ledger is
  'Yayımlanan haftalık planın değişmez puan defteri. Her öğretmen-gün paketi (TENEFFÜS, ÖĞLE_1, ÖĞLE_2 veya sabit) tam 1 puandır; hücre sayısı puanı çoğaltmaz.';

create index duty_teacher_score_ledger_teacher_week_idx
  on public.duty_teacher_score_ledger (campus_id, academic_year_id, teacher_source_id, week_start_date);
alter table public.duty_teacher_score_ledger enable row level security;
revoke all on public.duty_teacher_score_ledger from public, anon, authenticated;
grant select, insert on public.duty_teacher_score_ledger to service_role;

create or replace function public.prevent_duty_teacher_score_ledger_change()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public
as $$
begin
  raise exception 'Yayımlanmış nöbet puanı değiştirilemez.' using errcode = '55000';
end;
$$;
create trigger duty_teacher_score_ledger_immutable
  before update or delete on public.duty_teacher_score_ledger
  for each row execute function public.prevent_duty_teacher_score_ledger_change();

create or replace function public.record_published_duty_plan_scores()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public
as $$
begin
  if old.status = 'draft' and new.status = 'published' then
    insert into public.duty_teacher_score_ledger (
      plan_id, package_id, campus_id, academic_year_id,
      teacher_source_id, teacher_name_snapshot, week_start_date, duty_date,
      day_order, coverage_mode, assignment_kind, duty_location_id,
      duty_location_name_snapshot, points
    )
    select new.id, p.id, new.campus_id, new.academic_year_id,
           p.teacher_source_id, p.teacher_name_snapshot, new.week_start_date,
           new.week_start_date + (p.day_order - 1), p.day_order,
           p.coverage_mode, p.assignment_kind, p.duty_location_id,
           coalesce(min(a.duty_location_name_snapshot), dl.name), 1
      from public.duty_plan_assignment_packages p
      join public.duty_locations dl on dl.id = p.duty_location_id
      left join public.duty_plan_assignments a
        on a.plan_id = p.plan_id and a.package_id = p.id
     where p.plan_id = new.id
       and p.day_order = any(new.active_day_orders)
     group by p.id, p.teacher_source_id, p.teacher_name_snapshot, p.day_order,
              p.coverage_mode, p.assignment_kind, p.duty_location_id, dl.name
    on conflict (plan_id, package_id) do nothing;
  end if;
  return new;
end;
$$;
create trigger record_published_duty_plan_scores
  after update of status on public.duty_plans
  for each row execute function public.record_published_duty_plan_scores();

-- Hedef haftadan ÖNCE yayımlanmış ve sonradan aynı hafta için arşivlenmemiş
-- planların puanları. İsimler güncel importtan, puan geçmişi immutable
-- ledger'dan gelir.
create or replace function public.get_teacher_duty_score_snapshot(
  p_campus_name text,
  p_academic_year_name text,
  p_week_start_date date
)
returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_result jsonb;
begin
  if extract(isodow from p_week_start_date) <> 1 then
    raise exception 'week_start_date Pazartesi olmalıdır.' using errcode = '22023';
  end if;
  select id into v_campus_id from public.campuses where name = p_campus_name;
  select id into v_year_id from public.academic_years where name = p_academic_year_name;
  if v_campus_id is null or v_year_id is null then
    return jsonb_build_object('weekStartDate', p_week_start_date, 'teachers', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'teacherSourceId', u.teacher_source_id,
           'teacherName', u.teacher_name,
           'totalPoints', coalesce(s.total_points, 0),
           'dutyCount', coalesce(s.duty_count, 0),
           'lastDutyDate', s.last_duty_date,
           'lastFourWeeksDutyCount', coalesce(s.last_four_weeks, 0)
         ) order by u.teacher_name, u.teacher_source_id), '[]'::jsonb)
    into v_result
    from (
      select distinct ds.teacher_source_id, coalesce(t.name, ds.teacher_source_id) teacher_name
        from public.teacher_duty_settings ds
        left join public.timetable_imports ti on ti.academic_year_id = v_year_id and ti.status = 'imported'
        left join public.teachers t on t.timetable_import_id = ti.id and t.source_id = ds.teacher_source_id
       where ds.academic_year_id = v_year_id and ds.is_included
    ) u
    left join lateral (
      select sum(l.points) total_points, count(*) duty_count, max(l.duty_date) last_duty_date,
             count(*) filter (where l.week_start_date >= p_week_start_date - 28) last_four_weeks
        from public.duty_teacher_score_ledger l
        join public.duty_plans p on p.id = l.plan_id and p.status = 'published'
       where l.campus_id = v_campus_id and l.academic_year_id = v_year_id
         and l.teacher_source_id = u.teacher_source_id
         and l.week_start_date < p_week_start_date
    ) s on true;

  return jsonb_build_object('weekStartDate', p_week_start_date, 'teachers', v_result);
end;
$$;

create or replace function public.get_duty_plan_week_context(
  p_plan_id uuid,
  p_campus_name text,
  p_academic_year_name text
)
returns jsonb language sql stable security invoker
set search_path = pg_catalog, public
as $$
  select coalesce((
    select jsonb_build_object(
      'found', true,
      'weekStartDate', p.week_start_date,
      'activeDayOrders', to_jsonb(p.active_day_orders),
      'priorScoreSnapshot', p.prior_score_snapshot
    )
      from public.duty_plans p
      join public.campuses c on c.id = p.campus_id and c.name = p_campus_name
      join public.academic_years ay on ay.id = p.academic_year_id and ay.name = p_academic_year_name
     where p.id = p_plan_id
  ), jsonb_build_object('found', false));
$$;

-- Mevcut RPC'leri içerik kopyalamadan, kontrollü ve assert'li biçimde haftalık
-- gün evrenine geçir. Eski migration dosyaları değişmez.
do $$
declare
  v_oid regprocedure;
  v_def text;
  v_before integer;
begin
  v_oid := 'public.save_duty_plan_draft(text,text,text,text,integer,jsonb,jsonb,jsonb,boolean,uuid,integer)'::regprocedure;
  select pg_get_functiondef(v_oid) into v_def;
  v_before := (length(v_def) - length(replace(v_def, 'generate_series(1, 5) as d(day_order)', ''))) / length('generate_series(1, 5) as d(day_order)');
  if v_before <> 2 then raise exception 'save_duty_plan_draft beklenen generate_series sayısı 2, bulunan %', v_before; end if;
  v_def := replace(v_def, 'generate_series(1, 5) as d(day_order)',
    '(select jsonb_array_elements_text(coalesce(p_generation_options -> ''activeDayOrders'', ''[1,2,3,4,5]''::jsonb))::integer as day_order) as d');
  v_before := (length(v_def) - length(replace(v_def, 'where fa.academic_year_id = v_year_id', ''))) / length('where fa.academic_year_id = v_year_id');
  if v_before <> 3 then raise exception 'save_duty_plan_draft beklenen fixed-day filtre sayısı 3, bulunan %', v_before; end if;
  v_def := replace(v_def, 'where fa.academic_year_id = v_year_id',
    'where fa.academic_year_id = v_year_id and fa.day_order = any(array(select jsonb_array_elements_text(coalesce(p_generation_options -> ''activeDayOrders'', ''[1,2,3,4,5]''::jsonb))::smallint))');
  execute v_def;

  v_oid := 'public.publish_duty_plan_draft(uuid,text,text,integer)'::regprocedure;
  select pg_get_functiondef(v_oid) into v_def;
  v_before := (length(v_def) - length(replace(v_def, 'generate_series(1, 5) as d(day_order)', ''))) / length('generate_series(1, 5) as d(day_order)');
  if v_before <> 1 then raise exception 'publish_duty_plan_draft beklenen generate_series sayısı 1, bulunan %', v_before; end if;
  v_def := replace(v_def, 'generate_series(1, 5) as d(day_order)', 'unnest(v_plan.active_day_orders) as d(day_order)');
  v_before := (length(v_def) - length(replace(v_def, 'where fa.academic_year_id = v_year_id', ''))) / length('where fa.academic_year_id = v_year_id');
  if v_before <> 3 then raise exception 'publish_duty_plan_draft beklenen fixed-day filtre sayısı 3, bulunan %', v_before; end if;
  v_def := replace(v_def, 'where fa.academic_year_id = v_year_id',
    'where fa.academic_year_id = v_year_id and fa.day_order = any(v_plan.active_day_orders)');
  v_def := replace(v_def,
    'where campus_id = v_campus_id and academic_year_id = v_year_id and status = ''published'';',
    'where campus_id = v_campus_id and academic_year_id = v_year_id and week_start_date = v_plan.week_start_date and status = ''published'';');
  if position('week_start_date = v_plan.week_start_date' in v_def) = 0 then
    raise exception 'publish_duty_plan_draft hafta arşivleme patch uygulanamadı';
  end if;
  execute v_def;

  v_oid := 'public.get_published_duty_plan(text,text)'::regprocedure;
  select pg_get_functiondef(v_oid) into v_def;
  if position('status = ''published'';' in v_def) = 0 then
    raise exception 'get_published_duty_plan latest-week patch uygulanamadı';
  end if;
  v_def := replace(v_def,
    'where campus_id = v_campus_id and academic_year_id = v_year_id and status = ''published'';',
    'where campus_id = v_campus_id and academic_year_id = v_year_id and status = ''published'' order by week_start_date desc limit 1;');
  execute v_def;
end;
$$;

revoke all on function public.get_teacher_duty_score_snapshot(text, text, date) from public, anon, authenticated;
grant execute on function public.get_teacher_duty_score_snapshot(text, text, date) to service_role;
revoke all on function public.get_duty_plan_week_context(uuid, text, text) from public, anon, authenticated;
grant execute on function public.get_duty_plan_week_context(uuid, text, text) to service_role;
