-- ============================================================================
-- Deneme kaydı temizleme düzeltmesi
-- ============================================================================
-- 20261011090000 içindeki clear_trial_records security invoker olduğu için
-- duty_teacher_score_ledger üzerinde DELETE yetkisi yoktu. Ayrıca yayımlanmış/
-- arşivlenmiş nöbet planlarını koruyan lifecycle tetikleyicileri cascade
-- silmeleri engelliyordu. Tamamlanmış gözetmen planları da yalnız mevcut,
-- plan-kimliği kapsamlı delete_exam_invigilation_plan RPC'siyle silinebilir.
--
-- Bu ileri migration:
--   * fonksiyonu SECURITY DEFINER yapar (çalıştırma yalnız service_role'de),
--   * nöbet geçmişi koruma tetikleyicilerini yalnız bu transaction boyunca
--     ve tablo kilitleri altında kapatıp işlem bitmeden yeniden açar,
--   * gözetmen planlarını mevcut güvenli silme RPC'si üzerinden tek tek siler,
--   * diğer bütün kayıtları FK/tetikleyici uyumlu sırada temizler.
-- Bir hata olursa DDL dahil tüm değişiklikler aynı transaction ile geri alınır.

create or replace function public.clear_trial_records(
  p_campus_name text,
  p_academic_year_name text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_exam_plan_id uuid;
  v_duty_plans integer;
  v_exam_plans integer;
  v_assignment_lists integer;
  v_payroll_records integer;
  v_closed_periods integer;
begin
  select id into v_campus_id
    from public.campuses
    where name = p_campus_name;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select id into v_year_id
    from public.academic_years
    where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select count(*) into v_duty_plans
    from public.duty_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id;
  select count(*) into v_exam_plans
    from public.exam_invigilation_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id;
  select count(*) into v_assignment_lists
    from public.substitution_day_lists
    where campus_id = v_campus_id and academic_year_id = v_year_id;
  select
    (select count(*) from public.manual_payroll_entries
      where campus_id = v_campus_id and academic_year_id = v_year_id)
    +
    (select count(*)
      from public.payroll_period_lines l
      join public.payroll_periods p on p.id = l.payroll_period_id
      where p.campus_id = v_campus_id and p.academic_year_id = v_year_id)
    into v_payroll_records;
  select count(*) into v_closed_periods
    from public.payroll_periods
    where campus_id = v_campus_id
      and academic_year_id = v_year_id
      and status = 'closed';

  -- Tamamlanmış plan korumasını yalnız hedef plan kimliği için açan mevcut
  -- RPC'yi kullan. Böylece gözetmen tablolarının normal immutability kuralları
  -- değiştirilmez.
  for v_exam_plan_id in
    select id
      from public.exam_invigilation_plans
      where campus_id = v_campus_id and academic_year_id = v_year_id
      order by id
  loop
    perform public.delete_exam_invigilation_plan(v_exam_plan_id);
  end loop;

  -- Aşağıdaki tetikleyiciler yayımlanmış nöbet geçmişini normal kullanımda
  -- değişmez tutar. Bu yönetici sıfırlamasında, ilgili tablolar ACCESS
  -- EXCLUSIVE kilit altındayken transaction-lokal olarak kapatılır. Fonksiyon
  -- hata verirse PostgreSQL hem silmeleri hem trigger durumunu geri alır.
  execute 'alter table public.duty_teacher_score_ledger disable trigger duty_teacher_score_ledger_immutable';
  execute 'alter table public.duty_plan_assignments disable trigger enforce_duty_plan_assignment_write_rules';
  execute 'alter table public.duty_plan_assignment_packages disable trigger enforce_duty_plan_package_write_rules';
  execute 'alter table public.duty_plans disable trigger enforce_duty_plan_lifecycle';

  delete from public.duty_teacher_score_ledger
    where plan_id in (
      select id from public.duty_plans
      where campus_id = v_campus_id and academic_year_id = v_year_id
    );

  delete from public.duty_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id;

  execute 'alter table public.duty_plans enable trigger enforce_duty_plan_lifecycle';
  execute 'alter table public.duty_plan_assignment_packages enable trigger enforce_duty_plan_package_write_rules';
  execute 'alter table public.duty_plan_assignments enable trigger enforce_duty_plan_assignment_write_rules';
  execute 'alter table public.duty_teacher_score_ledger enable trigger duty_teacher_score_ledger_immutable';

  -- Önce puantaj snapshot'ları kaldırılır. Böylece kaynak görevlendirmelerdeki
  -- "kapanmış puantaja bağlı görev değiştirilemez" tetikleyicisi engel olmaz.
  delete from public.payroll_period_lines
    where payroll_period_id in (
      select id from public.payroll_periods
      where campus_id = v_campus_id and academic_year_id = v_year_id
    );
  delete from public.payroll_period_teacher_totals
    where payroll_period_id in (
      select id from public.payroll_periods
      where campus_id = v_campus_id and academic_year_id = v_year_id
    );
  delete from public.payroll_periods
    where campus_id = v_campus_id and academic_year_id = v_year_id;
  delete from public.manual_payroll_entries
    where campus_id = v_campus_id and academic_year_id = v_year_id;

  -- Önceki XML importlarına bağlı deneme görevlendirmeleri için yalnız bu
  -- transaction içinde history lock istisnası.
  perform set_config('nobet2027.bypass_history_lock', 'on', true);
  delete from public.teacher_absences
    where campus_id = v_campus_id and academic_year_id = v_year_id;
  delete from public.substitution_day_lists
    where campus_id = v_campus_id and academic_year_id = v_year_id;

  return jsonb_build_object(
    'status', 'ok',
    'deleted', jsonb_build_object(
      'dutyPlanCount', v_duty_plans,
      'examInvigilationPlanCount', v_exam_plans,
      'assignmentListCount', v_assignment_lists,
      'payrollRecordCount', v_payroll_records,
      'closedPeriodCount', v_closed_periods
    )
  );
end;
$$;

comment on function public.clear_trial_records(text, text) is
  'Yalnız service_role tarafından çağrılan, seçili kampüs+eğitim yılındaki '
  'deneme planlama/puantaj kayıtlarını tek transactionda temizleyen yönetici '
  'işlemi. XML, ders programı ve yapılandırma kayıtlarını korur.';

revoke all on function public.clear_trial_records(text, text) from public;
grant execute on function public.clear_trial_records(text, text) to service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.clear_trial_records(text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.clear_trial_records(text, text) from authenticated;
  end if;
end;
$$;
