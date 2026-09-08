import { EXAM_SCOPE_LABELS, type ExamAssignment, type ExamPlanDetail, type ExamScope, type ExamScopeCode, type ExamScopeListStatus, type ExamSession } from "./types";

/**
 * Tamamlanmış plan görüntüleme, yazdırma ve XLSX çıktısı aynı görünüm
 * modelini paylaşır. Buradaki hiçbir fonksiyon ağ isteği yapmaz ve güncel
 * öğretmen/sınıf/ders saati tablolarına bakmaz: yalnız plan detayındaki
 * TARİHSEL SNAPSHOT alanları kullanılır (`teacherName`, `schoolClassName`,
 * `periodName`, `examDate`). Sonraki bir XML importu bu çıktıyı değiştirmez.
 */
export type FoundExamPlan = Extract<ExamPlanDetail, { found: true }>;

/** Sınıfsız (20260929 öncesi) oturumlarda tarih plan tarihine düşer. */
export function sessionExamDate(session: ExamSession, planExamDate: string): string {
  return session.examDate ?? planExamDate;
}

export function scopeExamDates(scope: ExamScope, planExamDate: string): string[] {
  return Array.from(new Set(scope.sessions.map((session) => sessionExamDate(session, planExamDate)))).filter(Boolean).sort();
}

export function planExamDates(plan: FoundExamPlan): string[] {
  return Array.from(new Set(plan.scopes.flatMap((scope) => scope.sessions.map((session) => sessionExamDate(session, plan.examDate))))).filter(Boolean).sort();
}

/**
 * Okul grubu durumu ve planın genel durumu SUNUCUDAN gelir (RPC alanları
 * `listStatus` / `overallStatus`). Kural burada yeniden kurulmaz; alan
 * eksikse yalnız eski cevaplara karşı güvenli bir yedek kullanılır.
 */
export function scopeListStatus(scope: ExamScope): ExamScopeListStatus {
  return scope.listStatus ?? (scope.sessions.length === 0 ? "not_planned" : scope.status);
}

export function planIsCompleted(plan: FoundExamPlan): boolean {
  return plan.overallStatus === "completed";
}

/** Tamamlanmış bir okul grubu bir daha düzenlenemez. */
export function scopeIsReadOnly(plan: FoundExamPlan, scope: ExamScope): boolean {
  return planIsCompleted(plan) || scope.status === "completed";
}

export interface MatrixPeriod { periodOrder: number; periodName: string; startsAt: string | null; endsAt: string | null }
export interface MatrixRow { key: string; label: string; cells: (ExamSession | null)[] }
export interface ScopeDayMatrix { examDate: string; periods: MatrixPeriod[]; rows: MatrixRow[] }

/** Sınav yapılmayan sınıf–saat kesişimi `null` döner; arayüz ve XLSX bunu "—" yazar. */
export const EMPTY_CELL = "—";

export function buildScopeDayMatrix(scope: ExamScope, examDate: string, planExamDate: string): ScopeDayMatrix {
  const sessions = scope.sessions.filter((session) => sessionExamDate(session, planExamDate) === examDate);
  const periods = Array.from(new Map(sessions.map((session) => [session.periodOrder, {
    periodOrder: session.periodOrder, periodName: session.periodName, startsAt: session.startsAt, endsAt: session.endsAt,
  }])).values()).sort((a, b) => a.periodOrder - b.periodOrder);

  const classKeys = Array.from(new Map(sessions.map((session) => {
    const key = session.schoolClassId ?? `legacy:${session.id}`;
    const label = session.schoolClassName ?? session.schoolClassSourceId ?? "Genel oturum";
    return [key, label] as const;
  })).entries()).sort((a, b) => a[1].localeCompare(b[1], "tr"));

  const rows: MatrixRow[] = classKeys.map(([key, label]) => ({
    key,
    label,
    cells: periods.map((period) => sessions.find((session) =>
      (session.schoolClassId ?? `legacy:${session.id}`) === key && session.periodOrder === period.periodOrder) ?? null),
  }));

  return { examDate, periods, rows };
}

