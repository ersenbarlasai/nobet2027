import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * GERÇEK PostgreSQL testleri — 20260920090000 ile yeniden yazılan
 * get_duty_plan_task_candidates, solver-v3 tek-blok savunması ve yeni
 * fonksiyon yetkileri. Uzak projeye ASLA dokunulmaz.
 *
 *   DUTY_PLAN_PG_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
 *
 * Diğer pg süitleriyle birlikte `--no-file-parallelism` ile SERİ çalışmalıdır.
 */
const DB_URL = process.env.DUTY_PLAN_PG_TEST_DB_URL;
const enabled = Boolean(DB_URL);

interface Candidate {
  teacherSourceId: string;
  eligible: boolean;
  reasons: string[];
}
interface CandidatesResult {
  found: boolean;
  taskFound: boolean;
  isFixed: boolean;
  candidates: Candidate[];
}

describe.skipIf(!enabled)("görev adayları + v3 savunması — gerçek PostgreSQL", () => {
  let client: Client;
  let campusId: string;
  let campusName: string;
  let yearName: string;
  let yearId: string;
  let importId: string;
  let planId: string;
  const loc: Record<string, string> = {};
  const block: Record<string, string> = {};
  const teacher: Record<string, string> = {};
  const task: Record<string, string> = {};

  const sfx = Math.random().toString(36).slice(2, 7).toUpperCase();

  async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const names = Object.keys(args);
    const sql = `select public.${fn}(${names.map((n, i) => `${n} := $${i + 1}`).join(", ")}) as r`;
    const res = await client.query(
      sql,
      names.map((n) => {
        const v = args[n];
        return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
      }),
    );
    return res.rows[0].r as T;
  }

  /** Bir görev hücresi (assignment) yaratır; teacher verilirse SINGLE_BLOCK paketiyle atar. */
  async function cell(args: { day: number; locKey: string; blockCode: string; teacher?: string; kind?: string }): Promise<string> {
    let packageId: string | null = null;
    if (args.teacher) {
      const kind = args.kind ?? "generated";
      // duty_plan_assignment_packages_fixed_mode_ck: fixed ⇔ FIXED_SHORT_BREAKS.
      const coverage = kind === "fixed" ? "FIXED_SHORT_BREAKS" : "SINGLE_BLOCK";
      const existing = await client.query(
        "select id from public.duty_plan_assignment_packages where plan_id=$1 and day_order=$2 and teacher_source_id=$3 and duty_location_id=$4 and coverage_mode=$5",
        [planId, args.day, args.teacher, loc[args.locKey], coverage],
      );
      packageId = existing.rows[0]?.id ?? null;
      if (!packageId) {
        const pkg = await client.query(
          `insert into public.duty_plan_assignment_packages
             (plan_id, campus_id, day_order, duty_location_id, teacher_source_id, teacher_name_snapshot, coverage_mode, assignment_kind)
           values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
          [planId, campusId, args.day, loc[args.locKey], args.teacher, `Ogretmen ${args.teacher}`, coverage, kind],
        );
        packageId = pkg.rows[0].id;
      }
    }
    const res = await client.query(
      `insert into public.duty_plan_assignments
         (plan_id, campus_id, day_order, duty_location_id, duty_block_id, teacher_source_id, teacher_name_snapshot,
          duty_location_name_snapshot, duty_block_name_snapshot, assignment_kind, package_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
      [
        planId,
        campusId,
        args.day,
        loc[args.locKey],
        block[args.blockCode],
        args.teacher ?? null,
        args.teacher ? `Ogretmen ${args.teacher}` : null,
        args.locKey,
        args.blockCode,
        args.teacher ? (args.kind ?? "generated") : "unassigned",
        packageId,
      ],
    );
    return res.rows[0].id as string;
  }

  const candidatesFor = (taskId: string) =>
    rpc<CandidatesResult>("get_duty_plan_task_candidates", {
      p_plan_id: planId,
      p_task_id: taskId,
      p_campus_name: campusName,
      p_academic_year_name: yearName,
    });

  const reasonsOf = (r: CandidatesResult, src: string) => r.candidates.find((c) => c.teacherSourceId === src)?.reasons ?? [];
  const eligibleOf = (r: CandidatesResult, src: string) => r.candidates.find((c) => c.teacherSourceId === src)?.eligible;

  beforeAll(async () => {
    client = new Client({ connectionString: DB_URL });
    await client.connect();
    await client.query("begin");

    campusName = `Aday Kampus ${sfx}`;
    yearName = `2026-2027 ${sfx}`;
    campusId = (await client.query("insert into public.campuses (name, code) values ($1,$2) returning id", [campusName, `A${sfx}`])).rows[0].id;
    yearId = (await client.query("insert into public.academic_years (campus_id, name) values ($1,$2) returning id", [campusId, yearName])).rows[0].id;
    importId = (
      await client.query(
        "insert into public.timetable_imports (campus_id, academic_year_id, source_format, source_filename, status, imported_at) values ($1,$2,'asc','f.xml','imported', now()) returning id",
        [campusId, yearId],
      )
    ).rows[0].id;

    // Zaman kuralı geçsin diye periyotlar; öğretmenlere ders YAZILMAZ.
    for (const [name, order] of [
      ["4-OO", 4],
      ["5-OO", 5],
      ["5-IO", 6],
      ["6-IO", 7],
    ] as const) {
      await client.query("insert into public.lesson_periods (timetable_import_id, source_id, name, period_order) values ($1,$2,$3,$4)", [importId, `p${order}`, name, order]);
    }
    for (let d = 1; d <= 5; d += 1) {
      await client.query("insert into public.timetable_days (timetable_import_id, source_id, name, day_order) values ($1,$2,$3,$4)", [importId, `d${d}`, `Gun ${d}`, d]);
    }
    for (const row of (await client.query("select code, id from public.duty_blocks")).rows as { code: string; id: string }[]) block[row.code] = row.id;

    for (const src of ["HD1", "HD0", "FX", "FREE"]) {
      teacher[src] = (await client.query("insert into public.teachers (timetable_import_id, source_id, name) values ($1,$2,$3) returning id", [importId, src, `Ogretmen ${src}`])).rows[0].id;
    }

    for (const [key, code] of [
      ["ILKOKUL1", "ILKOKUL1"],
      ["LOBI", `LOBI${sfx}`],
      ["BALKON", `BALKON${sfx}`],
    ] as const) {
      loc[key] = (await client.query("select (public.create_duty_location($1,$2,$3,'corridor',1,null,true)).id as id", [campusId, `${key} ${sfx}`, code.slice(0, 16)])).rows[0].id;
    }

    const settings: Record<string, string> = {};
    for (const [src, halfDay] of [
      ["HD1", true],
      ["HD0", false],
      ["FX", true],
      ["FREE", true],
    ] as const) {
      settings[src] = (
        await client.query(
          `insert into public.teacher_duty_settings (campus_id, academic_year_id, teacher_source_id, teacher_name_snapshot, is_included, half_day_rule_enabled)
           values ($1,$2,$3,$4,true,$5) returning id`,
          [campusId, yearId, src, `Ogretmen ${src}`, halfDay],
        )
      ).rows[0].id;
    }

    // Herkes gün 2'de LOBI ve BALKON'un dört bloğunu, ayrıca İLKOKUL1 × Öğle
    // Arası-1'i tercih etsin (aday evreni tercihle sınırlanmasın).
    for (const src of ["HD1", "HD0", "FX", "FREE"]) {
      for (const [locKey, codes] of [
        ["LOBI", ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"]],
        ["BALKON", ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"]],
        ["ILKOKUL1", ["MORNING_BREAKS", "LONG_BREAK_1"]],
      ] as const) {
        for (const code of codes) {
          await client.query(
            `insert into public.teacher_duty_block_availabilities (campus_id, teacher_duty_setting_id, day_order, duty_location_id, duty_block_id)
             values ($1,$2,2,$3,$4) on conflict do nothing`,
            [campusId, settings[src], loc[locKey], block[code]],
          );
        }
      }
    }

    // FX gün 2'de İLKOKUL1'de sabit nöbetli.
    await client.query(
      `insert into public.fixed_duty_assignments (campus_id, academic_year_id, teacher_source_id, teacher_name_snapshot, duty_location_id, day_order)
       values ($1,$2,'FX','Ogretmen FX',$3,2)`,
      [campusId, yearId, loc.ILKOKUL1],
    );

    planId = (
      await client.query(
        `insert into public.duty_plans (campus_id, academic_year_id, timetable_import_id, status, source_fingerprint, algorithm_version, generation_options)
         values ($1,$2,$3,'draft',$4,'duty-plan-solver-v3-teacher-half-day-rules','{"maxWeeklyDuties": 5}'::jsonb) returning id`,
        [campusId, yearId, importId, "e".repeat(64)],
      )
    ).rows[0].id;
    // Planın kaynak parmak izini GÜNCEL değere hizala; aksi halde
    // set/preview RPC'leri fingerprint kontrolünde erken 'source_changed'
    // döner ve asıl doğrulamak istediğimiz kurala hiç ulaşılmaz.
    await client.query(
      "update public.duty_plans set source_fingerprint = public.compute_duty_plan_source_fingerprint($1,$2) where id = $3",
      [campusName, yearName, planId],
    );
    await client.query("set constraints all deferred");

    // Hedef hücre: gün 2, BALKON, Öğle Arası-2 (boş).
    task.target = await cell({ day: 2, locKey: "BALKON", blockCode: "LONG_BREAK_2" });
    // İLKOKUL1 gün 2 Sabah: fixed_only hücre.
    task.ilkokulMorning = await cell({ day: 2, locKey: "ILKOKUL1", blockCode: "MORNING_BREAKS", teacher: "FX", kind: "fixed" });
    // İLKOKUL1 gün 2 Öğle Arası-1: NORMAL hücre, boş.
    task.ilkokulLong1 = await cell({ day: 2, locKey: "ILKOKUL1", blockCode: "LONG_BREAK_1" });
  }, 60000);

  afterAll(async () => {
    if (client) {
      await client.query("rollback");
      await client.end();
    }
  });

  it("half-day KAPALI öğretmen BAŞKA blokta görevliyken aday KALIR", async () => {
    await client.query("savepoint sp");
    await cell({ day: 2, locKey: "LOBI", blockCode: "MORNING_BREAKS", teacher: "HD0" });
    const r = await candidatesFor(task.target);
    expect(reasonsOf(r, "HD0")).toEqual([]);
    expect(eligibleOf(r, "HD0")).toBe(true);
    await client.query("rollback to savepoint sp");
  });

  it("aynı gün AYNI BLOK'ta başka yerde görevliyken aday DEĞİLDİR", async () => {
    await client.query("savepoint sp");
    await cell({ day: 2, locKey: "LOBI", blockCode: "LONG_BREAK_2", teacher: "HD0" });
    const r = await candidatesFor(task.target);
    expect(reasonsOf(r, "HD0")).toContain("already_assigned_same_block");
    expect(eligibleOf(r, "HD0")).toBe(false);
    await client.query("rollback to savepoint sp");
  });

  it("half-day AÇIK öğretmen aynı gün ikinci normal görev için aday DEĞİLDİR", async () => {
    await client.query("savepoint sp");
    await cell({ day: 2, locKey: "LOBI", blockCode: "MORNING_BREAKS", teacher: "HD1" });
    const r = await candidatesFor(task.target);
    expect(reasonsOf(r, "HD1")).toContain("half_day_daily_limit");
    expect(reasonsOf(r, "HD1")).not.toContain("already_assigned_same_block");
    expect(eligibleOf(r, "HD1")).toBe(false);
    await client.query("rollback to savepoint sp");
  });

  it("sabit nöbet günü öğretmeni aday DEĞİLDİR", async () => {
    const r = await candidatesFor(task.target);
    expect(reasonsOf(r, "FX")).toContain("fixed_duty_day");
    expect(eligibleOf(r, "FX")).toBe(false);
  });

  it("boş hedef hücrede uygun öğretmen aday OLUR", async () => {
    const r = await candidatesFor(task.target);
    expect(eligibleOf(r, "FREE")).toBe(true);
    expect(reasonsOf(r, "FREE")).toEqual([]);
  });

  it("fixed_only hücre HİÇBİR normal aday üretmez", async () => {
    const r = await candidatesFor(task.ilkokulMorning);
    expect(r.isFixed).toBe(true);
    for (const c of r.candidates) {
      expect(c.eligible).toBe(false);
      expect(c.reasons).toContain("cell_not_open_for_normal");
    }
  });

  it("İLKOKUL1 × Öğle Arası-1 (normal) aday ÜRETİR", async () => {
    const r = await candidatesFor(task.ilkokulLong1);
    expect(eligibleOf(r, "FREE")).toBe(true);
    expect(reasonsOf(r, "FREE")).toEqual([]);
  });

  it("eşlemesi olmayan (not_required) hücre normal aday üretmez", async () => {
    await client.query("savepoint sp");
    // İLKOKUL1 × Öğle Arası-2 eşlemesi YOK — hücreyi elle yaratıp aday sorulur.
    const orphan = await cell({ day: 2, locKey: "ILKOKUL1", blockCode: "LONG_BREAK_2" });
    const r = await candidatesFor(orphan);
    for (const c of r.candidates) {
      expect(c.reasons).toContain("cell_not_open_for_normal");
      expect(c.eligible).toBe(false);
    }
    await client.query("rollback to savepoint sp");
  });

  it("hücrenin KENDİ ataması kendisiyle çakışma sayılmaz (yeniden atama)", async () => {
    await client.query("savepoint sp");
    await client.query("delete from public.duty_plan_assignments where id=$1", [task.target]);
    const own = await cell({ day: 2, locKey: "BALKON", blockCode: "LONG_BREAK_2", teacher: "HD1" });
    const r = await candidatesFor(own);
    expect(reasonsOf(r, "HD1")).toEqual([]);
    expect(eligibleOf(r, "HD1")).toBe(true);
    await client.query("rollback to savepoint sp");
  });

  it("v4 TENEFFÜS paketinin diğer hücresi ikinci günlük görev sayılmaz", async () => {
    await client.query("savepoint sp");
    await client.query(
      "update public.duty_plans set algorithm_version='duty-plan-solver-v4-three-packages' where id=$1",
      [planId],
    );
    const packageId = (
      await client.query(
        `insert into public.duty_plan_assignment_packages
           (plan_id,campus_id,day_order,duty_location_id,teacher_source_id,teacher_name_snapshot,coverage_mode,assignment_kind)
         values ($1,$2,2,$3,'HD1','Ogretmen HD1','SHORT_BREAKS','generated') returning id`,
        [planId, campusId, loc.LOBI],
      )
    ).rows[0].id;
    const ids: string[] = [];
    for (const code of ["MORNING_BREAKS", "AFTERNOON_BREAKS"]) {
      ids.push(
        (
          await client.query(
            `insert into public.duty_plan_assignments
               (plan_id,campus_id,day_order,duty_location_id,duty_block_id,teacher_source_id,teacher_name_snapshot,
                duty_location_name_snapshot,duty_block_name_snapshot,assignment_kind,package_id)
             values ($1,$2,2,$3,$4,'HD1','Ogretmen HD1','LOBI',$5,'generated',$6) returning id`,
            [planId, campusId, loc.LOBI, block[code], code, packageId],
          )
        ).rows[0].id,
      );
    }

    const r = await candidatesFor(ids[1]);
    expect(reasonsOf(r, "HD1")).not.toContain("daily_package_limit");
    expect(reasonsOf(r, "HD1")).not.toContain("half_day_daily_limit");
    expect(eligibleOf(r, "HD1")).toBe(true);
    await client.query("rollback to savepoint sp");
  });

  it("v4 farklı bir paket varsa toggle kapalı olsa bile günlük paket sınırı döner", async () => {
    await client.query("savepoint sp");
    await client.query(
      "update public.duty_plans set algorithm_version='duty-plan-solver-v4-three-packages' where id=$1",
      [planId],
    );
    await cell({ day: 2, locKey: "LOBI", blockCode: "MORNING_BREAKS", teacher: "HD0" });
    const r = await candidatesFor(task.target);
    expect(reasonsOf(r, "HD0")).toContain("daily_package_limit");
    expect(eligibleOf(r, "HD0")).toBe(false);
    await client.query("rollback to savepoint sp");
  });

  it("haftalık sınır dolduğunda weekly_limit_reached döner", async () => {
    await client.query("savepoint sp");
    await client.query("update public.duty_plans set generation_options = '{\"maxWeeklyDuties\": 1}'::jsonb where id=$1", [planId]);
    await cell({ day: 3, locKey: "LOBI", blockCode: "MORNING_BREAKS", teacher: "FREE" });
    const r = await candidatesFor(task.target);
    expect(reasonsOf(r, "FREE")).toContain("weekly_limit_reached");
    await client.query("rollback to savepoint sp");
  });

  // -------------------------------------------------------------------------
  // solver-v3 tek blok savunması
  // -------------------------------------------------------------------------
  it("v3 planda FULL_DAY preview YAPILANDIRILMIŞ hata döner (ham exception yok)", async () => {
    const r = await rpc<{ found: boolean; eligible: boolean; reasons: string[] }>("preview_duty_plan_manual_package", {
      p_plan_id: planId,
      p_campus_name: campusName,
      p_academic_year_name: yearName,
      p_day_order: 2,
      p_duty_location_id: loc.LOBI,
      p_teacher_source_id: "FREE",
      p_coverage_mode: "FULL_DAY",
      p_duty_block_id: null,
    });
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain("normal_package_must_be_single_block");
  });

  it("v3 planda SHORT_BREAKS set YAPILANDIRILMIŞ hata döner (ham exception yok)", async () => {
    const r = await rpc<{ status: string }>("set_duty_plan_manual_package", {
      p_plan_id: planId,
      p_campus_name: campusName,
      p_academic_year_name: yearName,
      p_day_order: 2,
      p_duty_location_id: loc.LOBI,
      p_teacher_source_id: "FREE",
      p_coverage_mode: "SHORT_BREAKS",
      p_expected_plan_version: 1,
      p_expected_affected_task_ids: null,
      p_duty_block_id: null,
    });
    expect(r.status).toBe("normal_package_must_be_single_block");
  });

  it("v3 planda SINGLE_BLOCK preview yapılandırılmış hata VERMEZ", async () => {
    const r = await rpc<{ found: boolean; reasons: string[] }>("preview_duty_plan_manual_package", {
      p_plan_id: planId,
      p_campus_name: campusName,
      p_academic_year_name: yearName,
      p_day_order: 2,
      p_duty_location_id: loc.BALKON,
      p_teacher_source_id: "FREE",
      p_coverage_mode: "SINGLE_BLOCK",
      p_duty_block_id: block.LONG_BREAK_2,
    });
    expect(r.reasons ?? []).not.toContain("normal_package_must_be_single_block");
    expect(r.reasons ?? []).not.toContain("cell_not_open_for_normal");
  });

  // -------------------------------------------------------------------------
  // Yetkiler
  // -------------------------------------------------------------------------
  it("yeni fonksiyonlar SECURITY INVOKER, sabit search_path ve yalnız service_role EXECUTE", async () => {
    const rolesExist = (await client.query("select count(*)::int as n from pg_roles where rolname in ('anon','authenticated','service_role')")).rows[0].n;
    const res = await client.query(
      `select p.proname, p.prosecdef,
              coalesce(array_to_string(p.proconfig, ','), '') as cfg,
              has_function_privilege('public', p.oid, 'EXECUTE') as pub
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public'
          and p.proname in ('is_duty_cell_open_for_normal','teacher_half_day_rule_enabled','save_teacher_duty_matrix_v2')
        order by p.proname`,
    );
    expect(res.rows).toHaveLength(3);
    for (const row of res.rows as { prosecdef: boolean; cfg: string; pub: boolean }[]) {
      expect(row.prosecdef).toBe(false);
      expect(row.cfg).toContain("search_path=");
      expect(row.pub).toBe(false);
    }

    if (rolesExist === 3) {
      const priv = await client.query(
        `select p.proname,
                has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
                has_function_privilege('service_role', p.oid, 'EXECUTE') as svc
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname='public'
            and p.proname in ('is_duty_cell_open_for_normal','teacher_half_day_rule_enabled','save_teacher_duty_matrix_v2',
                              'preview_duty_plan_manual_package','set_duty_plan_manual_package')`,
      );
      for (const row of priv.rows as { anon: boolean; auth: boolean; svc: boolean }[]) {
        expect(row.anon).toBe(false);
        expect(row.auth).toBe(false);
        expect(row.svc).toBe(true);
      }
    }
  });
});
