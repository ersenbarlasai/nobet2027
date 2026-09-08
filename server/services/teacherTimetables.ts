import type { SupabaseClient } from "@supabase/supabase-js";
import type { DayDef, MappingStatus, PeriodDef } from "./classTimetables";

/** RPC çağrısı başarısız olduğunda fırlatılır. Mesajı kullanıcıya güvenle gösterilebilir; bağlantı bilgisi/stack içermez. */
export class TeacherTimetableQueryError extends Error {}

// === Öğretmen listesi ========================================================

export interface TeacherSummary {
  id: string;
  sourceId: string;
  name: string;
  branch: string | null;
}

export interface CurrentImportTeachersResult {
  hasImport: boolean;
  importedAt: string | null;
  teachers: TeacherSummary[];
}

interface RawTeachersRpcResult {
  hasImport: boolean;
  importedAt: string | null;
  teachers: TeacherSummary[];
}

// sensitivity:"base" → case-insensitive (İ/i, I/ı gibi Türkçe harfler dahil); numeric:true → "10" "2"'den sonra gelir.
const teacherNameCollator = new Intl.Collator("tr", { numeric: true, sensitivity: "base" });

/** Öğretmen adlarını Türkçe/numeric-aware/case-insensitive biçimde karşılaştırır. Saf fonksiyon. */
export function compareTeacherNames(a: string, b: string): number {
  return teacherNameCollator.compare(a, b);
}

/**
 * public.get_current_import_teachers RPC'sini çağırır ve sonucu Türkçe/
 * numeric-aware/case-insensitive sıralamayla döner. RPC kendisi sıralama
 * yapmaz (bkz. migration).
 */
export async function fetchCurrentImportTeachers(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
): Promise<CurrentImportTeachersResult> {
  const { data, error } = await supabase.rpc("get_current_import_teachers", {
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
  });
  if (error) {
    throw new TeacherTimetableQueryError(error.message);
  }
  const result = data as RawTeachersRpcResult;
  const teachers = [...result.teachers].sort((a, b) => compareTeacherNames(a.name, b.name));
  return { hasImport: result.hasImport, importedAt: result.importedAt, teachers };
}

// === Öğretmen ders programı ==================================================

/** Ham (gruplanmamış) atama satırı — aynı card için birden çok sınıf/satır olabilir. */
export interface RawTeacherAssignmentRow {
  cardId: string;
  sourceCardKey: string;
  dayId: string;
  periodId: string;
  subjectName: string | null;
  className: string;
  classroom: string | null;
  mappingStatus: MappingStatus;
}

/** Bir card'ın gruplanmış hücre görünümü: tek subject, benzersiz sınıf/derslik listesi. */
export interface TeacherLessonCell {
  cardId: string;
  sourceCardKey: string;
  dayId: string;
  periodId: string;
  subjectName: string | null;
  classNames: string[];
  classroomNames: string[];
  mappingStatus: MappingStatus;
  /** Aynı gün+ders saatinde bu öğretmen için BAŞKA bir card da varsa true (kaynak XML veri çakışması). */
  conflict: boolean;
}

export interface TeacherTimetableSummary {
  dayCount: number;
  periodCount: number;
  weeklyLessonCount: number;
  occupiedCellCount: number;
  classCount: number;
  ambiguousLessonCount: number;
  conflictCellCount: number;
}

