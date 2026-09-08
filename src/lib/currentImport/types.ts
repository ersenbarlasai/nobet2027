export interface CurrentImportSummary {
  sourceFilename: string;
  status: string;
  campusName: string;
  academicYearName: string;
  /** ISO-8601 UTC zaman damgası; biçimlendirme yalnızca UI katmanında yapılır. */
  importedAt: string;
  teacherCount: number;
  classCount: number;
  dayCount: number;
  periodCount: number;
  sourceCardCount: number;
  normalizedAssignmentCount: number;
  hasCountMismatch?: boolean;
}

export interface CurrentImportSnapshot {
  hasImport: boolean;
  import: CurrentImportSummary | null;
}
