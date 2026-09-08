import { teacherDutyAvailabilityUrl } from "../localApi";
import type { SaveDutyMatrixApiError, SaveDutyMatrixPayload, SaveDutyMatrixSuccess, TeacherDutyMatrixResponse } from "./types";

/** RPC/HTTP hatası — matris alınamadı. AbortError bu tipe ait DEĞİLDİR (bkz. çağıran taraf). */
export class DutyMatrixFetchError extends Error {}

/**
 * Belirli bir öğretmenin nöbet uygunluk matrisini çeker. 404 (öğretmen
 * mevcut importta bulunamadı) HATA fırlatmaz — gövde (teacherFound:false)
 * olduğu gibi döner, aynen fetchTeacherTimetable deseni.
 */
export async function fetchDutyMatrix(teacherId: string, signal?: AbortSignal): Promise<TeacherDutyMatrixResponse> {
  const response = await fetch(teacherDutyAvailabilityUrl(teacherId), { signal });
  if (!response.ok && response.status !== 404) {
    throw new DutyMatrixFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as TeacherDutyMatrixResponse;
}

/** Kaydetme sırasında alan bazlı/durum bazlı hata — çağıran taraf error.code'a göre dallanır. */
export class SaveDutyMatrixError extends Error {
  apiError: SaveDutyMatrixApiError;
  constructor(apiError: SaveDutyMatrixApiError) {
    super(apiError.message);
    this.apiError = apiError;
  }
}

export async function saveDutyMatrix(
  teacherId: string,
  payload: SaveDutyMatrixPayload,
  signal?: AbortSignal,
): Promise<SaveDutyMatrixSuccess> {
  const response = await fetch(teacherDutyAvailabilityUrl(teacherId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const body = (await response.json()) as SaveDutyMatrixSuccess | SaveDutyMatrixApiError;
  if (!response.ok) {
    throw new SaveDutyMatrixError(body as SaveDutyMatrixApiError);
  }
  return body as SaveDutyMatrixSuccess;
}
