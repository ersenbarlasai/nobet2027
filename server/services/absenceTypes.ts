import type { SupabaseClient } from "@supabase/supabase-js";

export class AbsenceTypeQueryError extends Error {}
async function rpc<T>(db: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(name, args);
  if (error || !data) throw new AbsenceTypeQueryError("İşlem tamamlanamadı.");
  return data as T;
}
export const listAbsenceTypes = (db: SupabaseClient, c: string) =>
  rpc<Record<string, unknown>>(db, "list_absence_types", { p_campus_name: c });
export const saveAbsenceType = (db: SupabaseClient, c: string, b: { id?: string | null; name: string; createsDebt: boolean; effectiveFrom: string; isActive: boolean }) =>
  rpc<Record<string, unknown>>(db, "save_absence_type", { p_campus_name: c, p_type_id: b.id ?? null, p_name: b.name, p_creates_debt: b.createsDebt, p_effective_from: b.effectiveFrom, p_is_active: b.isActive });
export const deleteAbsenceType = (db: SupabaseClient, c: string, id: string) =>
  rpc<Record<string, unknown>>(db, "delete_absence_type", { p_campus_name: c, p_type_id: id });
