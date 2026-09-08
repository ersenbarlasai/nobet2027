-- ============================================================================
-- 20260925090000 öncesinde yayımlanmış haftalık planların puan defteri
-- ============================================================================
-- record_published_duty_plan_scores tetikleyicisi yalnız bundan sonraki
-- draft -> published geçişlerinde çalışır. Migration kurulurken zaten
-- published durumda bulunan planları burada bir kez ve idempotent biçimde
-- doldururuz. Archived planlar bilinçli olarak alınmaz: aynı haftanın eski
-- sürümlerini iki kez puanlamamak için puan sorgusunun yetkili evreni de
-- yalnız status='published' planlardır.

insert into public.duty_teacher_score_ledger (
  plan_id, package_id, campus_id, academic_year_id,
  teacher_source_id, teacher_name_snapshot, week_start_date, duty_date,
  day_order, coverage_mode, assignment_kind, duty_location_id,
  duty_location_name_snapshot, points
)
select dp.id, p.id, dp.campus_id, dp.academic_year_id,
       p.teacher_source_id, p.teacher_name_snapshot, dp.week_start_date,
       dp.week_start_date + (p.day_order - 1), p.day_order,
       p.coverage_mode, p.assignment_kind, p.duty_location_id,
       coalesce(min(a.duty_location_name_snapshot), dl.name), 1
  from public.duty_plans dp
  join public.duty_plan_assignment_packages p on p.plan_id = dp.id
  join public.duty_locations dl on dl.id = p.duty_location_id
  left join public.duty_plan_assignments a
    on a.plan_id = p.plan_id and a.package_id = p.id
 where dp.status = 'published'
   and p.day_order = any(dp.active_day_orders)
 group by dp.id, p.id, dp.campus_id, dp.academic_year_id,
          p.teacher_source_id, p.teacher_name_snapshot, dp.week_start_date,
          p.day_order, p.coverage_mode, p.assignment_kind,
          p.duty_location_id, dl.name
on conflict (plan_id, package_id) do nothing;

-- Her aktif published paket tam bir ledger satırına karşılık gelmelidir.
-- Eksik öğretmen/snapshot gibi tarihsel bir tutarsızlık varsa migration
-- sessizce eksik puan üretmek yerine transaction'ı durdurur.
do $$
begin
  if exists (
    select 1
      from public.duty_plans dp
      join public.duty_plan_assignment_packages p on p.plan_id = dp.id
      left join public.duty_teacher_score_ledger l
        on l.plan_id = dp.id and l.package_id = p.id
     where dp.status = 'published'
       and p.day_order = any(dp.active_day_orders)
       and l.id is null
  ) then
    raise exception 'Yayımlanmış plan puan geçmişi eksik kaldı.' using errcode = '23514';
  end if;
end;
$$;
