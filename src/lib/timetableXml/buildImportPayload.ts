import type { TimetableImportResult } from "./types";

// POST /api/timetable-imports için istek gövdesi. campusName/academicYearName
// BİLEREK burada yok — kampüs/eğitim yılı yerel backend'de merkezi
// yapılandırma (server/config.ts) olarak tutulur, frontend'den gönderilmez.
export interface ImportRequestPayload {
  sourceFormat: string;
  sourceFilename: string;
  sourceEncoding: string;
  sourceSha256: string;
  sourceCardCount: number;
  normalizedAssignmentCount: number;
  teachers: { sourceId: string; name: string; branch: string | null }[];
  classes: {
    sourceId: string;
    name: string;
    grade: string | null;
    /** XML source teacher ID (bkz. <class teacherid>) — normalize DB UUID DEĞİL. */
    classTeacherSourceId: string | null;
  }[];
  days: { sourceId: string; name: string; order: number }[];
  periods: {
    sourceId: string;
    name: string;
    order: number;
    startsAt: string | null;
    endsAt: string | null;
  }[];
  subjects: { sourceId: string; name: string; shortName: string | null }[];
  lessons: { sourceId: string; subjectSourceId: string | null; sourceGroupIds: string[] }[];
  lessonTeachers: { lessonSourceId: string; teacherSourceId: string; sourceOrder: number }[];
  lessonClasses: { lessonSourceId: string; classSourceId: string; sourceOrder: number }[];
  cards: {
    sourceIndex: number;
    sourceCardKey: string;
    lessonSourceId: string;
    daySourceId: string;
    periodSourceId: string;
    classroomSourceIds: string[];
  }[];
  assignments: {
    sourceCardKey: string;
    lessonSourceId: string;
    teacherSourceId: string;
    classSourceId: string;
    daySourceId: string;
    periodSourceId: string;
    subjectSourceId: string | null;
    classroom: string | null;
    mappingStatus: string;
  }[];
  validationIssues: {
    severity: "error" | "warning";
    code: string;
    message: string;
    affectedCount: number | null;
    distinctReferenceCount: number | null;
  }[];
}

export interface ImportFileMeta {
  sourceFormat: string;
  sourceFilename: string;
  sourceEncoding: string;
  sourceSha256: string;
}

/**
 * Doğrulanmış TimetableImportResult'ı, yerel backend'in
 * POST /api/timetable-imports beklediği düz JSON gövdeye dönüştürür.
 * Saf fonksiyondur — ağ isteği yapmaz.
 */
export function buildImportPayload(result: TimetableImportResult, fileMeta: ImportFileMeta): ImportRequestPayload {
  const subjectIdByLessonId = new Map(result.lessons.map((l) => [l.id, l.subjectId ?? null]));

  return {
    sourceFormat: fileMeta.sourceFormat,
    sourceFilename: fileMeta.sourceFilename,
    sourceEncoding: fileMeta.sourceEncoding,
    sourceSha256: fileMeta.sourceSha256,
    sourceCardCount: result.stats.sourceCardCount ?? 0,
    normalizedAssignmentCount: result.scheduleEntries.length,
    teachers: result.teachers.map((t) => ({ sourceId: t.id, name: t.name, branch: t.branch ?? null })),
    classes: result.classes.map((c) => ({
      sourceId: c.id,
      name: c.name,
      grade: c.grade ?? null,
      classTeacherSourceId: c.teacherId ?? null,
    })),
    days: result.days.map((d) => ({ sourceId: d.id, name: d.name, order: d.order })),
    periods: result.periods.map((p) => ({
      sourceId: p.id,
      name: p.name,
      order: p.order,
      startsAt: p.startTime ?? null,
      endsAt: p.endTime ?? null,
    })),
    subjects: result.subjects.map((s) => ({ sourceId: s.id, name: s.name, shortName: s.shortName ?? null })),
    lessons: result.lessons.map((l) => ({
      sourceId: l.id,
      subjectSourceId: l.subjectId ?? null,
      sourceGroupIds: l.sourceGroupIds,
    })),
    lessonTeachers: result.lessonTeachers.map((lt) => ({
      lessonSourceId: lt.lessonId,
      teacherSourceId: lt.teacherId,
      sourceOrder: lt.sourceOrder,
    })),
    lessonClasses: result.lessonClasses.map((lc) => ({
      lessonSourceId: lc.lessonId,
      classSourceId: lc.classId,
      sourceOrder: lc.sourceOrder,
    })),
    cards: result.cards.map((c) => ({
      sourceIndex: c.sourceIndex,
      sourceCardKey: c.id,
      lessonSourceId: c.lessonId,
      daySourceId: c.dayId,
      periodSourceId: c.periodId,
      classroomSourceIds: c.classroomSourceIds,
    })),
    assignments: result.scheduleEntries.map((e) => ({
      sourceCardKey: e.sourceCardId,
      lessonSourceId: e.sourceLessonId,
      teacherSourceId: e.teacherId,
      classSourceId: e.classId,
      daySourceId: e.dayId,
      periodSourceId: e.periodId,
      subjectSourceId: subjectIdByLessonId.get(e.sourceLessonId) ?? null,
      classroom: e.classroom ?? null,
      mappingStatus: e.mappingStatus,
    })),
    validationIssues: [
      ...result.validationErrors.map((issue) => ({
        severity: "error" as const,
        code: issue.code,
        message: issue.message,
        affectedCount: issue.affectedCount ?? null,
        distinctReferenceCount: issue.distinctReferenceCount ?? null,
      })),
      ...result.validationWarnings.map((issue) => ({
        severity: "warning" as const,
        code: issue.code,
        message: issue.message,
        affectedCount: issue.affectedCount ?? null,
        distinctReferenceCount: issue.distinctReferenceCount ?? null,
      })),
    ],
  };
}
