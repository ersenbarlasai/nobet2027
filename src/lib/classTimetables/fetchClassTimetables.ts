import { CLASS_TIMETABLES_CLASSES_URL, classTimetableUrl } from "../localApi";
import type { ClassTimetableResponse, CurrentImportClassesResponse } from "./types";

/** RPC/HTTP hatası — sınıf listesi/programı alınamadı. AbortError bu tipe ait DEĞİLDİR (bkz. çağıran taraf). */
export class ClassTimetableFetchError extends Error {}

export async function fetchClasses(signal?: AbortSignal): Promise<CurrentImportClassesResponse> {
  const response = await fetch(CLASS_TIMETABLES_CLASSES_URL, { signal });
  if (!response.ok) {
    throw new ClassTimetableFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as CurrentImportClassesResponse;
}

/**
 * Belirli bir sınıfın haftalık programını çeker. 404 (sınıf mevcut importta
 * bulunamadı) HATA fırlatmaz — çağrılan ekranın "seçilen sınıf artık
 * güncel importta yok" durumunu ayırt edebilmesi için gövde (classFound:false)
 * olduğu gibi döndürülür.
 */
export async function fetchClassTimetable(classId: string, signal?: AbortSignal): Promise<ClassTimetableResponse> {
  const response = await fetch(classTimetableUrl(classId), { signal });
  if (!response.ok && response.status !== 404) {
    throw new ClassTimetableFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as ClassTimetableResponse;
}
