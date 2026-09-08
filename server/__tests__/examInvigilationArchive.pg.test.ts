import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * Gerçek PostgreSQL kabul testi — deneme sınavı gözetmen plan arşivi.
 * Yalnız DUTY_PLAN_PG_TEST_DB_URL verilirse çalışır; tüm fixture tek
 * transaction içinde tutulur ve sonunda geri alınır.
 *
 *   DUTY_PLAN_PG_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/nobet2027_exam_archive
 */
const DB_URL = process.env.DUTY_PLAN_PG_TEST_DB_URL;

interface ScopeSummary { scopeCode: string; status: string; planned: boolean; requiredCount: number; assignedCount: number; openCount: number; warningCount: number }
interface PlanRecord { id: string; name: string; overallStatus: string; isStale: boolean; examDates: string[]; requiredCount: number; assignedCount: number; openCount: number; dutyWarningCount: number; weekStartDate: string; createdAt: string; scopes: ScopeSummary[] }

describe.skipIf(!DB_URL)("deneme sınavı gözetmen plan arşivi — gerçek PostgreSQL", () => {
  let db: Client;
  let campusName: string;
  let yearName: string;
  let middleClassId: string;
  let highClassId: string;
  let planA: string;
  let planB: string;
  let planC: string;

  async function rpc(functionName: string, args: unknown[]) {
    const placeholders = args.map((_, index) => `$${index + 1}`).join(",");
    return (await db.query(`select public.${functionName}(${placeholders}) as result`, args)).rows[0].result as Record<string, unknown>;
  }

  async function listPlans(filters: Record<string, unknown> = {}) {
    const result = await rpc("list_exam_invigilation_plans_v2", [
      campusName, yearName, filters.status ?? "all", filters.scopeCode ?? null,
      filters.search ?? null, filters.dateFrom ?? null, filters.dateTo ?? null, filters.sort ?? "newest",
    ]);
    return { status: result.status as string, items: result.items as PlanRecord[] };
  }

  async function detail(planId: string) {
    return await rpc("get_exam_invigilation_plan", [planId, campusName, yearName]);
  }

  async function scopeVersion(planId: string, scopeCode: string): Promise<number> {
    const plan = await detail(planId);
    const scopes = plan.scopes as { scopeCode: string; version: number }[];
    return scopes.find(scope => scope.scopeCode === scopeCode)!.version;
  }

  async function sessionId(planId: string, scopeCode: string, examDate: string, periodOrder: number): Promise<string> {
    const plan = await detail(planId);
    const scopes = plan.scopes as { scopeCode: string; sessions: { id: string; examDate: string; periodOrder: number }[] }[];
    return scopes.find(scope => scope.scopeCode === scopeCode)!.sessions
      .find(session => session.examDate === examDate && session.periodOrder === periodOrder)!.id;
  }

  async function createPlan(name: string, specs: unknown[]): Promise<string> {
    const created = await rpc("create_exam_invigilation_plan_v2", [campusName, yearName, name, "2026-09-14", JSON.stringify(specs)]);
    expect(created.status).toBe("ok");
    return String(created.planId);
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    await db.query("begin");
    const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
    campusName = `Archive Campus ${suffix}`;
    yearName = `2026-2027 ARCHIVE ${suffix}`;

    const campusId = (await db.query("insert into public.campuses(name,code) values($1,$2) returning id", [campusName, `A${suffix}`])).rows[0].id;
    const yearId = (await db.query("insert into public.academic_years(campus_id,name) values($1,$2) returning id", [campusId, yearName])).rows[0].id;
    const importId = (await db.query(`insert into public.timetable_imports(campus_id,academic_year_id,source_format,source_filename,status,imported_at)
      values($1,$2,'asc','archive.xml','imported',now()) returning id`, [campusId, yearId])).rows[0].id;
    await db.query("insert into public.lesson_periods(timetable_import_id,source_id,name,period_order,starts_at,ends_at) values($1,'p2','2. Saat',2,'09:20','10:00')", [importId]);
    await db.query("insert into public.lesson_periods(timetable_import_id,source_id,name,period_order,starts_at,ends_at) values($1,'p3','3. Saat',3,'10:10','10:50')", [importId]);
    await db.query("insert into public.timetable_days(timetable_import_id,source_id,name,day_order) values($1,'d3','Çarşamba',3)", [importId]);
    await db.query("insert into public.timetable_days(timetable_import_id,source_id,name,day_order) values($1,'d5','Cuma',5)", [importId]);
    for (const [sourceId, name] of [["t1", "Aylin Kaya"], ["t2", "Barış Ateş"], ["t3", "Ceren Yıldız"], ["duty", "Nöbetçi Öğretmen"]]) {
      await db.query("insert into public.teachers(timetable_import_id,source_id,name,branch) values($1,$2,$3,'Test')", [importId, sourceId, name]);
    }
    middleClassId = (await db.query("insert into public.school_classes(timetable_import_id,source_id,name,grade) values($1,'8a','8/A','8') returning id", [importId])).rows[0].id;
    highClassId = (await db.query("insert into public.school_classes(timetable_import_id,source_id,name,grade) values($1,'11a','11/A','11') returning id", [importId])).rows[0].id;

    await db.query("set local session_replication_role=replica");
    const dutyPlanId = (await db.query(`insert into public.duty_plans(campus_id,academic_year_id,timetable_import_id,status,source_fingerprint,algorithm_version,week_start_date)
      values($1,$2,$3,'published',$4,'test-v4','2026-09-14') returning id`, [campusId, yearId, importId, "b".repeat(64)])).rows[0].id;
    const locationId = (await db.query("insert into public.duty_locations(campus_id,name,short_code,category,sort_order) values($1,'Alt Bahçe',$2,'garden',1) returning id", [campusId, `AR${suffix}`.slice(0, 16)])).rows[0].id;
    const packageId = (await db.query(`insert into public.duty_plan_assignment_packages(plan_id,campus_id,day_order,duty_location_id,teacher_source_id,teacher_name_snapshot,coverage_mode,assignment_kind)
      values($1,$2,3,$3,'duty','Nöbetçi Öğretmen','SHORT_BREAKS','generated') returning id`, [dutyPlanId, campusId, locationId])).rows[0].id;
    const blockId = (await db.query("select id,name from public.duty_blocks order by block_order limit 1")).rows[0];
    await db.query(`insert into public.duty_plan_assignments(plan_id,campus_id,day_order,duty_location_id,duty_block_id,teacher_source_id,teacher_name_snapshot,duty_location_name_snapshot,duty_block_name_snapshot,assignment_kind,package_id)
      values($1,$2,3,$3,$4,'duty','Nöbetçi Öğretmen','Alt Bahçe',$5,'generated',$6)`, [dutyPlanId, campusId, locationId, blockId.id, blockId.name, packageId]);
    await db.query("set local session_replication_role=origin");

    // A: yalnız Ortaokul planlandı ve tamamlandı. Lise hiç oturum almadı.
    planA = await createPlan("Ortaokul Denemesi", [
      { scopeCode: "MIDDLE_SCHOOL", examDate: "2026-09-16", periodOrder: 2, schoolClassIds: [middleClassId], requiredCount: 1 },
    ]);
    // B: iki grup da planlandı, yalnız Ortaokul tamamlandı.
    planB = await createPlan("Karma Deneme", [
      { scopeCode: "MIDDLE_SCHOOL", examDate: "2026-09-18", periodOrder: 2, schoolClassIds: [middleClassId], requiredCount: 1 },
      { scopeCode: "HIGH_SCHOOL", examDate: "2026-09-18", periodOrder: 3, schoolClassIds: [highClassId], requiredCount: 1 },
    ]);
    // C: iki grup da planlandı ve tamamlandı; Ortaokul ataması nöbet devri uyarılı.
    planC = await createPlan("Tam Deneme", [
      { scopeCode: "MIDDLE_SCHOOL", examDate: "2026-09-16", periodOrder: 3, schoolClassIds: [middleClassId], requiredCount: 1 },
      { scopeCode: "HIGH_SCHOOL", examDate: "2026-09-16", periodOrder: 3, schoolClassIds: [highClassId], requiredCount: 1 },
    ]);

    // Tek transaction'da now() sabittir; sıralamayı gerçekten sınayabilmek için
    // oluşturulma zamanları tamamlama kilidinden ÖNCE ayrıştırılır.
    await db.query("update public.exam_invigilation_plans set created_at=$2 where id=$1", [planA, "2026-09-10T08:00:00Z"]);
    await db.query("update public.exam_invigilation_plans set created_at=$2 where id=$1", [planB, "2026-09-11T08:00:00Z"]);
    await db.query("update public.exam_invigilation_plans set created_at=$2 where id=$1", [planC, "2026-09-12T08:00:00Z"]);

    const assignA = await rpc("set_exam_invigilation_assignment", [planA, await sessionId(planA, "MIDDLE_SCHOOL", "2026-09-16", 2), 1, "t1", await scopeVersion(planA, "MIDDLE_SCHOOL"), false, null]);
    expect(assignA.status).toBe("ok");
    expect((await rpc("complete_exam_invigilation_scope", [planA, "MIDDLE_SCHOOL", await scopeVersion(planA, "MIDDLE_SCHOOL")])).status).toBe("ok");

    expect((await rpc("set_exam_invigilation_assignment", [planB, await sessionId(planB, "MIDDLE_SCHOOL", "2026-09-18", 2), 1, "t1", await scopeVersion(planB, "MIDDLE_SCHOOL"), false, null])).status).toBe("ok");
    expect((await rpc("set_exam_invigilation_assignment", [planB, await sessionId(planB, "HIGH_SCHOOL", "2026-09-18", 3), 1, "t2", await scopeVersion(planB, "HIGH_SCHOOL"), false, null])).status).toBe("ok");
    expect((await rpc("complete_exam_invigilation_scope", [planB, "MIDDLE_SCHOOL", await scopeVersion(planB, "MIDDLE_SCHOOL")])).status).toBe("ok");

    expect((await rpc("set_exam_invigilation_assignment", [planC, await sessionId(planC, "MIDDLE_SCHOOL", "2026-09-16", 3), 1, "duty", await scopeVersion(planC, "MIDDLE_SCHOOL"), true, "Rehber öğretmen devralacak."])).status).toBe("ok");
    expect((await rpc("set_exam_invigilation_assignment", [planC, await sessionId(planC, "HIGH_SCHOOL", "2026-09-16", 3), 1, "t3", await scopeVersion(planC, "HIGH_SCHOOL"), false, null])).status).toBe("ok");
    expect((await rpc("complete_exam_invigilation_scope", [planC, "MIDDLE_SCHOOL", await scopeVersion(planC, "MIDDLE_SCHOOL")])).status).toBe("ok");
    expect((await rpc("complete_exam_invigilation_scope", [planC, "HIGH_SCHOOL", await scopeVersion(planC, "HIGH_SCHOOL")])).status).toBe("ok");
  });

  afterAll(async () => {
    if (db) {
      await db.query("rollback");
      await db.end();
    }
  });

  it("taslak ve tamamlanmış planları ayrı süzer", async () => {
    const completed = await listPlans({ status: "completed" });
    expect(completed.items.map(item => item.name).sort()).toEqual(["Ortaokul Denemesi", "Tam Deneme"]);
    const drafts = await listPlans({ status: "draft" });
    expect(drafts.items.map(item => item.name)).toEqual(["Karma Deneme"]);
  });

  it("planlanmamış okul grubunu tamamlanma şartına almaz ve durumunu ayrı raporlar", async () => {
    const { items } = await listPlans({ search: "Ortaokul Denemesi" });
    expect(items).toHaveLength(1);
    const record = items[0];
    expect(record.overallStatus).toBe("completed");
    expect(record.scopes.find(scope => scope.scopeCode === "MIDDLE_SCHOOL")).toMatchObject({ status: "completed", planned: true, requiredCount: 1, assignedCount: 1, openCount: 0 });
    expect(record.scopes.find(scope => scope.scopeCode === "HIGH_SCHOOL")).toMatchObject({ status: "not_planned", planned: false, requiredCount: 0, assignedCount: 0 });
    expect(await (await detail(planA)).overallStatus).toBe("completed");
  });

  it("yalnız bir okul grubu tamamlandığında planı taslak sayar", async () => {
    const { items } = await listPlans({ search: "Karma" });
    expect(items[0].overallStatus).toBe("draft");
    expect(items[0].scopes.find(scope => scope.scopeCode === "MIDDLE_SCHOOL")!.status).toBe("completed");
    expect(items[0].scopes.find(scope => scope.scopeCode === "HIGH_SCHOOL")!.status).toBe("draft");
    expect((await detail(planB)).overallStatus).toBe("draft");
  });

  it("planlanan bütün gruplar tamamlandığında planı tamamlandı sayar ve sayıları verir", async () => {
    const { items } = await listPlans({ search: "Tam Deneme" });
    const record = items[0];
    expect(record.overallStatus).toBe("completed");
    expect(record).toMatchObject({ requiredCount: 2, assignedCount: 2, openCount: 0, dutyWarningCount: 1 });
    expect(record.examDates).toEqual(["2026-09-16"]);
    expect(record.weekStartDate).toBe("2026-09-14");
  });

  it("arama, tarih aralığı, okul grubu ve sıralama süzgeçlerini uygular", async () => {
    expect((await listPlans({ search: "deneme" })).items.map(item => item.name).sort()).toEqual(["Karma Deneme", "Ortaokul Denemesi", "Tam Deneme"]);
    expect((await listPlans({ dateFrom: "2026-09-17" })).items.map(item => item.name)).toEqual(["Karma Deneme"]);
    expect((await listPlans({ dateTo: "2026-09-16" })).items.map(item => item.name).sort()).toEqual(["Ortaokul Denemesi", "Tam Deneme"]);
    expect((await listPlans({ scopeCode: "HIGH_SCHOOL" })).items.map(item => item.name).sort()).toEqual(["Karma Deneme", "Tam Deneme"]);
    expect((await listPlans({ scopeCode: "MIDDLE_SCHOOL" })).items).toHaveLength(3);
    const newest = (await listPlans({ sort: "newest" })).items.map(item => item.name);
    const oldest = (await listPlans({ sort: "oldest" })).items.map(item => item.name);
    expect(oldest).toEqual(["Ortaokul Denemesi", "Karma Deneme", "Tam Deneme"]);
    expect(newest).toEqual(["Tam Deneme", "Karma Deneme", "Ortaokul Denemesi"]);
  });

  it("geçersiz süzgeçleri kontrollü validation_error ile reddeder", async () => {
    expect((await listPlans({ status: "archived" })).status).toBe("validation_error");
    expect((await listPlans({ scopeCode: "PRIMARY" })).status).toBe("validation_error");
    expect((await listPlans({ sort: "random" })).status).toBe("validation_error");
    expect((await listPlans({ dateFrom: "2026-09-20", dateTo: "2026-09-14" })).status).toBe("validation_error");
  });

  it("gün sekmeleri için oturumları tarih ve ders saatiyle snapshot alanlarından döndürür", async () => {
    const plan = await detail(planC);
    const scopes = plan.scopes as { scopeCode: string; listStatus: string; sessionCount: number; sessions: { examDate: string; periodOrder: number; periodName: string; startsAt: string; schoolClassName: string }[] }[];
    const middle = scopes.find(scope => scope.scopeCode === "MIDDLE_SCHOOL")!;
    expect(middle.listStatus).toBe("completed");
    expect(middle.sessionCount).toBe(1);
    expect(middle.sessions[0]).toMatchObject({ examDate: "2026-09-16", periodOrder: 3, periodName: "3. Saat", schoolClassName: "8/A" });
  });

  it("nöbet devri uyarısını ve idari düzenleme notunu tamamlanmış planda korur", async () => {
    const plan = await detail(planC);
    const scopes = plan.scopes as { scopeCode: string; sessions: { assignments: { teacherName: string; dutyWarning: { locationName: string }[]; dutyCoverageAcknowledged: boolean; dutyCoverageNote: string }[] }[] }[];
    const assignment = scopes.find(scope => scope.scopeCode === "MIDDLE_SCHOOL")!.sessions[0].assignments[0];
    expect(assignment.teacherName).toBe("Nöbetçi Öğretmen");
    expect(assignment.dutyWarning[0].locationName).toBe("Alt Bahçe");
    expect(assignment.dutyCoverageAcknowledged).toBe(true);
    expect(assignment.dutyCoverageNote).toBe("Rehber öğretmen devralacak.");
  });

  it("tamamlanmış plana doğrudan RPC ve SQL yazmalarını reddeder", async () => {
    const middleSession = await sessionId(planC, "MIDDLE_SCHOOL", "2026-09-16", 3);
    expect((await rpc("set_exam_invigilation_assignment", [planC, middleSession, 1, null, await scopeVersion(planC, "MIDDLE_SCHOOL"), false, null])).status).toBe("scope_completed");
    expect((await rpc("set_exam_invigilation_assignment", [planC, middleSession, 1, "t2", await scopeVersion(planC, "MIDDLE_SCHOOL"), false, null])).status).toBe("scope_completed");
    expect((await rpc("complete_exam_invigilation_scope", [planC, "MIDDLE_SCHOOL", await scopeVersion(planC, "MIDDLE_SCHOOL")])).status).toBe("already_completed");

    await db.query("savepoint direct_write");
    await expect(db.query("delete from public.exam_invigilation_assignments where plan_id=$1", [planC])).rejects.toThrow(/Tamamlanmış gözetmen listesi değiştirilemez/);
    await db.query("rollback to savepoint direct_write");
    await expect(db.query("update public.exam_invigilation_assignments set teacher_name_snapshot='Sahte' where plan_id=$1", [planC])).rejects.toThrow(/Tamamlanmış gözetmen listesi değiştirilemez/);
    await db.query("rollback to savepoint direct_write");
    await expect(db.query("delete from public.exam_invigilation_sessions where plan_id=$1", [planC])).rejects.toThrow(/Tamamlanmış gözetmen listesi değiştirilemez/);
    await db.query("rollback to savepoint direct_write");
    await expect(db.query("update public.exam_invigilation_scopes set status='draft' where plan_id=$1", [planC])).rejects.toThrow(/Tamamlanmış gözetmen listesi değiştirilemez/);
    await db.query("rollback to savepoint direct_write");
    await expect(db.query("update public.exam_invigilation_plans set name='Değiştirilmiş' where id=$1", [planC])).rejects.toThrow(/Tamamlanmış gözetmen planı değiştirilemez/);
    await db.query("rollback to savepoint direct_write");
    await expect(db.query("delete from public.exam_invigilation_plans where id=$1", [planC])).rejects.toThrow(/Tamamlanmış gözetmen planı değiştirilemez/);
    await db.query("rollback to savepoint direct_write");
  });

  it("anon ve authenticated rolleri arşiv fonksiyonlarını çalıştıramaz", async () => {
    const rows = (await db.query(`select p.proname,
        has_function_privilege('anon', p.oid, 'execute') anon_exec,
        has_function_privilege('authenticated', p.oid, 'execute') auth_exec,
        has_function_privilege('service_role', p.oid, 'execute') service_exec,
        p.prosecdef, p.proconfig
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('list_exam_invigilation_plans_v2','get_exam_invigilation_plan','prevent_completed_exam_invigilation_plan_change','delete_exam_invigilation_plan')`)).rows;
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      expect(row.anon_exec, row.proname).toBe(false);
      expect(row.auth_exec, row.proname).toBe(false);
      expect(row.service_exec, row.proname).toBe(true);
      expect(row.prosecdef, row.proname).toBe(false);
      expect(String(row.proconfig), row.proname).toContain("search_path=");
    }
  });

  it("sonraki XML importundan ve isim değişikliklerinden sonra tarihsel adları korur", async () => {
    // Plan B bilinçli olarak yarım bırakılmıştı. Yeni XML kuralı uyarınca önce
    // tamamlanmalı veya silinmelidir; tarihsel snapshot testi için burada silinir.
    expect((await rpc("discard_exam_invigilation_scope",[planB,"HIGH_SCHOOL",await scopeVersion(planB,"HIGH_SCHOOL")])).status).toBe("ok");
    await db.query("update public.teachers set name='SONRADAN DEĞİŞEN ÖĞRETMEN'");
    await db.query("update public.school_classes set name='SONRADAN DEĞİŞEN SINIF'");
    await db.query("update public.lesson_periods set name='SONRADAN DEĞİŞEN SAAT'");
    await db.query(`insert into public.timetable_imports(campus_id,academic_year_id,source_format,source_filename,status,imported_at)
      select campus_id,academic_year_id,'asc','new-archive.xml','imported',now()+interval '1 hour'
      from public.exam_invigilation_plans where id=$1`, [planC]);

    const plan = await detail(planC);
    const scopes = plan.scopes as { scopeCode: string; sessions: { periodName: string; schoolClassName: string; assignments: { teacherName: string }[] }[] }[];
    const session = scopes.find(scope => scope.scopeCode === "MIDDLE_SCHOOL")!.sessions[0];
    expect(session.schoolClassName).toBe("8/A");
    expect(session.periodName).toBe("3. Saat");
    expect(session.assignments[0].teacherName).toBe("Nöbetçi Öğretmen");
    expect(plan.isStale).toBe(true);

    const { items } = await listPlans({ status: "stale" });
    expect(items.map(item => item.name).sort()).toEqual(["Karma Deneme", "Ortaokul Denemesi", "Tam Deneme"]);
    expect(items.every(item => item.isStale)).toBe(true);
    // Kaynak değişse bile tamamlanmış planlar listede kalmaya devam eder.
    expect((await listPlans({ status: "completed" })).items).toHaveLength(3);
  });

  it("yetkili RPC tamamlanmış planı bağımlı oturum ve atamalarıyla siler", async () => {
    const deleted=await rpc("delete_exam_invigilation_plan",[planC]);
    expect(deleted).toMatchObject({status:"ok",deleted:1});
    expect((await detail(planC)).found).toBe(false);
    expect(Number((await db.query("select count(*) from public.exam_invigilation_sessions where plan_id=$1",[planC])).rows[0].count)).toBe(0);
    expect(Number((await db.query("select count(*) from public.exam_invigilation_assignments where plan_id=$1",[planC])).rows[0].count)).toBe(0);
    expect((await listPlans()).items.map(item=>item.id)).not.toContain(planC);
  });
});
