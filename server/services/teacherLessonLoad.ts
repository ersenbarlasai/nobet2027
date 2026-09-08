import type { SupabaseClient } from "@supabase/supabase-js";

export class TeacherLessonLoadQueryError extends Error {}

interface TeacherLessonPeriodCountRow {
  teacherSourceId: string;
  dayOrder: number;
  lessonPeriodCount: number;
}

/**
 * Öğretmenin GÜN BAZINDA gerçek ders yükü — `get_teacher_lesson_period_counts`
 * RPC'sinden (bkz. supabase migration) `teacherSourceId|dayOrder → sayı`
 * biçiminde. Solver'da yalnız SIRALAMA maliyetidir (öncelik 6); hiçbir
 * zorunlu uygunluk kuralını geçersiz KILMAZ.
 */
export async function fetchTeacherLessonPeriodCounts(
  supabase: SupabaseClient,
  timetableImportId: string,
): Promise<Map<string, number>> {
  const { data, error } = await supabase.rpc("get_teacher_lesson_period_counts", {
    p_timetable_import_id: timetableImportId,
  });
  if (error) {
    throw new TeacherLessonLoadQueryError("Öğretmen ders yükü alınamadı.");
  }
  const rows = (data ?? []) as TeacherLessonPeriodCountRow[];
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(`${row.teacherSourceId}|${row.dayOrder}`, row.lessonPeriodCount);
  }
  return map;
}
