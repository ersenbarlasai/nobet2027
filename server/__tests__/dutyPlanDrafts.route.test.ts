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

const LOC_A = "11111111-0000-0000-0000-000000000001";
const BLK_MORNING = "22222222-0000-0000-0000-000000000001";

function feasibilityStub() {
  return {
    hasImport: true,
    importedAt: "2026-09-01T10:00:00.000Z",
    analyzedAt: "2026-09-10T09:00:00.000Z",
    blocks: [],
    days: [],
    summary: { totalRequiredTasks: 0, totalCoveredTasks: 0, totalUncoveredTasks: 0, daysWithShortfall: [], feasible: true },
  };
}

function snapshotWithImport() {
  return {
    hasImport: true,
    campusId: "campus-1",
    academicYearId: "year-1",
    timetableImportId: "import-1",
    importedAt: "2026-09-01T10:00:00.000Z",
    sourceFingerprint: "a".repeat(64),
    days: [{ order: 1, name: "Pazartesi" }],
    blocks: [{ id: BLK_MORNING, code: "LONG_BREAK_1", name: "Öğle Arası-1", blockOrder: 2, conflictPeriodName: "5-OO" }],
    locations: [{ id: LOC_A, shortCode: "BAHCEA", category: "garden", allowsFixedAssignment: false, activeBlockCodes: ["LONG_BREAK_1"] }],
    tasks: [
      {
        dayOrder: 1,
        dutyLocationId: LOC_A,
        dutyLocationName: "Bahçe A",
        shortCode: "BAHCEA",
        category: "garden",
        dutyBlockId: BLK_MORNING,
        blockCode: "LONG_BREAK_1",
        blockName: "Öğle Arası-1",
        blockOrder: 2,
        kind: "normal",
        fixedCoveredByTeacherSourceId: null,
        fixedCoveredByTeacherName: null,
      },
    ],
    teachers: [{ teacherSourceId: "t1", teacherName: "Ada" }],
    candidateEdges: [{ dayOrder: 1, dutyLocationId: LOC_A, dutyBlockId: BLK_MORNING, teacherSourceId: "t1", teacherName: "Ada" }],
    teacherFixedDutyLoads: [],
    feasibility: feasibilityStub(),
    configurationErrors: [],
  };
}

describe("GET /api/duty-plans/preparation", () => {
  it("snapshot'ı olduğu gibi döner", async () => {
    const payload = snapshotWithImport();
    const supabase = fakeSupabase(async () => ({ data: payload, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/duty-plans/preparation").set("Origin", ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
  });

  it("import yokken hasImport:false döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: { hasImport: false }, error: null }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app).get("/api/duty-plans/preparation").set("Origin", ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasImport: false });
  });

  it("RPC hatasında secret/stack sızdırmadan 500 döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "boom", stack: "at foo.js:1:1" } }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app).get("/api/duty-plans/preparation").set("Origin", ORIGIN);
    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_SECRET);
    expect(body).not.toContain("foo.js");
  });
});

describe("Nöbet planı geçmişi uçları", () => {
  const PLAN_ID = "33333333-0000-4000-8000-000000000001";

  it("liste ve seçili plan ayrıntısını tarihsel puanlarla döner", async () => {
    const calls: string[] = [];
    const supabase = fakeSupabase(async (fn) => {
      calls.push(fn);
      if (fn === "list_duty_plan_history") return { data: { plans: [{ id: PLAN_ID, weekStartDate: "2026-09-14", status: "published", priorPointTotal: 200, weekPointTotal: 100, cumulativePointTotal: 300 }] }, error: null };
      if (fn === "get_duty_plan_history_detail") return { data: { found: true, id: PLAN_ID, status: "published", teacherPoints: [{ teacherSourceId: "t1", teacherName: "Ada", priorPoints: 4, weekPoints: 2, totalPoints: 6, isProjected: false }] }, error: null };
      throw new Error(`unexpected rpc ${fn}`);
    });
    const app = createApp(testConfig(), supabase);

    const list = await request(app).get("/api/duty-plans/history").set("Origin", ORIGIN);
    const detail = await request(app).get(`/api/duty-plans/history/${PLAN_ID}`).set("Origin", ORIGIN);
    expect(list.status).toBe(200);
    expect(list.body.plans[0]).toMatchObject({ priorPointTotal: 200, weekPointTotal: 100, cumulativePointTotal: 300 });
    expect(detail.status).toBe(200);
    expect(detail.body.teacherPoints[0]).toMatchObject({ priorPoints: 4, weekPoints: 2, totalPoints: 6 });
    expect(calls).toEqual(["list_duty_plan_history", "get_duty_plan_history_detail"]);
  });

  it("revizyonu expectedPlanVersion ile ayrı taslak olarak başlatır", async () => {
    const rpc = vi.fn(async (fn: string, args: unknown) => {
      expect(fn).toBe("create_duty_plan_revision");
      expect(args).toMatchObject({ p_plan_id: PLAN_ID, p_expected_plan_version: 4 });
      return { data: { status: "ok", planId: "revision-1", version: 1 }, error: null };
    });
    const app = createApp(testConfig(), { rpc } as unknown as SupabaseClient);
    const res = await request(app).post(`/api/duty-plans/history/${PLAN_ID}/revise`).set("Origin", ORIGIN).send({ expectedPlanVersion: 4 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "ok", planId: "revision-1" });
  });

  it("yayımlanmış planı fiziksel silmeden arşivler", async () => {
    const rpc = vi.fn(async (fn: string, args: unknown) => {
      expect(fn).toBe("archive_published_duty_plan");
      expect(args).toMatchObject({ p_plan_id: PLAN_ID, p_expected_plan_version: 2 });
      return { data: { status: "ok", planId: PLAN_ID, version: 3 }, error: null };
    });
    const app = createApp(testConfig(), { rpc } as unknown as SupabaseClient);
    const res = await request(app).post(`/api/duty-plans/history/${PLAN_ID}/archive`).set("Origin", ORIGIN).send({ expectedPlanVersion: 2 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("RPC hatasında secret/SQL/stack döndürmez", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: `select ${FAKE_SECRET}`, stack: "at db.sql:9" } }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app).get("/api/duty-plans/history").set("Origin", ORIGIN);
    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_SECRET);
    expect(body).not.toContain("db.sql");
  });
});

