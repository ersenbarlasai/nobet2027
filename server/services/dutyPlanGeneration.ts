import type { SupabaseClient } from "@supabase/supabase-js";
import type { DutyBlockCode, DutyBlockDto } from "./dutyBlocks";
import type { DutyPlanFeasibility } from "./dutyPlanFeasibility";
import { fetchDutyPlanDraft } from "./dutyPlanDrafts";
import {
  normalizeGenerationOptions,
  DutyPlanSolverOptionsError,
  type GenerationOptions,
  type SolverTeacherLoad,
} from "../lib/dutyPlanning/solver";
import { fetchTeacherLessonPeriodCounts } from "./teacherLessonLoad";
import {
  type V3CapacityAnalysis,
  type V3LockedViolation,
  type V3SolverInput,
  type V3LoadUnits,
  type V3TeacherCapacity,
} from "../lib/dutyPlanning/solverV3";
import {
  DUTY_PLAN_SOLVER_V4_VERSION,
  solveDutyPlanV4,
  type V4Input,
  type V4LockedPackage,
  type V4Result,
} from "../lib/dutyPlanning/solverV4";

/** v1 = hücre-bazlı; v2 = FULL_DAY/SHORT_BREAKS/SINGLE_BLOCK hibriti; v3 = yalnız SINGLE_BLOCK. */
/**
 * ÜRETİM sürümü. v4 ⇒ yalnız TENEFFÜS (Sabah + Öğleden Sonra), ÖĞLE_1 ve
 * ÖĞLE_2 paketleri; öğretmen başına günde en fazla bir normal paket.
 * Eski v1/v2/v3 planlar okunabilir kalır ve sessizce dönüştürülmez.
 */
export const DUTY_PLAN_ALGORITHM_VERSION = DUTY_PLAN_SOLVER_V4_VERSION;

export class DutyPlanGenerationQueryError extends Error {}

export interface TeacherDutyScoreSnapshotRow {
  teacherSourceId: string;
  teacherName: string;
  totalPoints: number;
  dutyCount: number;
  lastDutyDate: string | null;
  lastFourWeeksDutyCount: number;
}

export interface TeacherDutyScoreSnapshot {
  weekStartDate: string;
  teachers: TeacherDutyScoreSnapshotRow[];
}

function currentMondayIso(): string {
  const now = new Date();
  const day = now.getUTCDay() || 7;
  now.setUTCDate(now.getUTCDate() - day + 1);
  return now.toISOString().slice(0, 10);
}

export interface DutyPlanSnapshotDay {
  order: number;
  name: string;
}

export interface DutyPlanSnapshotTask {
  dayOrder: number;
  dutyLocationId: string;
  dutyLocationName: string;
  shortCode: string;
  category: string;
  dutyBlockId: string;
  blockCode: DutyBlockCode;
  blockName: string;
  blockOrder: number;
  kind: "fixed" | "normal";
  fixedCoveredByTeacherSourceId: string | null;
  fixedCoveredByTeacherName: string | null;
}

export interface DutyPlanSnapshotCandidateEdge {
  dayOrder: number;
  dutyLocationId: string;
  dutyBlockId: string;
  teacherSourceId: string;
  teacherName: string;
}

export interface DutyPlanSnapshotTeacherFixedLoad {
  teacherSourceId: string;
  fixedDutyDayCount: number;
}

/** Bulgu 5: plana dahil TÜM öğretmenler — candidateEdges'te hiç görünmeyenler dahil. */
export interface DutyPlanSnapshotTeacherRef {
  teacherSourceId: string;
  teacherName: string;
  /** AUTHORITATIVE (migration 20260920090000). true ⇔ aynı gün tek normal blok. */
  halfDayRuleEnabled?: boolean;
  /** Günlük normal blok üst sınırı — solver bunu HARD-CODE ETMEZ, buradan okur. */
  maxDailyNormalBlocks?: number;
}

export interface DutyPlanSnapshotLocation {
  id: string;
  shortCode: string;
  category: string;
  allowsFixedAssignment: boolean;
  activeBlockCodes: DutyBlockCode[];
}

export interface DutyPlanConfigurationErrorRow {
  dayOrder: number;
  blockCode: DutyBlockCode;
  blockName: string;
  periodName: string | null;
  teacherCount: number;
}

export type DutyPlanGenerationSnapshot =
  | { hasImport: false }
  | {
      hasImport: true;
      campusId: string;
      academicYearId: string;
      timetableImportId: string;
      importedAt: string | null;
      sourceFingerprint: string;
      days: DutyPlanSnapshotDay[];
      blocks: DutyBlockDto[];
      locations: DutyPlanSnapshotLocation[];
      tasks: DutyPlanSnapshotTask[];
      teachers: DutyPlanSnapshotTeacherRef[];
      candidateEdges: DutyPlanSnapshotCandidateEdge[];
      teacherFixedDutyLoads: DutyPlanSnapshotTeacherFixedLoad[];
      feasibility: DutyPlanFeasibility;
      configurationErrors: DutyPlanConfigurationErrorRow[];
    };

