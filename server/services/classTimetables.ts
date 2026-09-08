import type { SupabaseClient } from "@supabase/supabase-js";

/** RPC çağrısı başarısız olduğunda fırlatılır. Mesajı kullanıcıya güvenle gösterilebilir; bağlantı bilgisi/stack içermez. */
export class ClassTimetableQueryError extends Error {}

// === Sınıf listesi ===========================================================

export interface ClassSummary {
  id: string;
  sourceId: string;
  name: string;
  grade: string | null;
}

export interface CurrentImportClassesResult {
  hasImport: boolean;
  importedAt: string | null;
  classes: ClassSummary[];
}

interface RawClassesRpcResult {
  hasImport: boolean;
  importedAt: string | null;
  classes: { id: string; sourceId: string; name: string; grade: string | null }[];
}

const classNameCollator = new Intl.Collator("tr", { numeric: true, sensitivity: "base" });

/**
 * Sınıf adlarını Türkçe/numeric-aware biçimde karşılaştırır ("5/A" < "10/A"
 * — düz alfabetik sıralamada "10/A" "5/A"'dan önce gelirdi). Saf fonksiyon.
 */
export function compareClassNames(a: string, b: string): number {
  return classNameCollator.compare(a, b);
}

/**
 * public.get_current_import_classes RPC'sini çağırır ve sonucu numeric-aware
 * Türkçe sıralamayla döner. RPC kendisi sıralama yapmaz (bkz. migration).
 */
export async function fetchCurrentImportClasses(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
): Promise<CurrentImportClassesResult> {
  const { data, error } = await supabase.rpc("get_current_import_classes", {
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
  });
  if (error) {
    throw new ClassTimetableQueryError(error.message);
  }
  const result = data as RawClassesRpcResult;
  const classes = [...result.classes].sort((a, b) => compareClassNames(a.name, b.name));
  return { hasImport: result.hasImport, importedAt: result.importedAt, classes };
}

// === Sınıf ders programı =====================================================

export type MappingStatus = "exact" | "expanded" | "ambiguous";

export interface DayDef {
  id: string;
  sourceId: string;
  name: string;
  order: number;
}

export interface PeriodDef {
  id: string;
  sourceId: string;
  name: string;
  order: number;
  startTime: string | null;
  endTime: string | null;
}

export type TeacherAssignmentStatus = "assigned" | "unassigned";

/**
 * Veritabanından gelen ham (gruplanmamış) lesson/card satırı — bir card için
 * birden çok satır olabilir (birden çok öğretmen). Kaynak: lesson_classes →
 * lessons → timetable_cards, öğretmen lesson_teachers/teachers üzerinden
 * LEFT JOIN ile eklenir (bkz. migration 20260905090000). Bir lesson'ın hiç
 * öğretmeni yoksa (XML'de teacherids="") teacherName/mappingStatus NULL
 * olur — bu satır KAYBOLMAZ (sahte 'exact' değeri de verilmez).
 */
export interface RawAssignmentRow {
  cardId: string;
  sourceCardKey: string;
  dayId: string;
  periodId: string;
  subjectName: string | null;
  teacherName: string | null;
  classroomNames: string[];
  mappingStatus: MappingStatus | null;
  teacherAssignmentStatus: TeacherAssignmentStatus;
}

/** Bir card'ın gruplanmış hücre görünümü: tek ders, benzersiz öğretmen/derslik listesi. */
export interface LessonCell {
  cardId: string;
  sourceCardKey: string;
  dayId: string;
  periodId: string;
  subjectName: string | null;
  teacherNames: string[];
  classroomNames: string[];
  /** Öğretmensiz derste (XML teacherids="") NULL — sahte 'exact' değeri verilmez. */
  mappingStatus: MappingStatus | null;
  /** "unassigned": lesson'da hiç öğretmen yok (ör. teacherids="" deneme sınavı). Ders GİZLENMEZ. */
  teacherAssignmentStatus: TeacherAssignmentStatus;
  /** Aynı gün+ders saatinde bu sınıf için BAŞKA bir card da varsa true (kaynak XML veri çakışması). */
  conflict: boolean;
}

export interface ClassTimetableSummary {
  dayCount: number;
  periodCount: number;
  weeklyLessonCount: number;
  occupiedCellCount: number;
  ambiguousCellCount: number;
  conflictCellCount: number;
}

/** Sınıfın SINIF ÖĞRETMENİ — bir ders hücresindeki öğretmenlerle KARIŞTIRILMAMALI. */
export interface ClassTeacherSummary {
  id: string;
  name: string;
}

interface RawSnapshotRpcResult {
  hasImport: boolean;
  classFound: boolean;
  class?: { id: string; sourceId: string; name: string; grade: string | null; classTeacher: ClassTeacherSummary | null };
  importedAt?: string;
  days?: { id: string; sourceId: string; name: string; order: number }[];
  periods?: { id: string; sourceId: string; name: string; order: number; startTime: string | null; endTime: string | null }[];
  rows?: RawAssignmentRow[];
}

