-- ============================================================================
-- "Sistem ve Veri" ekranı: uygulama gerçek kullanıma alınmadan önce deneme
-- sürecinde oluşturulan planlama/puantaj kayıtlarını tek transactionda temizler.
-- Ders programı (timetable_*), öğretmen/sınıf/ders, nöbet yerleri/blokları,
-- öğretmen nöbet uygunlukları, sabit nöbet tanımları, ücret türleri/birim
-- ücretler ve kampüs/eğitim yılı KORUNUR — bu fonksiyonlar bunlara hiç dokunmaz.
-- ============================================================================

create or replace function public.get_trial_data_counts(
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
  v_duty_plans integer;
  v_exam_plans integer;
  v_assignment_lists integer;
  v_payroll_records integer;
  v_closed_periods integer;
begin
  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then
    return jsonb_build_object(
      'status', 'ok',
      'dutyPlanCount', 0, 'examInvigilationPlanCount', 0,
      'assignmentListCount', 0, 'payrollRecordCount', 0, 'closedPeriodCount', 0
    );
  end if;

  select id into v_year_id from public.academic_years where campus_id = v_campus_id and name = p_academic_year_name;

  if not found then
    return jsonb_build_object(
      'status', 'ok',
      'dutyPlanCount', 0, 'examInvigilationPlanCount', 0,
      'assignmentListCount', 0, 'payrollRecordCount', 0, 'closedPeriodCount', 0
    );
  end if;

  select count(*) into v_duty_plans
    from public.duty_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id;
  select count(*) into v_exam_plans
    from public.exam_invigilation_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id;
  select count(*) into v_assignment_lists
    from public.substitution_day_lists
    where campus_id = v_campus_id and (v_year_id is null or academic_year_id = v_year_id);
  select
    (select count(*) from public.manual_payroll_entries where campus_id = v_campus_id and (v_year_id is null or academic_year_id = v_year_id))
    + (select count(*) from public.payroll_period_lines l join public.payroll_periods p on p.id = l.payroll_period_id where p.campus_id = v_campus_id and (v_year_id is null or p.academic_year_id = v_year_id))
    into v_payroll_records;
  select count(*) into v_closed_periods
    from public.payroll_periods
    where campus_id = v_campus_id and status = 'closed' and (v_year_id is null or academic_year_id = v_year_id);

  return jsonb_build_object(
    'status', 'ok',
    'dutyPlanCount', v_duty_plans,
    'examInvigilationPlanCount', v_exam_plans,
    'assignmentListCount', v_assignment_lists,
    'payrollRecordCount', v_payroll_records,
    'closedPeriodCount', v_closed_periods
  );
end;
$$;

comment on function public.get_trial_data_counts(text, text) is
  'Deneme kayıtlarını temizle ekranı için salt-okunur özet sayılar. Hiçbir kayıt yazmaz/silmez.';

revoke all on function public.get_trial_data_counts(text, text) from public;
grant execute on function public.get_trial_data_counts(text, text) to service_role;

-- teacher_absences / substitution_day_lists üzerindeki
-- substitution_absence_history_lock / substitution_list_history_lock
-- tetikleyicileri, satır "güncel olmayan" bir XML içe aktarımına bağlıysa
-- DELETE'i reddeder (bkz. enforce_substitution_history_lock). Deneme
-- sürecinde XML birden çok kez yeniden yüklenmiş olabileceğinden, deneme
-- kayıtları çoğu zaman artık "güncel olmayan" bir içe aktarıma bağlıdır —
-- bu da temizlemeyi her zaman başarısız kılar. clear_trial_records bu kilidi,
-- yalnızca kendi transaction'ı içinde geçerli bir GUC bayrağıyla bilinçli
-- olarak atlar; tetikleyicinin normal (kilitli) davranışı başka her yerde
-- değişmeden kalır.
create or replace function public.enforce_substitution_history_lock() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_import uuid;
begin
  if current_setting('nobet2027.bypass_history_lock', true) = 'on' then
    return case when tg_op='DELETE' then old else new end;
  end if;
  v_import:=case when tg_table_name='teacher_absences' then old.timetable_import_id when tg_table_name='substitution_day_lists' then old.timetable_import_id else old.timetable_import_id end;
  if not public.substitution_import_is_current(v_import) then raise exception 'Geçmiş XML kaynağına bağlı görevlendirme değiştirilemez.' using errcode='55000'; end if;
  return case when tg_op='DELETE' then old else new end; end; $$;

-- ============================================================================
-- Tek transaction: plpgsql fonksiyon gövdesi doğası gereği atomiktir — bir
-- adım başarısız olursa (exception), fonksiyonun tüm etkileri geri alınır ve
-- hiçbir kayıt silinmez. FK'ler nedeniyle silme sırası önemlidir:
--   1) duty_teacher_score_ledger  (duty_plans/packages'a RESTRICT referans verir)
--   2) exam_invigilation_plans    (duty_plans'a RESTRICT referans verir; kendi
--                                   scope/session/assignment çocukları CASCADE)
--   3) duty_plans                 (assignments + packages CASCADE ile gider)
--   4) payroll_period_lines, payroll_period_teacher_totals (payroll_periods'a RESTRICT)
--      Önce bunlar silinir; aksi halde kapanmış puantaja bağlı substitution_tasks
--      ve manual_payroll_entries üzerindeki koruma tetikleyicileri DELETE'i engeller.
--   5) payroll_periods
--   6) manual_payroll_entries
--   7) teacher_absences, substitution_day_lists (substitution_tasks CASCADE ile gider)
-- ============================================================================
create or replace function public.clear_trial_records(
  p_campus_name text,
  p_academic_year_name text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_duty_plans integer;
  v_exam_plans integer;
  v_assignment_lists integer;
  v_payroll_records integer;
  v_closed_periods integer;
begin
  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select id into v_year_id from public.academic_years where campus_id = v_campus_id and name = p_academic_year_name;

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
    where campus_id = v_campus_id and (v_year_id is null or academic_year_id = v_year_id);
  select
    (select count(*) from public.manual_payroll_entries where campus_id = v_campus_id and (v_year_id is null or academic_year_id = v_year_id))
    + (select count(*) from public.payroll_period_lines l join public.payroll_periods p on p.id = l.payroll_period_id where p.campus_id = v_campus_id and (v_year_id is null or p.academic_year_id = v_year_id))
    into v_payroll_records;
  select count(*) into v_closed_periods
    from public.payroll_periods
    where campus_id = v_campus_id and status = 'closed' and (v_year_id is null or academic_year_id = v_year_id);

  delete from public.duty_teacher_score_ledger
    where plan_id in (
      select id from public.duty_plans
      where campus_id = v_campus_id and academic_year_id = v_year_id
    );

  delete from public.exam_invigilation_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id;

  delete from public.duty_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id;

  delete from public.payroll_period_lines
    where payroll_period_id in (
      select id from public.payroll_periods
      where campus_id = v_campus_id and (v_year_id is null or academic_year_id = v_year_id)
    );
  delete from public.payroll_period_teacher_totals
    where payroll_period_id in (
      select id from public.payroll_periods
      where campus_id = v_campus_id and (v_year_id is null or academic_year_id = v_year_id)
    );
  delete from public.payroll_periods
    where campus_id = v_campus_id and (v_year_id is null or academic_year_id = v_year_id);

  delete from public.manual_payroll_entries
    where campus_id = v_campus_id and (v_year_id is null or academic_year_id = v_year_id);

  -- is_local=true: bu bayrak yalnız bu transaction içinde geçerlidir, commit/
  -- rollback ile otomatik sıfırlanır. Bkz. enforce_substitution_history_lock.
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
  'Deneme sürecinde oluşan planlama/puantaj kayıtlarını TEK transactionda siler. '
  'Ders programı, öğretmen/sınıf/ders, nöbet yerleri/blokları, öğretmen nöbet '
  'uygunlukları, sabit nöbet tanımları, ücret türleri/birim ücretler ve '
  'kampüs/eğitim yılı bu fonksiyondan ETKİLENMEZ.';

revoke all on function public.clear_trial_records(text, text) from public;
grant execute on function public.clear_trial_records(text, text) to service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.get_trial_data_counts(text, text) from anon;
    revoke all on function public.clear_trial_records(text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.get_trial_data_counts(text, text) from authenticated;
    revoke all on function public.clear_trial_records(text, text) from authenticated;
  end if;
end;
$$;
