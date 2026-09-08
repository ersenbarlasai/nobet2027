import { z } from "zod";

// Frontend'in src/lib/timetableXml/buildImportPayload.ts ile ürettiği
// gövdeyle birebir eşleşir. Bu şema "gelen veriye güvenme" ilkesiyle
// yazıldı: her alan tekrar, sunucu tarafında doğrulanır — RPC (Postgres
// fonksiyonu) de kendi tarafında AYRICA doğrular (savunma derinliği).
const MAX_COLLECTION_SIZE = 20000;

const nonEmptyString = z.string().trim().min(1);
const positiveInt = z.number().int().positive();
const nonNegativeIntOrNull = z.number().int().nonnegative().nullable();

const teacherSchema = z.object({ sourceId: nonEmptyString, name: nonEmptyString, branch: z.string().nullable() });
const classSchema = z.object({
  sourceId: nonEmptyString,
  name: nonEmptyString,
  grade: z.string().nullable(),
  classTeacherSourceId: z.string().nullable(),
});
const daySchema = z.object({ sourceId: nonEmptyString, name: nonEmptyString, order: positiveInt });
const periodSchema = z.object({
  sourceId: nonEmptyString,
  name: nonEmptyString,
  order: positiveInt,
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
});
const subjectSchema = z.object({ sourceId: nonEmptyString, name: nonEmptyString, shortName: z.string().nullable() });
const lessonSchema = z.object({
  sourceId: nonEmptyString,
  subjectSourceId: z.string().nullable(),
  sourceGroupIds: z.array(z.string()).max(MAX_COLLECTION_SIZE),
});
const lessonTeacherSchema = z.object({
  lessonSourceId: nonEmptyString,
  teacherSourceId: nonEmptyString,
  sourceOrder: positiveInt,
});
const lessonClassSchema = z.object({
  lessonSourceId: nonEmptyString,
  classSourceId: nonEmptyString,
  sourceOrder: positiveInt,
});
const cardSchema = z.object({
  sourceIndex: positiveInt,
  sourceCardKey: nonEmptyString,
  lessonSourceId: nonEmptyString,
  daySourceId: nonEmptyString,
  periodSourceId: nonEmptyString,
  classroomSourceIds: z.array(z.string()).max(MAX_COLLECTION_SIZE),
});
const mappingStatusEnum = z.enum(["exact", "expanded", "ambiguous"]);
const assignmentSchema = z.object({
  sourceCardKey: nonEmptyString,
  lessonSourceId: nonEmptyString,
  teacherSourceId: nonEmptyString,
  classSourceId: nonEmptyString,
  daySourceId: nonEmptyString,
  periodSourceId: nonEmptyString,
  subjectSourceId: z.string().nullable(),
  classroom: z.string().nullable(),
  mappingStatus: mappingStatusEnum,
});
const severityEnum = z.enum(["error", "warning"]);
const validationIssueSchema = z.object({
  severity: severityEnum,
  code: nonEmptyString,
  message: nonEmptyString,
  affectedCount: nonNegativeIntOrNull,
  distinctReferenceCount: nonNegativeIntOrNull,
});

export const importRequestSchema = z.object({
  sourceFormat: nonEmptyString,
  sourceFilename: nonEmptyString,
  sourceEncoding: nonEmptyString,
  sourceSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "sourceSha256 64 haneli hex olmalı"),
  sourceCardCount: z.number().int().nonnegative(),
  normalizedAssignmentCount: z.number().int().nonnegative(),
  teachers: z.array(teacherSchema).max(MAX_COLLECTION_SIZE),
  classes: z.array(classSchema).max(MAX_COLLECTION_SIZE),
  days: z.array(daySchema).max(MAX_COLLECTION_SIZE),
  periods: z.array(periodSchema).max(MAX_COLLECTION_SIZE),
  subjects: z.array(subjectSchema).max(MAX_COLLECTION_SIZE),
  lessons: z.array(lessonSchema).max(MAX_COLLECTION_SIZE),
  lessonTeachers: z.array(lessonTeacherSchema).max(MAX_COLLECTION_SIZE),
  lessonClasses: z.array(lessonClassSchema).max(MAX_COLLECTION_SIZE),
  cards: z.array(cardSchema).max(MAX_COLLECTION_SIZE),
  assignments: z.array(assignmentSchema).max(MAX_COLLECTION_SIZE),
  validationIssues: z.array(validationIssueSchema).max(MAX_COLLECTION_SIZE),
});

export type ImportRequest = z.infer<typeof importRequestSchema>;

export type ImportValidationResult =
  | { ok: true; data: ImportRequest }
  | { ok: false; errors: string[] };

function findDuplicates(values: string[], label: string): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) dupes.add(v);
    seen.add(v);
  }
  return [...dupes].map((d) => `${label}: yinelenen source_id: ${d}`);
}

/**
 * zod ile şekil/tip doğrulamasından SONRA çalışan, koleksiyonlar-arası
 * referans bütünlüğünü ve iş kurallarını kontrol eden ikinci katman.
 * RPC bu kontrolleri kendi tarafında (Postgres) tekrar yapar — burası
 * yalnızca açıkça bozuk isteklerin veritabanına ulaşmadan hızlıca
 * reddedilmesi içindir.
 */
