import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createApp } from "../index";
import type { AppConfig } from "../config";

const FAKE_SECRET = "sb_secret_TEST_VALUE_MUST_NEVER_LEAK_9f8a7c";

function testConfig(): AppConfig {
  return {
    supabaseUrl: "https://example.supabase.co",
    supabaseSecretKey: FAKE_SECRET,
    port: 3001,
    allowedOrigin: "http://localhost:5173",
    campusName: "Test Kampüs",
    academicYearName: "2026-2027",
  };
}

function fakeSupabase(rpcImpl: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }>): SupabaseClient {
  return { rpc: vi.fn(rpcImpl) } as unknown as SupabaseClient;
}

const VALID_TEACHER_ID = "11111111-1111-1111-1111-111111111111";
const VALID_LOCATION_ID = "22222222-2222-2222-2222-222222222222";
const VALID_BLOCK_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const ORIGIN = "http://localhost:5173";

describe("GET /api/teacher-timetables/teachers/:teacherId/duty-availability", () => {
  it("1) başarılı GET: matris snapshot'ını döner", async () => {
    const rpcData = {
      hasImport: true,
      teacherFound: true,
      teacher: { id: VALID_TEACHER_ID, sourceId: "T1", name: "Ahmet Yılmaz" },
      isIncluded: true,
      halfDayRuleEnabled: true,
      days: [{ order: 1, name: "Pazartesi" }],
      blocks: [
        { id: VALID_BLOCK_ID, code: "MORNING_BREAKS", name: "Sabah Teneffüs Bloğu", blockOrder: 1, conflictPeriodName: null },
      ],
      dutyLocations: [
        {
          id: VALID_LOCATION_ID,
          name: "Ön Bahçe",
          shortCode: "ON-BAH",
          category: "garden",
          capacity: 2,
          sortOrder: 1,
          allowsFixedAssignment: false,
          blockIds: [VALID_BLOCK_ID],
          blockPolicies: [{ dutyBlockId: VALID_BLOCK_ID, blockCode: "MORNING_BREAKS", assignmentMode: "normal" }],
        },
      ],
      selectedBlockCells: [{ dutyLocationId: VALID_LOCATION_ID, dayOrder: 1, dutyBlockId: VALID_BLOCK_ID }],
      legacySelectedCells: [],
      lessonConflicts: [],
      fixedAssignments: [],
      fixedLocationAssignments: [],
      updatedAt: "2026-09-07T10:00:00.000Z",
    };
    const supabase = fakeSupabase(async () => ({ data: rpcData, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get(`/api/teacher-timetables/teachers/${VALID_TEACHER_ID}/duty-availability`).set("Origin", ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(rpcData);
    expect(supabase.rpc).toHaveBeenCalledWith("get_teacher_duty_matrix", {
      p_campus_name: "Test Kampüs",
      p_academic_year_name: "2026-2027",
      p_teacher_id: VALID_TEACHER_ID,
    });
  });

  it("2) ayar yokken varsayılan isIncluded=true ve boş seçim döner (hata sayılmaz)", async () => {
    const rpcData = {
      hasImport: true,
      teacherFound: true,
      teacher: { id: VALID_TEACHER_ID, sourceId: "T1", name: "Ahmet Yılmaz" },
      isIncluded: true,
      days: [],
      blocks: [],
      dutyLocations: [],
      selectedBlockCells: [],
      legacySelectedCells: [],
      lessonConflicts: [],
      updatedAt: null,
    };
    const supabase = fakeSupabase(async () => ({ data: rpcData, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get(`/api/teacher-timetables/teachers/${VALID_TEACHER_ID}/duty-availability`).set("Origin", ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body.isIncluded).toBe(true);
    expect(res.body.selectedBlockCells).toEqual([]);
  });

  it("3) geçersiz UUID → 400", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/teacher-timetables/teachers/not-a-uuid/duty-availability").set("Origin", ORIGIN);

    expect(res.status).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("4) stale/bilinmeyen öğretmen → 404", async () => {
    const supabase = fakeSupabase(async () => ({
      data: { hasImport: true, teacherFound: false, importedAt: "2026-09-07T10:00:00.000Z" },
      error: null,
    }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get(`/api/teacher-timetables/teachers/${VALID_TEACHER_ID}/duty-availability`).set("Origin", ORIGIN);

    expect(res.status).toBe(404);
    expect(res.body.teacherFound).toBe(false);
  });

  it("5) RPC hata dönerse güvenli 500 cevabı verir, secret/stack sızdırmaz", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "boom", stack: "at foo.js:1:1" } }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get(`/api/teacher-timetables/teachers/${VALID_TEACHER_ID}/duty-availability`).set("Origin", ORIGIN);

    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_SECRET);
    expect(body).not.toContain("foo.js");
  });
});

describe("PUT /api/teacher-timetables/teachers/:teacherId/duty-availability", () => {
  function validBody() {
    return {
      isIncluded: true,
      cells: [{ dutyLocationId: VALID_LOCATION_ID, dayOrder: 1, dutyBlockId: VALID_BLOCK_ID }],
      expectedUpdatedAt: null,
    };
  }

  it("6) başarılı PUT → 200 + updatedAt", async () => {
    const supabase = fakeSupabase(async () => ({ data: { status: "ok", updatedAt: "2026-09-07T10:05:00.000Z" }, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .put(`/api/teacher-timetables/teachers/${VALID_TEACHER_ID}/duty-availability`)
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send(validBody());

    expect(res.status).toBe(200);
    expect(res.body.updatedAt).toBe("2026-09-07T10:05:00.000Z");
    expect(supabase.rpc).toHaveBeenCalledWith("save_teacher_duty_matrix_v2", {
      p_campus_name: "Test Kampüs",
      p_academic_year_name: "2026-2027",
      p_teacher_id: VALID_TEACHER_ID,
      p_is_included: true,
      // Gövdede halfDayRuleEnabled yoksa null gider ⇒ RPC mevcut değeri KORUR.
      p_half_day_rule_enabled: null,
      p_cells: [{ duty_location_id: VALID_LOCATION_ID, day_order: 1, duty_block_id: VALID_BLOCK_ID }],
      p_expected_updated_at: null,
    });
  });

  it("6b) PUT halfDayRuleEnabled gönderilirse RPC'ye AYNI çağrıda iletilir", async () => {
    const supabase = fakeSupabase(async () => ({ data: { status: "ok", updatedAt: "2026-09-07T10:05:00.000Z", halfDayRuleEnabled: false }, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .put(`/api/teacher-timetables/teachers/${VALID_TEACHER_ID}/duty-availability`)
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send({ ...validBody(), halfDayRuleEnabled: false });

    expect(res.status).toBe(200);
    expect(res.body.halfDayRuleEnabled).toBe(false);
    expect(supabase.rpc).toHaveBeenCalledWith("save_teacher_duty_matrix_v2", expect.objectContaining({ p_half_day_rule_enabled: false }));
  });

  it("7) geçersiz UUID → 400", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .put("/api/teacher-timetables/teachers/not-a-uuid/duty-availability")
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send(validBody());

    expect(res.status).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("8) geçersiz gövde (dayOrder aralık dışı) → 400 VALIDATION_ERROR, RPC çağrılmaz", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .put(`/api/teacher-timetables/teachers/${VALID_TEACHER_ID}/duty-availability`)
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send({
        isIncluded: true,
        cells: [{ dutyLocationId: VALID_LOCATION_ID, dayOrder: 9, dutyBlockId: VALID_BLOCK_ID }],
        expectedUpdatedAt: null,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("9) RPC 'not_found' → 404", async () => {
    const supabase = fakeSupabase(async () => ({ data: { status: "not_found" }, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .put(`/api/teacher-timetables/teachers/${VALID_TEACHER_ID}/duty-availability`)
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send(validBody());

    expect(res.status).toBe(404);
  });

  it("10) RPC 'conflict' → 409 ve açıklayıcı mesaj", async () => {
    const supabase = fakeSupabase(async () => ({
      data: { status: "conflict", currentUpdatedAt: "2026-09-07T11:00:00.000Z" },
      error: null,
    }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .put(`/api/teacher-timetables/teachers/${VALID_TEACHER_ID}/duty-availability`)
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send({ ...validBody(), expectedUpdatedAt: "2000-01-01T00:00:00.000Z" });

    expect(res.status).toBe(409);
    expect(res.body.message).toContain("Güncel veriyi yeniden yükleyin");
    expect(res.body.currentUpdatedAt).toBe("2026-09-07T11:00:00.000Z");
  });

  it("10b) regresyon — ilk kayıt yarışı (expectedUpdatedAt:null) çakışması da 409 olarak eşlenir, currentUpdatedAt null olabilir", async () => {
    // save_teacher_duty_matrix RPC'si (bkz. supabase/migrations/..._create_teacher_duty_availability.sql,
    // "BULGU B DÜZELTMESİ" yorumu) v_found=true + p_expected_updated_at=null
    // durumunu da {status:"conflict", currentUpdatedAt:null-olabilir} olarak
    // döndürebilir — bu route/servis katmanının bu şekli de doğru 409'a
    // eşlediğini kalıcı olarak sabitler.
    const supabase = fakeSupabase(async () => ({ data: { status: "conflict", currentUpdatedAt: null }, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .put(`/api/teacher-timetables/teachers/${VALID_TEACHER_ID}/duty-availability`)
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send(validBody());

    expect(res.status).toBe(409);
    expect(res.body.currentUpdatedAt).toBeNull();
    expect(supabase.rpc).toHaveBeenCalledWith(
      "save_teacher_duty_matrix_v2",
      expect.objectContaining({ p_expected_updated_at: null }),
    );
  });

  it("10c) RPC 'fixed_day_locked' → 409, lockedDayOrders doğru döner, secret/stack sızmaz", async () => {
    const supabase = fakeSupabase(async () => ({
      data: { status: "fixed_day_locked", lockedDayOrders: [1, 3] },
      error: null,
    }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .put(`/api/teacher-timetables/teachers/${VALID_TEACHER_ID}/duty-availability`)
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send(validBody());

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("fixed_day_locked");
    expect(res.body.message).toBe("Sabit nöbet bulunan günlerde hiçbir blokta uygunluk değiştirilemez.");
    expect(res.body.lockedDayOrders).toEqual([1, 3]);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_SECRET);
  });

  it("11) RPC 'invalid_cells' → 400", async () => {
    const supabase = fakeSupabase(async () => ({
      data: { status: "invalid_cells", reason: "duty_location_not_available" },
      error: null,
    }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .put(`/api/teacher-timetables/teachers/${VALID_TEACHER_ID}/duty-availability`)
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send(validBody());

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_cells");
  });

  it("11b) RPC 'invalid_cells/fixed_assignment_only_location' → 400, açıklayıcı mesaj", async () => {
    const supabase = fakeSupabase(async () => ({
      data: { status: "invalid_cells", reason: "fixed_assignment_only_location" },
      error: null,
    }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .put(`/api/teacher-timetables/teachers/${VALID_TEACHER_ID}/duty-availability`)
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send(validBody());

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_cells");
    expect(res.body.reason).toBe("fixed_assignment_only_location");
    expect(res.body.message).toBe("Bu nöbet yerine yalnız Sabit Nöbetler ekranından öğretmen atanabilir.");
  });

  it("12) RPC bağlantı hatası → güvenli 500, secret/stack sızmaz", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: FAKE_SECRET, stack: "at foo.js:1:1" } }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .put(`/api/teacher-timetables/teachers/${VALID_TEACHER_ID}/duty-availability`)
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send(validBody());

    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_SECRET);
    expect(body).not.toContain("foo.js");
  });

  it("13) izin verilmeyen Origin → 403, RPC çağrılmaz", async () => {
    const supabase = fakeSupabase(async () => ({ data: { status: "ok", updatedAt: "x" }, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .put(`/api/teacher-timetables/teachers/${VALID_TEACHER_ID}/duty-availability`)
      .set("Origin", "https://evil.example.com")
      .set("Content-Type", "application/json")
      .send(validBody());

    expect(res.status).toBe(403);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("14) çok fazla hücre (>500) → 400, RPC çağrılmaz", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: null }));
    const app = createApp(testConfig(), supabase);

    const cells = Array.from({ length: 501 }, (_, i) => ({ dutyLocationId: VALID_LOCATION_ID, dayOrder: (i % 5) + 1 }));
    const res = await request(app)
      .put(`/api/teacher-timetables/teachers/${VALID_TEACHER_ID}/duty-availability`)
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send({ isIncluded: true, cells, expectedUpdatedAt: null });

    expect(res.status).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});
