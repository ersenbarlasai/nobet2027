import type {
  DayDef,
  LessonClassLink,
  LessonTeacherLink,
  PeriodDef,
  RawCard,
  RawLesson,
  ScheduleEntry,
  SchoolClass,
  Subject,
  Teacher,
  ValidationIssue,
} from "./types";

/**
 * aSc Timetables XML dışa aktarım biçimi için adaptör.
 *
 * Gerçek örnek dosyada (xml/asc.xml) doğrulanan şema:
 *   <timetable> kök elemanı, alt koleksiyonlar:
 *   periods, daysdefs, weeksdefs, termsdefs, subjects, teachers,
 *   buildings, classrooms, grades, classes, groups, lessons, cards.
 *
 *   - <teacher id name .../>                         → Öğretmen
 *   - <class id name grade .../>                      → Sınıf
 *   - <period period name starttime endtime .../>      → Ders saati (period sayısal id)
 *   - <daysdef id name days="10000".../>               → Gün tanımı; "days" 5 haneli
 *     bit dizisi (Pzt-Cum). Tek bit içeren daysdef'ler gerçek günlerdir;
 *     "Herhangi Bir Gün" / "Her Gün" gibi çok-bitli meta tanımlar günden sayılmaz.
 *   - <subject id name short.../>                      → Ders/branş.
 *   - <lesson id subjectid classids teacherids groupids .../> → Ders tanımı;
 *     classids/teacherids virgülle ayrılmış birden çok id içerebilir.
 *   - <card lessonid period days.../>                   → Bir lessonid'in belirli bir
 *     gün+saate yerleştirilmesi; days burada da tek-bitli bir bitmask'tir.
 *
 * Bu adaptör hem ham koleksiyonları (subjects, lessons, lessonTeachers,
 * lessonClasses, cards) hem normalize atama satırlarını (scheduleEntries)
 * üretir — ikisi de kaynak XML'e izlenebilir kalır (sourceLessonId/sourceCardId).
 *
 * Bir atama satırı (ScheduleEntry) = geçerli bir <card> için, ilişkili
 * <lesson>'ın (yalnızca tanımlı referanslara filtrelenmiş) teacherIds ×
 * classIds kartezyen birleşimi. Bu kartezyen varsayım, hem öğretmen hem
 * sınıf çoklu olduğunda (ör. kulüp saatleri) kesin doğrulanamaz — bkz.
 * AMBIGUOUS_CARTESIAN_MAPPING ve ScheduleEntry.mappingStatus.
 */

export const ASC_FORMAT_ID = "asc-timetables";
export const ASC_FORMAT_LABEL = "aSc Timetables XML";

export function isAscTimetableDocument(doc: Document): boolean {
  return doc.documentElement?.tagName === "timetable";
}

function attr(el: Element, name: string): string {
  return el.getAttribute(name)?.trim() ?? "";
}

function splitIds(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((v) => v && v.length > 0);
}

interface CollectResult<T> {
  items: T[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

function normalizeTeachers(doc: Document): CollectResult<Teacher> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const seen = new Set<string>();
  const items: Teacher[] = [];

  const els = Array.from(doc.getElementsByTagName("teacher"));
  for (const el of els) {
    const id = attr(el, "id");
    const name = attr(el, "name");
    if (!id || !name) {
      warnings.push({
        code: "MISSING_REQUIRED_FIELD",
        message: `Kimlik veya ad bilgisi eksik öğretmen kaydı atlandı (id="${id}").`,
      });
      continue;
    }
    if (seen.has(id)) {
      errors.push({ code: "DUPLICATE_ID", message: `Yinelenen öğretmen kimliği: ${id}` });
      continue;
    }
    seen.add(id);
    items.push({ id, name });
  }
  return { items, errors, warnings };
}

function normalizeClasses(doc: Document, teacherIds: Set<string>): CollectResult<SchoolClass> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const seen = new Set<string>();
  const items: SchoolClass[] = [];

