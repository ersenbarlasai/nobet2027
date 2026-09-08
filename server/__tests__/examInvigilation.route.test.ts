import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createApp } from "../index";
import type { AppConfig } from "../config";

const ORIGIN = "http://localhost:5173";
const SECRET = "sb_secret_EXAM_ROUTE_MUST_NOT_LEAK";
const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

function config(): AppConfig {
  return { supabaseUrl: "https://example.supabase.co", supabaseSecretKey: SECRET, port: 3001, allowedOrigin: ORIGIN, campusName: "Test Kampüs", academicYearName: "2026-2027" };
}

function appWithRpc(impl: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>) {
  return createApp(config(), { rpc: vi.fn(impl) } as unknown as SupabaseClient);
}

describe("Deneme sınavı gözetmen route'ları", () => {
  it("planı seçili sınıf, gün, saat ve okul grubu oturumlarıyla oluşturur", async () => {
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe("create_exam_invigilation_plan_v2");
      expect(args).toMatchObject({ p_week_start_date: "2026-09-14", p_session_specs: [
        { scopeCode: "MIDDLE_SCHOOL", examDate: "2026-09-16", periodOrder: 3, schoolClassIds: ["33333333-3333-4333-8333-333333333333"], requiredCount: 1 },
        { scopeCode: "HIGH_SCHOOL", examDate: "2026-09-18", periodOrder: 5, schoolClassIds: ["44444444-4444-4444-8444-444444444444"], requiredCount: 1 },
      ] });
      return { data: { status: "ok", planId: PLAN_ID }, error: null };
    });
    const response = await request(appWithRpc(rpc)).post("/api/exam-invigilation/plans").set("Origin", ORIGIN).send({
      name: "Haftalık Deneme Sınavları", weekStartDate: "2026-09-14", sessions: [
        { scopeCode: "MIDDLE_SCHOOL", examDate: "2026-09-16", periodOrder: 3, schoolClassIds: ["33333333-3333-4333-8333-333333333333"], requiredCount: 1 },
        { scopeCode: "HIGH_SCHOOL", examDate: "2026-09-18", periodOrder: 5, schoolClassIds: ["44444444-4444-4444-8444-444444444444"], requiredCount: 1 },
      ],
    });
    expect(response.status).toBe(201);
    expect(response.body.planId).toBe(PLAN_ID);
  });

  it("aynı sınıfın aynı gün ve saatini iki satırda tekrar etmeyi doğrulamada reddeder", async () => {
    const classId="33333333-3333-4333-8333-333333333333";
    const session={scopeCode:"MIDDLE_SCHOOL",examDate:"2026-09-18",periodOrder:2,schoolClassIds:[classId],requiredCount:1};
    const response=await request(appWithRpc(async()=>({data:{status:"ok"},error:null}))).post("/api/exam-invigilation/plans").set("Origin",ORIGIN).send({name:"Tekrar",weekStartDate:"2026-09-14",sessions:[session,session]});
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/birden fazla/);
  });

  it("gözetmen sayısının sınıf seçiminden bağımsız artırılmasını reddeder", async () => {
    const response=await request(appWithRpc(async()=>({data:{status:"ok"},error:null}))).post("/api/exam-invigilation/plans").set("Origin",ORIGIN).send({name:"Geçersiz sayı",weekStartDate:"2026-09-14",sessions:[{scopeCode:"MIDDLE_SCHOOL",examDate:"2026-09-18",periodOrder:2,schoolClassIds:["33333333-3333-4333-8333-333333333333"],requiredCount:2}]});
    expect(response.status).toBe(400);
  });

  it("aday listesini sunucunun ortak havuz süzgecinden değiştirmeden döndürür", async () => {
    const payload = { found: true, sessionFound: true, scopeVersion: 3, isStale: false, candidates: [{ teacherSourceId: "t1", teacherName: "Ada", suitability: "direct", dutyWarnings: [] }], excludedCounts: { lessonConflict: 4, otherScope: 2, otherSession: 1 } };
    const response = await request(appWithRpc(async (name) => {
      expect(name).toBe("get_exam_invigilation_candidates");
      return { data: payload, error: null };
    })).get(`/api/exam-invigilation/plans/${PLAN_ID}/sessions/${SESSION_ID}/candidates`).set("Origin", ORIGIN);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(payload);
  });

  it("diğer okul grubuna ayrılmış öğretmeni teacher_already_assigned_other_scope olarak reddeder", async () => {
    const response = await request(appWithRpc(async () => ({ data: { status: "teacher_already_assigned_other_scope", assignedScope: "HIGH_SCHOOL", periodName: "3. Saat" }, error: null })))
      .put(`/api/exam-invigilation/plans/${PLAN_ID}/sessions/${SESSION_ID}/assignment`).set("Origin", ORIGIN)
      .send({ slotNumber: 1, teacherSourceId: "t1", expectedScopeVersion: 2 });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: "teacher_already_assigned_other_scope", assignedScope: "HIGH_SCHOOL" });
  });

  it("nöbetli öğretmende açık devir onayı ister ve onay alanını RPC'ye taşır", async () => {
    const calls: Record<string, unknown>[] = [];
    const app = appWithRpc(async (_name, args) => {
      calls.push(args);
      if (args.p_duty_coverage_acknowledged === true) return { data: { status: "ok", scopeVersion: 4, assignmentId: "a1" }, error: null };
      return { data: { status: "duty_coverage_acknowledgement_required", dutyWarnings: [{ locationName: "Alt Bahçe", coverageMode: "BREAKS" }] }, error: null };
    });
    const url = `/api/exam-invigilation/plans/${PLAN_ID}/sessions/${SESSION_ID}/assignment`;
    const first = await request(app).put(url).set("Origin", ORIGIN).send({ slotNumber: 1, teacherSourceId: "t1", expectedScopeVersion: 3 });
    expect(first.status).toBe(409);
    expect(first.body.error).toBe("duty_coverage_acknowledgement_required");
    const second = await request(app).put(url).set("Origin", ORIGIN).send({ slotNumber: 1, teacherSourceId: "t1", expectedScopeVersion: 3, dutyCoverageAcknowledged: true, dutyCoverageNote: "Rehber öğretmen kısa süreli devralacak." });
    expect(second.status).toBe(200);
    expect(calls[1]).toMatchObject({ p_duty_coverage_acknowledged: true, p_duty_coverage_note: "Rehber öğretmen kısa süreli devralacak." });
  });

  it("yalnız seçilen okul grubunu beklenen sürümle tamamlar", async () => {
    const response = await request(appWithRpc(async (name, args) => {
      expect(name).toBe("complete_exam_invigilation_scope");
      expect(args).toMatchObject({ p_scope_code: "MIDDLE_SCHOOL", p_expected_scope_version: 7 });
      return { data: { status: "ok", version: 8 }, error: null };
    })).post(`/api/exam-invigilation/plans/${PLAN_ID}/complete`).set("Origin", ORIGIN).send({ scopeCode: "MIDDLE_SCHOOL", expectedScopeVersion: 7 });
    expect(response.status).toBe(200);
  });

  it("XML'den türeyen okul öncesi ve ilkokul kademelerini kabul eder", async () => {
    const response=await request(appWithRpc(async(name,args)=>{
      expect(name).toBe("create_exam_invigilation_plan_v2");
      expect(args.p_session_specs).toEqual([
        expect.objectContaining({scopeCode:"PRESCHOOL"}),
        expect.objectContaining({scopeCode:"PRIMARY_SCHOOL"}),
      ]);
      return{data:{status:"ok",planId:PLAN_ID},error:null};
    })).post("/api/exam-invigilation/plans").set("Origin",ORIGIN).send({name:"Tüm Kademeler",weekStartDate:"2026-09-14",sessions:[
      {scopeCode:"PRESCHOOL",examDate:"2026-09-18",periodOrder:2,schoolClassIds:["33333333-3333-4333-8333-333333333333"],requiredCount:1},
      {scopeCode:"PRIMARY_SCHOOL",examDate:"2026-09-18",periodOrder:2,schoolClassIds:["44444444-4444-4444-8444-444444444444"],requiredCount:1},
    ]});
    expect(response.status).toBe(201);
  });

  it("yarım kalan okul grubu taslağını diğer tamamlanmış gruba dokunmadan siler",async()=>{const response=await request(appWithRpc(async(name,args)=>{expect(name).toBe("discard_exam_invigilation_scope");expect(args).toMatchObject({p_plan_id:PLAN_ID,p_scope_code:"HIGH_SCHOOL",p_expected_version:4});return{data:{status:"ok",version:5},error:null}})).delete(`/api/exam-invigilation/plans/${PLAN_ID}/scopes/HIGH_SCHOOL`).set("Origin",ORIGIN).send({expectedScopeVersion:4});expect(response.status).toBe(200);});

  it("plan kaydını durumundan bağımsız olarak plan kimliğiyle siler",async()=>{const response=await request(appWithRpc(async(name,args)=>{expect(name).toBe("delete_exam_invigilation_plan");expect(args).toEqual({p_plan_id:PLAN_ID});return{data:{status:"ok",deleted:1},error:null}})).delete(`/api/exam-invigilation/plans/${PLAN_ID}`).set("Origin",ORIGIN);expect(response.status).toBe(200);expect(response.body.deleted).toBe(1);});

  it("bulunamayan plan kaydı için 404 döner",async()=>{const response=await request(appWithRpc(async()=>({data:{status:"plan_not_found"},error:null}))).delete(`/api/exam-invigilation/plans/${PLAN_ID}`).set("Origin",ORIGIN);expect(response.status).toBe(404);expect(response.body.message).toMatch(/bulunamadı/);});

  it("silme RPC'si uygulanmadığında bekleyen veritabanı güncellemesini açıkça bildirir",async()=>{const response=await request(appWithRpc(async()=>({data:null,error:{code:"PGRST202",message:"Could not find the function public.delete_exam_invigilation_plan"}}))).delete(`/api/exam-invigilation/plans/${PLAN_ID}`).set("Origin",ORIGIN);expect(response.status).toBe(503);expect(response.body).toMatchObject({error:"database_upgrade_required"});expect(response.body.message).toMatch(/veritabanı güncellemesi/);});

  it("plan kayıtları süzgeçlerini olduğu gibi listeleme RPC'sine taşır", async () => {
    const calls: Record<string, unknown>[] = [];
    const response = await request(appWithRpc(async (name, args) => {
      expect(name).toBe("list_exam_invigilation_plans_v2");
      calls.push(args);
      return { data: { status: "ok", items: [] }, error: null };
    })).get("/api/exam-invigilation/plans?status=completed&scopeCode=HIGH_SCHOOL&search=Deneme&dateFrom=2026-09-14&dateTo=2026-09-18&sort=oldest").set("Origin", ORIGIN);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [] });
    expect(calls[0]).toMatchObject({
      p_status: "completed", p_scope_code: "HIGH_SCHOOL", p_search: "Deneme",
      p_date_from: "2026-09-14", p_date_to: "2026-09-18", p_sort: "oldest",
    });
  });

  it("süzgeç verilmediğinde varsayılan olarak tüm kayıtları en yeniden sıralar", async () => {
    const calls: Record<string, unknown>[] = [];
    const response = await request(appWithRpc(async (_name, args) => {
      calls.push(args);
      return { data: { status: "ok", items: [{ id: PLAN_ID }] }, error: null };
    })).get("/api/exam-invigilation/plans").set("Origin", ORIGIN);
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(calls[0]).toMatchObject({ p_status: "all", p_scope_code: null, p_search: null, p_date_from: null, p_date_to: null, p_sort: "newest" });
  });

  it("geçersiz durum, okul grubu, tarih ve sıralama süzgeçlerini 400 ile reddeder", async () => {
    const app = appWithRpc(async () => ({ data: { status: "ok", items: [] }, error: null }));
    for (const query of ["status=archived", "scopeCode=PRIMARY", "sort=random", "dateFrom=14-09-2026", "dateFrom=2026-09-20&dateTo=2026-09-14", "unknownFilter=1"]) {
      const response = await request(app).get(`/api/exam-invigilation/plans?${query}`).set("Origin", ORIGIN);
      expect(response.status, query).toBe(400);
      expect(response.body.error).toBe("validation_error");
    }
  });

  it("RPC süzgeç doğrulaması başarısızsa 400 döner ve gövdeyi sızdırmaz", async () => {
    const response = await request(appWithRpc(async () => ({ data: { status: "validation_error", items: [] }, error: null })))
      .get("/api/exam-invigilation/plans?status=draft").set("Origin", ORIGIN);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain(SECRET);
  });

  it("süzgeçli listeleme hatasında da secret, SQL ve stack sızdırmaz", async () => {
    const response = await request(appWithRpc(async () => ({ data: null, error: { message: `select '${SECRET}' from pg_class`, stack: "at 20261001090000_add_exam_invigilation_plan_archive.sql:12" } })))
      .get("/api/exam-invigilation/plans?status=stale&search=Deneme").set("Origin", ORIGIN);
    const body = JSON.stringify(response.body);
    expect(response.status).toBe(500);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain("pg_class");
    expect(body).not.toContain("20261001090000");
    expect(body).not.toContain("select");
  });

  it("RPC hatasında secret, SQL ve stack bilgisini yanıt gövdesine sızdırmaz", async () => {
    const response = await request(appWithRpc(async () => ({ data: null, error: { message: `select '${SECRET}'`, stack: "at migration.sql:42" } })))
      .get("/api/exam-invigilation/plans").set("Origin", ORIGIN);
    const body = JSON.stringify(response.body);
    expect(response.status).toBe(500);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain("migration.sql");
    expect(body).not.toContain("select");
  });
});
