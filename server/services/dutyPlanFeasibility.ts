import type { SupabaseClient } from "@supabase/supabase-js";
import type { DutyBlockCode, DutyBlockDto } from "./dutyBlocks";
import { fetchCurrentDutyPlanDraft } from "./dutyPlanDrafts";
import { buildV4Input, fetchDutyPlanGenerationSnapshot } from "./dutyPlanGeneration";
import { normalizeGenerationOptions, type GenerationOptions } from "../lib/dutyPlanning/solver";
import { solveDutyPlanV4 } from "../lib/dutyPlanning/solverV4";

/**
 * "Planlanabilirlik Analizi" — SALT OKUNUR. Bu servis hiçbir nöbet planı
 * üretmez ve hiçbir atama yazmaz. Generation snapshot içindeki günlük analizi
 * ve aynı snapshot üzerinde çalışan solver-v3 haftalık kapasite önizlemesini
 * birlikte döndürür.
 */
export class DutyPlanFeasibilityQueryError extends Error {}

/** Karşılanamayan bir görevin gerekçesi. RPC ile birebir aynı küme. */
export type UncoveredTaskReason =
  /** Sabit nöbete uygun yer, o gün sabit öğretmeni atanmamış. */
  | "missing_fixed_assignment"
  /** Hiç aday öğretmen yok (uygunluk beyanı yok ya da ders çakışması elemiş). */
  | "no_candidate"
  /** Adayı var, ancak günlük kapasite/aynı-blok tekilliği nedeniyle başka görevlere gerekiyor. */
  | "matching_conflict";

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

export interface FeasibilityBlockSummary {
  blockId: string;
  blockCode: DutyBlockCode;
  blockName: string;
  blockOrder: number;
  required: number;
  fixedRequired: number;
  fixedCovered: number;
  fixedMissing: number;
  normalRequired: number;
  /**
   * Bloğu TEK BAŞINA ele alan naif karşılaştırmanın açığı
   * (normalRequired - aday sayısı). Yalnız kıyas için gösterilir.
   */
  independentShortfall: number;
  /**
   * Öğretmenin half_day_rule_enabled değerine göre günlük kapasitesini ve
   * aynı-blok tekilliğini uygulayan günlük maksimum eşleştirme sonrasındaki
   * açık. Haftalık önizleme için `weeklyCapacity` kullanılmalıdır.
   */
  matchingUncovered: number;
  candidateTeacherCount: number;
}

export interface FeasibilityUncoveredTask {
  dutyLocationId: string;
  dutyLocationName: string;
  shortCode: string;
  blockId: string;
  blockCode: DutyBlockCode;
  blockName: string;
  kind: "fixed" | "normal";
  /** Normal görevler için aday sayısı; sabit görevlerde null. */
  candidateCount: number | null;
  reason: UncoveredTaskReason;
}

export interface FeasibilityMissingFixed {
  dutyLocationId: string;
  dutyLocationName: string;
  shortCode: string;
  blockCodes: DutyBlockCode[];
}

export interface FeasibilityLessonConflict {
  blockId: string;
  blockCode: DutyBlockCode;
  blockName: string;
  periodName: string;
  /** O blokta uygunluk beyan etmiş ama çakışan dersi olduğu için elenen öğretmen sayısı. */
  teacherCount: number;
}

export interface FeasibilityFixedAssignment {
  teacherSourceId: string;
  teacherName: string;
  dutyLocationId: string;
  dutyLocationName: string;
  shortCode: string;
}

export interface FeasibilityDay {
  order: number;
  name: string;
  totals: FeasibilityDayTotals;
  blocks: FeasibilityBlockSummary[];
  uncoveredTasks: FeasibilityUncoveredTask[];
  missingFixedAssignments: FeasibilityMissingFixed[];
  excludedByLessonConflict: FeasibilityLessonConflict[];
  /**
   * Ders çakışması SAYILMAZ: güncel importta hedef/komşu periyot tanımı
   * eksik olduğu için elenenler (reasonCode=period_configuration_missing).
   * RPC bunu `excludedByLessonConflict`'ten AYRI döner (bkz.
   * 20260913090000_add_adjacent_period_duty_eligibility.sql bölüm 5) — bu
   * alan önceden yalnız RPC çıktısındaydı, TS tipinde eksikti.
   */
  excludedByConfigurationError: FeasibilityLessonConflict[];
  fixedAssignments: FeasibilityFixedAssignment[];
}

export interface FeasibilitySummary {
  totalRequiredTasks: number;
  totalCoveredTasks: number;
  totalUncoveredTasks: number;
  daysWithShortfall: number[];
  feasible: boolean;
}

/**
 * Günleri birbirinden bağımsız ele alan SQL analizinin yanında, otomatik plan
 * motorunun haftalık üst sınır ve günlük blok kapasiteleriyle hesapladığı
 * gerçek azami kapsama. Bu önizleme hiçbir plan/atama yazmaz.
 */
