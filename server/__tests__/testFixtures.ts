import type { ImportRequest } from "../validation/importPayload";

/** Geçerli, minimal bir içe aktarma isteği (testlerde temel alınır). */
export function buildValidImportRequestBody(overrides: Partial<Record<string, unknown>> = {}) {
  const body = {
    sourceFormat: "asc-timetables",
    sourceFilename: "test.xml",
    sourceEncoding: "utf-8",
    sourceSha256: "a".repeat(64),
    sourceCardCount: 1,
    normalizedAssignmentCount: 1,
    teachers: [{ sourceId: "T1", name: "Test Öğretmen", branch: null }],
    classes: [{ sourceId: "C1", name: "1/A", grade: null, classTeacherSourceId: null }],
    days: [{ sourceId: "D1", name: "Pazartesi", order: 1 }],
    periods: [{ sourceId: "P1", name: "1", order: 1, startsAt: "08:00", endsAt: "08:40" }],
    subjects: [{ sourceId: "S1", name: "Matematik", shortName: "MAT" }],
    lessons: [{ sourceId: "L1", subjectSourceId: "S1", sourceGroupIds: [] }],
    lessonTeachers: [{ lessonSourceId: "L1", teacherSourceId: "T1", sourceOrder: 1 }],
    lessonClasses: [{ lessonSourceId: "L1", classSourceId: "C1", sourceOrder: 1 }],
    cards: [
      {
        sourceIndex: 1,
        sourceCardKey: "card-1",
        lessonSourceId: "L1",
        daySourceId: "D1",
        periodSourceId: "P1",
        classroomSourceIds: [],
      },
    ],
    assignments: [
      {
        sourceCardKey: "card-1",
        lessonSourceId: "L1",
        teacherSourceId: "T1",
        classSourceId: "C1",
        daySourceId: "D1",
        periodSourceId: "P1",
        subjectSourceId: "S1",
        classroom: null,
        mappingStatus: "exact" as const,
      },
    ],
    validationIssues: [],
  };
  return { ...body, ...overrides };
}

export function asImportRequest(body: ReturnType<typeof buildValidImportRequestBody>): ImportRequest {
  return body as unknown as ImportRequest;
}