  const els = Array.from(doc.getElementsByTagName("class"));
  for (const el of els) {
    const id = attr(el, "id");
    const name = attr(el, "name");
    if (!id || !name) {
      warnings.push({
        code: "MISSING_REQUIRED_FIELD",
        message: `Kimlik veya ad bilgisi eksik sınıf kaydı atlandı (id="${id}").`,
      });
      continue;
    }
    if (seen.has(id)) {
      errors.push({ code: "DUPLICATE_ID", message: `Yinelenen sınıf kimliği: ${id}` });
      continue;
    }
    seen.add(id);
    const grade = attr(el, "grade");
    // <class teacherid="..."> — sınıfın SINIF ÖĞRETMENİ. Boş değer geçerli
    // bir durumdur (ör. anaokulu/kulüp şubelerinin sınıf öğretmeni olmayabilir).
    const teacherId = attr(el, "teacherid") || undefined;
    if (teacherId && !teacherIds.has(teacherId)) {
      // Sınıf sorumluluğu doğrudan bu ilişkiye bağlı olduğundan veri kaybı
      // sessizce kabul edilmez: importu engelleyen açık bir hata üretilir.
      errors.push({
        code: "UNDEFINED_CLASS_TEACHER_REF",
        message: `Sınıf (id=${id}) tanımsız bir sınıf öğretmeni (teacher id=${teacherId}) kaydına referans veriyor.`,
        affectedCount: 1,
        distinctReferenceCount: 1,
      });
      continue;
    }
    items.push({ id, name, grade: grade || undefined, teacherId });
  }
  return { items, errors, warnings };
}

function normalizePeriods(doc: Document): CollectResult<PeriodDef> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const seen = new Set<string>();
  const items: PeriodDef[] = [];

  const els = Array.from(doc.getElementsByTagName("period"));
  for (const el of els) {
    const id = attr(el, "period");
    const name = attr(el, "name") || id;
    if (!id) {
      warnings.push({ code: "MISSING_REQUIRED_FIELD", message: "Kimliği eksik ders saati kaydı atlandı." });
      continue;
    }
    if (seen.has(id)) {
      errors.push({ code: "DUPLICATE_ID", message: `Yinelenen ders saati kimliği: ${id}` });
      continue;
    }
    seen.add(id);
    const order = Number(id);
    items.push({
      id,
      name,
      order: Number.isFinite(order) ? order : items.length + 1,
      startTime: attr(el, "starttime") || undefined,
      endTime: attr(el, "endtime") || undefined,
    });
  }
  items.sort((a, b) => a.order - b.order);
  return { items, errors, warnings };
}

/** Tek-bitli days bitmask'ine sahip daysdef'leri gerçek gün olarak kabul eder. */
function normalizeDays(doc: Document): CollectResult<DayDef> & { bitPositionToDayId: Map<number, string> } {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const seen = new Set<string>();
  const items: DayDef[] = [];
  const bitPositionToDayId = new Map<number, string>();

  const els = Array.from(doc.getElementsByTagName("daysdef"));
  for (const el of els) {
    const id = attr(el, "id");
    const name = attr(el, "name");
    const days = attr(el, "days");
    if (!id || !name || !days) continue;
    if (days.includes(",")) continue; // "Herhangi Bir Gün" gibi çoklu-hafta meta tanımı
    const ones = [...days].reduce((count, ch) => count + (ch === "1" ? 1 : 0), 0);
    if (ones !== 1) continue; // "Her Gün" (11111) gibi tek gün olmayan tanım

    if (seen.has(id)) {
      errors.push({ code: "DUPLICATE_ID", message: `Yinelenen gün kimliği: ${id}` });
      continue;
    }
    seen.add(id);
    const position = days.indexOf("1") + 1;
    items.push({ id, name, order: position });
    bitPositionToDayId.set(position, id);
  }
  items.sort((a, b) => a.order - b.order);

  if (items.length === 0) {
    warnings.push({
      code: "MISSING_SECTION",
      message: "Tek güne karşılık gelen gün tanımı bulunamadı; gün sayısı güvenilir hesaplanamadı.",
    });
  }

  return { items, errors, warnings, bitPositionToDayId };
}

function normalizeSubjects(doc: Document): CollectResult<Subject> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const seen = new Set<string>();
  const items: Subject[] = [];

  const els = Array.from(doc.getElementsByTagName("subject"));
  for (const el of els) {
    const id = attr(el, "id");
    const name = attr(el, "name");
    if (!id || !name) {
      warnings.push({ code: "MISSING_REQUIRED_FIELD", message: `Kimlik veya ad bilgisi eksik ders kaydı atlandı (id="${id}").` });
      continue;
    }
    if (seen.has(id)) {
      errors.push({ code: "DUPLICATE_ID", message: `Yinelenen ders (subject) kimliği: ${id}` });
      continue;
    }
    seen.add(id);
    const shortName = attr(el, "short");
    items.push({ id, name, shortName: shortName || undefined });
  }
  return { items, errors, warnings };
}

