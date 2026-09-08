import { ASC_FORMAT_ID, ASC_FORMAT_LABEL, isAscTimetableDocument, parseAscTimetable } from "./ascAdapter";
import type { TimetableImportResult, ValidationIssue } from "./types";

function emptyResult(
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
  metadata: TimetableImportResult["metadata"],
): TimetableImportResult {
  return {
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
    stats: {
      teacherCount: null,
      classCount: null,
      dayCount: null,
      periodCount: null,
      sourceCardCount: null,
      scheduleEntryCount: null,
    },
    validationErrors: errors,
    validationWarnings: warnings,
    metadata,
    isValid: false,
  };
}

/** Dosya okunamadığında (ör. arrayBuffer() hatası) kullanılacak sonuç. */
export function buildUnreadableFileResult(fileName?: string): TimetableImportResult {
  return emptyResult(
    [{ code: "FILE_UNREADABLE", message: "Dosya okunamadı." }],
    [],
    { fileName },
  );
}

/**
 * XML metnini alır, güvenli biçimde ayrıştırır, tanınan şemaya göre
 * normalize eder ve doğrulama sonuçlarıyla birlikte döner.
 *
 * Saf fonksiyondur: DOM ve tarayıcının yerleşik DOMParser'ı dışında
 * dış bağımlılık kullanmaz, ağ isteği yapmaz, hiçbir içeriği innerHTML
 * ile basmaz.
 */
export function parseTimetableXml(xmlText: string, fileName?: string): TimetableImportResult {
  const baseMetadata = { fileName };

  if (xmlText.trim().length === 0) {
    return emptyResult(
      [{ code: "FILE_EMPTY", message: "Seçilen dosya boş." }],
      [],
      baseMetadata,
    );
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");

  const parserError = doc.getElementsByTagName("parsererror")[0];
  if (parserError) {
    return emptyResult(
      [{ code: "XML_MALFORMED", message: "XML biçimi geçersiz: dosya doğru bir XML sözdizimine sahip değil." }],
      [],
      baseMetadata,
    );
  }

  const rootTag = doc.documentElement?.tagName;
  if (!rootTag) {
    return emptyResult(
      [{ code: "XML_MALFORMED", message: "XML biçimi geçersiz: kök eleman bulunamadı." }],
      [],
      baseMetadata,
    );
  }

  const metadata = { ...baseMetadata, rootTag };

  if (isAscTimetableDocument(doc)) {
    const parsed = parseAscTimetable(doc);
    const isValid = parsed.errors.length === 0;

    return {
      teachers: parsed.teachers,
      classes: parsed.classes,
      days: parsed.days,
      periods: parsed.periods,
      subjects: parsed.subjects,
      lessons: parsed.lessons,
      lessonTeachers: parsed.lessonTeachers,
      lessonClasses: parsed.lessonClasses,
      cards: parsed.cards,
      scheduleEntries: parsed.scheduleEntries,
      stats: {
        teacherCount: parsed.teachers.length,
        classCount: parsed.classes.length,
        dayCount: parsed.days.length > 0 ? parsed.days.length : null,
        periodCount: parsed.periods.length,
        sourceCardCount: parsed.sourceCardCount,
        scheduleEntryCount: parsed.scheduleEntries.length,
      },
      validationErrors: parsed.errors,
      validationWarnings:
        parsed.days.length === 0
          ? [...parsed.warnings, { code: "STAT_UNRELIABLE", message: "Gün sayısı XML'den güvenilir biçimde tespit edilemedi." }]
          : parsed.warnings,
      metadata: { ...metadata, formatId: ASC_FORMAT_ID, formatLabel: ASC_FORMAT_LABEL },
      isValid,
    };
  }

  return emptyResult(
    [
      {
        code: "UNSUPPORTED_STRUCTURE",
        message: `Desteklenmeyen XML yapısı: kök eleman "<${rootTag}>" tanınan hiçbir ders programı şemasıyla eşleşmiyor.`,
      },
    ],
    [],
    metadata,
  );
}