export async function fetchDutyPlanGenerationSnapshot(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
): Promise<DutyPlanGenerationSnapshot> {
  const { data, error } = await supabase.rpc("get_duty_plan_generation_snapshot", {
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
  });
  if (error || !data) {
    throw new DutyPlanGenerationQueryError("Üretim snapshot'ı alınamadı.");
  }
  return data as unknown as DutyPlanGenerationSnapshot;
}

export async function fetchTeacherDutyScoreSnapshot(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
  weekStartDate: string,
): Promise<TeacherDutyScoreSnapshot> {
  const { data, error } = await supabase.rpc("get_teacher_duty_score_snapshot", {
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
    p_week_start_date: weekStartDate,
  });
  if (error || !data) throw new DutyPlanGenerationQueryError("Öğretmen nöbet puanları alınamadı.");
  return data as unknown as TeacherDutyScoreSnapshot;
}

/**
 * Snapshot'tan v3 solver girdisini kurar. Yer adı/short_code HARD-CODE
 * EDİLMEZ; her kural snapshot alanlarından okunur.
 */
export function buildV3Input(
  snapshot: Extract<DutyPlanGenerationSnapshot, { hasImport: true }>,
  normalTasks: { dayOrder: number; dutyLocationId: string; dutyBlockId: string; category?: string | null }[],
  lessonPeriodCountByTeacherDay: Map<string, number>,
  options: GenerationOptions,
  lockedAssignments: { dayOrder: number; dutyLocationId: string; dutyBlockId: string; teacherSourceId: string }[],
): V3SolverInput {
  // Sabit nöbet GÜNLERİ: fixed görevlerin kapsandığı (öğretmen, gün) çiftleri.
  // Kural 5 (sabit günde normal görev yok) bu kümeyle uygulanır.
  const seen = new Set<string>();
  const fixedDays: { teacherSourceId: string; dayOrder: number }[] = [];
  for (const t of snapshot.tasks) {
    if (t.kind !== "fixed" || !t.fixedCoveredByTeacherSourceId) continue;
    const key = `${t.fixedCoveredByTeacherSourceId}|${t.dayOrder}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fixedDays.push({ teacherSourceId: t.fixedCoveredByTeacherSourceId, dayOrder: t.dayOrder });
  }

  return {
    tasks: normalTasks.map((t) => ({ dayOrder: t.dayOrder, dutyLocationId: t.dutyLocationId, dutyBlockId: t.dutyBlockId, category: t.category })),
    // GEREKLİ sabit yük bu evrenden hesaplanır — atamalardan DEĞİL. Öğretmeni
    // henüz atanmamış bir sabit grup da gerçekte gereklidir.
    fixedTaskCells: snapshot.tasks
      .filter((t) => t.kind === "fixed")
      .map((t) => ({
        dayOrder: t.dayOrder,
        dutyLocationId: t.dutyLocationId,
        dutyBlockId: t.dutyBlockId,
        fixedCoveredByTeacherSourceId: t.fixedCoveredByTeacherSourceId,
      })),
    candidateEdges: snapshot.candidateEdges.map((e) => ({ dayOrder: e.dayOrder, dutyLocationId: e.dutyLocationId, dutyBlockId: e.dutyBlockId, teacherSourceId: e.teacherSourceId })),
    // Öğretmen evreninin TAMAMI korunur — adayı olmayan öğretmen de 0 yükle görünür.
    teachers: snapshot.teachers.map((t) => ({
      teacherSourceId: t.teacherSourceId,
      teacherName: t.teacherName,
      halfDayRuleEnabled: t.halfDayRuleEnabled,
      maxDailyNormalBlocks: t.maxDailyNormalBlocks,
    })),
    teacherFixedLoads: snapshot.teacherFixedDutyLoads.map((f) => ({ teacherSourceId: f.teacherSourceId, fixedDutyDayCount: f.fixedDutyDayCount })),
    fixedDays,
    lockedAssignments,
    lessonPeriodCountByTeacherDay: Object.fromEntries(lessonPeriodCountByTeacherDay),
    options,
  };
}

/**
 * Snapshot'tan üç-paketli v4 girdisini kurar. Paket anlamı yer adından
 * değil yalnız blok kodundan gelir; adaylık yine snapshot candidateEdges
 * kümesinin otoritesindedir.
 */
export function buildV4Input(
  snapshot: Extract<DutyPlanGenerationSnapshot, { hasImport: true }>,
  normalTasks: DutyPlanSnapshotTask[],
  lessonPeriodCountByTeacherDay: Map<string, number>,
  options: GenerationOptions,
  lockedPackages: V4LockedPackage[] = [],
  activeDayOrders: number[] = [1, 2, 3, 4, 5],
  historicalDutyPointsByTeacher: Map<string, number> = new Map(),
): V4Input {
  const activeDays = new Set(activeDayOrders);
  const fixedDayKeys = new Set<string>();
  const fixedDays: { teacherSourceId: string; dayOrder: number }[] = [];
  for (const task of snapshot.tasks) {
    if (!activeDays.has(task.dayOrder)) continue;
    if (task.kind !== "fixed" || !task.fixedCoveredByTeacherSourceId) continue;
    const key = `${task.fixedCoveredByTeacherSourceId}|${task.dayOrder}`;
    if (fixedDayKeys.has(key)) continue;
    fixedDayKeys.add(key);
    fixedDays.push({ teacherSourceId: task.fixedCoveredByTeacherSourceId, dayOrder: task.dayOrder });
  }
  const activeFixedLoadByTeacher = new Map<string, number>();
  for (const fixedDay of fixedDays) {
    activeFixedLoadByTeacher.set(fixedDay.teacherSourceId, (activeFixedLoadByTeacher.get(fixedDay.teacherSourceId) ?? 0) + 1);
  }

  return {
    tasks: normalTasks.map((task) => ({
      dayOrder: task.dayOrder,
      dutyLocationId: task.dutyLocationId,
      dutyBlockId: task.dutyBlockId,
      blockCode: task.blockCode,
      category: task.category,
    })),
    candidateEdges: snapshot.candidateEdges.filter((edge) => activeDays.has(edge.dayOrder)).map((edge) => ({
      dayOrder: edge.dayOrder,
      dutyLocationId: edge.dutyLocationId,
      dutyBlockId: edge.dutyBlockId,
      teacherSourceId: edge.teacherSourceId,
    })),
    teachers: snapshot.teachers.map((teacher) => ({ teacherSourceId: teacher.teacherSourceId, teacherName: teacher.teacherName })),
    teacherFixedLoads: [...activeFixedLoadByTeacher.entries()].map(([teacherSourceId, fixedDutyDayCount]) => ({
      teacherSourceId,
      fixedDutyDayCount,
    })),
    fixedDays,
    lockedPackages,
    lessonPeriodCountByTeacherDay,
    historicalDutyPointsByTeacher,
    options,
  };
}

export interface DutyPlanV4Diagnostics {
  algorithmVersion: string;
  packageModel: "TENEFFUS_OGLE_1_OGLE_2";
  totalPackageCount: number;
  assignedPackageCount: number;
  unassignedPackageCount: number;
  assignedTaskCount: number;
  unassignedTaskCount: number;
  fixedAssignmentCount: number;
  coverageOptimalityProven: boolean;
}

function v4Diagnostics(result: V4Result): DutyPlanV4Diagnostics {
  return {
    algorithmVersion: result.algorithmVersion,
    packageModel: "TENEFFUS_OGLE_1_OGLE_2",
    totalPackageCount: result.totalPackageCount,
    assignedPackageCount: result.assignedPackageCount,
    unassignedPackageCount: result.unassignedPackageCount,
    assignedTaskCount: result.assignedTaskCount,
    unassignedTaskCount: result.unassignedTaskCount,
    fixedAssignmentCount: result.fixedAssignmentCount,
    coverageOptimalityProven: result.coverageOptimalityProven,
  };
}

export type GenerateDutyPlanDraftResult =
  | { status: "no_import" }
  | { status: "partial_not_allowed"; uncoveredCount: number; totalTaskCount: number }
  | { status: "ok"; planId: string; version: number; sourceFingerprint: string; createdAt: string; updatedAt: string; summary: DutyPlanGenerationSummary }
  | { status: "source_changed"; currentSourceFingerprint: string | null }
  | { status: "invalid_assignment"; reason?: string }
  | { status: "invalid_summary"; authoritative: unknown }
  | { status: "teacher_day_conflict"; reason?: "half_day_rule" | "daily_package_limit" }
  /** Aynı gün AYNI BLOK'ta iki farklı yer (yarım gün kapalı olsa bile yasak). */
  | { status: "teacher_block_conflict" }
  /** Sabit nöbet gününde normal görev üretilmiş. */
  | { status: "teacher_has_fixed_duty" }
  | { status: "weekly_limit_exceeded" }
  | { status: "fixed_assignment_changed" }
  | { status: "version_conflict"; currentPlanId: string | null; currentVersion?: number }
  /** Kural 9: kilitli manuel atama mevcut kurallarla çelişiyor — SESSİZ düzeltme YOK. */
  | { status: "invalid_locked_assignment"; violations: V3LockedViolation[] };

/** solver-v3 teşhisleri — yalnız v3 üretimlerde dolar. */
export interface DutyPlanV3Diagnostics {
  algorithmVersion: string;
  assignedTaskCount: number;
  unassignedTaskCount: number;
  /** Sabit GÖREV BİRİMİ sayısı (hücre değil): distinct (öğretmen, gün). */
  fixedAssignmentCount: number;
  maxTheoreticalCoverage: number;
  /**
   * DEPRECATED ADLANDIRMA. Basit toplam kapasite açığı DEĞİL; gerçek
   * eşleştirme sonucu açık kalan görev sayısıdır
   * (= matchingConstrainedUncoveredTasks).
   */
  weeklyCapacityShortfall: number;
  /** Tercih/zaman/gün/blok/haftalık kısıtlar yüzünden açık kalan görevler. */
  matchingConstrainedUncoveredTasks: number;
  /** Yük BİRİMİ tablosu — ham hücre sayısıyla karıştırılmaz. */
  loadUnits: V3LoadUnits;
  /** NİHAİ sıralamanın optimumluğu (diversifyAreas açıkken false). */
  optimalityProven: boolean;
  /** KAPSAMA her durumda kesin maksimumdur. */
  coverageOptimalityProven: boolean;
  optimalityReason: "diversification_heuristic" | null;
  searchLimitReached: boolean;
  teacherCapacities: V3TeacherCapacity[];
  capacityScenarios: V3CapacityAnalysis;
}

export interface DutyPlanGenerationSummary {
  totalTaskCount: number;
  fixedTaskCount: number;
  fixedCoveredCount: number;
  normalTaskCount: number;
  normalCoveredCount: number;
  uncoveredCount: number;
  /** teacherSourceId'ye göre artan sırayla — save_duty_plan_draft'ın yetkili yeniden hesaplamasıyla BİREBİR aynı sırada olmalı. */
  teacherLoads: SolverTeacherLoad[];
  warnings: { code: string; message: string; teacherSourceId?: string }[];
  optionsUsed: GenerationOptions;
  /**
   * NİHAİ sonucun optimumluğu. UI bunu, KANITLANMAMIŞ bir sonucu "optimum/en
   * uygun" diye SUNMAMAK için kullanmalıdır.
   *
   * NEDEN false olabileceği SÜRÜME GÖRE değişir:
   *   v1/v2 — paket-farkında arama (branch-and-bound) düğüm bütçesine çarptı
   *           ⇒ searchLimitReached=true. Bulunan kapsama yine de güvenlidir.
   *   v3    — kesin min-cost-flow; arama limiti YOKTUR. false YALNIZ
   *           diversifyAreas=true iken, çeşitlilik geçişi SEZGİSEL olduğu için
   *           gelir ⇒ v3.optimalityReason="diversification_heuristic" ve
   *           searchLimitReached=false. Kapsama yine de KESİN maksimumdur
   *           (v3.coverageOptimalityProven=true).
   *
   * Yani optimalityProven=false HER ZAMAN searchLimitReached=true anlamına
   * GELMEZ.
   */
  optimalityProven: boolean;
  searchLimitReached: boolean;
  exploredNodeCount: number;
  /**
   * Yalnız REFERANS. v1/v2'de "paket kısıtı olmayan hücre-bazlı modelin
   * kapsaması" anlamındaydı. v3 modelinin KENDİSİ hücre-bazlıdır, bu yüzden
   * v3'te bu alan gerçek kapsamaya EŞİTTİR — uydurma bir değer DEĞİL,
   * modelin tanımı gereği aynı sayıdır.
   */
  cellOnlyBaselineCoverage: number;
  /**
   * v3 teşhisleri. v1/v2 planlarda BULUNMAZ — eski özetler değiştirilmez.
   */
  v3?: DutyPlanV3Diagnostics;
  /** Yalnız üç-paketli v4 planlarda bulunur. */
  v4?: DutyPlanV4Diagnostics;
}

interface AssignmentRow {
  day_order: number;
  duty_location_id: string;
  duty_block_id: string;
  teacher_source_id: string | null;
  assignment_kind: "fixed" | "generated" | "manual" | "unassigned";
  score_details: Record<string, unknown>;
}

export async function generateDutyPlanDraft(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
  optionsInput: Partial<GenerationOptions> | undefined,
  /**
   * Bulgu 3 — KESİN semantiği: undefined/null ⇔ istemci aktif taslak
   * OLMADIĞINI düşünüyor (o durumda mevcut biri varsa version_conflict).
   * Bir plan id'si ⇔ istemci O taslağı BİLİNÇLİ olarak yeniliyor (eşleşmezse
   * version_conflict). Servis burada ASLA sabit `null` göndermez — çağıranın
   * verdiği değeri OLDUĞU GİBİ RPC'ye taşır.
   */
  expectedPlanId: string | null | undefined,
  weekStartDateInput?: string,
  activeDayOrdersInput?: number[],
): Promise<GenerateDutyPlanDraftResult> {
  const snapshot = await fetchDutyPlanGenerationSnapshot(supabase, campusName, academicYearName);
  if (!snapshot.hasImport) {
    return { status: "no_import" };
  }

  let options: GenerationOptions;
  try {
    options = normalizeGenerationOptions(optionsInput);
  } catch (err) {
    if (err instanceof DutyPlanSolverOptionsError) {
      return { status: "invalid_assignment", reason: err.message };
    }
    throw err;
  }

  const weekStartDate = weekStartDateInput ?? currentMondayIso();
  const activeDayOrders = activeDayOrdersInput?.length ? [...new Set(activeDayOrdersInput)].sort((a, b) => a - b) : [1, 2, 3, 4, 5];
  const activeDays = new Set(activeDayOrders);
  const scoreSnapshot = weekStartDateInput
    ? await fetchTeacherDutyScoreSnapshot(supabase, campusName, academicYearName, weekStartDate)
    : { weekStartDate, teachers: snapshot.teachers.map((teacher) => ({ ...teacher, totalPoints: 0, dutyCount: 0, lastDutyDate: null, lastFourWeeksDutyCount: 0 })) };
  const historicalDutyPointsByTeacher = new Map(scoreSnapshot.teachers.map((teacher) => [teacher.teacherSourceId, teacher.totalPoints]));

  const fixedTasks = snapshot.tasks.filter((t) => activeDays.has(t.dayOrder) && t.kind === "fixed");
  const normalTasks = snapshot.tasks.filter((t) => activeDays.has(t.dayOrder) && t.kind === "normal");

  const lessonPeriodCountByTeacherDay = await fetchTeacherLessonPeriodCounts(supabase, snapshot.timetableImportId);

  const solverResult = solveDutyPlanV4(
    buildV4Input(snapshot, normalTasks, lessonPeriodCountByTeacherDay, options, [], activeDayOrders, historicalDutyPointsByTeacher),
  );
  if (solverResult.status === "invalid_configuration") {
    return { status: "invalid_assignment", reason: solverResult.configurationErrors[0]?.reason ?? "invalid_block_configuration" };
  }
  if (solverResult.status === "invalid_locked_assignment") {
    return {
      status: "invalid_locked_assignment",
      violations: solverResult.lockedViolations.map((violation) => ({
        code: "legacy_multiblock_package" as const,
        message: violation.reason,
        teacherSourceId: violation.teacherSourceId,
        dayOrder: violation.dayOrder,
        dutyLocationId: "",
        dutyBlockId: "",
      })),
    };
  }

  const fixedRows: AssignmentRow[] = fixedTasks.map((t) => ({
    day_order: t.dayOrder,
    duty_location_id: t.dutyLocationId,
    duty_block_id: t.dutyBlockId,
    teacher_source_id: t.fixedCoveredByTeacherSourceId,
    assignment_kind: t.fixedCoveredByTeacherSourceId ? "fixed" : "unassigned",
    score_details: {},
  }));

  const normalRows: AssignmentRow[] = solverResult.assignments.map((a) => ({
    day_order: a.dayOrder,
    duty_location_id: a.dutyLocationId,
    duty_block_id: a.dutyBlockId,
    teacher_source_id: a.teacherSourceId,
    assignment_kind: a.kind === "generated" ? "generated" : "unassigned",
    score_details: {},
  }));

  const allRows = [...fixedRows, ...normalRows];
  const fixedMissingCount = fixedRows.filter((r) => r.assignment_kind === "unassigned").length;
  const totalUncovered = solverResult.unassignedTaskCount + fixedMissingCount;

  if (!options.allowPartial && totalUncovered > 0) {
    return { status: "partial_not_allowed", uncoveredCount: totalUncovered, totalTaskCount: allRows.length };
  }

  // teacherLoads: solver'ın döndürdüğü yapı zaten teacherSourceId'ye göre
  // artan sırada — save_duty_plan_draft'ın 'submitted' kümesinden yeniden
  // hesapladığı diziyle (fixed satırların GÜN sayısı + generated satır
  // sayısı) BİREBİR eşleşmelidir; aksi halde invalid_summary döner.
  const summary: DutyPlanGenerationSummary = {
    totalTaskCount: allRows.length,
    fixedTaskCount: fixedRows.length,
    fixedCoveredCount: fixedRows.filter((r) => r.assignment_kind === "fixed").length,
    normalTaskCount: normalRows.length,
    normalCoveredCount: solverResult.assignedTaskCount,
    uncoveredCount: totalUncovered,
    teacherLoads: solverResult.teacherLoads,
    warnings: solverResult.warnings,
    optionsUsed: options,
    // v4 KESİN min-cost-flow kullanır: arama/limit YOKTUR.
    optimalityProven: solverResult.optimalityProven,
    searchLimitReached: solverResult.searchLimitReached,
    // v4'te arama düğümü kavramı YOKTUR.
    exploredNodeCount: 0,
    // Geriye uyumluluk alanı; v4'te birincil teşhis v4 nesnesidir.
    cellOnlyBaselineCoverage: solverResult.assignedTaskCount,
    v4: v4Diagnostics(solverResult),
  };

  const { data, error } = await supabase.rpc("save_duty_plan_draft", {
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
    p_expected_source_fingerprint: snapshot.sourceFingerprint,
    p_algorithm_version: DUTY_PLAN_ALGORITHM_VERSION,
    p_generation_seed: options.seed ?? null,
    p_generation_options: {
      ...options,
      weekStartDate,
      activeDayOrders,
      priorScoreSnapshot: Object.fromEntries(scoreSnapshot.teachers.map((teacher) => [teacher.teacherSourceId, teacher.totalPoints])),
    },
    p_assignments: allRows,
    p_summary: summary,
    p_allow_partial: options.allowPartial,
    p_expected_plan_id: expectedPlanId ?? null,
  });

  if (error || !data) {
    throw new DutyPlanGenerationQueryError("Nöbet planı taslağı kaydedilemedi.");
  }

  const result = data as { status: string; [key: string]: unknown };
  switch (result.status) {
    case "ok":
      return {
        status: "ok",
        planId: result.planId as string,
        version: result.version as number,
        sourceFingerprint: result.sourceFingerprint as string,
        createdAt: result.createdAt as string,
        updatedAt: result.updatedAt as string,
        summary,
      };
    case "source_changed":
      return { status: "source_changed", currentSourceFingerprint: (result.currentSourceFingerprint as string | null) ?? null };
    case "invalid_assignment":
      return { status: "invalid_assignment", reason: result.reason as string | undefined };
    case "invalid_summary":
      return { status: "invalid_summary", authoritative: result.authoritative };
    case "teacher_day_conflict": {
      const reason =
        result.reason === "half_day_rule" || result.reason === "daily_package_limit"
          ? result.reason
          : undefined;
      return { status: "teacher_day_conflict", reason };
    }
    case "teacher_block_conflict":
      return { status: "teacher_block_conflict" };
    case "teacher_has_fixed_duty":
      return { status: "teacher_has_fixed_duty" };
    case "weekly_limit_exceeded":
      return { status: "weekly_limit_exceeded" };
    case "fixed_assignment_changed":
      return { status: "fixed_assignment_changed" };
    case "version_conflict":
      return { status: "version_conflict", currentPlanId: (result.currentPlanId as string | null) ?? null, currentVersion: result.currentVersion as number | undefined };
    default:
      throw new DutyPlanGenerationQueryError(`Beklenmeyen RPC durumu: ${result.status}`);
  }
}

export type RegenerateDutyPlanDraftResult =
  | GenerateDutyPlanDraftResult
  | { status: "plan_not_found" }
  | { status: "plan_not_draft" };

/**
 * Mevcut taslağı yeniden üretir. Varsayılan davranış (wipeManualAssignments
 * false/undefined): mevcut MANUEL atamalar KİLİTLİ KISIT olarak korunur —
 * bu hücreler solver'ın `tasks` girdisinden çıkarılır ve o öğretmenin o
 * günü (excludedTeacherDays) TAMAMEN hariç tutulur (solver o güne başka bir
 * normal görev ATAMAZ), ayrıca haftalık kapasitesinden 1 düşülür. Kilitli
 * atamalar SONUÇTA 'manual' olarak AYNEN korunur — solver tarafından
 * ASLA yeniden değerlendirilmez/silinmez. wipeManualAssignments=true ⇔
 * kullanıcının AYRI, AÇIK onayı — bu durumda TÜM manuel atamalar silinir,
 * yeniden üretme sıfırdan (generate ile aynı) yapılır.
 */
export async function regenerateDutyPlanDraft(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
  planId: string,
  optionsInput: Partial<GenerationOptions> | undefined,
  wipeManualAssignments: boolean | undefined,
): Promise<RegenerateDutyPlanDraftResult> {
  const currentDraft = await fetchDutyPlanDraft(supabase, campusName, academicYearName, planId);
  if (!currentDraft.found) return { status: "plan_not_found" };
  if (currentDraft.status !== "draft") return { status: "plan_not_draft" };

  const snapshot = await fetchDutyPlanGenerationSnapshot(supabase, campusName, academicYearName);
  if (!snapshot.hasImport) return { status: "no_import" };

  let options: GenerationOptions;
  try {
    options = normalizeGenerationOptions(optionsInput);
  } catch (err) {
    if (err instanceof DutyPlanSolverOptionsError) return { status: "invalid_assignment", reason: err.message };
    throw err;
  }

  const storedWeekStartDateValue = currentDraft.generationOptions.weekStartDate;
  const hasStoredWeekContext = typeof storedWeekStartDateValue === "string";
  const storedWeekStartDate = hasStoredWeekContext ? storedWeekStartDateValue : currentMondayIso();
  const storedDayOrders = Array.isArray(currentDraft.generationOptions.activeDayOrders)
    ? currentDraft.generationOptions.activeDayOrders.filter((day): day is number => Number.isInteger(day) && day >= 1 && day <= 5)
    : [1, 2, 3, 4, 5];
  const activeDayOrders = storedDayOrders.length ? [...new Set(storedDayOrders)].sort((a, b) => a - b) : [1, 2, 3, 4, 5];
  const activeDays = new Set(activeDayOrders);
  const scoreSnapshot = hasStoredWeekContext
    ? await fetchTeacherDutyScoreSnapshot(supabase, campusName, academicYearName, storedWeekStartDate)
    : { weekStartDate: storedWeekStartDate, teachers: snapshot.teachers.map((teacher) => ({ ...teacher, totalPoints: 0, dutyCount: 0, lastDutyDate: null, lastFourWeeksDutyCount: 0 })) };
  const historicalDutyPointsByTeacher = new Map(scoreSnapshot.teachers.map((teacher) => [teacher.teacherSourceId, teacher.totalPoints]));

  const fixedTasks = snapshot.tasks.filter((t) => activeDays.has(t.dayOrder) && t.kind === "fixed");
  const normalTasks = snapshot.tasks.filter((t) => activeDays.has(t.dayOrder) && t.kind === "normal");

  const lockedRows = wipeManualAssignments ? [] : currentDraft.assignments.filter((a) => a.assignmentKind === "manual");

  // v4 yalnız TENEFFÜS (SHORT_BREAKS) ve tekli öğle paketlerini kabul eder.
  // Eski FULL_DAY paketleri sessizce dönüştürülmez.
  if (!wipeManualAssignments) {
    const legacyPackages = currentDraft.packages.filter(
      (pkg) => pkg.assignmentKind === "manual" && !["SINGLE_BLOCK", "SHORT_BREAKS"].includes(pkg.coverageMode),
    );
    if (legacyPackages.length > 0) {
      const byId = new Map(currentDraft.assignments.map((a) => [a.id, a]));
      return {
        status: "invalid_locked_assignment",
        violations: legacyPackages.flatMap((pkg) =>
          pkg.coveredTaskIds.map((taskId) => {
            const cell = byId.get(taskId);
            return {
              code: "legacy_multiblock_package" as const,
              message: `Bu manuel atama v4 tarafından desteklenmeyen "${pkg.coverageMode}" paketinin parçasıdır. Paketi kaldırın veya manuel atamaları temizlemeyi onaylayın.`,
              teacherSourceId: pkg.teacherSourceId,
              dayOrder: pkg.dayOrder,
              dutyLocationId: pkg.dutyLocationId,
              dutyBlockId: cell?.dutyBlockId ?? "",
            };
          }),
        ),
      };
    }
  }
  const lockedCellKey = (a: { dayOrder: number; dutyLocationId: string; dutyBlockId: string }) =>
    `${a.dayOrder}|${a.dutyLocationId}|${a.dutyBlockId}`;
  const lockedCells = new Set(lockedRows.map(lockedCellKey));

  const lessonPeriodCountByTeacherDay = await fetchTeacherLessonPeriodCounts(supabase, snapshot.timetableImportId);

  const openNormalTasks = normalTasks.filter((t) => !lockedCells.has(lockedCellKey(t)));

  const snapshotCellByKey = new Map(
    normalTasks.map((task) => [lockedCellKey(task), task]),
  );
  const assignmentById = new Map(currentDraft.assignments.map((assignment) => [assignment.id, assignment]));
  const lockedPackages: V4LockedPackage[] = wipeManualAssignments
    ? []
    : currentDraft.packages
        .filter((pkg) => pkg.assignmentKind === "manual" && (pkg.coverageMode === "SINGLE_BLOCK" || pkg.coverageMode === "SHORT_BREAKS"))
        .map((pkg) => ({
          teacherSourceId: pkg.teacherSourceId,
          dayOrder: pkg.dayOrder,
          dutyLocationId: pkg.dutyLocationId,
          coverageMode: pkg.coverageMode as "SINGLE_BLOCK" | "SHORT_BREAKS",
          cells: pkg.coveredTaskIds
            .map((taskId) => assignmentById.get(taskId))
            .map((assignment) => (assignment ? snapshotCellByKey.get(lockedCellKey(assignment)) : undefined))
            .filter((task): task is DutyPlanSnapshotTask => Boolean(task))
            .map((task) => ({
              dayOrder: task.dayOrder,
              dutyLocationId: task.dutyLocationId,
              dutyBlockId: task.dutyBlockId,
              blockCode: task.blockCode,
              category: task.category,
            })),
        }));

  const solverResult = solveDutyPlanV4(
    buildV4Input(snapshot, openNormalTasks, lessonPeriodCountByTeacherDay, options, lockedPackages, activeDayOrders, historicalDutyPointsByTeacher),
  );
  if (solverResult.status === "invalid_configuration") {
    return { status: "invalid_assignment", reason: solverResult.configurationErrors[0]?.reason ?? "invalid_block_configuration" };
  }
  if (solverResult.status === "invalid_locked_assignment") {
    return {
      status: "invalid_locked_assignment",
      violations: solverResult.lockedViolations.map((violation) => ({
        code: "legacy_multiblock_package" as const,
        message: violation.reason,
        teacherSourceId: violation.teacherSourceId,
        dayOrder: violation.dayOrder,
        dutyLocationId: "",
        dutyBlockId: "",
      })),
    };
  }

  const fixedRows: AssignmentRow[] = fixedTasks.map((t) => ({
    day_order: t.dayOrder,
    duty_location_id: t.dutyLocationId,
    duty_block_id: t.dutyBlockId,
    teacher_source_id: t.fixedCoveredByTeacherSourceId,
    assignment_kind: t.fixedCoveredByTeacherSourceId ? "fixed" : "unassigned",
    score_details: {},
  }));

  const lockedAssignmentRows: AssignmentRow[] = lockedRows.map((r) => ({
    day_order: r.dayOrder,
    duty_location_id: r.dutyLocationId,
    duty_block_id: r.dutyBlockId,
    teacher_source_id: r.teacherSourceId,
    assignment_kind: "manual",
    score_details: (r.scoreDetails ?? {}) as Record<string, unknown>,
  }));

  const solverRows: AssignmentRow[] = solverResult.assignments.map((a) => ({
    day_order: a.dayOrder,
    duty_location_id: a.dutyLocationId,
    duty_block_id: a.dutyBlockId,
    teacher_source_id: a.teacherSourceId,
    assignment_kind: a.kind === "generated" ? "generated" : "unassigned",
    score_details: {},
  }));

  const allRows = [...fixedRows, ...lockedAssignmentRows, ...solverRows];
  const fixedMissingCount = fixedRows.filter((r) => r.assignment_kind === "unassigned").length;
  const totalUncovered = solverResult.unassignedTaskCount + fixedMissingCount;

  if (!options.allowPartial && totalUncovered > 0) {
    return { status: "partial_not_allowed", uncoveredCount: totalUncovered, totalTaskCount: allRows.length };
  }

  // teacherLoads: v4 solver'ın döndürdüğü yük ZATEN kilitli manuel paketleri
  // İÇERİR. Burada İKİNCİ KEZ
  // eklenmez — aksi halde DB'nin yetkili yeniden hesabıyla uyuşmaz ve
  // invalid_summary üretirdi.
  //
  // v4 BİRİMİ: TENEFFÜS çifti tek paket; ÖĞLE_1/ÖĞLE_2 tekli paket.
  const teacherLoads: SolverTeacherLoad[] = [...solverResult.teacherLoads].sort((a, b) => a.teacherSourceId.localeCompare(b.teacherSourceId));

  const summary: DutyPlanGenerationSummary = {
    totalTaskCount: allRows.length,
    fixedTaskCount: fixedRows.length,
    fixedCoveredCount: fixedRows.filter((r) => r.assignment_kind === "fixed").length,
    normalTaskCount: normalTasks.length,
    normalCoveredCount: solverResult.assignedTaskCount + lockedAssignmentRows.length,
    uncoveredCount: totalUncovered,
    teacherLoads,
    warnings: solverResult.warnings,
    optionsUsed: options,
    optimalityProven: solverResult.optimalityProven,
    searchLimitReached: solverResult.searchLimitReached,
    // v4'te arama düğümü kavramı YOKTUR.
    exploredNodeCount: 0,
    // Geriye uyumluluk alanı.
    cellOnlyBaselineCoverage: solverResult.assignedTaskCount + lockedAssignmentRows.length,
    v4: {
      ...v4Diagnostics(solverResult),
      totalPackageCount: solverResult.totalPackageCount + lockedPackages.length,
      assignedPackageCount: solverResult.assignedPackageCount + lockedPackages.length,
      assignedTaskCount: solverResult.assignedTaskCount + lockedAssignmentRows.length,
    },
  };

  const { data, error } = await supabase.rpc("save_duty_plan_draft", {
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
    p_expected_source_fingerprint: snapshot.sourceFingerprint,
    p_algorithm_version: DUTY_PLAN_ALGORITHM_VERSION,
    p_generation_seed: options.seed ?? null,
    p_generation_options: {
      ...options,
      weekStartDate: storedWeekStartDate,
      activeDayOrders,
      priorScoreSnapshot: Object.fromEntries(scoreSnapshot.teachers.map((teacher) => [teacher.teacherSourceId, teacher.totalPoints])),
    },
    p_assignments: allRows,
    p_summary: summary,
    p_allow_partial: options.allowPartial,
    p_expected_plan_id: planId,
    // Node'da solver çalışırken (bu SÜRE alır) aradaki eşzamanlı bir manuel
    // PUT plan.version'ı artırmış olabilir — DB, kilit altında GERÇEK
    // versiyonla ATOMİK karşılaştırır; uyuşmazsa version_conflict döner ve
    // o manuel atamayı SESSİZCE EZMEZ (bkz. save_duty_plan_draft yorumu).
    p_expected_plan_version: currentDraft.version,
  });

  if (error || !data) {
    throw new DutyPlanGenerationQueryError("Nöbet planı taslağı yeniden üretilemedi.");
  }

  const result = data as { status: string; [key: string]: unknown };
  switch (result.status) {
    case "ok":
      return {
        status: "ok",
        planId: result.planId as string,
        version: result.version as number,
        sourceFingerprint: result.sourceFingerprint as string,
        createdAt: result.createdAt as string,
        updatedAt: result.updatedAt as string,
        summary,
      };
    case "source_changed":
      return { status: "source_changed", currentSourceFingerprint: (result.currentSourceFingerprint as string | null) ?? null };
    case "invalid_assignment":
      return { status: "invalid_assignment", reason: result.reason as string | undefined };
    case "invalid_summary":
      return { status: "invalid_summary", authoritative: result.authoritative };
    case "teacher_day_conflict": {
      const reason =
        result.reason === "half_day_rule" || result.reason === "daily_package_limit"
          ? result.reason
          : undefined;
      return { status: "teacher_day_conflict", reason };
    }
    case "teacher_block_conflict":
      return { status: "teacher_block_conflict" };
    case "teacher_has_fixed_duty":
      return { status: "teacher_has_fixed_duty" };
    case "weekly_limit_exceeded":
      return { status: "weekly_limit_exceeded" };
    case "fixed_assignment_changed":
      return { status: "fixed_assignment_changed" };
    case "version_conflict":
      return { status: "version_conflict", currentPlanId: (result.currentPlanId as string | null) ?? null, currentVersion: result.currentVersion as number | undefined };
    default:
      throw new DutyPlanGenerationQueryError(`Beklenmeyen RPC durumu: ${result.status}`);
  }
}
