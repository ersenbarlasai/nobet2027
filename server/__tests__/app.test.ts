import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createApp } from "../index";
import type { AppConfig } from "../config";
import { buildValidImportRequestBody } from "./testFixtures";

const FAKE_SECRET = "sb_secret_TEST_VALUE_MUST_NEVER_LEAK_9f8a7c";

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    supabaseUrl: "https://example.supabase.co",
    supabaseSecretKey: FAKE_SECRET,
    port: 3001,
    allowedOrigin: "http://localhost:5173",
    campusName: "Test Kampüs",
    academicYearName: "2026-2027",
    ...overrides,
  };
}

function fakeSupabase(rpcImpl: (...args: unknown[]) => Promise<{ data: unknown; error: unknown }>): SupabaseClient {
  return { rpc: vi.fn(rpcImpl) } as unknown as SupabaseClient;
}

describe("POST /api/timetable-imports", () => {
  it("2) geçersiz payload 400 döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .post("/api/timetable-imports")
      .set("Origin", "http://localhost:5173")
      .send({ invalid: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_payload");
  });

  it("4) başarılı import 200 döner ve RPC'ye doğru şekilde yönlenir", async () => {
    const successBody = {
      importId: "11111111-1111-1111-1111-111111111111",
      status: "imported",
      campusName: "Test Kampüs",
      academicYearName: "2026-2027",
      teacherCount: 1,
      classCount: 1,
      dayCount: 1,
      periodCount: 1,
      sourceCardCount: 1,
      normalizedAssignmentCount: 1,
      importedAt: "2026-08-31T00:00:00Z",
      alreadyImported: false,
    };
    const supabase = fakeSupabase(async () => ({ data: successBody, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .post("/api/timetable-imports")
      .set("Origin", "http://localhost:5173")
      .send(buildValidImportRequestBody());

    expect(res.status).toBe(200);
    expect(res.body).toEqual(successBody);
    expect(supabase.rpc).toHaveBeenCalledWith(
      "import_timetable_snapshot",
      expect.objectContaining({ p_payload: expect.objectContaining({ campus_name: "Test Kampüs" }) }),
    );
  });

  it("RPC hata dönerse 502 ve güvenli mesaj döner (kalıcı kayıt izlenimi vermez)", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "assignments: tanımsız teacher referansı: X" } }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .post("/api/timetable-imports")
      .set("Origin", "http://localhost:5173")
      .send(buildValidImportRequestBody());

    expect(res.status).toBe(502);
    expect(res.body.message).toBe("Veriler kaydedilemedi. Veritabanında değişiklik yapılmadı.");
  });

  it("12) hiçbir cevap secret anahtarını içermez", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "boom" } }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .post("/api/timetable-imports")
      .set("Origin", "http://localhost:5173")
      .send(buildValidImportRequestBody());

    expect(JSON.stringify(res.body)).not.toContain(FAKE_SECRET);
  });

  it("14) izin verilmeyen Origin 403 ile reddedilir", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .post("/api/timetable-imports")
      .set("Origin", "http://evil.example.com")
      .send(buildValidImportRequestBody());

    expect(res.status).toBe(403);
  });

  it("izin verilen Origin kabul edilir", async () => {
    const supabase = fakeSupabase(async () => ({
      data: { importId: "x", status: "imported", alreadyImported: false },
      error: null,
    }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .post("/api/timetable-imports")
      .set("Origin", "http://localhost:5173")
      .send(buildValidImportRequestBody());

    expect(res.status).toBe(200);
  });

  it("Vite varsayılan portu doluyken seçilen yerel yedek Origin kabul edilir", async () => {
    const supabase = fakeSupabase(async () => ({
      data: { importId: "x", status: "imported", alreadyImported: false },
      error: null,
    }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .post("/api/timetable-imports")
      .set("Origin", "http://localhost:5174")
      .send(buildValidImportRequestBody());

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5174");
  });

  it("yerel yedek port istisnası uzak origin yapılandırmasında açılmaz", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: null }));
    const app = createApp(testConfig({ allowedOrigin: "https://app.example.com" }), supabase);

    const res = await request(app)
      .post("/api/timetable-imports")
      .set("Origin", "http://localhost:5174")
      .send(buildValidImportRequestBody());

    expect(res.status).toBe(403);
  });

  it("Vite yedek port aralığı dışındaki yerel Origin reddedilir", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .post("/api/timetable-imports")
      .set("Origin", "http://localhost:5200")
      .send(buildValidImportRequestBody());

    expect(res.status).toBe(403);
  });

  it("15) aşırı büyük payload 413 ile reddedilir", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: null }));
    const app = createApp(testConfig(), supabase);

    const huge = buildValidImportRequestBody({
      teachers: Array.from({ length: 200000 }, (_, i) => ({
        sourceId: `T${i}`,
        name: "X".repeat(200),
        branch: null,
      })),
    });

    const res = await request(app)
      .post("/api/timetable-imports")
      .set("Origin", "http://localhost:5173")
      .send(huge);

    expect(res.status).toBe(413);
  });

  it("JSON dışı içerik türü reddedilir", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .post("/api/timetable-imports")
      .set("Origin", "http://localhost:5173")
      .set("Content-Type", "text/plain")
      .send("hello");

    expect(res.status).toBe(415);
  });
});
