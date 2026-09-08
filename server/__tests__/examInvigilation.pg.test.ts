import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * Gerçek PostgreSQL kabul testi. Yalnız DUTY_PLAN_PG_TEST_DB_URL verilirse
 * çalışır; tüm fixture tek transaction içinde tutulur ve sonunda geri alınır.
 */
const DB_URL = process.env.DUTY_PLAN_PG_TEST_DB_URL;

describe.skipIf(!DB_URL)("deneme sınavı gözetmen planlama — gerçek PostgreSQL", () => {
  let db: Client;
  let campusName: string;
  let yearName: string;
  let planId: string;
  let middleSessionId: string;
  let highSessionId: string;
  let schoolClassId: string;
  let middleVersion = 1;
  let highVersion = 1;

  async function rpc(functionName: string, args: unknown[]) {
    const placeholders = args.map((_, index) => `$${index + 1}`).join(",");
    return (await db.query(`select public.${functionName}(${placeholders}) as result`, args)).rows[0].result as Record<string, unknown>;
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    await db.query("begin");
    const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
    campusName = `Exam Campus ${suffix}`;
    yearName = `2026-2027 EXAM ${suffix}`;

    const campusId = (await db.query("insert into public.campuses(name,code) values($1,$2) returning id", [campusName, `E${suffix}`])).rows[0].id;
    const yearId = (await db.query("insert into public.academic_years(campus_id,name) values($1,$2) returning id", [campusId, yearName])).rows[0].id;
    const importId = (await db.query(`insert into public.timetable_imports(campus_id,academic_year_id,source_format,source_filename,status,imported_at)
      values($1,$2,'asc','exam.xml','imported',now()) returning id`, [campusId, yearId])).rows[0].id;
    const periodId = (await db.query("insert into public.lesson_periods(timetable_import_id,source_id,name,period_order,starts_at,ends_at) values($1,'p2','2. Saat',2,'09:20','10:00') returning id", [importId])).rows[0].id;
    const dayId = (await db.query("insert into public.timetable_days(timetable_import_id,source_id,name,day_order) values($1,'d5','Cuma',5) returning id", [importId])).rows[0].id;
    const teacherIds: Record<string, string> = {};
    for (const [sourceId, name] of [["busy", "Dersi Olan"], ["duty", "Nöbetçi Öğretmen"], ["free", "Uygun Öğretmen"]]) {
      teacherIds[sourceId] = (await db.query("insert into public.teachers(timetable_import_id,source_id,name,branch) values($1,$2,$3,'Test') returning id", [importId, sourceId, name])).rows[0].id;
    }
    const subjectId = (await db.query("insert into public.subjects(timetable_import_id,source_id,name) values($1,'sub','Ders') returning id", [importId])).rows[0].id;
    const classId = (await db.query("insert into public.school_classes(timetable_import_id,source_id,name,grade) values($1,'class','8A','8') returning id", [importId])).rows[0].id;
    schoolClassId = classId;
    const lessonId = (await db.query("insert into public.lessons(timetable_import_id,source_id,subject_id) values($1,'lesson',$2) returning id", [importId, subjectId])).rows[0].id;
    const cardId = (await db.query(`insert into public.timetable_cards(timetable_import_id,lesson_id,source_index,source_card_key,timetable_day_id,lesson_period_id)
      values($1,$2,1,'exam-card',$3,$4) returning id`, [importId, lessonId, dayId, periodId])).rows[0].id;
    await db.query(`insert into public.timetable_assignments(timetable_import_id,timetable_card_id,lesson_id,teacher_id,school_class_id,timetable_day_id,lesson_period_id,subject_id,mapping_status)
      values($1,$2,$3,$4,$5,$6,$7,$8,'exact')`, [importId, cardId, lessonId, teacherIds.busy, classId, dayId, periodId, subjectId]);

    // Fixture için yayımlanmış nöbet planı ve paketini doğrudan kur. Üretim
    // lifecycle tetikleyicilerini test etmiyoruz; gözetmen RPC'leri bundan sonra
    // normal origin modunda çalışır.
    await db.query("set local session_replication_role=replica");
    const dutyPlanId = (await db.query(`insert into public.duty_plans(campus_id,academic_year_id,timetable_import_id,status,source_fingerprint,algorithm_version,week_start_date)
      values($1,$2,$3,'published',$4,'test-v4','2026-09-14') returning id`, [campusId, yearId, importId, "a".repeat(64)])).rows[0].id;
    const locationId = (await db.query("insert into public.duty_locations(campus_id,name,short_code,category,sort_order) values($1,'Alt Bahçe',$2,'garden',1) returning id", [campusId, `EX${suffix}`.slice(0, 16)])).rows[0].id;
    await db.query(`insert into public.duty_plan_assignment_packages(plan_id,campus_id,day_order,duty_location_id,teacher_source_id,teacher_name_snapshot,coverage_mode,assignment_kind)
      values($1,$2,5,$3,'duty','Nöbetçi Öğretmen','SHORT_BREAKS','generated')`, [dutyPlanId, campusId, locationId]);
    await db.query("set local session_replication_role=origin");

    const created = await rpc("create_exam_invigilation_plan", [campusName, yearName, "Cuma Deneme Sınavı", "2026-09-14", "2026-09-18", [2], 1, 1]);
    expect(created.status).toBe("ok");
    planId = String(created.planId);
    const detail = await rpc("get_exam_invigilation_plan", [planId, campusName, yearName]);
    const scopes = detail.scopes as { scopeCode: string; version: number; sessions: { id: string }[] }[];
    const middle = scopes.find(scope => scope.scopeCode === "MIDDLE_SCHOOL")!;
    const high = scopes.find(scope => scope.scopeCode === "HIGH_SCHOOL")!;
    middleSessionId = middle.sessions[0].id;
    highSessionId = high.sessions[0].id;
    middleVersion = middle.version;
    highVersion = high.version;
  });

  it("aynı haftada farklı gün ve sınıf oturumlarını ayrı tarihsel görevler olarak oluşturur", async () => {
    const specs = [
      { scopeCode: "MIDDLE_SCHOOL", examDate: "2026-09-16", periodOrder: 2, schoolClassIds: [schoolClassId], requiredCount: 1 },
      { scopeCode: "HIGH_SCHOOL", examDate: "2026-09-18", periodOrder: 2, schoolClassIds: [schoolClassId], requiredCount: 1 },
    ];
    const created=await rpc("create_exam_invigilation_plan_v2",[campusName,yearName,"Çok Günlü Deneme","2026-09-14",JSON.stringify(specs)]);
    expect(created.status).toBe("ok");
    const detail=await rpc("get_exam_invigilation_plan",[created.planId,campusName,yearName]);
    const scopes=detail.scopes as {scopeCode:string;version:number;sessions:{id:string;examDate:string;schoolClassName:string;schoolClassSourceId:string;requiredCount:number}[]}[];
    const sessions=scopes.flatMap(s=>s.sessions);
    expect(sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({examDate:"2026-09-16",schoolClassName:"8A",schoolClassSourceId:"class",requiredCount:1}),
      expect.objectContaining({examDate:"2026-09-18",schoolClassName:"8A",schoolClassSourceId:"class",requiredCount:1}),
    ]));
    const wednesday=scopes.find(s=>s.scopeCode==="MIDDLE_SCHOOL")!.sessions[0];
    const friday=scopes.find(s=>s.scopeCode==="HIGH_SCHOOL")!.sessions[0];
    const wednesdayCandidates=await rpc("get_exam_invigilation_candidates",[created.planId,wednesday.id,campusName,yearName]);
    const fridayCandidates=await rpc("get_exam_invigilation_candidates",[created.planId,friday.id,campusName,yearName]);
    expect((wednesdayCandidates.candidates as {teacherSourceId:string;suitability:string}[])).toEqual(expect.arrayContaining([
      expect.objectContaining({teacherSourceId:"busy",suitability:"direct"}),
      expect.objectContaining({teacherSourceId:"duty",suitability:"direct"}),
    ]));
    expect((fridayCandidates.candidates as {teacherSourceId:string;suitability:string}[]).some(c=>c.teacherSourceId==="busy")).toBe(false);
    expect(fridayCandidates.candidates).toEqual(expect.arrayContaining([expect.objectContaining({teacherSourceId:"duty",suitability:"duty_coverage_required"})]));
    // Yeni XML, oturumlu açık gözetmen taslakları varken bilinçli olarak
    // engellenir. Bu yardımcı taslak sonraki stale-kaynak senaryosundan önce silinir.
    await db.query("delete from public.exam_invigilation_plans where id=$1",[created.planId]);
  });

  it("sınıf bazlı oturumlarda tek gözetmen görevini doğrulanmış DB kısıtıyla zorunlu tutar", async () => {
    const constraint=await db.query("select convalidated,pg_get_constraintdef(oid) definition from pg_constraint where conname='exam_invigilation_class_single_invigilator_ck'");
    expect(constraint.rows[0]).toMatchObject({convalidated:true});
    expect(constraint.rows[0].definition).toContain("required_invigilator_count = 1");
  });

  afterAll(async () => {
    if (db) {
      await db.query("rollback");
      await db.end();
    }
  });

  it("dersi olanı eler, nöbetliyi uyarılı ve boş öğretmeni doğrudan uygun döndürür", async () => {
    const result = await rpc("get_exam_invigilation_candidates", [planId, middleSessionId, campusName, yearName]);
    const candidates = result.candidates as { teacherSourceId: string; suitability: string }[];
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ teacherSourceId: "free", suitability: "direct" }),
      expect.objectContaining({ teacherSourceId: "duty", suitability: "duty_coverage_required" }),
    ]));
    expect(candidates.some(candidate => candidate.teacherSourceId === "busy")).toBe(false);
    expect(result.excludedCounts).toMatchObject({ lessonConflict: 1 });
  });

  it("nöbet uyarısını açık onay olmadan kaydetmez", async () => {
    const rejected = await rpc("set_exam_invigilation_assignment", [planId, middleSessionId, 1, "duty", middleVersion, false, null]);
    expect(rejected.status).toBe("duty_coverage_acknowledgement_required");
    const accepted = await rpc("set_exam_invigilation_assignment", [planId, middleSessionId, 1, "duty", middleVersion, true, "Rehber öğretmen devralacak."]);
    expect(accepted.status).toBe("ok");
    middleVersion = Number(accepted.scopeVersion);
  });

  it("Ortaokula atanan öğretmeni Lise aday havuzundan tamamen çıkarır", async () => {
    const result = await rpc("get_exam_invigilation_candidates", [planId, highSessionId, campusName, yearName]);
    const candidates = result.candidates as { teacherSourceId: string }[];
    expect(candidates.some(candidate => candidate.teacherSourceId === "duty")).toBe(false);
    expect(result.excludedCounts).toMatchObject({ otherScope: 1 });
  });

  it("iki okul grubunu birbirinden bağımsız tamamlar ve tamamlanan grubu kilitler", async () => {
    const highAssignment = await rpc("set_exam_invigilation_assignment", [planId, highSessionId, 1, "free", highVersion, false, null]);
    expect(highAssignment.status).toBe("ok");
    highVersion = Number(highAssignment.scopeVersion);
    const middleCompleted = await rpc("complete_exam_invigilation_scope", [planId, "MIDDLE_SCHOOL", middleVersion]);
    expect(middleCompleted.status).toBe("ok");
    const middleChange = await rpc("set_exam_invigilation_assignment", [planId, middleSessionId, 1, null, Number(middleCompleted.version), false, null]);
    expect(middleChange.status).toBe("scope_completed");
    const highCompleted = await rpc("complete_exam_invigilation_scope", [planId, "HIGH_SCHOOL", highVersion]);
    expect(highCompleted.status).toBe("ok");
    await db.query("savepoint completed_scope_write");
    await expect(db.query("delete from public.exam_invigilation_assignments where plan_id=$1", [planId])).rejects.toThrow(/Tamamlanmış gözetmen listesi değiştirilemez/);
    await db.query("rollback to savepoint completed_scope_write");
  });

  it("sonradan gelen yeni ders programı importunu stale kaynak olarak algılar", async () => {
    await db.query(`insert into public.timetable_imports(campus_id,academic_year_id,source_format,source_filename,status,imported_at)
      select campus_id,academic_year_id,'asc','new-exam.xml','imported',now()+interval '1 hour'
      from public.exam_invigilation_plans where id=$1`, [planId]);
    const result = await rpc("get_exam_invigilation_plan", [planId, campusName, yearName]);
    expect(result.isStale).toBe(true);
  });
});
