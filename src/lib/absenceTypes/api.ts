import { LOCAL_API_BASE_URL } from "../localApi";
import type { AbsenceType } from "./types";

const BASE = `${LOCAL_API_BASE_URL}/api/absence-types`;
async function read<T>(r: Response): Promise<T> {
  const b = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw Object.assign(new Error(b.message ?? "İşlem tamamlanamadı."), { status: b.error, details: b });
  return b as T;
}
async function request<T>(promise: Promise<Response>): Promise<T> { return read<T>(await promise); }

export const fetchAbsenceTypes = () => request<{ items: AbsenceType[] }>(fetch(BASE));
export const saveAbsenceType = (body: { id?: string | null; name: string; createsDebt: boolean; effectiveFrom: string; isActive: boolean }) =>
  request<Record<string, unknown>>(fetch(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
export const deleteAbsenceType = (id: string) =>
  request<{ status: string; action: "deleted" | "deactivated" }>(fetch(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" }));
