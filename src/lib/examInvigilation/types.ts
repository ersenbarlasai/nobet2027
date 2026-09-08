export type ExamScopeCode = "PRESCHOOL" | "PRIMARY_SCHOOL" | "MIDDLE_SCHOOL" | "HIGH_SCHOOL" | "OTHER";
export type ExamScopeStatus = "draft" | "completed";

export interface ExamPeriod { periodOrder: number; name: string; startsAt: string | null; endsAt: string | null }
export interface ExamSchoolClass { id: string; sourceId: string; name: string; grade: string | null }
export interface ExamPublishedWeek { planId: string; weekStartDate: string; version: number }
export interface ExamPreparation { hasImport: boolean; teacherCount?: number; periods: ExamPeriod[]; classes: ExamSchoolClass[]; publishedWeeks: ExamPublishedWeek[] }

/** Oturumu olmayan okul grubu "planlanmadı"dır; taslak/tamamlandı ile karıştırılmaz. */
export type ExamScopeListStatus = "not_planned" | ExamScopeStatus;
export type ExamPlanOverallStatus = "draft" | "completed";
export type ExamPlanStatusFilter = "all" | "draft" | "completed" | "stale";
export type ExamPlanSort = "newest" | "oldest";

export interface ExamPlanListScope {
  scopeCode: ExamScopeCode;
  status: ExamScopeListStatus;
  rawStatus: ExamScopeStatus;
  planned: boolean;
  version: number;
  completedAt: string | null;
  sessionCount: number;
  requiredCount: number;
  assignedCount: number;
  openCount: number;
  warningCount: number;
}
export interface ExamPlanListItem {
  id: string;
  name: string;
  weekStartDate: string;
  examDate: string;
  examDates: string[];
  createdAt: string;
  updatedAt: string;
  isStale: boolean;
  overallStatus: ExamPlanOverallStatus;
  requiredCount: number;
  assignedCount: number;
  openCount: number;
  dutyWarningCount: number;
  scopes: ExamPlanListScope[];
}
export interface ExamPlanList { items: ExamPlanListItem[] }
export interface ExamPlanListFilters {
  status?: ExamPlanStatusFilter;
  scopeCode?: ExamScopeCode | null;
  search?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  sort?: ExamPlanSort;
}

export const EXAM_SCOPE_LIST_STATUS_LABELS: Record<ExamScopeListStatus, string> = {
  not_planned: "Planlanmadı",
  draft: "Taslak",
  completed: "Tamamlandı",
};

export interface DutyWarning { packageId: string; locationName: string; coverageMode: string }
export interface ExamAssignment { id: string; slotNumber: number; teacherSourceId: string; teacherName: string; dutyWarning: DutyWarning[] | null; dutyCoverageAcknowledged: boolean; dutyCoverageNote: string | null }
export interface ExamSession { id: string; examDate?: string; schoolClassId?: string | null; schoolClassSourceId?: string | null; schoolClassName?: string | null; periodOrder: number; periodName: string; startsAt: string | null; endsAt: string | null; requiredCount: number; assignments: ExamAssignment[] }
export interface ExamScope { id: string; scopeCode: ExamScopeCode; status: ExamScopeStatus; listStatus: ExamScopeListStatus; sessionCount: number; version: number; completedAt: string | null; sessions: ExamSession[] }
/** `overallStatus` ve `listStatus` sunucudan gelir; istemci tamamlanma kuralını yeniden kurmaz. */
export type ExamPlanDetail = { found: false } | { found: true; id: string; name: string; weekStartDate: string; examDate: string; timetableImportId: string; dutyPlanId: string; campusName: string; academicYearName: string; sourceFingerprint: string; isStale: boolean; overallStatus: ExamPlanOverallStatus; createdAt: string; updatedAt: string; scopes: ExamScope[] };

export interface ExamCandidate { teacherSourceId: string; teacherName: string; branch: string | null; dailyLessonCount: number; previousInvigilationCount: number; weeklyDutyPoints: number; suitability: "direct" | "duty_coverage_required"; dutyWarnings: DutyWarning[] }
export interface ExamCandidates { found: true; sessionFound: true; scopeVersion: number; isStale: boolean; candidates: ExamCandidate[]; excludedCounts: { lessonConflict: number; otherScope: number; otherSession: number } }

export interface CreateExamSessionSpec { scopeCode: ExamScopeCode; examDate: string; periodOrder: number; schoolClassIds: string[]; requiredCount: number }
export interface CreateExamPlanInput { name: string; weekStartDate: string; sessions: CreateExamSessionSpec[] }
export interface SetExamAssignmentInput { slotNumber: number; teacherSourceId: string | null; expectedScopeVersion: number; dutyCoverageAcknowledged?: boolean; dutyCoverageNote?: string | null }

export class ExamInvigilationApiError extends Error {
  status: string;
  details: Record<string, unknown>;
  constructor(status: string, message: string, details: Record<string, unknown> = {}) { super(message); this.status = status; this.details = details; }
}

export const EXAM_SCOPE_LABELS: Record<ExamScopeCode,string> = {
  PRESCHOOL: "Okul öncesi",
  PRIMARY_SCHOOL: "İlkokul",
  MIDDLE_SCHOOL: "Ortaokul",
  HIGH_SCHOOL: "Lise",
  OTHER: "Diğer",
};
export const EXAM_SCOPE_ORDER: ExamScopeCode[] = ["PRESCHOOL", "PRIMARY_SCHOOL", "MIDDLE_SCHOOL", "HIGH_SCHOOL", "OTHER"];
