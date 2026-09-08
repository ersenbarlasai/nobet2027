import type { PublishedDutyPlanAssignmentDto, PublishedDutyPlanPackageDto } from "../../dutyPlanDrafts/types";
import type { FoundPublishedDutyPlan } from "../buildPublishedDutyPlanWorkbook";

export const LOC_BAHCE = "loc-bahce";
export const LOC_KORIDOR = "loc-koridor";

export const BLK_MORNING = "blk-morning";
export const BLK_LONG1 = "blk-long1";
export const BLK_LONG2 = "blk-long2";
export const BLK_AFTERNOON = "blk-afternoon";

// Tarihsel SNAPSHOT isimleri — sonraki bir XML importunda canlı tabloda
// değişseler bile yayımlanmış planın çıktısı BUNLARI göstermelidir.
export const SNAPSHOT_LOCATION_BAHCE = "Bahçe (Eski Ad — Snapshot)";
export const SNAPSHOT_LOCATION_KORIDOR = "İlkokul Koridor";

export function assignment(overrides: Partial<PublishedDutyPlanAssignmentDto> = {}): PublishedDutyPlanAssignmentDto {
  return {
    id: "a-x",
    dayOrder: 1,
    dutyLocationId: LOC_BAHCE,
    dutyLocationName: SNAPSHOT_LOCATION_BAHCE,
    dutyBlockId: BLK_MORNING,
    dutyBlockName: "Sabah Teneffüs Bloğu",
    teacherSourceId: "T1",
    teacherName: "Ayşe Yılmaz",
    assignmentKind: "generated",
    packageId: null,
    ...overrides,
  };
}

export function dutyPackage(overrides: Partial<PublishedDutyPlanPackageDto> = {}): PublishedDutyPlanPackageDto {
  return {
    id: "pkg-x",
    dayOrder: 1,
    dutyLocationId: LOC_BAHCE,
    dutyLocationName: SNAPSHOT_LOCATION_BAHCE,
    teacherSourceId: "T1",
    teacherName: "Ayşe Yılmaz",
    coverageMode: "FULL_DAY",
    assignmentKind: "generated",
    coveredBlockCodes: ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"],
    ...overrides,
  };
}

export function publishedPlan(overrides: Partial<FoundPublishedDutyPlan> = {}): FoundPublishedDutyPlan {
  return {
    found: true,
    id: "plan-1",
    status: "published",
    algorithmVersion: "duty-plan-solver-v1",
    generationOptions: { minWeeklyDuties: 1, targetWeeklyDuties: 2, maxWeeklyDuties: 3, balanceWorkload: true, diversifyAreas: true, allowPartial: true },
    summary: {
      teacherLoads: [
        { teacherSourceId: "T1", normalDutyCount: 4, fixedDutyDayCount: 0, totalDutyCount: 4 },
        { teacherSourceId: "T5", normalDutyCount: 0, fixedDutyDayCount: 2, totalDutyCount: 2 },
      ],
    },
    version: 3,
    createdAt: "2026-09-10T09:00:00.000Z",
    updatedAt: "2026-09-11T10:30:00.000Z",
    assignments: [],
    packages: [],
    ...overrides,
  };
}

/**
 * Dört blok × iki gün, paketli tam plan:
 * - `pkg-full`  : T1 / Pazartesi / Bahçe / FULL_DAY (4 hücre, TEK paket)
 * - `pkg-fixed` : T5 / Pazartesi / Koridor / FIXED_SHORT_BREAKS (2 hücre)
 * - `pkg-short` : T5 / Salı / Bahçe / SHORT_BREAKS (2 hücre, manuel)
 * - `pkg-single`: T2 / Salı / Koridor / SINGLE_BLOCK (1 hücre)
 */
