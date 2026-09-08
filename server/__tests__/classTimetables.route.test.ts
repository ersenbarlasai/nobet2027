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

describe("GET /api/class-timetables/classes", () => {
  it("1) import yokken hasImport:false döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: { hasImport: false, importedAt: null, classes: [] }, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/class-timetables/classes").set("Origin", "http://localhost:5173");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasImport: false, importedAt: null, classes: [] });
  });

  it("2) sınıf listesini numeric-aware sıralı döner", async () => {
    const rpcData = {
      hasImport: true,
      importedAt: "2026-08-31T20:23:46.000Z",
      classes: [
        { id: "c-10a", sourceId: "S10A", name: "10/A", grade: null },
        { id: "c-5a", sourceId: "S5A", name: "5/A", grade: null },
        { id: "c-5b", sourceId: "S5B", name: "5/B", grade: null },
      ],
    };
    const supabase = fakeSupabase(async () => ({ data: rpcData, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/class-timetables/classes").set("Origin", "http://localhost:5173");

    expect(res.status).toBe(200);
    expect(res.body.classes.map((c: { name: string }) => c.name)).toEqual(["5/A", "5/B", "10/A"]);
    expect(supabase.rpc).toHaveBeenCalledWith("get_current_import_classes", {
      p_campus_name: "Test Kampüs",
      p_academic_year_name: "2026-2027",
    });
  });

  it("13) RPC hata dönerse güvenli 500 cevabı verir", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "connection to server failed" } }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/class-timetables/classes").set("Origin", "http://localhost:5173");

    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Sınıf listesi alınamadı.");
  });

  it("14) hiçbir cevap secret veya stack trace içermez", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "boom", stack: "at foo.js:1:1" } }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/class-timetables/classes").set("Origin", "http://localhost:5173");

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_SECRET);
    expect(body).not.toContain("foo.js");
  });

  it("15) izin verilmeyen Origin 403 ile reddedilir", async () => {
    const supabase = fakeSupabase(async () => ({ data: { hasImport: false, importedAt: null, classes: [] }, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/class-timetables/classes").set("Origin", "http://evil.example.com");

    expect(res.status).toBe(403);
  });
});

describe("GET /api/class-timetables/classes/:classId", () => {
  it("4) geçerli sınıf programını 200 ile döner", async () => {
    const rpcData = {
      hasImport: true,
      classFound: true,
      class: { id: "c-1", sourceId: "C1", name: "5/A", grade: null, classTeacher: { id: "t-1", name: "A. Yılmaz" } },
      importedAt: "2026-08-31T20:23:46.000Z",
      days: [{ id: "d-1", sourceId: "D1", name: "Pazartesi", order: 1 }],
      periods: [
        { id: "p-1", sourceId: "P1", name: "1. Ders", order: 1, startTime: "08:30:00", endTime: "09:10:00" },
      ],
      rows: [
        {
          cardId: "card-1",
          sourceCardKey: "card-1",
          dayId: "d-1",
          periodId: "p-1",
          subjectName: "Matematik",
          teacherName: "A. Yılmaz",
          classroomNames: ["5A-D1"],
          mappingStatus: "exact",
          teacherAssignmentStatus: "assigned",
        },
      ],
    };
    const supabase = fakeSupabase(async () => ({ data: rpcData, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/class-timetables/classes/c-1").set("Origin", "http://localhost:5173");

    expect(res.status).toBe(200);
    expect(res.body.class).toEqual(rpcData.class);
    expect(res.body.lessons).toHaveLength(1);
    expect(res.body.lessons[0].teacherNames).toEqual(["A. Yılmaz"]);
    expect(res.body.summary).toEqual({
      dayCount: 1,
      periodCount: 1,
      weeklyLessonCount: 1,
      occupiedCellCount: 1,
      ambiguousCellCount: 0,
      conflictCellCount: 0,
    });
    expect(supabase.rpc).toHaveBeenCalledWith("get_class_timetable_snapshot", {
      p_campus_name: "Test Kampüs",
      p_academic_year_name: "2026-2027",
      p_class_id: "c-1",
    });
  });

  it("1-9) öğretmensiz (teacherids=\"\") lesson/card kaybolmadan döner (ör. ORTAOKUL DENEME)", async () => {
    const rpcData = {
      hasImport: true,
      classFound: true,
      class: { id: "c-8a", sourceId: "C8A", name: "8/A", grade: null, classTeacher: null },
      importedAt: "2026-08-31T20:23:46.000Z",
      days: [{ id: "d-cuma", sourceId: "D5", name: "Cuma", order: 5 }],
      periods: [
        { id: "p-2", sourceId: "P2", name: "2", order: 2, startTime: "10:00:00", endTime: "10:35:00" },
        { id: "p-3", sourceId: "P3", name: "3", order: 3, startTime: "10:45:00", endTime: "10:55:00" },
        { id: "p-4", sourceId: "P4", name: "4", order: 4, startTime: "11:30:00", endTime: "12:05:00" },
        { id: "p-5oo", sourceId: "P5", name: "5-OO", order: 5, startTime: "12:15:00", endTime: "12:50:00" },
      ],
      rows: [
        {
          cardId: "card-1",
          sourceCardKey: "card-1",
          dayId: "d-cuma",
          periodId: "p-2",
          subjectName: "ORTAOKUL DENEME",
          teacherName: null,
          classroomNames: [],
          mappingStatus: null,
          teacherAssignmentStatus: "unassigned",
        },
        {
          cardId: "card-2",
          sourceCardKey: "card-2",
          dayId: "d-cuma",
          periodId: "p-3",
          subjectName: "ORTAOKUL DENEME",
          teacherName: null,
          classroomNames: [],
          mappingStatus: null,
          teacherAssignmentStatus: "unassigned",
        },
        {
          cardId: "card-3",
          sourceCardKey: "card-3",
          dayId: "d-cuma",
          periodId: "p-4",
          subjectName: "ORTAOKUL DENEME",
          teacherName: null,
          classroomNames: [],
          mappingStatus: null,
          teacherAssignmentStatus: "unassigned",
        },
        {
          cardId: "card-4",
          sourceCardKey: "card-4",
          dayId: "d-cuma",
          periodId: "p-5oo",
          subjectName: "ORTAOKUL DENEME",
          teacherName: null,
          classroomNames: [],
          mappingStatus: null,
          teacherAssignmentStatus: "unassigned",
        },
      ],
    };
    const supabase = fakeSupabase(async () => ({ data: rpcData, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/class-timetables/classes/c-8a").set("Origin", "http://localhost:5173");

    expect(res.status).toBe(200);
    expect(res.body.lessons).toHaveLength(4);
    expect(res.body.lessons.every((l: { teacherNames: string[] }) => l.teacherNames.length === 0)).toBe(true);
    expect(res.body.lessons.every((l: { teacherAssignmentStatus: string }) => l.teacherAssignmentStatus === "unassigned")).toBe(
      true,
    );
    expect(res.body.lessons.every((l: { mappingStatus: string | null }) => l.mappingStatus === null)).toBe(true);
    expect(res.body.summary.weeklyLessonCount).toBe(4);
    expect(res.body.summary.occupiedCellCount).toBe(4);
    expect(res.body.summary.ambiguousCellCount).toBe(0);
  });

  it("14) sınıf öğretmeni olmayan sınıfta classTeacher:null döner", async () => {
    const rpcData = {
      hasImport: true,
      classFound: true,
      class: { id: "c-2", sourceId: "C2", name: "4YAS", grade: null, classTeacher: null },
      importedAt: "2026-08-31T20:23:46.000Z",
      days: [{ id: "d-1", sourceId: "D1", name: "Pazartesi", order: 1 }],
      periods: [{ id: "p-1", sourceId: "P1", name: "1", order: 1, startTime: "09:15:00", endTime: "09:50:00" }],
      rows: [],
    };
    const supabase = fakeSupabase(async () => ({ data: rpcData, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/class-timetables/classes/c-2").set("Origin", "http://localhost:5173");

    expect(res.status).toBe(200);
    expect(res.body.class.classTeacher).toBeNull();
  });

  it("5) eski/bilinmeyen importtan classId için güvenli 404 döner", async () => {
    const supabase = fakeSupabase(async () => ({
      data: { hasImport: true, classFound: false, importedAt: "2026-08-31T20:23:46.000Z" },
      error: null,
    }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/class-timetables/classes/old-class").set("Origin", "http://localhost:5173");

    expect(res.status).toBe(404);
  });

  it("6) bilinmeyen classId (hiç import yok) için 404 döner", async () => {
    const supabase = fakeSupabase(async () => ({ data: { hasImport: false, classFound: false }, error: null }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/class-timetables/classes/unknown").set("Origin", "http://localhost:5173");

    expect(res.status).toBe(404);
  });

  it("13) RPC hata dönerse güvenli 500 cevabı verir", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "connection to server failed" } }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/class-timetables/classes/c-1").set("Origin", "http://localhost:5173");

    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Sınıf ders programı alınamadı.");
  });

  it("14) hiçbir cevap secret veya stack trace içermez", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "boom", stack: "at foo.js:1:1" } }));
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/class-timetables/classes/c-1").set("Origin", "http://localhost:5173");

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_SECRET);
    expect(body).not.toContain("foo.js");
  });
});