interface LessonRecord {
  id: string;
  subjectId: string;
  classroomIds: string[];
}

interface LessonCollectResult {
  lessons: RawLesson[];
  recordById: Map<string, LessonRecord>;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

function normalizeLessons(doc: Document): LessonCollectResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const seen = new Set<string>();
  const lessons: RawLesson[] = [];
  const recordById = new Map<string, LessonRecord>();

  for (const el of Array.from(doc.getElementsByTagName("lesson"))) {
    const id = attr(el, "id");
    if (!id) {
      warnings.push({ code: "MISSING_REQUIRED_FIELD", message: "Kimliği eksik ders (lesson) kaydı atlandı." });
      continue;
    }
    if (seen.has(id)) {
      errors.push({ code: "DUPLICATE_ID", message: `Yinelenen ders (lesson) kimliği: ${id}` });
      continue;
    }
    seen.add(id);
    const subjectId = attr(el, "subjectid");
    lessons.push({ id, subjectId: subjectId || undefined, sourceGroupIds: splitIds(attr(el, "groupids")) });
    recordById.set(id, {
      id,
      subjectId,
      classroomIds: splitIds(attr(el, "classroomids")),
    });
  }

  return { lessons, recordById, errors, warnings };
}

/** Benzersiz hatalı kimlik sayısı ile bu hatadan etkilenen kayıt/card sayısını ayrı tutar. */
class RefIssueTracker {
  private uniqueIds = new Set<string>();
  private affectedCount = 0;

  record(id: string) {
    this.uniqueIds.add(id || "(boş)");
    this.affectedCount += 1;
  }

  get uniqueCount() {
    return this.uniqueIds.size;
  }

  get recordCount() {
    return this.affectedCount;
  }

  hasIssues() {
    return this.affectedCount > 0;
  }

  toIssue(code: ValidationIssue["code"], describeRecords: string): ValidationIssue {
    return {
      code,
      message: `${this.uniqueCount} benzersiz tanımsız kimliğe referans veren ${this.recordCount} ${describeRecords} atlandı.`,
      affectedCount: this.recordCount,
      distinctReferenceCount: this.uniqueCount,
    };
  }
}

interface LessonLinksResult {
  lessonTeachers: LessonTeacherLink[];
  lessonClasses: LessonClassLink[];
  teacherIdsByLesson: Map<string, string[]>;
  classIdsByLesson: Map<string, string[]>;
  warnings: ValidationIssue[];
}

/**
 * Her <lesson>'ın virgülle ayrılmış teacherids/classids listesini açar,
 * yalnızca tanımlı öğretmen/sınıf kimliklerine referans veren satırları
 * tutar (tanımsız referanslar burada, tek yerde, filtrelenir — kart bazlı
 * atama üretimi bu filtrelenmiş listeleri güvenle kullanır).
 */
function buildLessonLinks(
  doc: Document,
  teacherIds: Set<string>,
  classIds: Set<string>,
): LessonLinksResult {
  const warnings: ValidationIssue[] = [];
  const lessonTeachers: LessonTeacherLink[] = [];
  const lessonClasses: LessonClassLink[] = [];
  const teacherIdsByLesson = new Map<string, string[]>();
  const classIdsByLesson = new Map<string, string[]>();

  const undefinedTeacherRefs = new RefIssueTracker();
  const undefinedClassRefs = new RefIssueTracker();

  for (const el of Array.from(doc.getElementsByTagName("lesson"))) {
    const lessonId = attr(el, "id");
    if (!lessonId) continue;

    const teacherList: string[] = [];
    splitIds(attr(el, "teacherids")).forEach((teacherId, index) => {
      if (!teacherIds.has(teacherId)) {
        undefinedTeacherRefs.record(teacherId);
        return;
      }
      lessonTeachers.push({ lessonId, teacherId, sourceOrder: index + 1 });
      teacherList.push(teacherId);
    });
    teacherIdsByLesson.set(lessonId, teacherList);

    const classList: string[] = [];
    splitIds(attr(el, "classids")).forEach((classId, index) => {
      if (!classIds.has(classId)) {
        undefinedClassRefs.record(classId);
        return;
      }
      lessonClasses.push({ lessonId, classId, sourceOrder: index + 1 });
      classList.push(classId);
    });
    classIdsByLesson.set(lessonId, classList);
  }

  if (undefinedTeacherRefs.hasIssues()) {
    warnings.push(undefinedTeacherRefs.toIssue("UNDEFINED_TEACHER_REF", "lesson-öğretmen ilişkisi"));
  }
  if (undefinedClassRefs.hasIssues()) {
    warnings.push(undefinedClassRefs.toIssue("UNDEFINED_CLASS_REF", "lesson-sınıf ilişkisi"));
  }

  return { lessonTeachers, lessonClasses, teacherIdsByLesson, classIdsByLesson, warnings };
}

