import type { SupabaseClient } from "@supabase/supabase-js";

export interface ImportOutcome {
  importId: string;
  status: string;
  campusName: string;
  academicYearName: string;
  teacherCount: number;
  classCount: number;
  dayCount: number;
  periodCount: number;
  sourceCardCount: number;
  normalizedAssignmentCount: number;
  importedAt: string;
  alreadyImported: boolean;
}

/** RPC çağrısı başarısız olduğunda fırlatılır. Mesajı kullanıcıya güvenle gösterilebilir; bağlantı bilgisi/stack içermez. */
export class ImportRpcError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = "ImportRpcError";
    this.code = code;
  }
}

/**
 * public.import_timetable_snapshot RPC'sini çağırır. Bu RPC yalnızca
 * service_role (sb_secret_...) ile çağrılabilir — supabase istemcisi bu
 * modülün DIŞINDA (server/supabase.ts) o anahtarla oluşturulur; bu
 * fonksiyon hiçbir zaman tarayıcıdan çağrılmaz.
 */
export async function importTimetableSnapshot(
  supabase: SupabaseClient,
  rpcPayload: Record<string, unknown>,
): Promise<ImportOutcome> {
  const { data, error } = await supabase.rpc("import_timetable_snapshot", { p_payload: rpcPayload });
  if (error) {
    throw new ImportRpcError(error.message, error.code ?? null);
  }
  return data as ImportOutcome;
}
