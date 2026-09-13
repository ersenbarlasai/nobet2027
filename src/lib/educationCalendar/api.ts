import { LOCAL_API_BASE_URL } from "../localApi";
import type { EducationCalendar } from "./types";

const BASE = `${LOCAL_API_BASE_URL}/api/education-calendar`;
async function read<T>(r: Response): Promise<T> {
  const b = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw Object.assign(new Error(b.message ?? "İşlem tamamlanamadı."), { status: b.error, details: b });
  return b as T;
}
async function request<T>(promise: Promise<Response>): Promise<T> { return read<T>(await promise); }

export const fetchEducationCalendar = () => request<EducationCalendar>(fetch(BASE));
export const saveEducationTerm = (body: { startDate: string; endDate: string; description?: string | null }) =>
  request<Record<string, unknown>>(fetch(`${BASE}/term`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
export const addEducationClosure = (body: { closureType: string; dateFrom: string; dateTo: string; description?: string | null }) =>
  request<Record<string, unknown>>(fetch(`${BASE}/closures`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
export const deleteEducationClosure = (id: string) =>
  request<{ status: string }>(fetch(`${BASE}/closures/${encodeURIComponent(id)}`, { method: "DELETE" }));
