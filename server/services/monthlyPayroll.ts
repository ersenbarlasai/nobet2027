import type { SupabaseClient } from "@supabase/supabase-js";
import { computeMonthlyPayroll, type ActiveWeekInput, type CorrectionInput, type QualifyingLessonInput } from "./monthlyPayrollEngine";

export class MonthlyPayrollQueryError extends Error {}
async function rpc<T>(db: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(name, args);
  if (error || !data) throw new MonthlyPayrollQueryError("İşlem tamamlanamadı.");
  return data as T;
}

interface RawInputs {
  teacherSourceId: string;
  teacherNameSnapshot: string;
  monthStart: string;
  activeWeeks: ActiveWeekInput[];
  carryInDebt: number;
  debtCreatedThisMonth: number;
  qualifyingLessons: QualifyingLessonInput[];
  carryInFinancialOffsetCents: number;
  corrections: CorrectionInput[];
  hasEducationCalendar: boolean;
  hasCompensationType: boolean;
}

/** Ayın 1. günü tarihine normalize eder (RPC/tablolar buna göre anahtarlanır). */
export function monthStartOf(dateIso: string): string {
  return `${dateIso.slice(0, 7)}-01`;
}

async function fetchInputs(db: SupabaseClient, c: string, y: string, teacherSourceId: string, monthStart: string) {
  return rpc<RawInputs>(db, "get_teacher_monthly_payroll_inputs", { p_campus_name: c, p_academic_year_name: y, p_teacher_source_id: teacherSourceId, p_month_start: monthStart });
}

export const listMonthlyPayrollRelevantTeachers = (db: SupabaseClient, c: string, y: string, monthStart: string) =>
  rpc<{ items: Array<{ sourceId: string; name: string }> }>(db, "list_monthly_payroll_relevant_teachers", { p_campus_name: c, p_academic_year_name: y, p_month_start: monthStart });

export const listMonthlyPayrollPeriods = (db: SupabaseClient, c: string, y: string) =>
  rpc<Array<{ id: string; monthStart: string; status: "open" | "closed"; closedAt: string | null }>>(db, "list_monthly_payroll_periods", { p_campus_name: c, p_academic_year_name: y });

export const getMonthlyPayrollSnapshot = (db: SupabaseClient, c: string, y: string, monthStart: string, teacherSourceId: string) =>
  rpc<Record<string, unknown>>(db, "get_monthly_payroll_snapshot", { p_campus_name: c, p_academic_year_name: y, p_month_start: monthStart, p_teacher_source_id: teacherSourceId });

export const addPayrollCorrection = (db: SupabaseClient, c: string, y: string, b: { teacherSourceId: string; monthStart: string; type: string; amount: number; unitRateCents?: number | null; reason: string; createdBy: string }) =>
  rpc<Record<string, unknown>>(db, "add_payroll_correction", { p_campus_name: c, p_academic_year_name: y, p_teacher_source_id: b.teacherSourceId, p_month_start: b.monthStart, p_correction_type: b.type, p_amount: b.amount, p_unit_rate_cents: b.unitRateCents ?? null, p_reason: b.reason, p_created_by: b.createdBy });

export const listPayrollCorrections = (db: SupabaseClient, c: string, y: string, monthStart: string, teacherSourceId: string) =>
  rpc<Array<Record<string, unknown>>>(db, "list_payroll_corrections", { p_campus_name: c, p_academic_year_name: y, p_month_start: monthStart, p_teacher_source_id: teacherSourceId });

export const clearTeacherAbsenceDebt = (db: SupabaseClient, c: string, y: string, b: { teacherSourceId: string; debtAmount: number; reason: string; createdBy: string; targetMonthStart: string }) =>
  rpc<Record<string, unknown>>(db, "clear_teacher_absence_debt", { p_campus_name: c, p_academic_year_name: y, p_teacher_source_id: b.teacherSourceId, p_debt_amount: b.debtAmount, p_reason: b.reason, p_created_by: b.createdBy, p_target_month_start: b.targetMonthStart });

export const listAbsenceDebtYearEndClearances = (db: SupabaseClient, c: string, y: string) =>
  rpc<Array<Record<string, unknown>>>(db, "list_absence_debt_year_end_clearances", { p_campus_name: c, p_academic_year_name: y });

export const setSubstitutionPayrollCompensationType = (db: SupabaseClient, c: string, typeId: string | null) =>
  rpc<Record<string, unknown>>(db, "set_substitution_payroll_compensation_type", { p_campus_name: c, p_type_id: typeId });

/**
 * Açık dönem için CANLI önizleme: motoru çağırır, DB'ye yazmaz. Kapanış ile
 * BİREBİR aynı hesap yolunu (computeMonthlyPayroll) kullanır — iki farklı
 * hesap mantığı yazılmaz.
 */
export async function previewMonthlyPayroll(db: SupabaseClient, c: string, y: string, teacherSourceId: string, monthStart: string) {
  const inputs = await fetchInputs(db, c, y, teacherSourceId, monthStart);
  const result = computeMonthlyPayroll(inputs);
  return { ...result, teacherNameSnapshot: inputs.teacherNameSnapshot, hasEducationCalendar: inputs.hasEducationCalendar, hasCompensationType: inputs.hasCompensationType };
}

export async function closeMonthlyPayrollForTeacher(db: SupabaseClient, c: string, y: string, teacherSourceId: string, monthStart: string) {
  const inputs = await fetchInputs(db, c, y, teacherSourceId, monthStart);
  if (!inputs.hasEducationCalendar) return { status: "pending_education_calendar" as const };
  if (!inputs.hasCompensationType) return { status: "pending_compensation_type" as const };
  const result = computeMonthlyPayroll(inputs);
  if (result.hasMissingRate) return { status: "pending_unit_rate" as const };
  const persisted = await rpc<{ status: string; periodId?: string }>(db, "persist_monthly_payroll_snapshot", {
    p_campus_name: c, p_academic_year_name: y, p_month_start: monthStart,
    p_result: { ...result, teacherNameSnapshot: inputs.teacherNameSnapshot },
  });
  return persisted;
}

export const closeMonthlyPayrollPeriod = (db: SupabaseClient, c: string, y: string, monthStart: string) =>
  rpc<Record<string, unknown>>(db, "close_monthly_payroll_period", { p_campus_name: c, p_academic_year_name: y, p_month_start: monthStart });