export type ClassTimetableSnapshot =
  | { hasImport: false; classFound: false }
  | { hasImport: true; classFound: false; importedAt: string }
  | {
      hasImport: true;
      classFound: true;
      class: { id: string; sourceId: string; name: string; grade: string | null; classTeacher: ClassTeacherSummary | null };
      importedAt: string;
      days: DayDef[];
      periods: PeriodDef[];
      lessons: LessonCell[];
      summary: ClassTimetableSummary;
    };

const MAPPING_PRIORITY: Record<MappingStatus, number> = { exact: 0, expanded: 1, ambiguous: 2 };

/** null (öğretmensiz satır) her zaman dolu bir değere yenilir — aynı card içinde bu asla karışmaz (öğretmensiz lesson tek satır üretir). */
function higherPriorityStatus(a: MappingStatus | null, b: MappingStatus | null): MappingStatus | null {
  if (a === null) return b;
  if (b === null) return a;
  return MAPPING_PRIORITY[b] > MAPPING_PRIORITY[a] ? b : a;
}

/**
 * Ham atama satırlarını `timetable_card_id` bazında tek hücreye gruplar:
 * tek subject, benzersiz öğretmen adları listesi, benzersiz derslik adları
 * listesi, en yüksek riskli mapping status (ambiguous > expanded > exact).
 * Aynı gün+ders saatinde birden çok FARKLI card varsa conflict=true işaretler.
 * Saf fonksiyondur (ağ/veritabanı erişimi yok) — test edilebilir.
 */
export function groupAssignmentRows(rows: RawAssignmentRow[]): LessonCell[] {
  const byCard = new Map<
    string,
    {
      sourceCardKey: string;
      dayId: string;
      periodId: string;
      subjectName: string | null;
      teacherNames: Set<string>;
      classroomNames: Set<string>;
      mappingStatus: MappingStatus | null;
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
        teacherNames: new Set(),
        classroomNames: new Set(),
        mappingStatus: row.mappingStatus,
      };
      byCard.set(row.cardId, group);
    }
    // Öğretmensiz satırda teacherName NULL'dır — Set'e eklenmez (teacherNames=[] korunur).
    if (row.teacherName) group.teacherNames.add(row.teacherName);
    for (const name of row.classroomNames) group.classroomNames.add(name);
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
      teacherNames: [...group.teacherNames],
      classroomNames: [...group.classroomNames],
      mappingStatus: group.mappingStatus,
      teacherAssignmentStatus: group.teacherNames.size === 0 ? "unassigned" : "assigned",
      conflict,
    };
  });
}

/**
 * Gruplanmış hücrelerden özet sayıları türetir. weeklyLessonCount, ham
 * assignment satırı sayısını DEĞİL benzersiz card/hücre sayısını kullanır
 * (bkz. görev tanımı — "Atama Kaydı" ile "Plan Kartı" karıştırılmamalı).
 * Saf fonksiyondur.
 */
export function computeClassTimetableSummary(
  lessons: LessonCell[],
  dayCount: number,
  periodCount: number,
): ClassTimetableSummary {
  const occupiedCells = new Set(lessons.map((l) => `${l.dayId}:${l.periodId}`));
  const conflictCells = new Set(lessons.filter((l) => l.conflict).map((l) => `${l.dayId}:${l.periodId}`));
  return {
    dayCount,
    periodCount,
    weeklyLessonCount: lessons.length,
    occupiedCellCount: occupiedCells.size,
    ambiguousCellCount: lessons.filter((l) => l.mappingStatus === "ambiguous").length,
    conflictCellCount: conflictCells.size,
  };
}

/**
 * public.get_class_timetable_snapshot RPC'sini çağırır ve ham atama
 * satırlarını gruplayarak (bkz. groupAssignmentRows) hücre bazlı bir
 * haftalık program döner.
 */
export async function fetchClassTimetableSnapshot(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
  classId: string,
): Promise<ClassTimetableSnapshot> {
  const { data, error } = await supabase.rpc("get_class_timetable_snapshot", {
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
    p_class_id: classId,
  });
  if (error) {
    throw new ClassTimetableQueryError(error.message);
  }
  const result = data as RawSnapshotRpcResult;

  if (!result.hasImport || !result.classFound || !result.class || !result.importedAt) {
    return result.hasImport
      ? { hasImport: true, classFound: false, importedAt: result.importedAt ?? "" }
      : { hasImport: false, classFound: false };
  }

  const days = (result.days ?? []).map((d) => ({ id: d.id, sourceId: d.sourceId, name: d.name, order: d.order }));
  const periods = (result.periods ?? []).map((p) => ({
    id: p.id,
    sourceId: p.sourceId,
    name: p.name,
    order: p.order,
    startTime: p.startTime,
    endTime: p.endTime,
  }));
  const lessons = groupAssignmentRows(result.rows ?? []);
  const summary = computeClassTimetableSummary(lessons, days.length, periods.length);

  return {
    hasImport: true,
    classFound: true,
    class: result.class,
    importedAt: result.importedAt,
    days,
    periods,
    lessons,
    summary,
  };
}