export function cellTeacherName(session: ExamSession | null): string {
  if (!session) return EMPTY_CELL;
  const assignment = session.assignments.find((item) => item.slotNumber === 1) ?? session.assignments[0];
  return assignment?.teacherName ?? EMPTY_CELL;
}

export interface TeacherDutyRow {
  assignmentId: string;
  teacherName: string;
  teacherSourceId: string;
  scopeCode: ExamScopeCode;
  scopeLabel: string;
  className: string;
  examDate: string;
  periodName: string;
  periodTime: string;
  dutyWarningText: string;
  dutyCoverageNote: string;
  assignment: ExamAssignment;
  session: ExamSession;
}

function timeRange(session: ExamSession): string {
  const start = session.startsAt?.slice(0, 5);
  const end = session.endsAt?.slice(0, 5);
  if (!start && !end) return EMPTY_CELL;
  return end ? `${start ?? ""}–${end}` : (start ?? EMPTY_CELL);
}

export function teacherDutyRows(plan: FoundExamPlan): TeacherDutyRow[] {
  return plan.scopes.flatMap((scope) => scope.sessions.flatMap((session) => session.assignments.map((assignment) => ({
    assignmentId: assignment.id,
    teacherName: assignment.teacherName,
    teacherSourceId: assignment.teacherSourceId,
    scopeCode: scope.scopeCode,
    scopeLabel: EXAM_SCOPE_LABELS[scope.scopeCode],
    className: session.schoolClassName ?? session.schoolClassSourceId ?? "Genel oturum",
    examDate: sessionExamDate(session, plan.examDate),
    periodName: session.periodName,
    periodTime: timeRange(session),
    dutyWarningText: assignment.dutyWarning?.length
      ? assignment.dutyWarning.map((warning) => `${warning.locationName} · ${warning.coverageMode}`).join(", ")
      : EMPTY_CELL,
    dutyCoverageNote: assignment.dutyCoverageNote ?? EMPTY_CELL,
    assignment,
    session,
  })))).sort((a, b) =>
    a.teacherName.localeCompare(b.teacherName, "tr")
    || a.examDate.localeCompare(b.examDate)
    || a.session.periodOrder - b.session.periodOrder);
}

export interface TeacherSummaryRow {
  teacherSourceId: string;
  teacherName: string;
  totalCount: number;
  middleCount: number;
  highCount: number;
  scopeCounts: Partial<Record<ExamScopeCode, number>>;
  warningCount: number;
  dates: string[];
}

/** Öğretmen bazlı gözetmenlik özeti — atama satırlarından türetilir. */
export function teacherSummaryRows(plan: FoundExamPlan): TeacherSummaryRow[] {
  const map = new Map<string, TeacherSummaryRow>();
  for (const row of teacherDutyRows(plan)) {
    const existing = map.get(row.teacherSourceId) ?? {
      teacherSourceId: row.teacherSourceId, teacherName: row.teacherName,
      totalCount: 0, middleCount: 0, highCount: 0, scopeCounts: {}, warningCount: 0, dates: [],
    };
    existing.totalCount += 1;
    if (row.scopeCode === "MIDDLE_SCHOOL") existing.middleCount += 1;
    if (row.scopeCode === "HIGH_SCHOOL") existing.highCount += 1;
    existing.scopeCounts[row.scopeCode] = (existing.scopeCounts[row.scopeCode] ?? 0) + 1;
    if (row.assignment.dutyWarning?.length) existing.warningCount += 1;
    if (!existing.dates.includes(row.examDate)) existing.dates.push(row.examDate);
    map.set(row.teacherSourceId, existing);
  }
  return Array.from(map.values())
    .map((row) => ({ ...row, dates: [...row.dates].sort() }))
    .sort((a, b) => b.totalCount - a.totalCount || a.teacherName.localeCompare(b.teacherName, "tr"));
}
