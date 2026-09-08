import type { DutyBlock, DutyBlockCode } from "../dutyLocations/types";

export type { DutyBlock, DutyBlockCode };

/** Backend server/lib/dutyPlanning/solver.ts ile birebir aynı — yalnız gösterim. */
export interface GenerationOptions {
  minWeeklyDuties: number;
  targetWeeklyDuties: number;
  maxWeeklyDuties: number;
  balanceWorkload: boolean;
  diversifyAreas: boolean;
  allowPartial: boolean;
  seed?: number;
}

export const DEFAULT_GENERATION_OPTIONS: GenerationOptions = {
  minWeeklyDuties: 1,
  targetWeeklyDuties: 2,
  maxWeeklyDuties: 3,
  balanceWorkload: true,
  diversifyAreas: true,
  allowPartial: true,
};

export interface SolverTeacherLoad {
  teacherSourceId: string;
  normalDutyCount: number;
  fixedDutyDayCount: number;
  totalDutyCount: number;
}

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

export interface SolverWarning {
  code: "fixed_load_at_or_above_max" | "no_candidate" | "teacher_no_candidate_cells" | "teacher_below_min";
  message: string;
  teacherSourceId?: string;
  dayOrder?: number;
  dutyLocationId?: string;
  dutyBlockId?: string;
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

export interface DutyPlanSnapshotTeacherRef {
  teacherSourceId: string;
  teacherName: string;
  /** AUTHORITATIVE (bkz. migration 20260920090000). true ⇔ aynı gün tek normal blok. */
  halfDayRuleEnabled?: boolean;
  /** Günlük normal blok üst sınırı — solver bunu HARD-CODE ETMEZ, buradan okur. */
  maxDailyNormalBlocks?: number;
}

export interface DutyPlanConfigurationErrorRow {
  dayOrder: number;
  blockCode: DutyBlockCode;
  blockName: string;
  periodName: string | null;
  teacherCount: number;
}

/** analyze_duty_plan_feasibility'nin gün bazlı özeti — yalnız snapshot içinde gömülü olarak kullanılan alanlar. */
export interface FeasibilityDayTotals {
  requiredTasks: number;
  coveredTasks: number;
  uncoveredTasks: number;
  fixedRequired: number;
  fixedCovered: number;
  fixedMissing: number;
  normalRequired: number;
  normalMatched: number;
  normalUncovered: number;
  candidateTeacherCount: number;
}

export interface FeasibilityDaySummary {
  order: number;
  name: string;
  totals: FeasibilityDayTotals;
}

export interface DutyPlanFeasibilitySummaryEmbedded {
  hasImport: boolean;
  days?: FeasibilityDaySummary[];
  summary?: {
    totalRequiredTasks: number;
    totalCoveredTasks: number;
    totalUncoveredTasks: number;
    daysWithShortfall: number[];
    feasible: boolean;
  };
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
      blocks: DutyBlock[];
      tasks: DutyPlanSnapshotTask[];
      teachers: DutyPlanSnapshotTeacherRef[];
      candidateEdges: DutyPlanSnapshotCandidateEdge[];
      teacherFixedDutyLoads: DutyPlanSnapshotTeacherFixedLoad[];
      feasibility: DutyPlanFeasibilitySummaryEmbedded;
      configurationErrors: DutyPlanConfigurationErrorRow[];
    };

export interface DutyPlanGenerationSummary {
  totalTaskCount: number;
  fixedTaskCount: number;
  fixedCoveredCount: number;
  normalTaskCount: number;
  normalCoveredCount: number;
  uncoveredCount: number;
  teacherLoads: SolverTeacherLoad[];
  warnings: SolverWarning[];
  optionsUsed: GenerationOptions;
  /**
   * NİHAİ sonucun optimumluğu. `false` iken ekran sonucu ASLA "optimum/en
   * uygun" diye SUNMAMALI — "en iyi BULUNAN çözüm" denmeli.
   *
   * NEDEN false olabileceği SÜRÜME GÖRE değişir:
   *   v1/v2 — paket-farkında arama (branch-and-bound) düğüm bütçesine çarptı
   *           ⇒ `searchLimitReached=true`.
   *   v3    — kesin min-cost-flow kullanılır, arama limiti YOKTUR. false
   *           yalnız `diversifyAreas=true` iken, çeşitlilik geçişi SEZGİSEL
   *           olduğu için gelir ⇒ `v3.optimalityReason="diversification_heuristic"`,
   *           `searchLimitReached=false`.
   *
   * Yani `optimalityProven=false` HER ZAMAN `searchLimitReached=true`
   * ANLAMINA GELMEZ. v3'te kapsamanın kesin maksimum olduğu ayrıca
   * `v3.coverageOptimalityProven` ile bildirilir.
   */
  optimalityProven: boolean;
  searchLimitReached: boolean;
  exploredNodeCount: number;
  /** Yalnız REFERANS: eski hücre-bazlı modelin kapsaması — üst sınır DEĞİLDİR. */
  cellOnlyBaselineCoverage: number;
  /**
   * solver-v3 TEŞHİSLERİ (yalnız v3 planlarda dolar). v1/v2 planlarda
   * bulunmaz — eski özetler DEĞİŞTİRİLMEZ.
   */
  v3?: DutyPlanV3Diagnostics;
  v4?: {
    algorithmVersion: string;
    packageModel: "TENEFFUS_OGLE_1_OGLE_2";
    totalPackageCount: number;
    assignedPackageCount: number;
    unassignedPackageCount: number;
    assignedTaskCount: number;
    unassignedTaskCount: number;
    fixedAssignmentCount: number;
    coverageOptimalityProven: boolean;
  };
}

/** solver-v3'e özgü teşhis alanları (bkz. server/lib/dutyPlanning/solverV3.ts). */
export interface DutyPlanV3Diagnostics {
  algorithmVersion: string;
  assignedTaskCount: number;
  unassignedTaskCount: number;
  /** Sabit GÖREV BİRİMİ sayısı (hücre değil): distinct (öğretmen, gün). */
  fixedAssignmentCount: number;
  /** Mevcut kurallar altında ULAŞILABİLİR azami normal kapsama. */
  maxTheoreticalCoverage: number;
  /** DEPRECATED ADLANDIRMA — matchingConstrainedUncoveredTasks ile aynı değer. */
  weeklyCapacityShortfall: number;
  /** Gerçek eşleştirme sonucu açık kalan görevler (toplam kapasite farkı DEĞİL). */
  matchingConstrainedUncoveredTasks?: number;
  /** Yük BİRİMİ tablosu — ham hücre sayısıyla karıştırılmaz. */
  loadUnits?: DutyPlanLoadUnits;
  /** NİHAİ sıralamanın optimumluğu (diversifyAreas açıkken false). */
  optimalityProven?: boolean;
  /** KAPSAMA her durumda kesin maksimumdur. */
  coverageOptimalityProven?: boolean;
  optimalityReason?: "diversification_heuristic" | null;
  searchLimitReached?: boolean;
  teacherCapacities: DutyPlanTeacherCapacity[];
  capacityScenarios?: DutyPlanCapacityScenarios;
}

/**
 * Yük BİRİMİ tablosu. Hücre sayısı ile yük birimi AYNI DEĞİLDİR: her normal
 * hücre 1 birim, sabit hücreler ikişerli paketlerde toplandığı için 2 hücre
 * 1 birimdir. Arayüz kapasiteyi HAM HÜCRE sayısıyla karşılaştırmamalıdır.
 */
export interface DutyPlanLoadUnits {
  normalRequiredUnits: number;
  /** GEREKLİ sabit birim — (gün, yer) grubundan; öğretmen atanmamış olsa bile sayılır. */
  fixedRequiredUnits: number;
  /** Öğretmeni EKSİKSİZ bulunan sabit birim. */
  fixedCoveredUnits?: number;
  /** fixedRequiredUnits − fixedCoveredUnits. */
  fixedUncoveredUnits?: number;
  totalRequiredLoadUnits: number;
  aggregateTeacherCapacity: number;
  aggregateCapacitySlack: number;
  /** GERÇEK normal + fixed_only hücre sayısı (varsayımla türetilmez). */
  rawTaskCells: number;
  /** Tutarsız sabit gruplar — sessizce karşılanmış sayılmaz. */
  malformedFixedGroups?: {
    dayOrder: number;
    dutyLocationId: string;
    cellCount: number;
    coveredCellCount: number;
    distinctTeacherCount: number;
    reason: "partially_covered" | "multiple_teachers";
  }[];
}

export interface DutyPlanTeacherCapacity {
  teacherSourceId: string;
  fixedDutyDayCount: number;
  lockedNormalCount: number;
  generatedNormalCount: number;
  usedWeekly: number;
  weeklyCapacity: number;
  remainingWeekly: number;
  maxDailyNormalBlocks: number;
  usedByDay: Record<number, number>;
}

export interface DutyPlanCapacityScenario {
  scenario: "currentRules" | "allHalfDayRulesDisabled";
  maxCoverableTasks: number;
  totalNormalTasks: number;
  uncoveredTasks: number;
  weeklyCapacityShortfall: number;
  shortfallByDay: Record<number, number>;
  shortfallByBlock: Record<string, number>;
}

export interface DutyPlanCapacityScenarios {
  currentRules: DutyPlanCapacityScenario;
  allHalfDayRulesDisabled: DutyPlanCapacityScenario;
  coverageGainIfHalfDayDisabled: number;
}

/** Bir öğretmen-günü kapsayan paket türü (bkz. duty_plan_assignment_packages). */
export type DutyPlanPackageCoverageMode = "FULL_DAY" | "SHORT_BREAKS" | "SINGLE_BLOCK" | "FIXED_SHORT_BREAKS";

export const PACKAGE_COVERAGE_MODE_LABELS: Record<DutyPlanPackageCoverageMode, string> = {
  FULL_DAY: "Tüm Gün",
  SHORT_BREAKS: "Teneffüs (Sabah + Öğleden Sonra)",
  SINGLE_BLOCK: "Tek Blok",
  FIXED_SHORT_BREAKS: "Sabit",
};

/** Aynı gün/yer/öğretmen için TEK paket — birden çok hücreyi kapsayabilir. */
export interface DutyPlanDraftPackageDto {
  id: string;
  dayOrder: number;
  dutyLocationId: string;
  teacherSourceId: string;
  teacherName: string;
  coverageMode: DutyPlanPackageCoverageMode;
  assignmentKind: "fixed" | "generated" | "manual";
  coveredTaskIds: string[];
}

export interface DutyPlanDraftAssignmentDto {
  id: string;
  dayOrder: number;
  dutyLocationId: string;
  dutyLocationName: string;
  dutyBlockId: string;
  dutyBlockName: string;
  teacherSourceId: string | null;
  teacherName: string | null;
  assignmentKind: "fixed" | "generated" | "manual" | "unassigned";
  fixedDutyAssignmentId: string | null;
  scoreDetails: Record<string, unknown>;
  /** unassigned ⇔ null; diğerlerinde ait olduğu paket. */
  packageId: string | null;
}

export type DutyPlanDraftDto =
  | { found: false }
  | {
      found: true;
      id: string;
      status: "draft" | "published" | "archived";
      timetableImportId: string;
      sourceFingerprint: string;
      savedSourceFingerprint: string;
      currentSourceFingerprint: string | null;
      isStale: boolean;
      algorithmVersion: string;
      generationSeed: number | null;
      generationOptions: Partial<GenerationOptions>;
      summary: Partial<DutyPlanGenerationSummary>;
      version: number;
      createdAt: string;
      updatedAt: string;
      weekStartDate?: string;
      activeDayOrders?: number[];
      priorScoreSnapshot?: Record<string, number>;
      assignments: DutyPlanDraftAssignmentDto[];
      packages: DutyPlanDraftPackageDto[];
    };

/** POST /api/duty-plans/drafts/generate — 201 gövdesi. */
export interface GenerateDutyPlanDraftOk {
  status: "ok";
  planId: string;
  version: number;
  sourceFingerprint: string;
  createdAt: string;
  updatedAt: string;
  summary: DutyPlanGenerationSummary;
}

export interface GenerateDutyPlanDraftInput {
  options?: Partial<GenerationOptions>;
  expectedPlanId?: string | null;
  weekStartDate?: string;
  activeDayOrders?: number[];
}

// ============================================================================
// Manuel atama + yeniden üretme + yayımlama
// ============================================================================

/**
 * get_duty_plan_task_candidates'in DÜRÜST gerekçe kümesi (bkz. migration
 * 20260920090000). `already_assigned_that_day` ARTIK ÜRETİLMEZ — yerine
 * `daily_package_limit` (v4 günlük tek görev paketi), `half_day_daily_limit`
 * (tarihsel yarım gün kuralı) ve `already_assigned_same_block`
 * (aynı gün+blok başka yer) ayrı ayrı döner; tip geriye uyumluluk için eski
 * değeri de taşır.
 */
export type TaskCandidateReason =
  | "cell_not_open_for_normal"
  | "fixed_duty_day"
  | "already_assigned_same_block"
  | "daily_package_limit"
  | "half_day_daily_limit"
  | "no_preference_for_cell"
  | "time_rule_violation"
  | "weekly_limit_reached"
  | "already_assigned_that_day";

/**
 * Arayüz etiketleri. v4'te toggle'dan bağımsız olarak öğretmen başına günde
 * yalnız bir TENEFFÜS / ÖĞLE_1 / ÖĞLE_2 paketi vardır. Tarihsel planların
 * yarım-gün ve aynı-blok gerekçeleri geriye uyumluluk için korunur.
 */
export const TASK_CANDIDATE_REASON_LABELS: Record<TaskCandidateReason, string> = {
  cell_not_open_for_normal: "Bu blok normal atamaya kapalı (yalnız sabit)",
  fixed_duty_day: "O gün sabit nöbeti var",
  already_assigned_same_block: "Aynı gün aynı blokta başka yerde görevli",
  daily_package_limit: "O gün zaten başka bir normal görev paketi var",
  half_day_daily_limit: "Yarım gün kuralı: o gün normal görev sınırına ulaşmış",
  no_preference_for_cell: "Bu hücre için uygunluk işaretlememiş",
  time_rule_violation: "Ders/zaman kuralı nedeniyle uygun değil",
  weekly_limit_reached: "Haftalık üst sınıra ulaşmış",
  already_assigned_that_day: "O gün başka normal görevi var (eski model)",
};

export interface TaskCandidateDto {
  teacherSourceId: string;
  teacherName: string;
  isCurrent: boolean;
  eligible: boolean;
  reasons: TaskCandidateReason[];
}

export type TaskCandidatesDto =
  | { found: false }
  | { found: true; taskFound: false; planStatus: string; planVersion: number }
  | {
      found: true;
      taskFound: true;
      planStatus: string;
      planVersion: number;
      isFixed: boolean;
      currentAssignment: { teacherSourceId: string | null; teacherName: string | null; assignmentKind: string };
      isStale: boolean;
      currentSourceFingerprint: string | null;
      candidates: TaskCandidateDto[];
    };

export interface UpdateDutyPlanAssignmentInput {
  teacherSourceId: string | null;
  expectedPlanVersion: number;
}

export interface UpdateDutyPlanAssignmentOk {
  status: "ok";
  version: number;
  assignment: {
    taskId: string;
    dayOrder: number;
    dutyLocationId: string;
    dutyBlockId: string;
    teacherSourceId: string | null;
    teacherName: string | null;
    assignmentKind: string;
  };
  summary: Partial<DutyPlanGenerationSummary>;
}

export interface ManualPackageConflictDto {
  id: string;
  coverageMode: DutyPlanPackageCoverageMode;
  dutyLocationId: string;
  assignmentKind: string;
}

export interface UpdateDutyPlanAssignmentErrorBody {
  status:
    | "plan_not_found"
    | "plan_not_draft"
    | "version_conflict"
    | "source_changed"
    | "task_not_found"
    | "fixed_task_immutable"
    | "teacher_not_in_import"
    | "teacher_not_included"
    | "teacher_has_fixed_duty"
    | "teacher_day_conflict"
    | "teacher_block_conflict"
    | "cell_not_open_for_normal"
    | "no_preference_for_cell"
    | "time_rule_violation"
    | "weekly_limit_exceeded"
    | "requires_package_action"
    | "v4_package_action_required"
    | "validation_error"
    | "internal_error"
    | "query_failed";
  message: string;
  currentVersion?: number;
  currentSourceFingerprint?: string | null;
  conflictingPackage?: ManualPackageConflictDto;
  /** requires_package_action ⇔ hücre çok hücreli bir pakete ait; manual-package uç noktasını kullanın (sessiz bölme yok). */
  package?: { id: string; coverageMode: DutyPlanPackageCoverageMode; teacherSourceId: string; teacherName: string; dutyLocationId: string; coveredTaskIds: string[] };
}

export class UpdateDutyPlanAssignmentApiError extends Error {
  body: UpdateDutyPlanAssignmentErrorBody;
  constructor(body: UpdateDutyPlanAssignmentErrorBody) {
    super(body.message);
    this.body = body;
  }
}

export interface RegenerateDutyPlanDraftInput {
  options?: Partial<GenerationOptions>;
  expectedPlanVersion: number;
  /** true ⇔ kullanıcının AYRI, AÇIK onayı — mevcut manuel atamalar SİLİNİR. Varsayılan (false/undefined): manuel atamalar kilitli kısıt olarak korunur. */
  wipeManualAssignments?: boolean;
}

export interface PublishDutyPlanDraftInput {
  expectedPlanVersion: number;
}

export interface PublishDutyPlanDraftOk {
  status: "ok";
  planId: string;
  version: number;
  publishedAt: string;
  archivedPreviousPlanId: string | null;
}

export interface PublishDutyPlanDraftErrorBody {
  status: "plan_not_found" | "plan_not_draft" | "version_conflict" | "source_stale" | "open_tasks_remaining" | "rule_violation" | "validation_error" | "internal_error" | "query_failed";
  message: string;
  currentVersion?: number;
  currentSourceFingerprint?: string | null;
  uncoveredCount?: number;
  reason?: string;
}

export class PublishDutyPlanDraftApiError extends Error {
  body: PublishDutyPlanDraftErrorBody;
  constructor(body: PublishDutyPlanDraftErrorBody) {
    super(body.message);
    this.body = body;
  }
}

export interface PublishedDutyPlanAssignmentDto {
  id: string;
  dayOrder: number;
  dutyLocationId: string;
  dutyLocationName: string;
  dutyBlockId: string;
  dutyBlockName: string;
  teacherSourceId: string | null;
  teacherName: string | null;
  assignmentKind: "fixed" | "generated" | "manual" | "unassigned";
  packageId: string | null;
}

/** Yayımlanmış plan paketi — tarihsel snapshot alanlarıyla (sonraki XML importundan ETKİLENMEZ). */
export interface PublishedDutyPlanPackageDto {
  id: string;
  dayOrder: number;
  dutyLocationId: string;
  dutyLocationName: string;
  teacherSourceId: string;
  teacherName: string;
  coverageMode: DutyPlanPackageCoverageMode;
  assignmentKind: "fixed" | "generated" | "manual";
  coveredBlockCodes: string[];
}

export type PublishedDutyPlanDto =
  | { found: false }
  | {
      found: true;
      id: string;
      status: "published";
      algorithmVersion: string;
      generationOptions: Partial<GenerationOptions>;
      summary: Partial<DutyPlanGenerationSummary>;
      version: number;
      createdAt: string;
      updatedAt: string;
      weekStartDate?: string;
      activeDayOrders?: number[];
      assignments: PublishedDutyPlanAssignmentDto[];
      packages: PublishedDutyPlanPackageDto[];
    };

export type DutyPlanHistoryStatus = "draft" | "published" | "archived";

export interface DutyPlanHistoryListItem {
  id: string;
  weekStartDate: string;
  activeDayOrders: number[];
  status: DutyPlanHistoryStatus;
  version: number;
  algorithmVersion: string;
  createdAt: string;
  updatedAt: string;
  packageCount: number;
  assignedTeacherCount: number;
  priorPointTotal: number;
  weekPointTotal: number;
  projectedWeekPointTotal: number;
  cumulativePointTotal: number;
  normalCoveredCount: number;
  uncoveredCount: number;
}

export interface DutyPlanHistoryListDto { plans: DutyPlanHistoryListItem[] }

export interface DutyPlanTeacherPoints {
  teacherSourceId: string;
  teacherName: string;
  priorPoints: number;
  weekPoints: number;
  totalPoints: number;
  isProjected: boolean;
}

export type DutyPlanHistoryDetailDto =
  | { found: false }
  | (Omit<Extract<PublishedDutyPlanDto, { found: true }>, "status"> & {
      status: DutyPlanHistoryStatus;
      priorScoreSnapshot: Record<string, number>;
      isStale: boolean;
      teacherPoints: DutyPlanTeacherPoints[];
    });

export interface DutyPlanHistoryMutationInput { expectedPlanVersion: number }

export type DutyPlanHistoryMutationResult =
  | { status: "ok" | "already_draft" | "already_archived"; planId: string; version: number }
  | { status: string; planId?: string; currentVersion?: number; currentSourceFingerprint?: string | null };

export interface DutyPlanHistoryMutationErrorBody {
  status: string;
  message: string;
  planId?: string;
  currentVersion?: number;
}

export class DutyPlanHistoryMutationApiError extends Error {
  body: DutyPlanHistoryMutationErrorBody;
  constructor(body: DutyPlanHistoryMutationErrorBody) {
    super(body.message);
    this.body = body;
  }
}

export const WEEKDAY_NAMES: Record<number, string> = {
  1: "Pazartesi",
  2: "Salı",
  3: "Çarşamba",
  4: "Perşembe",
  5: "Cuma",
};

/**
 * Uygun olmayan öğretmen gerekçesi (detay panelinde gösterilir). Backend
 * öğretmen bazında "uygunluk işaretlenmemiş" ile "ders/zaman çakışması"
 * ayrımını DÖNDÜRMEZ (yalnız candidateEdges — geçerli/geçersiz, ayrım yok);
 * bu yüzden bu ikisi TEK birleşik, dürüst bir gerekçede toplanır —
 * ayrıştırılamayan bir şeyi ayrıştırıyormuş gibi göstermek YANLIŞ bilgi
 * verir. period_configuration_missing yalnız BLOK seviyesinde (aggregate)
 * bilinir, hangi öğretmeni etkilediği bilinmez — bu yüzden bireysel bir
 * öğretmene ASLA bu gerekçe atanmaz; yalnız blok seviyesinde ayrı bir
 * uyarı olarak gösterilir (bkz. sayfadaki configErrorForBlock).
 */
/**
 * ESKİ istemci-taraflı sınıflandırma kümesi.
 *
 * ARTIK GÖREV DETAY PANELİNDE KULLANILMAZ: aday listesi AUTHORITATIVE
 * `get_duty_plan_task_candidates` RPC'sinden okunur (bkz.
 * fetchDutyPlanTaskCandidates). `already_assigned_that_day` eski "günde tek
 * görev" modelini varsayıyordu ve yarım gün kuralı KAPALI öğretmenleri
 * yanlışlıkla eliyordu. Tip ve yardımcı, eski birim testleri ve geriye
 * uyumluluk için korunur.
 */
export type IneligibilityReason = "fixed_duty_day" | "already_assigned_that_day" | "weekly_limit_reached" | "availability_or_time_conflict";

export const INELIGIBILITY_REASON_LABELS: Record<IneligibilityReason, string> = {
  fixed_duty_day: "O gün sabit nöbeti var",
  already_assigned_that_day: "O gün başka normal görevi var",
  weekly_limit_reached: "Haftalık üst sınıra ulaşmış",
  availability_or_time_conflict: "Uygunluk işaretlenmemiş veya ders/zaman çakışması var",
};

/**
 * Bir öğretmenin belirli bir hücre için TEK merkezi durumu — hem "uygun"
 * hem "uygun olmayan" listesi AYNI değerlendirmeden türetilir, iki ayrı
 * ayrışabilecek karar mantığı YOKTUR (bkz. classifyTeacherForCell).
 * Öncelik sırası: current > fixed_duty_day > already_assigned_that_day >
 * weekly_limit_reached > eligible > availability_or_time_conflict.
 */
export type CellCandidateStatus = "current" | "eligible" | IneligibilityReason;

export interface CellCandidateClassification {
  teacherSourceId: string;
  teacherName: string;
  status: CellCandidateStatus;
}

export function isEligibleStatus(status: CellCandidateStatus): boolean {
  return status === "current" || status === "eligible";
}

/**
 * TEK merkezi karar fonksiyonu — bir hücre için her öğretmenin durumunu
 * belirler. `hasCandidateEdge` yalnız TEMEL hücre uygunluğunu gösterir
 * (backend'in candidateEdges'i); mevcut taslaktaki GÜNLÜK TEKİLLİK ve
 * HAFTALIK LİMİT burada AYRICA uygulanır — candidateEdges'te olmak tek
 * başına "Uygun öğretmenler" listesine girmeye YETMEZ.
 */
export function classifyTeacherForCell(params: {
  teacherSourceId: string;
  isCurrentAssignee: boolean;
  hasFixedDutyThatDay: boolean;
  hasOtherNormalDutyThatDay: boolean;
  totalWeeklyLoad: number | null;
  maxWeeklyDuties: number;
  hasCandidateEdge: boolean;
}): CellCandidateStatus {
  if (params.isCurrentAssignee) return "current";
  if (params.hasFixedDutyThatDay) return "fixed_duty_day";
  if (params.hasOtherNormalDutyThatDay) return "already_assigned_that_day";
  if (params.totalWeeklyLoad !== null && params.totalWeeklyLoad >= params.maxWeeklyDuties) return "weekly_limit_reached";
  if (params.hasCandidateEdge) return "eligible";
  return "availability_or_time_conflict";
}

// ============================================================================
// Dağıtım tercihleri form doğrulaması — backend'in normalizeGenerationOptions
// ile AYNI kuralları (integer, 0-3, min<=target<=max, seed opsiyonel integer)
// istemcide de uygular; backend doğrulaması bununla DEĞİŞTİRİLMEZ, korunur.
// ============================================================================
export type GenerationOptionsFieldErrors = Partial<Record<"minWeeklyDuties" | "targetWeeklyDuties" | "maxWeeklyDuties" | "seed", string>>;

export interface GenerationOptionsValidation {
  valid: boolean;
  fieldErrors: GenerationOptionsFieldErrors;
}

function isIntegerInRange(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= 3;
}

export function validateGenerationOptions(options: {
  minWeeklyDuties: number;
  targetWeeklyDuties: number;
  maxWeeklyDuties: number;
  seed?: number;
}): GenerationOptionsValidation {
  const fieldErrors: GenerationOptionsFieldErrors = {};

  if (!isIntegerInRange(options.minWeeklyDuties)) fieldErrors.minWeeklyDuties = "0 ile 3 arasında bir tam sayı olmalı.";
  if (!isIntegerInRange(options.targetWeeklyDuties)) fieldErrors.targetWeeklyDuties = "0 ile 3 arasında bir tam sayı olmalı.";
  if (!Number.isInteger(options.maxWeeklyDuties) || options.maxWeeklyDuties < 0 || options.maxWeeklyDuties > 3) {
    fieldErrors.maxWeeklyDuties = "0 ile 3 arasında bir tam sayı olmalı; dördüncü nöbet verilmez.";
  }

  if (
    !fieldErrors.minWeeklyDuties &&
    !fieldErrors.targetWeeklyDuties &&
    !fieldErrors.maxWeeklyDuties &&
    !(options.minWeeklyDuties <= options.targetWeeklyDuties && options.targetWeeklyDuties <= options.maxWeeklyDuties)
  ) {
    fieldErrors.targetWeeklyDuties = "min ≤ hedef ≤ max olmalı.";
  }

  if (options.seed !== undefined && !(Number.isFinite(options.seed) && Number.isInteger(options.seed))) {
    fieldErrors.seed = "Seed bir tam sayı olmalı.";
  }

  return { valid: Object.keys(fieldErrors).length === 0, fieldErrors };
}

// ============================================================================
// Manuel PAKET (FULL_DAY/SHORT_BREAKS/SINGLE_BLOCK) — çok hücreli manuel atama
// ============================================================================

export type ManualPackageCoverageMode = "FULL_DAY" | "SHORT_BREAKS" | "SINGLE_BLOCK";

export const MANUAL_PACKAGE_COVERAGE_MODE_LABELS: Record<ManualPackageCoverageMode, string> = {
  FULL_DAY: "Bu nöbet yerine tüm gün ata",
  SHORT_BREAKS: "Teneffüs (Sabah + Öğleden Sonra) ata",
  SINGLE_BLOCK: "Bu blok için ata",
};

export interface ManualPackageInput {
  dayOrder: number;
  dutyLocationId: string;
  /** null ⇔ paketi kaldır (unassigned). */
  teacherSourceId: string | null;
  coverageMode: ManualPackageCoverageMode;
  /** Yalnız coverageMode=SINGLE_BLOCK iken zorunlu. */
  dutyBlockId?: string;
}

export interface ManualPackageTargetTaskDto {
  id: string;
  dutyBlockId: string;
  dutyBlockName: string;
  currentTeacherSourceId: string | null;
  currentTeacherName: string | null;
  currentAssignmentKind: string;
  currentPackageId: string | null;
}

export interface ManualPackageAffectedTaskDto {
  id: string;
  dutyBlockId: string;
  dutyBlockName: string;
  currentTeacherSourceId: string | null;
  currentTeacherName: string | null;
  packageId: string | null;
}

export type PreviewDutyPlanManualPackageResult =
  | { found: false }
  | { found: true; eligible: false; reasons: string[]; targetTaskIds?: undefined; affectedTasks?: undefined }
  | {
      found: true;
      planStatus: string;
      planVersion: number;
      targetTaskIds: string[];
      targetTasks: ManualPackageTargetTaskDto[];
      affectedTasks: ManualPackageAffectedTaskDto[];
      eligible: boolean;
      reasons: string[];
      conflictingPackage: ManualPackageConflictDto | null;
    };

export interface SetDutyPlanManualPackageInput extends ManualPackageInput {
  expectedPlanVersion: number;
  /** Bir ÖNCEKİ preview'dan gelen affectedTasks id kümesi — açık onay için. */
  expectedAffectedTaskIds?: string[] | null;
}

export interface SetDutyPlanManualPackageOk {
  status: "ok";
  version: number;
  packageId: string | null;
  summary: Partial<DutyPlanGenerationSummary>;
}

export interface SetDutyPlanManualPackageErrorBody {
  status:
    | "plan_not_found"
    | "plan_not_draft"
    | "version_conflict"
    | "source_changed"
    | "invalid_package_combination"
    | "task_not_found"
    | "fixed_task_immutable"
    | "requires_confirmation"
    | "stale_affected_set"
    | "teacher_not_in_import"
    | "teacher_not_included"
    | "teacher_has_fixed_duty"
    | "teacher_day_conflict"
    | "teacher_block_conflict"
    | "cell_not_open_for_normal"
    | "normal_package_must_be_single_block"
    | "no_preference_for_cell"
    | "time_rule_violation"
    | "weekly_limit_exceeded"
    | "validation_error"
    | "internal_error"
    | "query_failed";
  message: string;
  currentVersion?: number;
  currentSourceFingerprint?: string | null;
  affectedTasks?: ManualPackageAffectedTaskDto[];
  conflictingPackage?: ManualPackageConflictDto;
}

export class SetDutyPlanManualPackageApiError extends Error {
  body: SetDutyPlanManualPackageErrorBody;
  constructor(body: SetDutyPlanManualPackageErrorBody) {
    super(body.message);
    this.body = body;
  }
}