export function fullPublishedPlan(): FoundPublishedDutyPlan {
  return publishedPlan({
    assignments: [
      assignment({ id: "a1", dutyBlockId: BLK_MORNING, dutyBlockName: "Sabah Teneffüs Bloğu", packageId: "pkg-full" }),
      assignment({ id: "a2", dutyBlockId: BLK_LONG1, dutyBlockName: "Uzun Nöbet 1", packageId: "pkg-full" }),
      assignment({ id: "a3", dutyBlockId: BLK_LONG2, dutyBlockName: "Uzun Nöbet 2", packageId: "pkg-full" }),
      assignment({ id: "a4", dutyBlockId: BLK_AFTERNOON, dutyBlockName: "Öğleden Sonra Teneffüs Bloğu", packageId: "pkg-full" }),
      assignment({
        id: "a5",
        dutyLocationId: LOC_KORIDOR,
        dutyLocationName: SNAPSHOT_LOCATION_KORIDOR,
        dutyBlockId: BLK_MORNING,
        dutyBlockName: "Sabah Teneffüs Bloğu",
        teacherSourceId: "T5",
        teacherName: "Deniz Kaya",
        assignmentKind: "fixed",
        packageId: "pkg-fixed",
      }),
      assignment({
        id: "a6",
        dutyLocationId: LOC_KORIDOR,
        dutyLocationName: SNAPSHOT_LOCATION_KORIDOR,
        dutyBlockId: BLK_AFTERNOON,
        dutyBlockName: "Öğleden Sonra Teneffüs Bloğu",
        teacherSourceId: "T5",
        teacherName: "Deniz Kaya",
        assignmentKind: "fixed",
        packageId: "pkg-fixed",
      }),
      assignment({ id: "a7", dayOrder: 2, dutyBlockId: BLK_MORNING, dutyBlockName: "Sabah Teneffüs Bloğu", teacherSourceId: "T5", teacherName: "Deniz Kaya", assignmentKind: "manual", packageId: "pkg-short" }),
      assignment({ id: "a8", dayOrder: 2, dutyBlockId: BLK_AFTERNOON, dutyBlockName: "Öğleden Sonra Teneffüs Bloğu", teacherSourceId: "T5", teacherName: "Deniz Kaya", assignmentKind: "manual", packageId: "pkg-short" }),
      assignment({
        id: "a9",
        dayOrder: 2,
        dutyLocationId: LOC_KORIDOR,
        dutyLocationName: SNAPSHOT_LOCATION_KORIDOR,
        dutyBlockId: BLK_LONG1,
        dutyBlockName: "Uzun Nöbet 1",
        teacherSourceId: "T2",
        teacherName: "Can Demir",
        packageId: "pkg-single",
      }),
    ],
    packages: [
      dutyPackage({ id: "pkg-full" }),
      dutyPackage({
        id: "pkg-fixed",
        dutyLocationId: LOC_KORIDOR,
        dutyLocationName: SNAPSHOT_LOCATION_KORIDOR,
        teacherSourceId: "T5",
        teacherName: "Deniz Kaya",
        coverageMode: "FIXED_SHORT_BREAKS",
        assignmentKind: "fixed",
        coveredBlockCodes: ["MORNING_BREAKS", "AFTERNOON_BREAKS"],
      }),
      dutyPackage({
        id: "pkg-short",
        dayOrder: 2,
        teacherSourceId: "T5",
        teacherName: "Deniz Kaya",
        coverageMode: "SHORT_BREAKS",
        assignmentKind: "manual",
        coveredBlockCodes: ["MORNING_BREAKS", "AFTERNOON_BREAKS"],
      }),
      dutyPackage({
        id: "pkg-single",
        dayOrder: 2,
        dutyLocationId: LOC_KORIDOR,
        dutyLocationName: SNAPSHOT_LOCATION_KORIDOR,
        teacherSourceId: "T2",
        teacherName: "Can Demir",
        coverageMode: "SINGLE_BLOCK",
        assignmentKind: "generated",
        coveredBlockCodes: ["LONG_BREAK_1"],
      }),
    ],
  });
}
