import type { SupabaseClient } from "@supabase/supabase-js";

export interface CurrentImportSummary {
  sourceFilename: string;
  status: string;
  campusName: string;
  academicYearName: string;
  importedAt: string;
  teacherCount: number;
  classCount: number;
  dayCount: number;
  periodCount: number;
  sourceCardCount: number;
  normalizedAssignmentCount: number;
  hasCountMismatch: boolean;
}

export interface CurrentImportSnapshot {
  hasImport: boolean;
  import: CurrentImportSummary | null;
}

/** RPC çağrısı başarısız olduğunda fırlatılır. Mesajı kullanıcıya güvenle gösterilebilir; bağlantı bilgisi/stack içermez. */
export class CurrentImportQueryError extends Error {}

/**
 * public.get_current_timetable_import_snapshot RPC'sini çağırır — tek
 * kampüs+eğitim yılı için en güncel başarılı importun salt-okunur özetini
 * döner. Veri değiştirmez. Yalnız service_role ile çağrılabilir.
 */
export async function fetchCurrentImportSnapshot(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
): Promise<CurrentImportSnapshot> {
  const { data, error } = await supabase.rpc("get_current_timetable_import_snapshot", {
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
  });
  if (error) {
    throw new CurrentImportQueryError(error.message);
  }
  return data as CurrentImportSnapshot;
}
