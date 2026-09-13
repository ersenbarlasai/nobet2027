import { LOCAL_API_BASE_URL } from "../localApi";
import type { MonthlyPayrollOverview, PayrollCorrection, PayrollPeriod, RelevantTeacher } from "./types";

const BASE = `${LOCAL_API_BASE_URL}/api/monthly-payroll`;
async function read<T>(r: Response): Promise<T> {
  const b = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw Object.assign(new Error(b.message ?? "İşlem tamamlanamadı."), { status: b.error, details: b });
  return b as T;
}
async function request<T>(promise: Promise<Response>): Promise<T> { return read<T>(await promise); }

export const fetchRelevantTeachers = (monthStart: string) =>
  request<{ items: RelevantTeacher[] }>(fetch(`${BASE}/relevant-teachers?monthStart=${encodeURIComponent(monthStart)}`));
export const fetchMonthlyOverview = (monthStart: string, teacherSourceId: string) =>
  request<MonthlyPayrollOverview>(fetch(`${BASE}/overview?monthStart=${encodeURIComponent(monthStart)}&teacherSourceId=${encodeURIComponent(teacherSourceId)}`));
export const closeMonthlyPayrollForTeacher = (monthStart: string, teacherSourceId: string) =>
  request<Record<string, unknown>>(fetch(`${BASE}/close-teacher`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ monthStart, teacherSourceId }) }));
export const closeMonthlyPayrollPeriod = (monthStart: string) =>
  request<Record<string, unknown>>(fetch(`${BASE}/close-period`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ monthStart }) }));
export const fetchPayrollPeriods = () => request<{ items: PayrollPeriod[] }>(fetch(`${BASE}/periods`));
export const fetchPayrollCorrections = (monthStart: string, teacherSourceId: string) =>
  request<{ items: PayrollCorrection[] }>(fetch(`${BASE}/corrections?monthStart=${encodeURIComponent(monthStart)}&teacherSourceId=${encodeURIComponent(teacherSourceId)}`));
export const addPayrollCorrection = (body: { teacherSourceId: string; monthStart: string; type: string; amount: number; unitRateCents?: number | null; reason: string; createdBy?: string | null }) =>
  request<Record<string, unknown>>(fetch(`${BASE}/corrections`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
export const yearEndClearDebt = (body: { teacherSourceId: string; debtAmount: number; reason: string; targetMonthStart: string; createdBy?: string | null }) =>
  request<Record<string, unknown>>(fetch(`${BASE}/year-end-clear`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
export const fetchYearEndClearances = () => request<{ items: Array<Record<string, unknown>> }>(fetch(`${BASE}/year-end-clearances`));
export const setSubstitutionCompensationType = (typeId: string | null) =>
  request<Record<string, unknown>>(fetch(`${BASE}/compensation-type`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ typeId }) }));
