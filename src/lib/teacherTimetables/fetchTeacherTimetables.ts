import { TEACHER_TIMETABLES_TEACHERS_URL, teacherTimetableUrl } from "../localApi";
import type { CurrentImportTeachersResponse, TeacherTimetableResponse } from "./types";

/** RPC/HTTP hatası — öğretmen listesi/programı alınamadı. AbortError bu tipe ait DEĞİLDİR (bkz. çağıran taraf). */
export class TeacherTimetableFetchError extends Error {}

export async function fetchTeachers(signal?: AbortSignal): Promise<CurrentImportTeachersResponse> {
  const response = await fetch(TEACHER_TIMETABLES_TEACHERS_URL, { signal });
  if (!response.ok) {
    throw new TeacherTimetableFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as CurrentImportTeachersResponse;
}

/**
 * Belirli bir öğretmenin haftalık programını çeker. 404 (öğretmen mevcut
 * importta bulunamadı) HATA fırlatmaz — çağıran ekranın "seçilen öğretmen
 * artık güncel importta yok" durumunu ayırt edebilmesi için gövde
 * (teacherFound:false) olduğu gibi döndürülür.
 */
export async function fetchTeacherTimetable(teacherId: string, signal?: AbortSignal): Promise<TeacherTimetableResponse> {
  const response = await fetch(teacherTimetableUrl(teacherId), { signal });
  if (!response.ok && response.status !== 404) {
    throw new TeacherTimetableFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as TeacherTimetableResponse;
}