export interface WeeklyCapacityPreview {
  algorithmVersion: string;
  /** Aktif taslak varsa onun ayarları; yoksa solver varsayılanları kullanılır. */
  optionsSource: "current_draft" | "defaults";
  sourceDraftId: string | null;
  optionsUsed: GenerationOptions;
  teacherCount: number;
  totalTaskCount: number;
  fixedTaskCount: number;
  fixedCoveredCount: number;
  normalTaskCount: number;
  normalMaxCoverableCount: number;
  totalMaxCoverableCount: number;
  totalUncoveredCount: number;
  feasible: boolean;
  coverageOptimalityProven: boolean;
  loadUnits: {
    normalRequiredUnits: number;
    fixedRequiredUnits: number;
    fixedCoveredUnits: number;
    fixedUncoveredUnits: number;
    totalRequiredLoadUnits: number;
    aggregateTeacherCapacity: number;
    aggregateCapacitySlack: number;
    rawTaskCells: number;
    malformedFixedGroups: unknown[];
  };
}

export type DutyPlanFeasibility =
  | { hasImport: false }
  | {
      hasImport: true;
      importedAt: string | null;
      analyzedAt: string;
      blocks: DutyBlockDto[];
      days: FeasibilityDay[];
      summary: FeasibilitySummary;
      weeklyCapacity: WeeklyCapacityPreview;
    };

export async function fetchDutyPlanFeasibility(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
): Promise<DutyPlanFeasibility> {
  // Generation snapshot günlük analizi zaten AUTHORITATIVE biçimde içerir.
  // Aynı snapshot'ı solver-v4'e vererek iki ekranın görev/aday evrenlerinin
  // ayrışmasını önleriz; ayrıca ikinci bir SQL iş kuralı yazmayız.
  const snapshot = await fetchDutyPlanGenerationSnapshot(supabase, campusName, academicYearName);
  if (!snapshot.hasImport) return { hasImport: false };

  let currentDraft: Awaited<ReturnType<typeof fetchCurrentDutyPlanDraft>> = { found: false };
  try {
    currentDraft = await fetchCurrentDutyPlanDraft(supabase, campusName, academicYearName);
  } catch {
    // Aktif taslak bilgisi yalnız ayar kaynağıdır. Okunamaması günlük/haftalık
    // analizi düşürmez; açıkça solver varsayılanlarına geri dönülür.
  }

  const optionsSource = currentDraft.found ? "current_draft" : "defaults";
  const options = normalizeGenerationOptions(
    currentDraft.found ? (currentDraft.generationOptions as Partial<GenerationOptions>) : undefined,
  );
  const fixedTasks = snapshot.tasks.filter((task) => task.kind === "fixed");
  const normalTasks = snapshot.tasks.filter((task) => task.kind === "normal");
  const solved = solveDutyPlanV4(buildV4Input(snapshot, normalTasks, new Map(), options));
  if (solved.status !== "ok") {
    throw new DutyPlanFeasibilityQueryError("Haftalık kapasite önizlemesi hesaplanamadı.");
  }

  const fixedCoveredCount = fixedTasks.filter((task) => task.fixedCoveredByTeacherSourceId !== null).length;
  const totalMaxCoverableCount = fixedCoveredCount + solved.assignedTaskCount;
  const fixedGroups = new Map<string, typeof fixedTasks>();
  for (const task of fixedTasks) {
    const key = `${task.dayOrder}|${task.dutyLocationId}`;
    const list = fixedGroups.get(key) ?? [];
    list.push(task);
    fixedGroups.set(key, list);
  }
  const fixedRequiredUnits = fixedGroups.size;
  const fixedCoveredUnits = [...fixedGroups.values()].filter((tasks) => {
    const teachers = new Set(tasks.map((task) => task.fixedCoveredByTeacherSourceId).filter(Boolean));
    return teachers.size === 1 && tasks.every((task) => task.fixedCoveredByTeacherSourceId !== null);
  }).length;
  const aggregateTeacherCapacity = snapshot.teachers.length * options.maxWeeklyDuties;
  const totalRequiredLoadUnits = solved.totalPackageCount + fixedRequiredUnits;
  const weeklyCapacity: WeeklyCapacityPreview = {
    algorithmVersion: solved.algorithmVersion,
    optionsSource,
    sourceDraftId: currentDraft.found ? currentDraft.id : null,
    optionsUsed: options,
    teacherCount: snapshot.teachers.length,
    totalTaskCount: snapshot.tasks.length,
    fixedTaskCount: fixedTasks.length,
    fixedCoveredCount,
    normalTaskCount: normalTasks.length,
    normalMaxCoverableCount: solved.assignedTaskCount,
    totalMaxCoverableCount,
    totalUncoveredCount: snapshot.tasks.length - totalMaxCoverableCount,
    feasible: totalMaxCoverableCount === snapshot.tasks.length,
    coverageOptimalityProven: solved.coverageOptimalityProven,
    loadUnits: {
      normalRequiredUnits: solved.totalPackageCount,
      fixedRequiredUnits,
      fixedCoveredUnits,
      fixedUncoveredUnits: fixedRequiredUnits - fixedCoveredUnits,
      totalRequiredLoadUnits,
      aggregateTeacherCapacity,
      aggregateCapacitySlack: aggregateTeacherCapacity - totalRequiredLoadUnits,
      rawTaskCells: snapshot.tasks.length,
      malformedFixedGroups: [],
    },
  };

  return {
    ...snapshot.feasibility,
    hasImport: true,
    weeklyCapacity,
  } as DutyPlanFeasibility;
}
