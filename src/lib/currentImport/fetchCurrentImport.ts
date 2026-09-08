import { CURRENT_TIMETABLE_IMPORT_URL } from "../localApi";
import type { CurrentImportSnapshot } from "./types";

/**
 * Yerel backend'den GET /api/timetable-imports/current çağırır. Supabase'e
 * hiç doğrudan bağlanmaz. `signal` verilirse isteği iptal edilebilir kılar
 * (bkz. CurrentImportStatus.tsx — refreshKey değişince veya unmount'ta
 * önceki isteği iptal eder, böylece geç dönen eski cevap yeni state'i ezemez).
 */
export async function fetchCurrentImport(signal?: AbortSignal): Promise<CurrentImportSnapshot> {
  const response = await fetch(CURRENT_TIMETABLE_IMPORT_URL, { signal });
  if (!response.ok) {
    throw new Error(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as CurrentImportSnapshot;
}