interface CardsAndAssignmentsResult {
  cards: RawCard[];
  assignments: ScheduleEntry[];
  sourceCardCount: number;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

function mappingStatusFor(teacherCount: number, classCount: number) {
  if (teacherCount > 1 && classCount > 1) return "ambiguous" as const;
  if (teacherCount > 1 || classCount > 1) return "expanded" as const;
  return "exact" as const;
}

function buildCardsAndAssignments(
  doc: Document,
  lessonRecords: Map<string, LessonRecord>,
  subjectNames: Map<string, string>,
  teacherIdsByLesson: Map<string, string[]>,
  classIdsByLesson: Map<string, string[]>,
  periodIds: Set<string>,
  bitPositionToDayId: Map<number, string>,
): CardsAndAssignmentsResult {
  const warnings: ValidationIssue[] = [];
  const cards: RawCard[] = [];
  const assignments: ScheduleEntry[] = [];

  const undefinedLessonRefs = new RefIssueTracker();
  const undefinedPeriodRefs = new RefIssueTracker();
  const undefinedDayRefs = new RefIssueTracker();

  const ambiguousLessonIds = new Set<string>();
  let ambiguousEntryCount = 0;

  const cardEls = Array.from(doc.getElementsByTagName("card"));
  let cardIndex = 0;

  for (const cardEl of cardEls) {
    cardIndex += 1;
    const lessonId = attr(cardEl, "lessonid");
    const period = attr(cardEl, "period");
    const days = attr(cardEl, "days");
    // Şemada <card> için açık bir id alanı yok; izlenebilirlik için sıra
    // numarasına dayalı sentetik ve bu ayrıştırma için kararlı bir kimlik üretiyoruz.
    const sourceCardId = `card-${cardIndex}`;

    const lesson = lessonRecords.get(lessonId);
    if (!lesson) {
      undefinedLessonRefs.record(lessonId);
      continue;
    }

    if (!period || !periodIds.has(period)) {
      undefinedPeriodRefs.record(period);
      continue;
    }

    const bitPosition = days.indexOf("1");
    const dayId = bitPosition >= 0 ? bitPositionToDayId.get(bitPosition + 1) : undefined;
    if (!dayId) {
      undefinedDayRefs.record(days);
      continue;
    }

    cards.push({
      id: sourceCardId,
      sourceIndex: cardIndex,
      lessonId,
      dayId,
      periodId: period,
      classroomSourceIds: splitIds(attr(cardEl, "classroomids")),
    });

    const classroom = firstNonEmpty(attr(cardEl, "classroomids"), lesson.classroomIds[0]);
    const lessonName = subjectNames.get(lesson.subjectId);

    const teachers = teacherIdsByLesson.get(lessonId) ?? [];
    const classes = classIdsByLesson.get(lessonId) ?? [];
    const status = mappingStatusFor(teachers.length, classes.length);
    const isAmbiguous = status === "ambiguous";

    for (const teacherId of teachers) {
      for (const classId of classes) {
        if (isAmbiguous) {
          ambiguousLessonIds.add(lessonId);
          ambiguousEntryCount += 1;
        }
        assignments.push({
          id: `${lessonId}-${cardIndex}-${teacherId}-${classId}`,
          teacherId,
          classId,
          dayId,
          periodId: period,
          lessonName,
          classroom,
          sourceLessonId: lessonId,
          sourceCardId,
          mappingStatus: status,
        });
      }
    }
  }

  if (undefinedLessonRefs.hasIssues()) {
    warnings.push(undefinedLessonRefs.toIssue("UNDEFINED_LESSON_REF", "plan kartı"));
  }
  if (undefinedPeriodRefs.hasIssues()) {
    warnings.push(undefinedPeriodRefs.toIssue("UNDEFINED_PERIOD_REF", "plan kartı"));
  }
  if (undefinedDayRefs.hasIssues()) {
    warnings.push(undefinedDayRefs.toIssue("UNDEFINED_DAY_REF", "plan kartı"));
  }
  if (ambiguousLessonIds.size > 0) {
    warnings.push({
      code: "AMBIGUOUS_CARTESIAN_MAPPING",
      message: `${ambiguousLessonIds.size} ders kaydı hem birden çok öğretmene hem birden çok sınıfa aynı anda referans veriyor (ör. kulüp/ortak etkinlik saatleri). Bu ${ambiguousEntryCount} atama kaydı, öğretmen×sınıf kartezyen (çarpım) varsayımıyla üretildi; gerçek eşleşme XML'den kesin doğrulanamıyor.`,
      affectedCount: ambiguousEntryCount,
      distinctReferenceCount: ambiguousLessonIds.size,
    });
  }

  return { cards, assignments, sourceCardCount: cardEls.length, errors: [], warnings };
}

export interface AscParseResult {
  teachers: Teacher[];
  classes: SchoolClass[];
  days: DayDef[];
  periods: PeriodDef[];
  subjects: Subject[];
  lessons: RawLesson[];
  lessonTeachers: LessonTeacherLink[];
  lessonClasses: LessonClassLink[];
  cards: RawCard[];
  scheduleEntries: ScheduleEntry[];
  sourceCardCount: number;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

const REQUIRED_SECTIONS = ["teachers", "classes", "periods", "lessons", "cards"];

const EMPTY_RESULT: Omit<AscParseResult, "errors" | "warnings"> = {
  teachers: [],
  classes: [],
  days: [],
  periods: [],
  subjects: [],
  lessons: [],
  lessonTeachers: [],
  lessonClasses: [],
  cards: [],
  scheduleEntries: [],
  sourceCardCount: 0,
};

export function parseAscTimetable(doc: Document): AscParseResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  for (const tag of REQUIRED_SECTIONS) {
    if (doc.getElementsByTagName(tag).length === 0) {
      errors.push({ code: "MISSING_SECTION", message: `Gerekli veri bölümü bulunamadı: <${tag}>.` });
    }
  }
  if (errors.length > 0) {
    return { ...EMPTY_RESULT, errors, warnings };
  }

