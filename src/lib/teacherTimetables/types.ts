import type { DayDef, MappingStatus, PeriodDef } from "../classTimetables/types";

export type { DayDef, MappingStatus, PeriodDef };

export interface TeacherSummary {
  id: string;
  sourceId: string;
  name: string;
  branch: string | null;
}

export interface CurrentImportTeachersResponse {
  hasImport: boolean;
  importedAt: string | null;
  teachers: TeacherSummary[];
}

export interface TeacherLessonCell {
  cardId: string;
  sourceCardKey: string;
  dayId: string;
  periodId: string;
  subjectName: string | null;
  classNames: string[];
  classroomNames: string[];
  mappingStatus: MappingStatus;
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

export type TeacherTimetableResponse =
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
