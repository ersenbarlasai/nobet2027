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

const VALID_UUID = "11111111-1111-1111-1111-111111111111";

describe("GET /api/teacher-timetables/teachers", () => {
  it("1) import yokken hasImport:false döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: { hasImport: false, importedAt: null, teachers: [] }, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/teacher-timetables/teachers").set("Origin", "http://localhost:5173");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasImport: false, importedAt: null, teachers: [] });
  });

  it("2/3) öğretmen listesini Türkçe/numeric-aware sıralı döner", async () => {
    const rpcData = {
      hasImport: true,
      importedAt: "2026-08-31T20:23:46.000Z",
      teachers: [
        { id: "t-10", sourceId: "S10", name: "10. Öğretmen", branch: null },
        { id: "t-arslan", sourceId: "SA", name: "Arslan Asuman", branch: null },
        { id: "t-2", sourceId: "S2", name: "2. Öğretmen", branch: null },
      ],
    };
    const supabase = fakeSupabase(async () => ({ data: rpcData, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/teacher-timetables/teachers").set("Origin", "http://localhost:5173");

    expect(res.status).toBe(200);
    const names = res.body.teachers.map((t: { name: string }) => t.name);
    expect(names.indexOf("2. Öğretmen")).toBeLessThan(names.indexOf("10. Öğretmen"));
    expect(supabase.rpc).toHaveBeenCalledWith("get_current_import_teachers", {
      p_campus_name: "Test Kampüs",
      p_academic_year_name: "2026-2027",
    });
  });

  it("17) RPC hata dönerse güvenli 500 cevabı verir", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "connection to server failed" } }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/teacher-timetables/teachers").set("Origin", "http://localhost:5173");

    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Öğretmen listesi alınamadı.");
  });

  it("18) hiçbir cevap secret veya stack trace içermez", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "boom", stack: "at foo.js:1:1" } }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/teacher-timetables/teachers").set("Origin", "http://localhost:5173");

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_SECRET);
    expect(body).not.toContain("foo.js");
  });

  it("19) izin verilmeyen Origin 403 ile reddedilir", async () => {
    const supabase = fakeSupabase(async () => ({ data: { hasImport: false, importedAt: null, teachers: [] }, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/teacher-timetables/teachers").set("Origin", "http://evil.example.com");

    expect(res.status).toBe(403);
  });
});

describe("GET /api/teacher-timetables/teachers/:teacherId", () => {
  it("4) geçerli öğretmen programını 200 ile döner", async () => {
    const rpcData = {
      hasImport: true,
      teacherFound: true,
      teacher: { id: VALID_UUID, sourceId: "T1", name: "A. Yılmaz", branch: null },
      importedAt: "2026-08-31T20:23:46.000Z",
      days: [{ id: "d-1", sourceId: "D1", name: "Pazartesi", order: 1 }],
      periods: [{ id: "p-1", sourceId: "P1", name: "5-OO", order: 1, startTime: "12:15:00", endTime: "12:50:00" }],
      rows: [
        {
          cardId: "card-1",
          sourceCardKey: "card-1",
          dayId: "d-1",
          periodId: "p-1",
          subjectName: "KULÜP/LİSE",
          className: "5/A",
          classroom: null,
          mappingStatus: "expanded",
        },
        {
          cardId: "card-1",
          sourceCardKey: "card-1",
          dayId: "d-1",
          periodId: "p-1",
          subjectName: "KULÜP/LİSE",
          className: "5/B",
          classroom: null,
          mappingStatus: "expanded",
        },
      ],
    };
    const supabase = fakeSupabase(async () => ({ data: rpcData, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get(`/api/teacher-timetables/teachers/${VALID_UUID}`).set("Origin", "http://localhost:5173");

    expect(res.status).toBe(200);
    expect(res.body.teacher).toEqual(rpcData.teacher);
    expect(res.body.lessons).toHaveLength(1);
    expect(res.body.lessons[0].classNames).toEqual(["5/A", "5/B"]);
    expect(res.body.summary).toEqual({
      dayCount: 1,
      periodCount: 1,
      weeklyLessonCount: 1,
      occupiedCellCount: 1,
      classCount: 2,
      ambiguousLessonCount: 0,
      conflictCellCount: 0,
    });
    expect(supabase.rpc).toHaveBeenCalledWith("get_teacher_timetable_snapshot", {
      p_campus_name: "Test Kampüs",
      p_academic_year_name: "2026-2027",
      p_teacher_id: VALID_UUID,
    });
  });

  it("5) eski/bilinmeyen importtan teacherId için güvenli 404 döner", async () => {
    const supabase = fakeSupabase(async () => ({
      data: { hasImport: true, teacherFound: false, importedAt: "2026-08-31T20:23:46.000Z" },
      error: null,
    }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get(`/api/teacher-timetables/teachers/${VALID_UUID}`).set("Origin", "http://localhost:5173");

    expect(res.status).toBe(404);
  });

  it("6) bilinmeyen teacherId (hiç import yok) için 404 döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: { hasImport: false, teacherFound: false }, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get(`/api/teacher-timetables/teachers/${VALID_UUID}`).set("Origin", "http://localhost:5173");

    expect(res.status).toBe(404);
  });

  it("7) geçersiz UUID formatı 400 ile reddedilir (RPC hiç çağrılmaz)", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/teacher-timetables/teachers/not-a-uuid").set("Origin", "http://localhost:5173");

    expect(res.status).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("17) RPC hata dönerse güvenli 500 cevabı verir", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "connection to server failed" } }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get(`/api/teacher-timetables/teachers/${VALID_UUID}`).set("Origin", "http://localhost:5173");

    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Öğretmen ders programı alınamadı.");
  });

  it("18) hiçbir cevap secret veya stack trace içermez", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "boom", stack: "at foo.js:1:1" } }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get(`/api/teacher-timetables/teachers/${VALID_UUID}`).set("Origin", "http://localhost:5173");

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_SECRET);
    expect(body).not.toContain("foo.js");
  });
});
