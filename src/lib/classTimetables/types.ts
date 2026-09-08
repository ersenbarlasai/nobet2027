export interface ClassSummary {
  id: string;
  sourceId: string;
  name: string;
  grade: string | null;
}

/** Sınıfın SINIF ÖĞRETMENİ — bir ders hücresindeki öğretmenlerle KARIŞTIRILMAMALI. */
export interface ClassTeacherSummary {
  id: string;
  name: string;
}

export interface CurrentImportClassesResponse {
  hasImport: boolean;
  importedAt: string | null;
  classes: ClassSummary[];
}

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

export interface LessonCell {
  cardId: string;
  sourceCardKey: string;
  dayId: string;
  periodId: string;
  subjectName: string | null;
  teacherNames: string[];
  classroomNames: string[];
  /** Öğretmensiz derste (XML teacherids="") NULL — sahte 'exact' değeri yoktur. */
  mappingStatus: MappingStatus | null;
  /** "unassigned": lesson'da hiç öğretmen yok (ör. teacherids="" deneme sınavı). Ders GİZLENMEZ. */
  teacherAssignmentStatus: TeacherAssignmentStatus;
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

export type ClassTimetableResponse =
  | { hasImport: false; classFound: false }
  | { hasImport: true; classFound: false; importedAt: string }
  | {
      hasImport: true;
      classFound: true;
      class: ClassSummary & { classTeacher: ClassTeacherSummary | null };
      importedAt: string;
      days: DayDef[];
      periods: PeriodDef[];
      lessons: LessonCell[];
      summary: ClassTimetableSummary;
    };