describe("POST /api/duty-plans/drafts/generate", () => {
  it("başarılı üretimde snapshot + save_duty_plan_draft çağrılır, 201 döner", async () => {
    const snapshot = snapshotWithImport();
    const calls: string[] = [];
    const supabase = fakeSupabase(async (fn) => {
      calls.push(fn);
      if (fn === "get_duty_plan_generation_snapshot") return { data: snapshot, error: null };
      if (fn === "get_teacher_lesson_period_counts") return { data: [], error: null };
      if (fn === "save_duty_plan_draft") {
        return {
          data: { status: "ok", planId: "plan-1", version: 1, sourceFingerprint: snapshot.sourceFingerprint, createdAt: "now", updatedAt: "now" },
          error: null,
        };
      }
      throw new Error(`unexpected rpc ${fn}`);
    });
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .post("/api/duty-plans/drafts/generate")
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("ok");
    expect(res.body.planId).toBe("plan-1");
    expect(calls).toEqual(["get_duty_plan_generation_snapshot", "get_teacher_lesson_period_counts", "save_duty_plan_draft"]);
  });

  it("import yoksa 409 no_import döner ve save RPC'sini çağırmaz", async () => {
    const supabase = fakeSupabase(async (fn) => {
      if (fn === "get_duty_plan_generation_snapshot") return { data: { hasImport: false }, error: null };
      if (fn === "get_teacher_lesson_period_counts") return { data: [], error: null };
      throw new Error(`unexpected rpc ${fn}`);
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .post("/api/duty-plans/drafts/generate")
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_import");
  });

  it("save RPC source_changed dönerse 409 döner", async () => {
    const snapshot = snapshotWithImport();
    const supabase = fakeSupabase(async (fn) => {
      if (fn === "get_duty_plan_generation_snapshot") return { data: snapshot, error: null };
      if (fn === "get_teacher_lesson_period_counts") return { data: [], error: null };
      if (fn === "save_duty_plan_draft") return { data: { status: "source_changed", currentSourceFingerprint: "b".repeat(64) }, error: null };
      throw new Error(`unexpected rpc ${fn}`);
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .post("/api/duty-plans/drafts/generate")
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("source_changed");
  });

  it("geçersiz options (min>max) 400 döner ve hiçbir RPC çağrılmaz", async () => {
    const supabase = fakeSupabase(async (fn) => {
      throw new Error(`unexpected rpc ${fn}`);
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .post("/api/duty-plans/drafts/generate")
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send({ options: { minWeeklyDuties: 4, targetWeeklyDuties: 2, maxWeeklyDuties: 3 } });
    expect(res.status).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("açık görev varken allowPartial:false ile 409 partial_not_allowed döner ve save çağrılmaz", async () => {
    const snapshot = snapshotWithImport();
    // Aday kenarını kaldır: görev kapsanamaz.
    snapshot.candidateEdges = [];
    const calls: string[] = [];
    const supabase = fakeSupabase(async (fn) => {
      calls.push(fn);
      if (fn === "get_duty_plan_generation_snapshot") return { data: snapshot, error: null };
      if (fn === "get_teacher_lesson_period_counts") return { data: [], error: null };
      throw new Error(`unexpected rpc ${fn}`);
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .post("/api/duty-plans/drafts/generate")
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send({ options: { allowPartial: false } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("partial_not_allowed");
    expect(calls).toEqual(["get_duty_plan_generation_snapshot", "get_teacher_lesson_period_counts"]);
  });

  it("RPC hatasında secret/stack sızdırmadan 500 döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "boom", stack: "at foo.js:1:1" } }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .post("/api/duty-plans/drafts/generate")
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send({});
    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_SECRET);
    expect(body).not.toContain("foo.js");
  });

  it("bulgu 3: body'deki expectedPlanId, save_duty_plan_draft'a p_expected_plan_id olarak taşınır", async () => {
    const snapshot = snapshotWithImport();
    let capturedArgs: unknown;
    const supabase = fakeSupabase(async (fn, args) => {
      if (fn === "get_duty_plan_generation_snapshot") return { data: snapshot, error: null };
      if (fn === "get_teacher_lesson_period_counts") return { data: [], error: null };
      if (fn === "save_duty_plan_draft") {
        capturedArgs = args;
        return { data: { status: "ok", planId: "plan-2", version: 2, sourceFingerprint: snapshot.sourceFingerprint, createdAt: "now", updatedAt: "now" }, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    });
    const app = createApp(testConfig(), supabase);
    const planId = "11111111-1111-4111-8111-111111111111";

    const res = await request(app)
      .post("/api/duty-plans/drafts/generate")
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send({ expectedPlanId: planId });

    expect(res.status).toBe(201);
    expect((capturedArgs as { p_expected_plan_id: string }).p_expected_plan_id).toBe(planId);
  });

  it("expectedPlanId gönderilmezse RPC'ye null taşınır (aktif taslak yok varsayımı)", async () => {
    const snapshot = snapshotWithImport();
    let capturedArgs: unknown;
    const supabase = fakeSupabase(async (fn, args) => {
      if (fn === "get_duty_plan_generation_snapshot") return { data: snapshot, error: null };
      if (fn === "get_teacher_lesson_period_counts") return { data: [], error: null };
      if (fn === "save_duty_plan_draft") {
        capturedArgs = args;
        return { data: { status: "ok", planId: "plan-1", version: 1, sourceFingerprint: snapshot.sourceFingerprint, createdAt: "now", updatedAt: "now" }, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    });
    const app = createApp(testConfig(), supabase);

    await request(app).post("/api/duty-plans/drafts/generate").set("Origin", ORIGIN).set("Content-Type", "application/json").send({});

    expect((capturedArgs as { p_expected_plan_id: string | null }).p_expected_plan_id).toBeNull();
  });

  it("save RPC version_conflict dönerse 409 döner (currentPlanId dahil)", async () => {
    const snapshot = snapshotWithImport();
    const supabase = fakeSupabase(async (fn) => {
      if (fn === "get_duty_plan_generation_snapshot") return { data: snapshot, error: null };
      if (fn === "get_teacher_lesson_period_counts") return { data: [], error: null };
      if (fn === "save_duty_plan_draft") return { data: { status: "version_conflict", currentPlanId: "other-plan" }, error: null };
      throw new Error(`unexpected rpc ${fn}`);
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app).post("/api/duty-plans/drafts/generate").set("Origin", ORIGIN).set("Content-Type", "application/json").send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("version_conflict");
    expect(res.body.currentPlanId).toBe("other-plan");
  });

  it("bulgu 7: save RPC invalid_summary dönerse 500 döner ve authoritative alanını taşır, secret sızdırmaz", async () => {
    const snapshot = snapshotWithImport();
    const authoritative = { totalTaskCount: 1, fixedTaskCount: 0, fixedCoveredCount: 0, normalTaskCount: 1, normalCoveredCount: 1, uncoveredCount: 0, teacherLoads: [] };
    const supabase = fakeSupabase(async (fn) => {
      if (fn === "get_duty_plan_generation_snapshot") return { data: snapshot, error: null };
      if (fn === "get_teacher_lesson_period_counts") return { data: [], error: null };
      if (fn === "save_duty_plan_draft") return { data: { status: "invalid_summary", authoritative }, error: null };
      throw new Error(`unexpected rpc ${fn}`);
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app).post("/api/duty-plans/drafts/generate").set("Origin", ORIGIN).set("Content-Type", "application/json").send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("invalid_summary");
    expect(res.body.authoritative).toEqual(authoritative);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_SECRET);
  });
});

describe("GET /api/duty-plans/drafts/current", () => {
  it("aktif taslağı döner", async () => {
    const payload = { found: true, id: "plan-1", status: "draft" };
    const supabase = fakeSupabase(async (fn) => {
      expect(fn).toBe("get_current_duty_plan_draft");
      return { data: payload, error: null };
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app).get("/api/duty-plans/drafts/current").set("Origin", ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
  });
});

describe("GET /api/duty-plans/drafts/:planId", () => {
  it("geçersiz uuid için 400 döner", async () => {
    const supabase = fakeSupabase(async (fn) => {
      throw new Error(`unexpected rpc ${fn}`);
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app).get("/api/duty-plans/drafts/not-a-uuid").set("Origin", ORIGIN);
    expect(res.status).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("bulunamayan plan için 404 döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: { found: false }, error: null }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .get("/api/duty-plans/drafts/11111111-1111-4111-8111-111111111111")
      .set("Origin", ORIGIN);
    expect(res.status).toBe(404);
  });

  it("bulunan plan 200 döner", async () => {
    const payload = { found: true, id: "plan-1", status: "draft" };
    const supabase = fakeSupabase(async () => ({ data: payload, error: null }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .get("/api/duty-plans/drafts/11111111-1111-4111-8111-111111111111")
      .set("Origin", ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
  });
});

describe("DELETE /api/duty-plans/drafts/:planId", () => {
  it("başarılı silmede 204 döner", async () => {
    const supabase = fakeSupabase(async (fn) => {
      expect(fn).toBe("delete_duty_plan_draft");
      return { data: { status: "ok" }, error: null };
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .delete("/api/duty-plans/drafts/11111111-1111-4111-8111-111111111111")
      .set("Origin", ORIGIN);
    expect(res.status).toBe(204);
  });

  it("not_draft durumunda 409 döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: { status: "not_draft" }, error: null }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .delete("/api/duty-plans/drafts/11111111-1111-4111-8111-111111111111")
      .set("Origin", ORIGIN);
    expect(res.status).toBe(409);
  });

  it("not_found durumunda 404 döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: { status: "not_found" }, error: null }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .delete("/api/duty-plans/drafts/11111111-1111-4111-8111-111111111111")
      .set("Origin", ORIGIN);
    expect(res.status).toBe(404);
  });
});

const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";

describe("GET /api/duty-plans/published/current", () => {
  it("yayımlanmış planı döner", async () => {
    const payload = { found: true, id: "plan-1", status: "published" };
    const supabase = fakeSupabase(async (fn) => {
      expect(fn).toBe("get_published_duty_plan");
      return { data: payload, error: null };
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app).get("/api/duty-plans/published/current").set("Origin", ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
  });

  it("yayımlanmış plan yoksa found:false 200 döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: { found: false }, error: null }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app).get("/api/duty-plans/published/current").set("Origin", ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ found: false });
  });

  it("RPC hatasında secret/stack sızdırmadan 500 döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "boom", stack: "at foo.js:1:1" } }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app).get("/api/duty-plans/published/current").set("Origin", ORIGIN);
    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_SECRET);
    expect(body).not.toContain("foo.js");
  });
});

describe("GET /api/duty-plans/drafts/:planId/tasks/:taskId/candidates", () => {
  it("geçersiz uuid için 400 döner, RPC çağrılmaz", async () => {
    const supabase = fakeSupabase(async (fn) => {
      throw new Error(`unexpected rpc ${fn}`);
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app).get(`/api/duty-plans/drafts/not-a-uuid/tasks/${TASK_ID}/candidates`).set("Origin", ORIGIN);
    expect(res.status).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("bulunan görev için adayları döner", async () => {
    const payload = {
      found: true,
      taskFound: true,
      planStatus: "draft",
      planVersion: 3,
      isFixed: false,
      currentAssignment: { teacherSourceId: null, teacherName: null, assignmentKind: "unassigned" },
      isStale: false,
      currentSourceFingerprint: "a".repeat(64),
      candidates: [],
    };
    const supabase = fakeSupabase(async (fn) => {
      expect(fn).toBe("get_duty_plan_task_candidates");
      return { data: payload, error: null };
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app).get(`/api/duty-plans/drafts/${PLAN_ID}/tasks/${TASK_ID}/candidates`).set("Origin", ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
  });

  it("plan veya görev bulunamazsa 404 döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: { found: true, taskFound: false, planStatus: "draft", planVersion: 1 }, error: null }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app).get(`/api/duty-plans/drafts/${PLAN_ID}/tasks/${TASK_ID}/candidates`).set("Origin", ORIGIN);
    expect(res.status).toBe(404);
  });

  it("RPC hatasında secret/stack sızdırmadan 500 döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "boom", stack: "at foo.js:1:1" } }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app).get(`/api/duty-plans/drafts/${PLAN_ID}/tasks/${TASK_ID}/candidates`).set("Origin", ORIGIN);
    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_SECRET);
    expect(body).not.toContain("foo.js");
  });
});

describe("PUT /api/duty-plans/drafts/:planId/tasks/:taskId", () => {
  it("geçersiz body için 400 döner, RPC çağrılmaz", async () => {
    const supabase = fakeSupabase(async (fn) => {
      throw new Error(`unexpected rpc ${fn}`);
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .put(`/api/duty-plans/drafts/${PLAN_ID}/tasks/${TASK_ID}`)
      .set("Origin", ORIGIN)
      .send({ teacherSourceId: "t1" }); // expectedPlanVersion eksik
    expect(res.status).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("başarılı manuel atamada 200 döner", async () => {
    const payload = {
      status: "ok",
      version: 2,
      assignment: { taskId: TASK_ID, dayOrder: 1, dutyLocationId: "loc-1", dutyBlockId: "blk-1", teacherSourceId: "t1", teacherName: "Ada", assignmentKind: "manual" },
      summary: {},
    };
    const supabase = fakeSupabase(async (fn, args) => {
      expect(fn).toBe("update_duty_plan_assignment");
      expect(args).toMatchObject({ p_plan_id: PLAN_ID, p_task_id: TASK_ID, p_teacher_source_id: "t1", p_expected_plan_version: 1 });
      return { data: payload, error: null };
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .put(`/api/duty-plans/drafts/${PLAN_ID}/tasks/${TASK_ID}`)
      .set("Origin", ORIGIN)
      .send({ teacherSourceId: "t1", expectedPlanVersion: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
  });

  it("teacher_day_conflict → 409 döner, conflictingPackage'ı taşır", async () => {
    const conflictingPackage = { id: "pkg-2", coverageMode: "SINGLE_BLOCK", dutyLocationId: "loc-2", assignmentKind: "manual" };
    const supabase = fakeSupabase(async () => ({ data: { status: "teacher_day_conflict", conflictingPackage }, error: null }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .put(`/api/duty-plans/drafts/${PLAN_ID}/tasks/${TASK_ID}`)
      .set("Origin", ORIGIN)
      .send({ teacherSourceId: "t1", expectedPlanVersion: 1 });
    expect(res.status).toBe(409);
    expect(res.body.conflictingPackage).toEqual(conflictingPackage);
  });

  it("requires_package_action → 409 döner, package'ı taşır (sessiz bölme yok)", async () => {
    const pkg = { id: "pkg-1", coverageMode: "FULL_DAY", teacherSourceId: "t1", teacherName: "Ada", dutyLocationId: "loc-1", coveredTaskIds: ["t1", "t2", "t3", "t4"] };
    const supabase = fakeSupabase(async () => ({ data: { status: "requires_package_action", package: pkg }, error: null }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .put(`/api/duty-plans/drafts/${PLAN_ID}/tasks/${TASK_ID}`)
      .set("Origin", ORIGIN)
      .send({ teacherSourceId: "t2", expectedPlanVersion: 1 });
    expect(res.status).toBe(409);
    expect(res.body.package).toEqual(pkg);
  });

  it("fixed_task_immutable → 409 döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: { status: "fixed_task_immutable" }, error: null }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .put(`/api/duty-plans/drafts/${PLAN_ID}/tasks/${TASK_ID}`)
      .set("Origin", ORIGIN)
      .send({ teacherSourceId: "t1", expectedPlanVersion: 1 });
    expect(res.status).toBe(409);
  });

  it("RPC hatasında secret/stack sızdırmadan 500 döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "boom", stack: "at foo.js:1:1" } }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .put(`/api/duty-plans/drafts/${PLAN_ID}/tasks/${TASK_ID}`)
      .set("Origin", ORIGIN)
      .send({ teacherSourceId: "t1", expectedPlanVersion: 1 });
    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_SECRET);
    expect(body).not.toContain("foo.js");
  });
});

describe("POST /api/duty-plans/drafts/:planId/manual-package/preview", () => {
  function validBody() {
    return { dayOrder: 1, dutyLocationId: "33333333-3333-4333-8333-333333333333", teacherSourceId: "t1", coverageMode: "FULL_DAY" };
  }

  it("geçersiz body (dutyLocationId uuid değil) 400 döner", async () => {
    const supabase = fakeSupabase(async () => {
      throw new Error("unexpected rpc call");
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .post(`/api/duty-plans/drafts/${PLAN_ID}/manual-package/preview`)
      .set("Origin", ORIGIN)
      .send({ ...validBody(), dutyLocationId: "not-a-uuid" });
    expect(res.status).toBe(400);
  });

  it("SINGLE_BLOCK için dutyBlockId zorunlu — eksikse 400 döner", async () => {
    const supabase = fakeSupabase(async () => {
      throw new Error("unexpected rpc call");
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .post(`/api/duty-plans/drafts/${PLAN_ID}/manual-package/preview`)
      .set("Origin", ORIGIN)
      .send({ ...validBody(), coverageMode: "SINGLE_BLOCK" });
    expect(res.status).toBe(400);
  });

  it("plan bulunamazsa 404 döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: { found: false }, error: null }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app).post(`/api/duty-plans/drafts/${PLAN_ID}/manual-package/preview`).set("Origin", ORIGIN).send(validBody());
    expect(res.status).toBe(404);
  });

  it("başarılı önizlemede 200 + eligible/affectedTasks/conflictingPackage döner", async () => {
    const rpcResult = {
      found: true,
      planStatus: "draft",
      planVersion: 3,
      targetTaskIds: ["t1", "t2", "t3", "t4"],
      targetTasks: [],
      affectedTasks: [{ id: "t5", dutyBlockId: "blk-x", dutyBlockName: "Uzun 1", currentTeacherSourceId: "t9", currentTeacherName: "Zeynep", packageId: "pkg-9" }],
      eligible: true,
      reasons: [],
      conflictingPackage: null,
    };
    const supabase = fakeSupabase(async (fn) => {
      expect(fn).toBe("preview_duty_plan_manual_package");
      return { data: rpcResult, error: null };
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app).post(`/api/duty-plans/drafts/${PLAN_ID}/manual-package/preview`).set("Origin", ORIGIN).send(validBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual(rpcResult);
  });

  it("RPC hatasında secret/stack sızdırmadan 500 döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "boom", stack: "at foo.js:1:1" } }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app).post(`/api/duty-plans/drafts/${PLAN_ID}/manual-package/preview`).set("Origin", ORIGIN).send(validBody());
    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_SECRET);
    expect(body).not.toContain("foo.js");
  });
});

describe("PUT /api/duty-plans/drafts/:planId/manual-package", () => {
  function validBody() {
    return { dayOrder: 1, dutyLocationId: "33333333-3333-4333-8333-333333333333", teacherSourceId: "t1", coverageMode: "FULL_DAY", expectedPlanVersion: 1 };
  }

  it("geçersiz body (expectedPlanVersion eksik) 400 döner", async () => {
    const supabase = fakeSupabase(async () => {
      throw new Error("unexpected rpc call");
    });
    const app = createApp(testConfig(), supabase);
    const { expectedPlanVersion: _omit, ...withoutVersion } = validBody();
    void _omit;
    const res = await request(app).put(`/api/duty-plans/drafts/${PLAN_ID}/manual-package`).set("Origin", ORIGIN).send(withoutVersion);
    expect(res.status).toBe(400);
  });

  it("başarılı yazımda 200 döner", async () => {
    const rpcResult = { status: "ok", version: 2, packageId: "pkg-1", summary: { totalTaskCount: 1 } };
    const supabase = fakeSupabase(async (fn) => {
      expect(fn).toBe("set_duty_plan_manual_package");
      return { data: rpcResult, error: null };
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app).put(`/api/duty-plans/drafts/${PLAN_ID}/manual-package`).set("Origin", ORIGIN).send(validBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual(rpcResult);
  });

  it("requires_confirmation → 409 döner, affectedTasks'ı taşır (sessiz yazma yok)", async () => {
    const affectedTasks = [{ id: "t5", dutyBlockId: "blk-x", dutyBlockName: "Uzun 1", currentTeacherSourceId: "t9", currentTeacherName: "Zeynep", packageId: "pkg-9" }];
    const supabase = fakeSupabase(async () => ({ data: { status: "requires_confirmation", affectedTasks }, error: null }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app).put(`/api/duty-plans/drafts/${PLAN_ID}/manual-package`).set("Origin", ORIGIN).send(validBody());
    expect(res.status).toBe(409);
    expect(res.body.affectedTasks).toEqual(affectedTasks);
  });

  it("stale_affected_set → 409 döner, güncel affectedTasks'ı taşır", async () => {
    const affectedTasks = [{ id: "t6", dutyBlockId: "blk-y", dutyBlockName: "Uzun 2", currentTeacherSourceId: "t8", currentTeacherName: "Ali", packageId: "pkg-8" }];
    const supabase = fakeSupabase(async () => ({ data: { status: "stale_affected_set", affectedTasks }, error: null }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .put(`/api/duty-plans/drafts/${PLAN_ID}/manual-package`)
      .set("Origin", ORIGIN)
      .send({ ...validBody(), expectedAffectedTaskIds: ["44444444-4444-4444-8444-444444444444"] });
    expect(res.status).toBe(409);
    expect(res.body.affectedTasks).toEqual(affectedTasks);
  });

  it("teacher_day_conflict → 409 döner, conflictingPackage'ı taşır", async () => {
    const conflictingPackage = { id: "pkg-2", coverageMode: "SHORT_BREAKS", dutyLocationId: "loc-2", assignmentKind: "manual" };
    const supabase = fakeSupabase(async () => ({ data: { status: "teacher_day_conflict", conflictingPackage }, error: null }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app).put(`/api/duty-plans/drafts/${PLAN_ID}/manual-package`).set("Origin", ORIGIN).send(validBody());
    expect(res.status).toBe(409);
    expect(res.body.conflictingPackage).toEqual(conflictingPackage);
  });

  it("weekly_limit_exceeded → 409 döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: { status: "weekly_limit_exceeded" }, error: null }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app).put(`/api/duty-plans/drafts/${PLAN_ID}/manual-package`).set("Origin", ORIGIN).send(validBody());
    expect(res.status).toBe(409);
  });

  it("RPC hatasında secret/stack sızdırmadan 500 döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "boom", stack: "at foo.js:1:1" } }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app).put(`/api/duty-plans/drafts/${PLAN_ID}/manual-package`).set("Origin", ORIGIN).send(validBody());
    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_SECRET);
    expect(body).not.toContain("foo.js");
  });
});

describe("POST /api/duty-plans/drafts/:planId/regenerate", () => {
  it("geçersiz body için 400 döner", async () => {
    const supabase = fakeSupabase(async (fn) => {
      throw new Error(`unexpected rpc ${fn}`);
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app).post(`/api/duty-plans/drafts/${PLAN_ID}/regenerate`).set("Origin", ORIGIN).send({});
    expect(res.status).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("plan draft değilse 409 plan_not_draft döner", async () => {
    const supabase = fakeSupabase(async (fn) => {
      if (fn === "get_duty_plan_draft") return { data: { found: true, id: PLAN_ID, status: "published", assignments: [] }, error: null };
      throw new Error(`unexpected rpc ${fn}`);
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .post(`/api/duty-plans/drafts/${PLAN_ID}/regenerate`)
      .set("Origin", ORIGIN)
      .send({ expectedPlanVersion: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("plan_not_draft");
  });

  it("RPC hatasında secret/stack sızdırmadan 500 döner", async () => {
    const supabase = fakeSupabase(async (fn) => {
      if (fn === "get_duty_plan_draft") throw Object.assign(new Error("boom at foo.js:1:1"), {});
      throw new Error(`unexpected rpc ${fn}`);
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .post(`/api/duty-plans/drafts/${PLAN_ID}/regenerate`)
      .set("Origin", ORIGIN)
      .send({ expectedPlanVersion: 1 });
    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_SECRET);
    expect(body).not.toContain("foo.js");
  });
});

describe("POST /api/duty-plans/drafts/:planId/publish", () => {
  it("geçersiz body için 400 döner", async () => {
    const supabase = fakeSupabase(async (fn) => {
      throw new Error(`unexpected rpc ${fn}`);
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app).post(`/api/duty-plans/drafts/${PLAN_ID}/publish`).set("Origin", ORIGIN).send({});
    expect(res.status).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("başarılı yayımlamada 200 döner", async () => {
    const payload = { status: "ok", planId: PLAN_ID, version: 2, publishedAt: "2026-09-10T09:00:00.000Z", archivedPreviousPlanId: null };
    const supabase = fakeSupabase(async (fn, args) => {
      expect(fn).toBe("publish_duty_plan_draft");
      expect(args).toMatchObject({ p_plan_id: PLAN_ID, p_expected_plan_version: 1 });
      return { data: payload, error: null };
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .post(`/api/duty-plans/drafts/${PLAN_ID}/publish`)
      .set("Origin", ORIGIN)
      .send({ expectedPlanVersion: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
  });

  it("açık görev varken 409 open_tasks_remaining döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: { status: "open_tasks_remaining", uncoveredCount: 3 }, error: null }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .post(`/api/duty-plans/drafts/${PLAN_ID}/publish`)
      .set("Origin", ORIGIN)
      .send({ expectedPlanVersion: 1 });
    expect(res.status).toBe(409);
    expect(res.body.uncoveredCount).toBe(3);
  });

  it("RPC hatasında secret/stack sızdırmadan 500 döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "boom", stack: "at foo.js:1:1" } }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .post(`/api/duty-plans/drafts/${PLAN_ID}/publish`)
      .set("Origin", ORIGIN)
      .send({ expectedPlanVersion: 1 });
    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_SECRET);
    expect(body).not.toContain("foo.js");
  });
});

// ============================================================================
// YENİ DB durumlarının route eşleşmesi (migration 20260920090000)
// ============================================================================
// Amaç: TANIMLI hiçbir DB sonucu default 500/internal_error dalına DÜŞMEMELİ
// ve hata gövdeleri SQL/stack/secret SIZDIRMAMALI.
describe("yeni yarım gün DB durumları → route eşleşmesi", () => {
  // zod .uuid() sürüm nibble'ı doğrular — dosyanın üstündeki LOC_A/BLK_MORNING
  // sabitleri (…-0000-…) bu doğrulamayı GEÇMEZ, bu yüzden v4 biçiminde ayrı
  // sabitler kullanılır.
  const VALID_LOC_UUID = "33333333-3333-4333-8333-333333333333";
  const VALID_BLOCK_UUID = "44444444-4444-4444-8444-444444444444";

  /** Yanıt gövdesinde asla bulunmaması gerekenler. */
  function expectNoLeak(body: unknown) {
    const text = JSON.stringify(body);
    expect(text).not.toContain(FAKE_SECRET);
    expect(text).not.toMatch(/\bselect\b|\binsert\b|\bupdate .* set\b/i);
    expect(text).not.toMatch(/pg_catalog|PL\/pgSQL|\.sql:\d+|at [\w.]+ \(/);
    expect(text).not.toContain("stack");
  }

  const manualCases: { status: string; extra?: Record<string, unknown>; expected: number }[] = [
    { status: "cell_not_open_for_normal", expected: 409 },
    { status: "teacher_block_conflict", expected: 409 },
    { status: "teacher_has_fixed_duty", expected: 409 },
    {
      status: "teacher_day_conflict",
      extra: { reason: "half_day_rule", conflictingPackage: { id: "pkg-1", coverageMode: "SINGLE_BLOCK", dutyLocationId: "loc-1", assignmentKind: "manual" } },
      expected: 409,
    },
  ];

  for (const c of manualCases) {
    it(`tek hücre manuel atama: ${c.status}${c.extra?.reason ? `/${String(c.extra.reason)}` : ""} → ${c.expected}`, async () => {
      const supabase = fakeSupabase(async () => ({ data: { status: c.status, ...(c.extra ?? {}) }, error: null }));
      const app = createApp(testConfig(), supabase);
      const res = await request(app)
        .put(`/api/duty-plans/drafts/${PLAN_ID}/tasks/${TASK_ID}`)
        .set("Origin", ORIGIN)
        .send({ teacherSourceId: "t1", expectedPlanVersion: 1 });
      expect(res.status).toBe(c.expected);
      expect(res.body.error).toBe(c.status);
      expect(typeof res.body.message).toBe("string");
      expect(res.body.message.length).toBeGreaterThan(0);
      expectNoLeak(res.body);
    });
  }

  it("tek hücre manuel atama: teacher_day_conflict/half_day_rule mesajı yarım gün kuralını açıklar", async () => {
    const supabase = fakeSupabase(async () => ({
      data: { status: "teacher_day_conflict", reason: "half_day_rule", conflictingPackage: { id: "p", coverageMode: "SINGLE_BLOCK", dutyLocationId: "l", assignmentKind: "manual" } },
      error: null,
    }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .put(`/api/duty-plans/drafts/${PLAN_ID}/tasks/${TASK_ID}`)
      .set("Origin", ORIGIN)
      .send({ teacherSourceId: "t1", expectedPlanVersion: 1 });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("half_day_rule");
    expect(res.body.message).toMatch(/yarım gün/i);
  });

  it("ilk üretim: v4 daily_package_limit eski yarım gün hatası gibi sunulmaz", async () => {
    const supabase = fakeSupabase(async (fn) => {
      if (fn === "get_duty_plan_generation_snapshot") return { data: snapshotWithImport(), error: null };
      if (fn === "get_teacher_lesson_period_counts") return { data: [], error: null };
      if (fn === "save_duty_plan_draft") {
        return { data: { status: "teacher_day_conflict", reason: "daily_package_limit" }, error: null };
      }
      return { data: null, error: { message: `unexpected ${fn}` } };
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app).post("/api/duty-plans/drafts/generate").set("Origin", ORIGIN).send({});
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("daily_package_limit");
    expect(res.body.message).toMatch(/görev paketi/i);
    expect(res.body.message).not.toMatch(/yarım gün kuralı açık/i);
    expectNoLeak(res.body);
  });

  const packageCases = ["cell_not_open_for_normal", "teacher_block_conflict", "normal_package_must_be_single_block"];
  for (const status of packageCases) {
    it(`manuel paket: ${status} → 409`, async () => {
      const supabase = fakeSupabase(async () => ({ data: { status }, error: null }));
      const app = createApp(testConfig(), supabase);
      const res = await request(app)
        .put(`/api/duty-plans/drafts/${PLAN_ID}/manual-package`)
        .set("Origin", ORIGIN)
        .send({ dayOrder: 1, dutyLocationId: VALID_LOC_UUID, teacherSourceId: "t1", coverageMode: "SINGLE_BLOCK", dutyBlockId: VALID_BLOCK_UUID, expectedPlanVersion: 1 });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(status);
      expectNoLeak(res.body);
    });
  }

  const generateCases = ["teacher_block_conflict", "teacher_has_fixed_duty"];
  for (const status of generateCases) {
    it(`ilk üretim (save_duty_plan_draft): ${status} → 409`, async () => {
      const supabase = fakeSupabase(async (fn) => {
        if (fn === "get_duty_plan_generation_snapshot") return { data: snapshotWithImport(), error: null };
        if (fn === "get_teacher_lesson_period_counts") return { data: [], error: null };
        if (fn === "save_duty_plan_draft") return { data: { status }, error: null };
        return { data: null, error: { message: `unexpected ${fn}` } };
      });
      const app = createApp(testConfig(), supabase);
      const res = await request(app).post("/api/duty-plans/drafts/generate").set("Origin", ORIGIN).send({});
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(status);
      expectNoLeak(res.body);
    });
  }

  it("ilk üretim: invalid_assignment/normal_package_must_be_single_block → 400, reason taşınır", async () => {
    const supabase = fakeSupabase(async (fn) => {
      if (fn === "get_duty_plan_generation_snapshot") return { data: snapshotWithImport(), error: null };
      if (fn === "get_teacher_lesson_period_counts") return { data: [], error: null };
      if (fn === "save_duty_plan_draft") return { data: { status: "invalid_assignment", reason: "normal_package_must_be_single_block" }, error: null };
      return { data: null, error: { message: `unexpected ${fn}` } };
    });
    const app = createApp(testConfig(), supabase);
    const res = await request(app).post("/api/duty-plans/drafts/generate").set("Origin", ORIGIN).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_assignment");
    expect(res.body.reason).toBe("normal_package_must_be_single_block");
    expectNoLeak(res.body);
  });

  it("publish rule_violation/half_day_rule_violation → 409, gerekçe taşınır", async () => {
    const supabase = fakeSupabase(async () => ({ data: { status: "rule_violation", reason: "half_day_rule_violation" }, error: null }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app).post(`/api/duty-plans/drafts/${PLAN_ID}/publish`).set("Origin", ORIGIN).send({ expectedPlanVersion: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("rule_violation");
    expect(res.body.reason).toBe("half_day_rule_violation");
    expectNoLeak(res.body);
  });

  it("publish rule_violation/daily_package_limit_violation → paket kuralını açıklar", async () => {
    const supabase = fakeSupabase(async () => ({ data: { status: "rule_violation", reason: "daily_package_limit_violation" }, error: null }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app).post(`/api/duty-plans/drafts/${PLAN_ID}/publish`).set("Origin", ORIGIN).send({ expectedPlanVersion: 1 });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("daily_package_limit_violation");
    expect(res.body.message).toMatch(/görev paketi/i);
    expectNoLeak(res.body);
  });

  it("RPC hatası 500 dönse bile SQL/stack/secret sızdırmaz", async () => {
    const supabase = fakeSupabase(async () => ({
      data: null,
      error: { message: `select * from duty_plans where secret='${FAKE_SECRET}'`, stack: "at pg.js:12:3" },
    }));
    const app = createApp(testConfig(), supabase);
    const res = await request(app)
      .put(`/api/duty-plans/drafts/${PLAN_ID}/tasks/${TASK_ID}`)
      .set("Origin", ORIGIN)
      .send({ teacherSourceId: "t1", expectedPlanVersion: 1 });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expectNoLeak(res.body);
  });
});
