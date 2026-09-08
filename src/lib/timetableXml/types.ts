// Ders programı XML içe aktarımının normalize edilmiş veri modeli.
// Ham XML düğümleri asla doğrudan bu tiplere aktarılmaz; aday alanlar
// önce doğrulanır, sonra bu ortak yapıya dönüştürülür.

export interface Teacher {
  id: string;
  name: string;
  branch?: string;
}

export interface SchoolClass {
  id: string;
  name: string;
  grade?: string;
  /** Kaynak XML <class teacherid> referansı — sınıfın SINIF ÖĞRETMENİ. Boş teacherid="" → undefined. */
  teacherId?: string;
}

export interface DayDef {
  id: string;
  name: string;
  order: number;
}

export interface PeriodDef {
  id: string;
  name: string;
  order: number;
  startTime?: string;
  endTime?: string;
}

export interface Subject {
  id: string;
  name: string;
  shortName?: string;
}

/** Ham XML <lesson> kaydı. Öğretmen/sınıf ilişkileri ayrı koleksiyonlardadır (bkz. LessonTeacherLink/LessonClassLink). */
export interface RawLesson {
  id: string;
  subjectId?: string;
  /** Ham <lesson groupids="..."> değeri; kayıpsız saklanır, henüz tüketilmiyor. */
  sourceGroupIds: string[];
}

export interface LessonTeacherLink {
  lessonId: string;
  teacherId: string;
  /** XML'deki virgülle ayrılmış teacherids listesindeki 1-tabanlı sıra. */
  sourceOrder: number;
}

export interface LessonClassLink {
  lessonId: string;
  classId: string;
  /** XML'deki virgülle ayrılmış classids listesindeki 1-tabanlı sıra. */
  sourceOrder: number;
}

/** Ham XML <card> kaydı: bir lesson'ın belirli bir gün+ders saatine yerleşimi. */
export interface RawCard {
  id: string;
  /** XML'deki tüm <card> elemanları arasında 1-tabanlı sıra (geçersiz kartlar dahil, sayaç kayması olmaz). */
  sourceIndex: number;
  lessonId: string;
  dayId: string;
  periodId: string;
  classroomSourceIds: string[];
}

export type AssignmentMappingStatus = "exact" | "expanded" | "ambiguous";

export interface ScheduleEntry {
  id: string;
  teacherId: string;
  classId: string;
  dayId: string;
  periodId: string;
  lessonName?: string;
  classroom?: string;
  /** Bu atama kaydının üretildiği ham <lesson> kimliği (izlenebilirlik). */
  sourceLessonId: string;
  /** Bu atama kaydının üretildiği ham <card> kaydının sentetik kimliği (izlenebilirlik). */
  sourceCardId: string;
  /**
   * exact: lesson'da tek öğretmen + tek sınıf. expanded: yalnız biri çoklu.
   * ambiguous: hem öğretmen hem sınıf çoklu — kartezyen çarpım varsayımı
   * XML'den kesin doğrulanamaz (bkz. AMBIGUOUS_CARTESIAN_MAPPING uyarısı).
   */
  mappingStatus: AssignmentMappingStatus;
}

export type ValidationIssueCode =
  | "FILE_UNREADABLE"
  | "FILE_EMPTY"
  | "XML_MALFORMED"
  | "UNSUPPORTED_STRUCTURE"
  | "MISSING_SECTION"
  | "DUPLICATE_ID"
  | "UNDEFINED_LESSON_REF"
  | "UNDEFINED_TEACHER_REF"
  | "UNDEFINED_CLASS_REF"
  | "UNDEFINED_DAY_REF"
  | "UNDEFINED_PERIOD_REF"
  | "UNDEFINED_CLASS_TEACHER_REF"
  | "MISSING_REQUIRED_FIELD"
  | "NO_SCHEDULE_ENTRIES"
  | "STAT_UNRELIABLE"
  | "AMBIGUOUS_CARTESIAN_MAPPING";

export type ValidationIssueSeverity = "error" | "warning" | "info";

export interface ValidationIssue {
  code: ValidationIssueCode;
  message: string;
  /** Bu sorundan etkilenen kayıt/kart sayısı (benzersiz kimlik sayısıyla KARIŞTIRILMAMALI). */
  affectedCount?: number;
  /** Bu soruna yol açan benzersiz geçersiz kaynak kimliği sayısı. */
  distinctReferenceCount?: number;
}

export interface ImportMetadata {
  fileName?: string;
  fileSizeBytes?: number;
  rootTag?: string;
  formatId?: string;
  formatLabel?: string;
}

export interface TimetableImportStats {
  teacherCount: number | null;
  classCount: number | null;
  dayCount: number | null;
  periodCount: number | null;
  /** Ham XML'deki <card> (plan kartı) sayısı — bir card, bir lesson'ın belirli gün+saate yerleşimidir. */
  sourceCardCount: number | null;
  /**
   * Normalize edilmiş öğretmen-sınıf atama satırı sayısı. Bir card, ilişkili
   * lesson'ın teacherIds × classIds kombinasyonuna göre birden çok atama
   * kaydına açılabildiği için bu sayı sourceCardCount'tan büyük olabilir.
   */
  scheduleEntryCount: number | null;
}

export interface TimetableImportResult {
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
  stats: TimetableImportStats;
  validationErrors: ValidationIssue[];
  validationWarnings: ValidationIssue[];
  metadata: ImportMetadata;
  /** Kritik hata yok: önizleme gösterilebilir, "Verileri Onayla" etkin olabilir. */
  isValid: boolean;
}
