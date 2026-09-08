import type { DutyBlock, DutyBlockCode } from "../dutyLocations/types";

export type { DutyBlock, DutyBlockCode };

/** Karşılanamayan bir görevin gerekçesi (RPC ile birebir aynı küme). */
export type UncoveredTaskReason =
  /** Yalnız sabit atamayla karşılanan bir yer × blok görevi (assignment_mode='fixed_only'), o gün sabit öğretmeni atanmamış. */
  | "missing_fixed_assignment"
  /** Hiç aday öğretmen yok (uygunluk beyanı yok ya da zaman kuralı elemiş). */
  | "no_candidate"
  /** Adayı var ama günlük kapasite/aynı-blok tekilliği nedeniyle başka görevlere gerekiyor. */
  | "matching_conflict";

export const UNCOVERED_REASON_LABELS: Record<UncoveredTaskReason, string> = {
  missing_fixed_assignment: "Sabit öğretmen atanmamış",
  no_candidate: "Uygun öğretmen yok",
  matching_conflict: "Adaylar başka göreve gerekiyor",
};

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
  /** Bloğu tek başına ele alan naif karşılaştırmanın açığı — yalnız kıyas için. */
  independentShortfall: number;
  /** Öğretmenin yarım gün ayarını ve aynı-blok tekilliğini uygulayan günlük eşleştirme sonrası açık. */
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
   * eksik olduğu için elenenler. RPC bunu `excludedByLessonConflict`'ten
   * AYRI döner — konfigürasyon hatası ders çakışması olarak GÖSTERİLMEMELİ.
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

export interface WeeklyCapacityLoadUnits {
  normalRequiredUnits: number;
  fixedRequiredUnits: number;
  fixedCoveredUnits: number;
  fixedUncoveredUnits: number;
  totalRequiredLoadUnits: number;
  aggregateTeacherCapacity: number;
  aggregateCapacitySlack: number;
  rawTaskCells: number;
  malformedFixedGroups: unknown[];
}

/** Otomatik plan motorunun haftalık sınırları uygulayan salt-okunur önizlemesi. */
export interface WeeklyCapacityPreview {
  algorithmVersion: string;
  optionsSource: "current_draft" | "defaults";
  sourceDraftId: string | null;
  optionsUsed: {
    minWeeklyDuties: number;
    targetWeeklyDuties: number;
    maxWeeklyDuties: number;
    balanceWorkload: boolean;
    diversifyAreas: boolean;
    allowPartial: boolean;
    seed?: number;
  };
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
  loadUnits: WeeklyCapacityLoadUnits;
}

export type DutyPlanFeasibilityResponse =
  | { hasImport: false }
  | {
      hasImport: true;
      importedAt: string | null;
      analyzedAt: string;
      blocks: DutyBlock[];
      days: FeasibilityDay[];
      summary: FeasibilitySummary;
      weeklyCapacity: WeeklyCapacityPreview;
    };