  const teacherResult = normalizeTeachers(doc);
  const teacherIds = new Set(teacherResult.items.map((t) => t.id));
  const classResult = normalizeClasses(doc, teacherIds);
  const periodResult = normalizePeriods(doc);
  const dayResult = normalizeDays(doc);
  const subjectResult = normalizeSubjects(doc);
  const lessonResult = normalizeLessons(doc);

  const classIds = new Set(classResult.items.map((c) => c.id));
  const periodIds = new Set(periodResult.items.map((p) => p.id));
  const subjectNames = new Map(subjectResult.items.map((s) => [s.id, s.name]));

  const linksResult = buildLessonLinks(doc, teacherIds, classIds);

  const cardsResult = buildCardsAndAssignments(
    doc,
    lessonResult.recordById,
    subjectNames,
    linksResult.teacherIdsByLesson,
    linksResult.classIdsByLesson,
    periodIds,
    dayResult.bitPositionToDayId,
  );

  errors.push(
    ...teacherResult.errors,
    ...classResult.errors,
    ...periodResult.errors,
    ...dayResult.errors,
    ...subjectResult.errors,
    ...lessonResult.errors,
    ...cardsResult.errors,
  );
  warnings.push(
    ...teacherResult.warnings,
    ...classResult.warnings,
    ...periodResult.warnings,
    ...dayResult.warnings,
    ...subjectResult.warnings,
    ...lessonResult.warnings,
    ...linksResult.warnings,
    ...cardsResult.warnings,
  );

  if (cardsResult.assignments.length === 0) {
    errors.push({
      code: "NO_SCHEDULE_ENTRIES",
      message: "XML dosyasında hiç atama kaydı (öğretmen-sınıf eşleşmesi) bulunamadı.",
    });
  }

  return {
    teachers: teacherResult.items,
    classes: classResult.items,
    days: dayResult.items,
    periods: periodResult.items,
    subjects: subjectResult.items,
    lessons: lessonResult.lessons,
    lessonTeachers: linksResult.lessonTeachers,
    lessonClasses: linksResult.lessonClasses,
    cards: cardsResult.cards,
    scheduleEntries: cardsResult.assignments,
    sourceCardCount: cardsResult.sourceCardCount,
    errors,
    warnings,
  };
}
