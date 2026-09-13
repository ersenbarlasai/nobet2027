import type { SupabaseClient } from "@supabase/supabase-js";

export class EducationCalendarQueryError extends Error {}
async function rpc<T>(db: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(name, args);
  if (error || !data) throw new EducationCalendarQueryError("İşlem tamamlanamadı.");
  return data as T;
}
export const listEducationCalendar = (db: SupabaseClient, c: string, y: string) =>
  rpc<Record<string, unknown>>(db, "list_education_calendar", { p_campus_name: c, p_academic_year_name: y });
export const saveEducationTerm = (db: SupabaseClient, c: string, y: string, b: { startDate: string; endDate: string; description?: string | null }) =>
  rpc<Record<string, unknown>>(db, "save_education_term", { p_campus_name: c, p_academic_year_name: y, p_start_date: b.startDate, p_end_date: b.endDate, p_description: b.description ?? null });
export const addEducationCalendarClosure = (db: SupabaseClient, c: string, y: string, b: { closureType: string; dateFrom: string; dateTo: string; description?: string | null }) =>
  rpc<Record<string, unknown>>(db, "add_education_calendar_closure", { p_campus_name: c, p_academic_year_name: y, p_closure_type: b.closureType, p_date_from: b.dateFrom, p_date_to: b.dateTo, p_description: b.description ?? null });
export const deleteEducationCalendarClosure = (db: SupabaseClient, c: string, id: string) =>
  rpc<Record<string, unknown>>(db, "delete_education_calendar_closure", { p_campus_name: c, p_closure_id: id });
