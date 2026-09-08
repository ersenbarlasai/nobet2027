import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createApp } from "../index";
import type { AppConfig } from "../config";

const ORIGIN = "http://localhost:5173";
const SECRET = "sb_secret_SUBSTITUTION_MUST_NOT_LEAK";
const ID = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const config: AppConfig = { supabaseUrl: "https://example.supabase.co", supabaseSecretKey: SECRET, port: 3001, allowedOrigin: ORIGIN, campusName: "Test Kampüs", academicYearName: "2026-2027" };
const appWith = (impl: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>) => createApp(config, { rpc: vi.fn(impl) } as unknown as SupabaseClient);

describe("ders yerine görevlendirme route'ları", () => {
  it("tüm gün yokluk kapsamını ve seçili dersleri RPC'ye taşır", async () => {
    const response = await request(appWith(async (name, args) => {
      expect(name).toBe("create_teacher_absence");
      expect(args).toMatchObject({ p_absence_scope: "all_day", p_teacher_source_id: "T1", p_lesson_keys: [{ assignmentDate: "2026-09-07", timetableCardId: TASK }] });
      return { data: { status: "ok", absenceId: ID, taskCount: 1 }, error: null };
    })).post("/api/substitutions/absences").set("Origin", ORIGIN).send({ teacherSourceId: "T1", dateFrom: "2026-09-07", dateTo: "2026-09-07", absenceScope: "all_day", reasonCode: "leave", lessons: [{ assignmentDate: "2026-09-07", timetableCardId: TASK }] });
    expect(response.status).toBe(201);
  });

  it("boş ders kapsamını ve bilinmeyen alanı reddeder", async () => {
    const app = appWith(async () => ({ data: { status: "ok" }, error: null }));
    const base = { teacherSourceId: "T1", dateFrom: "2026-09-07", dateTo: "2026-09-07", absenceScope: "selected_lessons", reasonCode: "leave", lessons: [] };
    expect((await request(app).post("/api/substitutions/absences").set("Origin", ORIGIN).send(base)).status).toBe(400);
    expect((await request(app).post("/api/substitutions/absences").set("Origin", ORIGIN).send({ ...base, lessons: [{ assignmentDate: "2026-09-07", timetableCardId: TASK }], extra: true })).status).toBe(400);
  });

  it("günlük sınır aşımını güvenli 409 yanıtıyla döndürür", async () => {
    const response = await request(appWith(async () => ({ data: { status: "daily_limit_acknowledgement_required", candidate: { dailyLimit: 5 } }, error: null })))
      .put(`/api/substitutions/tasks/${TASK}`).set("Origin", ORIGIN).send({ teacherSourceId: "T1", expectedVersion: 2 });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("daily_limit_acknowledgement_required");
  });

  it("yokluk silme önizlemesini ve onaylanan etki kümesini ayrı çağırır", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const app = appWith(async (name, args) => {
      calls.push({ name, args });
      return { data: name.startsWith("preview") ? { found: true, absenceId: ID, affectedTasks: [{ id: TASK }] } : { status: "ok" }, error: null };
    });
    expect((await request(app).get(`/api/substitutions/absences/${ID}/delete-preview`).set("Origin", ORIGIN)).status).toBe(200);
    expect((await request(app).delete(`/api/substitutions/absences/${ID}`).set("Origin", ORIGIN).send({ expectedTaskIds: [TASK] })).status).toBe(200);
    expect(calls[1]).toMatchObject({ name: "delete_teacher_absence", args: { p_absence_id: ID, p_expected_task_ids: [TASK] } });
  });

  it("gün listesi silerken beklenen sürümü zorunlu tutar", async () => {
    const app = appWith(async () => ({ data: { status: "ok" }, error: null }));
    expect((await request(app).delete(`/api/substitutions/lists/${ID}`).set("Origin", ORIGIN).send({})).status).toBe(400);
    expect((await request(app).delete(`/api/substitutions/lists/${ID}`).set("Origin", ORIGIN).send({ expectedVersion: 3 })).status).toBe(200);
  });

  it("puantaj tarihini ve kapanış kararını RPC'ye taşır", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const app = appWith(async (name, args) => { calls.push({ name, args }); return { data: name === "get_payroll_overview" ? { status: "open", totals: [], lines: [] } : { status: "ok" }, error: null }; });
    await request(app).get("/api/substitutions/payroll?anchorDate=2026-09-07").set("Origin", ORIGIN);
    await request(app).post("/api/substitutions/payroll/close").set("Origin", ORIGIN).send({ anchorDate: "2026-09-07", force: true });
    expect(calls[0]).toMatchObject({ name: "get_payroll_overview", args: { p_anchor_date: "2026-09-07" } });
    expect(calls[1]).toMatchObject({ name: "close_payroll_period", args: { p_force: true } });
  });

  it("manuel puantaj düzenlemesini kimlik ve doğrulanmış alanlarla RPC'ye taşır", async () => {
    const response = await request(appWith(async (name, args) => {
      expect(name).toBe("update_manual_payroll_entry");
      expect(args).toMatchObject({ p_entry_id: ID, p_teacher_source_id: "T2", p_duty_date: "2026-09-14", p_quantity: 2 });
      return { data: { status: "ok" }, error: null };
    })).put(`/api/substitutions/payroll/entries/${ID}`).set("Origin", ORIGIN).send({ teacherSourceId: "T2", dutyDate: "2026-09-14", compensationTypeId: TASK, quantity: 2, note: "Düzeltildi" });
    expect(response.status).toBe(200);
  });

  it("özel ücret türünü yeniden adlandırmayı RPC'ye taşır",async()=>{
    const response=await request(appWith(async(name,args)=>{expect(name).toBe("save_compensation_type");expect(args).toMatchObject({p_type_id:ID,p_name:"Akşam Çalışması",p_is_active:true});return{data:{status:"ok",id:ID},error:null}})).post("/api/substitutions/compensation-types").set("Origin",ORIGIN).send({id:ID,name:"Akşam Çalışması",isActive:true});
    expect(response.status).toBe(200);
  });

  it("özel ücret türünü güvenli silme RPC'sine taşır",async()=>{
    const response=await request(appWith(async(name,args)=>{expect(name).toBe("delete_compensation_type");expect(args).toMatchObject({p_type_id:ID,p_campus_name:"Test Kampüs"});return{data:{status:"ok",action:"deactivated"},error:null}})).delete(`/api/substitutions/compensation-types/${ID}`).set("Origin",ORIGIN);
    expect(response.status).toBe(200);expect(response.body.action).toBe("deactivated");
  });

  it("sistem ücret türünün silinmesini reddeder",async()=>{
    const response=await request(appWith(async()=>({data:{status:"system_type_locked"},error:null}))).delete(`/api/substitutions/compensation-types/${ID}`).set("Origin",ORIGIN);
    expect(response.status).toBe(409);expect(response.body.message).toMatch(/Sistem ücret türü silinemez/);
  });

  it("RPC hata ayrıntısı, SQL, secret ve stack sızdırmaz", async () => {
    const response = await request(appWith(async () => ({ data: null, error: { message: `select '${SECRET}' from pg_class`, stack: "at migration.sql:42" } })))
      .get("/api/substitutions/lists").set("Origin", ORIGIN);
    const body = JSON.stringify(response.body);
    expect(response.status).toBe(500);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain("select");
    expect(body).not.toContain("stack");
  });
});
