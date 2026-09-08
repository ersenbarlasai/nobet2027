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

function fakeSupabase(rpcImpl: (...args: unknown[]) => Promise<{ data: unknown; error: unknown }>): SupabaseClient {
  return { rpc: vi.fn(rpcImpl) } as unknown as SupabaseClient;
}

describe("GET /api/timetable-imports/current", () => {
  it("1) başarılı import varken RPC sonucunu olduğu gibi döner", async () => {
    const snapshot = {
      hasImport: true,
      import: {
        sourceFilename: "asc.xml",
        status: "imported",
        campusName: "Test Kampüs",
        academicYearName: "2026-2027",
        importedAt: "2026-08-31T20:15:00Z",
        teacherCount: 55,
        classCount: 26,
        dayCount: 5,
        periodCount: 10,
        sourceCardCount: 1140,
        normalizedAssignmentCount: 1341,
        hasCountMismatch: false,
      },
    };
    const supabase = fakeSupabase(async () => ({ data: snapshot, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/timetable-imports/current").set("Origin", "http://localhost:5173");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(snapshot);
    expect(supabase.rpc).toHaveBeenCalledWith("get_current_timetable_import_snapshot", {
      p_campus_name: "Test Kampüs",
      p_academic_year_name: "2026-2027",
    });
  });

  it("2) import yokken hasImport:false döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: { hasImport: false, import: null }, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/timetable-imports/current").set("Origin", "http://localhost:5173");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasImport: false, import: null });
  });

  it("10) RPC hata dönerse güvenli 500 cevabı verir", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "connection to server failed" } }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/timetable-imports/current").set("Origin", "http://localhost:5173");

    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Mevcut ders programı bilgisi alınamadı.");
  });

  it("11) hiçbir cevap secret veya stack trace içermez", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "boom", stack: "at foo.js:1:1" } }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/timetable-imports/current").set("Origin", "http://localhost:5173");

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_SECRET);
    expect(body).not.toContain("foo.js");
    expect(res.body.detail).toBeUndefined();
  });

  it("12) izin verilmeyen Origin 403 ile reddedilir", async () => {
    const supabase = fakeSupabase(async () => ({ data: { hasImport: false, import: null }, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/timetable-imports/current").set("Origin", "http://evil.example.com");

    expect(res.status).toBe(403);
  });
});
