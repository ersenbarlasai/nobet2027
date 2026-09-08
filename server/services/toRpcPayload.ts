import type { ImportRequest } from "../validation/importPayload";

/**
 * Frontend/istek sözleşmesi (camelCase) ile RPC'nin (public.import_timetable_snapshot)
 * beklediği jsonb sözleşmesini (snake_case) BİLEREK ayırır — SQL tarafında
 * çift-tırnaklı camelCase sütun adlarıyla uğraşmak yerine, bu sınırda tek
 * bir yerde dönüştürme yapılır. campusName/academicYearName burada, istekten
 * DEĞİL, merkezi backend yapılandırmasından enjekte edilir.
 */
export function toRpcPayload(request: ImportRequest, campusName: string, academicYearName: string) {
  return {
    campus_name: campusName,
    academic_year_name: academicYearName,
    source_format: request.sourceFormat,
    source_filename: request.sourceFilename,
    source_encoding: request.sourceEncoding,
    source_sha256: request.sourceSha256,
    source_card_count: request.sourceCardCount,
    normalized_assignment_count: request.normalizedAssignmentCount,
    teachers: request.teachers.map((t) => ({ source_id: t.sourceId, name: t.name, branch: t.branch })),
    classes: request.classes.map((c) => ({
      source_id: c.sourceId,
      name: c.name,
      grade: c.grade,
      class_teacher_source_id: c.classTeacherSourceId,
    })),
    days: request.days.map((d) => ({ source_id: d.sourceId, name: d.name, sort_order: d.order })),
    periods: request.periods.map((p) => ({
      source_id: p.sourceId,
      name: p.name,
      sort_order: p.order,
      starts_at: p.startsAt,
      ends_at: p.endsAt,
    })),
    subjects: request.subjects.map((s) => ({ source_id: s.sourceId, name: s.name, short_name: s.shortName })),
    lessons: request.lessons.map((l) => ({
      source_id: l.sourceId,
      subject_source_id: l.subjectSourceId,
      source_group_ids: l.sourceGroupIds,
    })),
    lesson_teachers: request.lessonTeachers.map((lt) => ({
      lesson_source_id: lt.lessonSourceId,
      teacher_source_id: lt.teacherSourceId,
      source_order: lt.sourceOrder,
    })),
    lesson_classes: request.lessonClasses.map((lc) => ({
      lesson_source_id: lc.lessonSourceId,
      class_source_id: lc.classSourceId,
      source_order: lc.sourceOrder,
    })),
    cards: request.cards.map((c) => ({
      source_index: c.sourceIndex,
      source_card_key: c.sourceCardKey,
      lesson_source_id: c.lessonSourceId,
      day_source_id: c.daySourceId,
      period_source_id: c.periodSourceId,
      classroom_source_ids: c.classroomSourceIds,
    })),
    assignments: request.assignments.map((a) => ({
      source_card_key: a.sourceCardKey,
      lesson_source_id: a.lessonSourceId,
      teacher_source_id: a.teacherSourceId,
      class_source_id: a.classSourceId,
      day_source_id: a.daySourceId,
      period_source_id: a.periodSourceId,
      subject_source_id: a.subjectSourceId,
      classroom: a.classroom,
      mapping_status: a.mappingStatus,
    })),
    validation_issues: request.validationIssues.map((i) => ({
      severity: i.severity,
      code: i.code,
      message: i.message,
      affected_count: i.affectedCount,
      distinct_reference_count: i.distinctReferenceCount,
    })),
  };
}