export function validateImportRequest(body: unknown): ImportValidationResult {
  const parsed = importRequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(kök)"}: ${i.message}`),
    };
  }

  const data = parsed.data;
  const errors: string[] = [];

  errors.push(...findDuplicates(data.teachers.map((t) => t.sourceId), "teachers"));
  errors.push(...findDuplicates(data.classes.map((c) => c.sourceId), "classes"));
  errors.push(...findDuplicates(data.days.map((d) => d.sourceId), "days"));
  errors.push(...findDuplicates(data.periods.map((p) => p.sourceId), "periods"));
  errors.push(...findDuplicates(data.subjects.map((s) => s.sourceId), "subjects"));
  errors.push(...findDuplicates(data.lessons.map((l) => l.sourceId), "lessons"));
  errors.push(...findDuplicates(data.cards.map((c) => c.sourceCardKey), "cards"));

  const teacherIds = new Set(data.teachers.map((t) => t.sourceId));
  const classIds = new Set(data.classes.map((c) => c.sourceId));
  const dayIds = new Set(data.days.map((d) => d.sourceId));
  const periodIds = new Set(data.periods.map((p) => p.sourceId));
  const subjectIds = new Set(data.subjects.map((s) => s.sourceId));
  const lessonIds = new Set(data.lessons.map((l) => l.sourceId));
  const cardKeys = new Set(data.cards.map((c) => c.sourceCardKey));

  for (const c of data.classes) {
    if (c.classTeacherSourceId !== null && !teacherIds.has(c.classTeacherSourceId)) {
      errors.push(`classes: tanımsız sınıf öğretmeni (teacher) referansı: ${c.classTeacherSourceId}`);
    }
  }
  for (const l of data.lessons) {
    if (l.subjectSourceId !== null && !subjectIds.has(l.subjectSourceId)) {
      errors.push(`lessons: tanımsız subject referansı: ${l.subjectSourceId}`);
    }
  }
  for (const lt of data.lessonTeachers) {
    if (!lessonIds.has(lt.lessonSourceId)) errors.push(`lessonTeachers: tanımsız lesson referansı: ${lt.lessonSourceId}`);
    if (!teacherIds.has(lt.teacherSourceId)) errors.push(`lessonTeachers: tanımsız teacher referansı: ${lt.teacherSourceId}`);
  }
  for (const lc of data.lessonClasses) {
    if (!lessonIds.has(lc.lessonSourceId)) errors.push(`lessonClasses: tanımsız lesson referansı: ${lc.lessonSourceId}`);
    if (!classIds.has(lc.classSourceId)) errors.push(`lessonClasses: tanımsız class referansı: ${lc.classSourceId}`);
  }
  for (const c of data.cards) {
    if (!lessonIds.has(c.lessonSourceId)) errors.push(`cards: tanımsız lesson referansı: ${c.lessonSourceId}`);
    if (!dayIds.has(c.daySourceId)) errors.push(`cards: tanımsız day referansı: ${c.daySourceId}`);
    if (!periodIds.has(c.periodSourceId)) errors.push(`cards: tanımsız period referansı: ${c.periodSourceId}`);
  }

  const teacherCountByLesson = new Map<string, Set<string>>();
  const classCountByLesson = new Map<string, Set<string>>();
  for (const lt of data.lessonTeachers) {
    if (!teacherCountByLesson.has(lt.lessonSourceId)) teacherCountByLesson.set(lt.lessonSourceId, new Set());
    teacherCountByLesson.get(lt.lessonSourceId)!.add(lt.teacherSourceId);
  }
  for (const lc of data.lessonClasses) {
    if (!classCountByLesson.has(lc.lessonSourceId)) classCountByLesson.set(lc.lessonSourceId, new Set());
    classCountByLesson.get(lc.lessonSourceId)!.add(lc.classSourceId);
  }

  for (const a of data.assignments) {
    if (!cardKeys.has(a.sourceCardKey)) errors.push(`assignments: tanımsız card referansı: ${a.sourceCardKey}`);
    if (!lessonIds.has(a.lessonSourceId)) errors.push(`assignments: tanımsız lesson referansı: ${a.lessonSourceId}`);
    if (!teacherIds.has(a.teacherSourceId)) errors.push(`assignments: tanımsız teacher referansı: ${a.teacherSourceId}`);
    if (!classIds.has(a.classSourceId)) errors.push(`assignments: tanımsız class referansı: ${a.classSourceId}`);
    if (!dayIds.has(a.daySourceId)) errors.push(`assignments: tanımsız day referansı: ${a.daySourceId}`);
    if (!periodIds.has(a.periodSourceId)) errors.push(`assignments: tanımsız period referansı: ${a.periodSourceId}`);
    if (a.subjectSourceId !== null && !subjectIds.has(a.subjectSourceId)) {
      errors.push(`assignments: tanımsız subject referansı: ${a.subjectSourceId}`);
    }

    // mapping_status, o lesson için bilinen öğretmen/sınıf çokluğuyla tutarlı olmalı.
    const teacherCount = teacherCountByLesson.get(a.lessonSourceId)?.size ?? 0;
    const classCount = classCountByLesson.get(a.lessonSourceId)?.size ?? 0;
    const expected = teacherCount > 1 && classCount > 1 ? "ambiguous" : teacherCount > 1 || classCount > 1 ? "expanded" : "exact";
    if (a.mappingStatus !== expected) {
      errors.push(
        `assignments: hatalı mapping_status (lesson=${a.lessonSourceId}): gönderilen "${a.mappingStatus}", beklenen "${expected}"`,
      );
    }
  }

  if (data.normalizedAssignmentCount !== data.assignments.length) {
    errors.push(
      `normalizedAssignmentCount (${data.normalizedAssignmentCount}) assignments dizisinin uzunluğuyla (${data.assignments.length}) uyuşmuyor.`,
    );
  }
  if (data.sourceCardCount < data.cards.length) {
    errors.push(`sourceCardCount (${data.sourceCardCount}) cards dizisinin uzunluğundan (${data.cards.length}) küçük olamaz.`);
  }

  if (data.validationIssues.some((i) => i.severity === "error")) {
    errors.push("Kritik doğrulama hatası içeren XML kaydedilemez.");
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data };
}
