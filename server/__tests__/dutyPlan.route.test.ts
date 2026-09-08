import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createApp } from "../index";
import type { AppConfig } from "../config";

const FAKE_SECRET = "sb_secret_TEST_VALUE_MUST_NEVER_LEAK_9f8a7c";
const ORIGIN = "http://localhost:5173";

function testConfig(): AppConfig {
  return {
    supabaseUrl: "https://example.supabase.co",
    supabaseSecretKey: FAKE_SECRET,
    port: 3001,
    allowedOrigin: ORIGIN,
    campusName: "Test Kampüs",
    academicYearName: "2026-2027",
  };
}

function fakeSupabase(rpcImpl: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }>): SupabaseClient {
  return { rpc: vi.fn(rpcImpl) } as unknown as SupabaseClient;
}

const BLOCK_ID = "aaaaaaaa-0000-0000-0000-000000000002";
const LOCATION_ID = "22222222-2222-2222-2222-222222222222";

function feasibilityPayload() {
  return {
    hasImport: true,
    importedAt: "2026-09-01T10:00:00.000Z",
    analyzedAt: "2026-09-10T09:00:00.000Z",
    blocks: [{ id: BLOCK_ID, code: "LONG_BREAK_1", name: "Uzun Nöbet 1", blockOrder: 2, conflictPeriodName: "5-OO" }],
    days: [
      {
        order: 1,
        name: "Pazartesi",
        totals: {
          requiredTasks: 3,
          coveredTasks: 1,
          uncoveredTasks: 2,
          fixedRequired: 1,
          fixedCovered: 0,
          fixedMissing: 1,
          normalRequired: 2,
          normalMatched: 1,
          normalUncovered: 1,
          candidateTeacherCount: 1,
        },
        blocks: [
          {
            blockId: BLOCK_ID,
            blockCode: "LONG_BREAK_1",
            blockName: "Uzun Nöbet 1",
            blockOrder: 2,
            required: 2,
            fixedRequired: 0,
            fixedCovered: 0,
            fixedMissing: 0,
            normalRequired: 2,
            // Naif sayım "yeterli aday var" der (2 görev, 1 aday → 1),
            // eşleştirme gerçek açığı gösterir.
            independentShortfall: 1,
            matchingUncovered: 1,
            candidateTeacherCount: 1,
          },
        ],
        uncoveredTasks: [
          {
            dutyLocationId: LOCATION_ID,
            dutyLocationName: "Yemekhane",
            shortCode: "YEMEK",
            blockId: BLOCK_ID,
            blockCode: "LONG_BREAK_1",
            blockName: "Uzun Nöbet 1",
            kind: "normal",
            candidateCount: 0,
            reason: "no_candidate",
          },
        ],
        missingFixedAssignments: [],
        excludedByLessonConflict: [],
        fixedAssignments: [],
      },
    ],
    summary: {
      totalRequiredTasks: 3,
      totalCoveredTasks: 1,
      totalUncoveredTasks: 2,
      daysWithShortfall: [1],
      feasible: false,
    },
  };
}

function generationSnapshotPayload() {
  const feasibility = feasibilityPayload();
  return {
    hasImport: true,
    campusId: "11111111-1111-1111-1111-111111111111",
    academicYearId: "22222222-2222-2222-2222-222222222222",
    timetableImportId: "33333333-3333-3333-3333-333333333333",
    importedAt: feasibility.importedAt,
    sourceFingerprint: "source-fingerprint",
    days: [{ order: 1, name: "Pazartesi" }],
    blocks: feasibility.blocks,
    locations: [],
    tasks: [
      {
        dayOrder: 1,
        dutyLocationId: "fixed-location",
        dutyLocationName: "Sabit Yer",
        shortCode: "SABIT",
        category: "Kat",
        dutyBlockId: BLOCK_ID,
        blockCode: "LONG_BREAK_1",
        blockName: "Uzun Nöbet 1",
        blockOrder: 2,
        kind: "fixed",
        fixedCoveredByTeacherSourceId: null,
        fixedCoveredByTeacherName: null,
      },
      ...[LOCATION_ID, "44444444-4444-4444-4444-444444444444"].map((dutyLocationId) => ({
        dayOrder: 1,
        dutyLocationId,
        dutyLocationName: "Normal Yer",
        shortCode: "NORMAL",
        category: "Bahçe",
        dutyBlockId: BLOCK_ID,
        blockCode: "LONG_BREAK_1",
        blockName: "Uzun Nöbet 1",
        blockOrder: 2,
        kind: "normal",
        fixedCoveredByTeacherSourceId: null,
        fixedCoveredByTeacherName: null,
      })),
    ],
    teachers: [{ teacherSourceId: "T1", teacherName: "Öğretmen 1", halfDayRuleEnabled: true, maxDailyNormalBlocks: 1 }],
    candidateEdges: [LOCATION_ID, "44444444-4444-4444-4444-444444444444"].map((dutyLocationId) => ({
      dayOrder: 1,
      dutyLocationId,
      dutyBlockId: BLOCK_ID,
      teacherSourceId: "T1",
      teacherName: "Öğretmen 1",
    })),
    teacherFixedDutyLoads: [],
    feasibility,
    configurationErrors: [],
  };
}

