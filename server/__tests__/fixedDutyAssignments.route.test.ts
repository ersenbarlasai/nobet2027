import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createApp } from "../index";
import type { AppConfig } from "../config";

const FAKE_SECRET = "sb_secret_TEST_VALUE_MUST_NEVER_LEAK_9f8a7c";
const ORIGIN = "http://localhost:5173";
const TEACHER_ID = "10000000-0000-4000-8000-000000000001";
const LOCATION_ID = "20000000-0000-4000-8000-000000000002";

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

function validBody() {
  return { teacherId: TEACHER_ID, dayOrder: 1, dutyLocationId: LOCATION_ID };
}

describe("POST /api/fixed-duty-assignments — sabit nöbete uygunluk kuralı", () => {
  it("1) uygun olmayan nöbet yeri → 400 location_not_fixed_eligible ve açıklayıcı mesaj", async () => {
    // Frontend seçim listesi yalnız allows_fixed_assignment=true olan yerleri
    // gösterir; bu test o filtre AŞILDIĞINDA (eski sekme, doğrudan HTTP
    // isteği) backend'in yine de reddettiğini sabitler.
    const supabase = fakeSupabase(async () => ({ data: { status: "location_not_fixed_eligible" }, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .post("/api/fixed-duty-assignments")
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send(validBody());

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("location_not_fixed_eligible");
    expect(res.body.message).toContain("ilkokul koridorlarına");
    // Bu durum "bulunamadı" ile KARIŞTIRILMAMALIDIR: yer vardır ve aktiftir,
    // yalnızca sabit nöbete uygun değildir.
    expect(res.status).not.toBe(404);
  });

  it("2) uygun nöbet yeri → 201", async () => {
    const supabase = fakeSupabase(async () => ({ data: { status: "ok", id: "fx-1" }, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .post("/api/fixed-duty-assignments")
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send(validBody());

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("fx-1");
    expect(supabase.rpc).toHaveBeenCalledWith("create_fixed_duty_assignment", {
      p_campus_name: "Test Kampüs",
      p_academic_year_name: "2026-2027",
      p_teacher_id: TEACHER_ID,
      p_day_order: 1,
      p_duty_location_id: LOCATION_ID,
    });
  });

  it("3) location_not_found hâlâ 404 döner (uygunluk kuralıyla karışmaz)", async () => {
    const supabase = fakeSupabase(async () => ({ data: { status: "location_not_found" }, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .post("/api/fixed-duty-assignments")
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send(validBody());

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("location_not_found");
  });

  it("4) gün/yer çakışması → 409", async () => {
    const supabase = fakeSupabase(async () => ({ data: { status: "location_conflict" }, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .post("/api/fixed-duty-assignments")
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send(validBody());

    expect(res.status).toBe(409);
  });

  it("5) RPC hatasında güvenli 500; secret sızmaz", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "boom" } }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .post("/api/fixed-duty-assignments")
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send(validBody());

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_SECRET);
  });
});

describe("GET /api/fixed-duty-assignments", () => {
  it("6) dutyLocations yalnız sabit nöbete uygun yerleri taşır (RPC filtresi geçirilir)", async () => {
    const snapshot = {
      hasImport: true,
      teachers: [],
      days: [],
      dutyLocations: [
        { id: LOCATION_ID, name: "İlkokul 1. Kat", shortCode: "ILKOKUL1", allowsFixedAssignment: true },
      ],
      assignments: [],
    };
    const supabase = fakeSupabase(async () => ({ data: snapshot, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/fixed-duty-assignments").set("Origin", ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body.dutyLocations).toEqual([
      { id: LOCATION_ID, name: "İlkokul 1. Kat", shortCode: "ILKOKUL1", allowsFixedAssignment: true },
    ]);
  });
});
