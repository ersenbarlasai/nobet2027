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

const COUNTS = {
  dutyPlanCount: 3,
  examInvigilationPlanCount: 2,
  assignmentListCount: 5,
  payrollRecordCount: 12,
  closedPeriodCount: 1,
};

describe("GET /api/system-data/trial-data/counts", () => {
  it("1) RPC sonucunu camelCase DTO olarak döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: { status: "ok", ...COUNTS }, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/system-data/trial-data/counts").set("Origin", ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(COUNTS);
  });

  it("2) RPC hata dönerse 500 ve jenerik mesaj — ham veritabanı hatası sızdırmaz", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "relation does not exist" } }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/system-data/trial-data/counts").set("Origin", ORIGIN);

    expect(res.status).toBe(500);
    expect(res.body.error.message).not.toMatch(/relation/i);
  });
});

describe("POST /api/system-data/trial-data/clear", () => {
  it("3) doğru onay ifadesiyle çağrılır ve silinen sayıları döner", async () => {
    const supabase = fakeSupabase(async (fn) => {
      expect(fn).toBe("clear_trial_records");
      return { data: { status: "ok", deleted: COUNTS }, error: null };
    });
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .post("/api/system-data/trial-data/clear")
      .set("Origin", ORIGIN)
      .send({ confirmationText: "KAYITLARI TEMİZLE" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: COUNTS });
  });

  it("4) onay ifadesi eksik/hatalıysa RPC hiç çağrılmadan 400 döner", async () => {
    const rpc = vi.fn();
    const supabase = { rpc } as unknown as SupabaseClient;
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .post("/api/system-data/trial-data/clear")
      .set("Origin", ORIGIN)
      .send({ confirmationText: "yanlis" });

    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("5) RPC başarısız olursa ham veritabanı mesajı değil, sabit kullanıcı mesajı döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "foreign key violation on duty_plans" } }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .post("/api/system-data/trial-data/clear")
      .set("Origin", ORIGIN)
      .send({ confirmationText: "KAYITLARI TEMİZLE" });

    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe(
      "Kayıtlar temizlenemedi. Veritabanında değişiklik yapılmadı. Lütfen tekrar deneyin.",
    );
  });
});