describe("GET /api/duty-plan/feasibility", () => {
  it("1) günlük analizle haftalık solver önizlemesini birlikte döner", async () => {
    const snapshot = generationSnapshotPayload();
    const supabase = fakeSupabase(async (fn) =>
      fn === "get_current_duty_plan_draft" ? { data: { found: false }, error: null } : { data: snapshot, error: null },
    );
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/duty-plan/feasibility").set("Origin", ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual(snapshot.feasibility.summary);
    expect(res.body.weeklyCapacity).toMatchObject({
      optionsSource: "defaults",
      teacherCount: 1,
      totalTaskCount: 3,
      fixedTaskCount: 1,
      fixedCoveredCount: 0,
      normalTaskCount: 2,
      normalMaxCoverableCount: 1,
      totalMaxCoverableCount: 1,
      totalUncoveredCount: 2,
      feasible: false,
      coverageOptimalityProven: true,
      optionsUsed: { minWeeklyDuties: 1, targetWeeklyDuties: 2, maxWeeklyDuties: 3 },
    });
    expect(supabase.rpc).toHaveBeenCalledWith("get_duty_plan_generation_snapshot", {
      p_campus_name: "Test Kampüs",
      p_academic_year_name: "2026-2027",
    });
  });

  it("1b) aktif taslak varsa haftalık önizleme onun üretim ayarlarını kullanır", async () => {
    const snapshot = generationSnapshotPayload();
    const supabase = fakeSupabase(async (fn) =>
      fn === "get_current_duty_plan_draft"
        ? {
            data: {
              found: true,
              id: "draft-1",
              generationOptions: { minWeeklyDuties: 0, targetWeeklyDuties: 4, maxWeeklyDuties: 5 },
            },
            error: null,
          }
        : { data: snapshot, error: null },
    );
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/duty-plan/feasibility").set("Origin", ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body.weeklyCapacity).toMatchObject({
      optionsSource: "current_draft",
      sourceDraftId: "draft-1",
      optionsUsed: { minWeeklyDuties: 0, targetWeeklyDuties: 4, maxWeeklyDuties: 5 },
    });
  });

  it("2) import yokken hasImport:false döner (hata sayılmaz)", async () => {
    const supabase = fakeSupabase(async () => ({ data: { hasImport: false }, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/duty-plan/feasibility").set("Origin", ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasImport: false });
  });

  it("3) RPC hatasında güvenli 500 döner; secret/stack sızdırmaz", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "boom", stack: "at foo.js:1:1" } }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/duty-plan/feasibility").set("Origin", ORIGIN);

    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_SECRET);
    expect(body).not.toContain("foo.js");
  });

  it("4) salt okunur: yazma metotları yönlendirilmez (404/405)", async () => {
    const supabase = fakeSupabase(async () => ({ data: { hasImport: false }, error: null }));
    const app = createApp(testConfig(), supabase);

    const post = await request(app)
      .post("/api/duty-plan/feasibility")
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send({});
    const del = await request(app).delete("/api/duty-plan/feasibility").set("Origin", ORIGIN);

    expect(post.status).toBeGreaterThanOrEqual(404);
    expect(del.status).toBeGreaterThanOrEqual(404);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});