function splitClassroomNames(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const MAPPING_PRIORITY: Record<MappingStatus, number> = { exact: 0, expanded: 1, ambiguous: 2 };

function higherPriorityStatus(a: MappingStatus, b: MappingStatus): MappingStatus {
  return MAPPING_PRIORITY[b] > MAPPING_PRIORITY[a] ? b : a;
}

/**
 * Ham atama satırlarını `timetable_card_id` bazında tek hücreye gruplar: tek
 * subject, benzersiz sınıf adları listesi, benzersiz derslik adları listesi,
 * en yüksek riskli mapping status (ambiguous > expanded > exact). Aynı
 * gün+ders saatinde birden çok FARKLI card varsa conflict=true işaretler.
 * Saf fonksiyondur (ağ/veritabanı erişimi yok) — test edilebilir. (bkz.
 * server/services/classTimetables.ts::groupAssignmentRows — aynı desen,
 * yalnız gruplanan ikincil alan öğretmen değil sınıf adıdır.)
 */
export function groupTeacherAssignmentRows(rows: RawTeacherAssignmentRow[]): TeacherLessonCell[] {
  const byCard = new Map<
    string,
    {
      sourceCardKey: string;
      dayId: string;
      periodId: string;
      subjectName: string | null;
      classNames: Set<string>;
      classroomNames: Set<string>;
      mappingStatus: MappingStatus;
    }
  >();

  for (const row of rows) {
    let group = byCard.get(row.cardId);
    if (!group) {
      group = {
        sourceCardKey: row.sourceCardKey,
        dayId: row.dayId,
        periodId: row.periodId,
        subjectName: row.subjectName,
        classNames: new Set(),
        classroomNames: new Set(),
        mappingStatus: row.mappingStatus,
      };
      byCard.set(row.cardId, group);
    }
    group.classNames.add(row.className);
    for (const name of splitClassroomNames(row.classroom)) group.classroomNames.add(name);
    group.mappingStatus = higherPriorityStatus(group.mappingStatus, row.mappingStatus);
  }

  // Aynı (gün, ders saati) hücresinde birden çok FARKLI card varsa bu bir
  // veri çakışmasıdır (iki ayrı XML kaydı aynı hücreyi paylaşıyor).
  const cardIdsByCell = new Map<string, Set<string>>();
  for (const [cardId, group] of byCard) {
    const cellKey = `${group.dayId}:${group.periodId}`;
    const set = cardIdsByCell.get(cellKey) ?? new Set<string>();
    set.add(cardId);
    cardIdsByCell.set(cellKey, set);
  }

  return [...byCard.entries()].map(([cardId, group]) => {
    const cellKey = `${group.dayId}:${group.periodId}`;
    const conflict = (cardIdsByCell.get(cellKey)?.size ?? 1) > 1;
    return {
      cardId,
      sourceCardKey: group.sourceCardKey,
      dayId: group.dayId,
      periodId: group.periodId,
      subjectName: group.subjectName,
      classNames: [...group.classNames],
      classroomNames: [...group.classroomNames],
      mappingStatus: group.mappingStatus,
      conflict,
    };
  });
}

/**
 * Gruplanmış hücrelerden özet sayıları türetir. weeklyLessonCount, ham
 * assignment satırı sayısını DEĞİL benzersiz card/hücre sayısını kullanır.
 * classCount, öğretmenin ders verdiği BENZERSİZ sınıf sayısıdır (tüm
 * hücrelerdeki classNames birleşiminin boyutu). Saf fonksiyondur.
 */
export function computeTeacherTimetableSummary(
  lessons: TeacherLessonCell[],
  dayCount: number,
  periodCount: number,
): TeacherTimetableSummary {
  const occupiedCells = new Set(lessons.map((l) => `${l.dayId}:${l.periodId}`));
  const conflictCells = new Set(lessons.filter((l) => l.conflict).map((l) => `${l.dayId}:${l.periodId}`));
  const allClassNames = new Set(lessons.flatMap((l) => l.classNames));
  return {
    dayCount,
    periodCount,
    weeklyLessonCount: lessons.length,
    occupiedCellCount: occupiedCells.size,
    classCount: allClassNames.size,
    ambiguousLessonCount: lessons.filter((l) => l.mappingStatus === "ambiguous").length,
    conflictCellCount: conflictCells.size,
  };
}

interface RawSnapshotRpcResult {
  hasImport: boolean;
  teacherFound: boolean;
  teacher?: TeacherSummary;
  importedAt?: string;
  days?: DayDef[];
  periods?: PeriodDef[];
  rows?: RawTeacherAssignmentRow[];
}

export type TeacherTimetableSnapshot =
  | { hasImport: false; teacherFound: false }
  | { hasImport: true; teacherFound: false; importedAt: string }
  | {
      hasImport: true;
      teacherFound: true;
      teacher: TeacherSummary;
      importedAt: string;
      days: DayDef[];
      periods: PeriodDef[];
      lessons: TeacherLessonCell[];
      summary: TeacherTimetableSummary;
    };

/**
 * public.get_teacher_timetable_snapshot RPC'sini çağırır ve ham atama
 * satırlarını gruplayarak (bkz. groupTeacherAssignmentRows) hücre bazlı bir
 * haftalık program döner.
 */
export async function fetchTeacherTimetableSnapshot(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
  teacherId: string,
): Promise<TeacherTimetableSnapshot> {
  const { data, error } = await supabase.rpc("get_teacher_timetable_snapshot", {
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
    p_teacher_id: teacherId,
  });
  if (error) {
    throw new TeacherTimetableQueryError(error.message);
  }
  const result = data as RawSnapshotRpcResult;

  if (!result.hasImport || !result.teacherFound || !result.teacher || !result.importedAt) {
    return result.hasImport
      ? { hasImport: true, teacherFound: false, importedAt: result.importedAt ?? "" }
      : { hasImport: false, teacherFound: false };
  }

  const days = result.days ?? [];
  const periods = result.periods ?? [];
  const lessons = groupTeacherAssignmentRows(result.rows ?? []);
  const summary = computeTeacherTimetableSummary(lessons, days.length, periods.length);

  return {
    hasImport: true,
    teacherFound: true,
    teacher: result.teacher,
    importedAt: result.importedAt,
    days,
    periods,
    lessons,
    summary,
  };
}
