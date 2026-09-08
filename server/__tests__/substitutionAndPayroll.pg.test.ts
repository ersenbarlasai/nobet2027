import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { toRpcPayload } from "../services/toRpcPayload";
import type { ImportRequest } from "../validation/importPayload";

const DB_URL = process.env.DUTY_PLAN_PG_TEST_DB_URL;

describe.skipIf(!DB_URL)("ders yerine görevlendirme ve puantaj — gerçek PostgreSQL", () => {
  const campusName = `Sub Test ${Math.random().toString(36).slice(2, 9)}`;
  const yearName = "2026-2027";
  let db: Client;
  let cardByKey: Record<string, string>;
  let listId: string;
  let absenceId: string;

  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const keys = Object.keys(args);
    const result = await db.query(
      `select public.${name}(${keys.map((key, index) => `${key} := $${index + 1}`).join(",")}) result`,
      keys.map((key) => typeof args[key] === "object" && args[key] !== null ? JSON.stringify(args[key]) : args[key]),
    );
    return result.rows[0].result as T;
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    const request: ImportRequest = {
      sourceFormat: "asc-timetables", sourceFilename: "substitution.xml", sourceEncoding: "utf-8",
      sourceSha256: Math.random().toString(16).slice(2).padEnd(64, "a").slice(0, 64), sourceCardCount: 3, normalizedAssignmentCount: 3,
      teachers: [
        { sourceId: "T-ABSENT", name: "Ayşe Yok", branch: "Matematik" },
        { sourceId: "T-ALLDAY", name: "Bora Tüm Gün", branch: "Türkçe" },
        { sourceId: "T-FREE", name: "Cem Uygun", branch: "Matematik" },
        { sourceId: "T-SECOND", name: "Deniz Yok", branch: "Fen" },
      ],
      classes: [
        { sourceId: "C7", name: "7/A", grade: "7", classTeacherSourceId: null },
        { sourceId: "C8", name: "8/A", grade: "8", classTeacherSourceId: null },
      ],
      days: [{ sourceId: "D1", name: "Pazartesi", order: 1 }],
      periods: [
        { sourceId: "P1", name: "1. Saat", order: 1, startsAt: "08:30", endsAt: "09:10" },
        { sourceId: "P2", name: "2. Saat", order: 2, startsAt: "09:20", endsAt: "10:00" },
        { sourceId: "P3", name: "3. Saat", order: 3, startsAt: "10:10", endsAt: "10:50" },
      ],
      subjects: [
        { sourceId: "S-MAT", name: "Matematik", shortName: "MAT" },
        { sourceId: "S-TR", name: "Türkçe", shortName: "TR" },
        { sourceId: "S-FEN", name: "Fen", shortName: "FEN" },
      ],
      lessons: [
        { sourceId: "L1", subjectSourceId: "S-MAT", sourceGroupIds: [] },
        { sourceId: "L2", subjectSourceId: "S-TR", sourceGroupIds: [] },
        { sourceId: "L3", subjectSourceId: "S-FEN", sourceGroupIds: [] },
      ],
      lessonTeachers: [
        { lessonSourceId: "L1", teacherSourceId: "T-ABSENT", sourceOrder: 1 },
        { lessonSourceId: "L2", teacherSourceId: "T-ALLDAY", sourceOrder: 1 },
        { lessonSourceId: "L3", teacherSourceId: "T-SECOND", sourceOrder: 1 },
      ],
      lessonClasses: [
        { lessonSourceId: "L1", classSourceId: "C7", sourceOrder: 1 },
        { lessonSourceId: "L2", classSourceId: "C7", sourceOrder: 1 },
        { lessonSourceId: "L3", classSourceId: "C8", sourceOrder: 1 },
      ],
      cards: [
        { sourceIndex: 1, sourceCardKey: "card-1", lessonSourceId: "L1", daySourceId: "D1", periodSourceId: "P1", classroomSourceIds: [] },
        { sourceIndex: 2, sourceCardKey: "card-2", lessonSourceId: "L2", daySourceId: "D1", periodSourceId: "P2", classroomSourceIds: [] },
        { sourceIndex: 3, sourceCardKey: "card-3", lessonSourceId: "L3", daySourceId: "D1", periodSourceId: "P3", classroomSourceIds: [] },
      ],
      assignments: [
        { sourceCardKey: "card-1", lessonSourceId: "L1", teacherSourceId: "T-ABSENT", classSourceId: "C7", daySourceId: "D1", periodSourceId: "P1", subjectSourceId: "S-MAT", classroom: null, mappingStatus: "exact" },
        { sourceCardKey: "card-2", lessonSourceId: "L2", teacherSourceId: "T-ALLDAY", classSourceId: "C7", daySourceId: "D1", periodSourceId: "P2", subjectSourceId: "S-TR", classroom: null, mappingStatus: "exact" },
        { sourceCardKey: "card-3", lessonSourceId: "L3", teacherSourceId: "T-SECOND", classSourceId: "C8", daySourceId: "D1", periodSourceId: "P3", subjectSourceId: "S-FEN", classroom: null, mappingStatus: "exact" },
      ],
      validationIssues: [],
    };
    const payload = toRpcPayload(request, campusName, yearName);
    await rpc("import_timetable_snapshot", { p_payload: payload });
    const cards = await db.query("select c.source_card_key,c.id from public.timetable_cards c join public.timetable_imports i on i.id=c.timetable_import_id join public.campuses x on x.id=i.campus_id where x.name=$1", [campusName]);
    cardByKey = Object.fromEntries(cards.rows.map((row) => [row.source_card_key, row.id]));
  });

  afterAll(async () => { await db.end(); });

  it("tam gün yokluk öğretmeni diğer ders saatinde de aday havuzundan çıkarır", async () => {
    await rpc("create_teacher_absence", { p_campus_name: campusName, p_academic_year_name: yearName, p_teacher_source_id: "T-ALLDAY", p_date_from: "2026-09-07", p_date_to: "2026-09-07", p_reason_code: "leave", p_note: null, p_lesson_keys: [{ assignmentDate: "2026-09-07", timetableCardId: cardByKey["card-2"] }], p_absence_scope: "all_day" });
    const created = await rpc<{ status: string; absenceId: string }>("create_teacher_absence", { p_campus_name: campusName, p_academic_year_name: yearName, p_teacher_source_id: "T-ABSENT", p_date_from: "2026-09-07", p_date_to: "2026-09-07", p_reason_code: "medical_report", p_note: null, p_lesson_keys: [{ assignmentDate: "2026-09-07", timetableCardId: cardByKey["card-1"] }], p_absence_scope: "selected_lessons" });
    expect(created.status).toBe("ok"); absenceId = created.absenceId;
    const row = await db.query("select id,day_list_id from public.substitution_tasks where absence_id=$1", [absenceId]);
    listId = row.rows[0].day_list_id;
    const candidates = await rpc<{ items: Array<{ teacherSourceId: string; branchSupportsSubject: boolean }> }>("get_substitution_task_candidates", { p_task_id: row.rows[0].id, p_campus_name: campusName, p_academic_year_name: yearName });
    expect(candidates.items.some((item) => item.teacherSourceId === "T-ALLDAY")).toBe(false);
    expect(candidates.items.find((item) => item.teacherSourceId === "T-FREE")?.branchSupportsSubject).toBe(true);
  });

  it("tamamlanmış güncel listeye yeni yokluk eklenince liste taslağa döner", async () => {
    let list = await rpc<{ version: number }>("get_substitution_day_list", { p_list_id: listId, p_campus_name: campusName, p_academic_year_name: yearName });
    const openTasks = await db.query("select id from public.substitution_tasks where day_list_id=$1 and resolution_status='open'", [listId]);
    for (const row of openTasks.rows) {
      const result = await rpc<{ version: number }>("set_substitution_task_resolution", { p_task_id: row.id, p_teacher_source_id: null, p_unfilled_note: "Uygun öğretmen bulunamadı", p_expected_version: list.version, p_override_ack: false, p_override_note: null });
      list.version = result.version;
    }
    await rpc("complete_substitution_day_list", { p_list_id: listId, p_expected_version: list.version });
    const created = await rpc<{ status: string }>("create_teacher_absence", { p_campus_name: campusName, p_academic_year_name: yearName, p_teacher_source_id: "T-SECOND", p_date_from: "2026-09-07", p_date_to: "2026-09-07", p_reason_code: "official_duty", p_note: null, p_lesson_keys: [{ assignmentDate: "2026-09-07", timetableCardId: cardByKey["card-3"] }], p_absence_scope: "selected_lessons" });
    expect(created.status).toBe("ok");
    const state = await db.query("select status,completed_at from public.substitution_day_lists where id=$1", [listId]);
    expect(state.rows[0]).toMatchObject({ status: "draft", completed_at: null });
  });

  it("silme önizlemesindeki etki kümesi değişirse atomik olarak reddeder", async () => {
    const preview = await rpc<{ affectedTasks: Array<{ id: string }> }>("preview_delete_teacher_absence", { p_absence_id: absenceId, p_campus_name: campusName, p_academic_year_name: yearName });
    const stale = await rpc<{ status: string }>("delete_teacher_absence", { p_absence_id: absenceId, p_expected_task_ids: [] });
    expect(stale.status).toBe("stale_affected_set");
    expect((await db.query("select count(*)::int count from public.teacher_absences where id=$1", [absenceId])).rows[0].count).toBe(1);
    expect(preview.affectedTasks).toHaveLength(1);
  });

  it("tamamlanan ders yerine görevlendirmeyi otomatik ekler; manuel kayıt ve kapanış fiyatını dondurur", async () => {
    const list = await rpc<{ version: number; tasks: Array<{ id: string; absentTeacherSourceId: string }> }>("get_substitution_day_list", { p_list_id: listId, p_campus_name: campusName, p_academic_year_name: yearName });
    const task = list.tasks.find((item) => item.absentTeacherSourceId === "T-SECOND")!;
    const assignment=await rpc<{version:number}>("set_substitution_task_resolution", { p_task_id: task.id, p_teacher_source_id: "T-FREE", p_unfilled_note: null, p_expected_version: list.version, p_override_ack: false, p_override_note: null });
    await rpc("complete_substitution_day_list",{p_list_id:listId,p_expected_version:assignment.version});
    const type = await db.query("select t.id,t.entry_mode from public.compensation_types t join public.campuses c on c.id=t.campus_id where c.name=$1 and t.system_code='SUBSTITUTION'", [campusName]);
    expect(type.rows[0].entry_mode).toBe("manual");
    const rate = await rpc<{ id: string }>("add_compensation_rate", { p_campus_name: campusName, p_type_id: type.rows[0].id, p_effective_from: "2026-09-01", p_unit_rate: 125.5 });
    const beforeManual = await rpc<{ lines: Array<{ source_kind: string }> }>("get_payroll_overview", { p_campus_name: campusName, p_academic_year_name: yearName, p_anchor_date: "2026-09-07" });
    expect(beforeManual.lines).toHaveLength(1);
    expect(beforeManual.lines[0].source_kind).toBe("substitution");
    expect((await rpc<{ status: string }>("add_manual_payroll_entry", {
      p_campus_name: campusName,
      p_academic_year_name: yearName,
      p_teacher_source_id: "T-FREE",
      p_duty_date: "2026-09-07",
      p_type_id: type.rows[0].id,
      p_quantity: 1,
      p_note: "Deniz Yok yerine 3. saat",
      p_replaced_teacher_source_id: "T-SECOND",
    })).status).toBe("ok");
    const open = await rpc<{ status: string; totals: Array<{ teacher_source_id: string; total_quantity: number }>; lines: Array<{ source_kind: string; rate_missing: boolean }> }>("get_payroll_overview", { p_campus_name: campusName, p_academic_year_name: yearName, p_anchor_date: "2026-09-07" });
    expect(open.status).toBe("open");
    expect(open.totals.find((item) => item.teacher_source_id === "T-FREE")?.total_quantity).toBe(2);
    expect(open.lines).toHaveLength(2);
    expect(open.lines.map((item)=>item.source_kind).sort()).toEqual(["manual","substitution"]);
    expect(open.lines.some((item) => item.rate_missing)).toBe(false);
    expect((await rpc<{ status: string }>("close_payroll_period", { p_campus_name: campusName, p_academic_year_name: yearName, p_anchor_date: "2026-09-07", p_force: true })).status).toBe("ok");
    await expect(db.query("update public.compensation_rate_versions set unit_rate=999 where id=$1", [rate.id])).rejects.toThrow(/değiştirilemez/);
  });

  it("özel ücret türünü yeniden adlandırır; kullanım durumuna göre siler veya pasifleştirir", async () => {
    const unused = await rpc<{ status: string; id: string }>("save_compensation_type", {
      p_campus_name: campusName,
      p_type_id: null,
      p_name: "Geçici Görev",
      p_is_active: true,
    });
    expect(unused.status).toBe("ok");

    const renamed = await rpc<{ status: string }>("save_compensation_type", {
      p_campus_name: campusName,
      p_type_id: unused.id,
      p_name: "Geçici Görev Güncel",
      p_is_active: true,
    });
    expect(renamed.status).toBe("ok");
    expect((await db.query("select name from public.compensation_types where id=$1", [unused.id])).rows[0].name).toBe("Geçici Görev Güncel");

    expect(await rpc("delete_compensation_type", { p_campus_name: campusName, p_type_id: unused.id })).toMatchObject({ status: "ok", action: "deleted" });
    expect((await db.query("select count(*)::int count from public.compensation_types where id=$1", [unused.id])).rows[0].count).toBe(0);

    const used = await rpc<{ status: string; id: string }>("save_compensation_type", {
      p_campus_name: campusName,
      p_type_id: null,
      p_name: "Kullanılmış Ek Görev",
      p_is_active: true,
    });
    expect((await rpc<{ status: string }>("add_manual_payroll_entry", {
      p_campus_name: campusName,
      p_academic_year_name: yearName,
      p_teacher_source_id: "T-FREE",
      p_duty_date: "2026-10-05",
      p_type_id: used.id,
      p_quantity: 1,
      p_note: "Geçmiş kayıt korunmalı",
      p_replaced_teacher_source_id: null,
    })).status).toBe("ok");

    expect(await rpc("delete_compensation_type", { p_campus_name: campusName, p_type_id: used.id })).toMatchObject({ status: "ok", action: "deactivated" });
    expect((await db.query("select is_active from public.compensation_types where id=$1", [used.id])).rows[0].is_active).toBe(false);
    expect((await db.query("select count(*)::int count from public.manual_payroll_entries where compensation_type_id=$1", [used.id])).rows[0].count).toBe(1);

    const reactivated = await rpc<{ status: string; id: string; action: string }>("save_compensation_type", {
      p_campus_name: campusName,
      p_type_id: null,
      p_name: "Kullanılmış Ek Görev",
      p_is_active: true,
    });
    expect(reactivated).toMatchObject({ status: "ok", id: used.id, action: "reactivated" });

    const systemType = await db.query("select t.id from public.compensation_types t join public.campuses c on c.id=t.campus_id where c.name=$1 and t.system_code='SUBSTITUTION'", [campusName]);
    expect(await rpc("delete_compensation_type", { p_campus_name: campusName, p_type_id: systemType.rows[0].id })).toMatchObject({ status: "system_type_locked" });
  });

  it("ders-yerine görevini gözetmen adayından çıkarır ve çok-tarihli aralık filtresini doğru uygular", async () => {
    const context=await db.query("select c.id campus_id,y.id year_id,i.id import_id from public.campuses c join public.academic_years y on y.campus_id=c.id join public.timetable_imports i on i.academic_year_id=y.id where c.name=$1 and y.name=$2 order by i.created_at desc limit 1",[campusName,yearName]);
    const {campus_id:campusId,year_id:yearId,import_id:importId}=context.rows[0];
    const duty=(await db.query("insert into public.duty_plans(campus_id,academic_year_id,timetable_import_id,status,source_fingerprint,algorithm_version,week_start_date) values($1,$2,$3,'draft',$4,'test-v1','2026-09-07') returning id",[campusId,yearId,importId,"f".repeat(64)])).rows[0].id;
    const plan=(await db.query("insert into public.exam_invigilation_plans(campus_id,academic_year_id,timetable_import_id,duty_plan_id,name,week_start_date,exam_date,source_fingerprint) values($1,$2,$3,$4,'Aralık Testi','2026-09-07','2026-09-07',$5) returning id",[campusId,yearId,importId,duty,"e".repeat(64)])).rows[0].id;
    const scope=(await db.query("insert into public.exam_invigilation_scopes(plan_id,scope_code) values($1,'MIDDLE_SCHOOL') returning id,version",[plan])).rows[0];
    const period=await db.query("select id,period_order,name,starts_at,ends_at from public.lesson_periods where timetable_import_id=$1 and period_order=3",[importId]);
    const klass=await db.query("select id,source_id,name from public.school_classes where timetable_import_id=$1 and source_id='C8'",[importId]);
    const session=(await db.query("insert into public.exam_invigilation_sessions(plan_id,scope_id,timetable_import_id,exam_date,school_class_id,school_class_source_id_snapshot,school_class_name_snapshot,lesson_period_id,period_order,period_name_snapshot,starts_at_snapshot,ends_at_snapshot,required_invigilator_count) values($1,$2,$3,'2026-09-07',$4,$5,$6,$7,3,$8,$9,$10,1) returning id",[plan,scope.id,importId,klass.rows[0].id,klass.rows[0].source_id,klass.rows[0].name,period.rows[0].id,period.rows[0].name,period.rows[0].starts_at,period.rows[0].ends_at])).rows[0].id;
    await db.query("insert into public.exam_invigilation_sessions(plan_id,scope_id,timetable_import_id,exam_date,school_class_id,school_class_source_id_snapshot,school_class_name_snapshot,lesson_period_id,period_order,period_name_snapshot,starts_at_snapshot,ends_at_snapshot,required_invigilator_count) values($1,$2,$3,'2026-09-11',$4,$5,$6,$7,3,$8,$9,$10,1)",[plan,scope.id,importId,klass.rows[0].id,klass.rows[0].source_id,klass.rows[0].name,period.rows[0].id,period.rows[0].name,period.rows[0].starts_at,period.rows[0].ends_at]);
    const candidates=await rpc<{candidates:Array<{teacherSourceId:string}>}>("get_exam_invigilation_candidates",{p_plan_id:plan,p_session_id:session,p_campus_name:campusName,p_academic_year_name:yearName});
    expect(candidates.candidates.some((item)=>item.teacherSourceId==="T-FREE")).toBe(false);
    const setResult=await rpc<{status:string}>("set_exam_invigilation_assignment",{p_plan_id:plan,p_session_id:session,p_slot_number:1,p_teacher_source_id:"T-FREE",p_expected_scope_version:scope.version,p_duty_coverage_acknowledged:false,p_duty_coverage_note:null});
    expect(setResult.status).toBe("substitution_conflict");
    const filtered=await rpc<{items:Array<{id:string}>}>("list_exam_invigilation_plans_v2",{p_campus_name:campusName,p_academic_year_name:yearName,p_status:"all",p_scope_code:null,p_search:null,p_date_from:"2026-09-08",p_date_to:"2026-09-10",p_sort:"newest"});
    expect(filtered.items.some((item)=>item.id===plan)).toBe(false);
  });
});
