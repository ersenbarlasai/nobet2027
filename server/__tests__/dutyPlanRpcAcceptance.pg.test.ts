import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * GERÇEK PostgreSQL KABUL testleri — save_duty_plan_draft,
 * update_duty_plan_assignment, preview/set_duty_plan_manual_package ve
 * publish_duty_plan_draft DOĞRUDAN `select public.rpc(...)` ile çağrılır.
 * PostgREST GEREKMEZ; route mock'ları burada KULLANILMAZ.
 *
 *   DUTY_PLAN_PG_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
 *
 * Diğer pg süitleriyle `--no-file-parallelism` ile SERİ çalışmalıdır.
 */
const DB_URL = process.env.DUTY_PLAN_PG_TEST_DB_URL;
const enabled = Boolean(DB_URL);

const V3 = "duty-plan-solver-v3-teacher-half-day-rules";

describe.skipIf(!enabled)("nöbet planı RPC kabul testleri — gerçek PostgreSQL", () => {
  let client: Client;
  let campusId: string;
  let campusName: string;
  let yearName: string;
  let yearId: string;
  let importId: string;
  const loc: Record<string, string> = {};
  const block: Record<string, string> = {};
  const settingId: Record<string, string> = {};

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

  /** Plan + paket + atama tablolarının BÜTÜN gözlemlenebilir durumu. */
  async function stateHash(): Promise<string> {
    const res = await client.query(`
      select coalesce(md5(
        coalesce((select string_agg(p.id::text || p.status || p.version::text || p.summary::text, '|' order by p.id) from public.duty_plans p), '') || '#' ||
        coalesce((select string_agg(a.id::text || coalesce(a.teacher_source_id,'') || a.assignment_kind || coalesce(a.package_id::text,''), '|' order by a.id) from public.duty_plan_assignments a), '') || '#' ||
        coalesce((select string_agg(k.id::text || k.coverage_mode || k.assignment_kind, '|' order by k.id) from public.duty_plan_assignment_packages k), '')
      ), 'empty') as h`);
    return res.rows[0].h as string;
  }

  async function currentFingerprint(): Promise<string> {
    return rpc<string>("compute_duty_plan_source_fingerprint", { p_campus_name: campusName, p_academic_year_name: yearName });
  }

  /** Taslak plan oluşturur (verilen algoritma sürümüyle) ve id döner. */
  async function makePlan(algorithm = V3, status = "draft"): Promise<string> {
    const fp = await currentFingerprint();
    const res = await client.query(
      `insert into public.duty_plans (campus_id, academic_year_id, timetable_import_id, status, source_fingerprint, algorithm_version, generation_options)
       values ($1,$2,$3,$4,$5,$6,'{"maxWeeklyDuties": 5}'::jsonb) returning id`,
      [campusId, yearId, importId, status, fp, algorithm],
    );
    return res.rows[0].id as string;
  }

  /** Bir hücre + (öğretmen verilirse) paketi yazar. */
  async function cell(planId: string, args: { day: number; locKey: string; blockCode: string; teacher?: string; kind?: string }): Promise<string> {
    let packageId: string | null = null;
    if (args.teacher) {
      const kind = args.kind ?? "generated";
      const coverage = kind === "fixed" ? "FIXED_SHORT_BREAKS" : "SINGLE_BLOCK";
      // v3 modelinde her normal hücre KENDİ SINGLE_BLOCK paketini alır; yalnız
      // sabit paket (FIXED_SHORT_BREAKS) aynı gün+yer için PAYLAŞILIR.
      const existing =
        coverage === "FIXED_SHORT_BREAKS"
          ? await client.query(
              "select id from public.duty_plan_assignment_packages where plan_id=$1 and day_order=$2 and teacher_source_id=$3 and duty_location_id=$4 and coverage_mode=$5",
              [planId, args.day, args.teacher, loc[args.locKey], coverage],
            )
          : { rows: [] as { id: string }[] };
      packageId =
        existing.rows[0]?.id ??
        (
          await client.query(
            `insert into public.duty_plan_assignment_packages
               (plan_id, campus_id, day_order, duty_location_id, teacher_source_id, teacher_name_snapshot, coverage_mode, assignment_kind)
             values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
            [planId, campusId, args.day, loc[args.locKey], args.teacher, `Ogretmen ${args.teacher}`, coverage, kind],
          )
        ).rows[0].id;
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

  /** save_duty_plan_draft için p_assignments satırı. */
  function row(day: number, locKey: string, blockCode: string, teacher: string | null, kind: string) {
    return { day_order: day, duty_location_id: loc[locKey], duty_block_id: block[blockCode], teacher_source_id: teacher, assignment_kind: kind, score_details: {} };
  }

  /** Görev evreninin TAMAMI (2 yer × 4 blok + İLKOKUL1 3 blok) × 5 gün. */
  function fullUniverse(assign: (day: number, locKey: string, code: string) => string | null) {
    const rows: ReturnType<typeof row>[] = [];
    for (let d = 1; d <= 5; d += 1) {
      for (const [locKey, codes] of [
        ["LOBI", ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"]],
        ["BALKON", ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"]],
        ["ILKOKUL1", ["MORNING_BREAKS", "AFTERNOON_BREAKS", "LONG_BREAK_1"]],
      ] as const) {
        for (const code of codes) {
          const isFixedCell = locKey === "ILKOKUL1" && code !== "LONG_BREAK_1";
          if (isFixedCell) {
            // Sabit hücre: yalnız o gün İLKOKUL1'de sabit atama varsa kapsanır.
            rows.push(row(d, locKey, code, d === 2 ? "FX" : null, d === 2 ? "fixed" : "unassigned"));
            continue;
          }
          const t = assign(d, locKey, code);
          rows.push(row(d, locKey, code, t, t ? "generated" : "unassigned"));
        }
      }
    }
    return rows;
  }

  /** save_duty_plan_draft'ın yetkili özet formülüyle BİREBİR aynı özet. */
  async function summaryFor(rows: ReturnType<typeof row>[]) {
    const universe = ["HD1", "HD0", "FX", "FREE"];
    const normalByTeacher = new Map<string, number>();
    for (const r of rows) {
      if (!r.teacher_source_id || r.assignment_kind === "unassigned") continue;
      if (r.assignment_kind === "fixed") continue;
      // Paket-gün sayısı: aynı gün+yer+öğretmen TEK paket.
      normalByTeacher.set(`${r.teacher_source_id}`, 0);
    }
    // v3 BİRİMİ: her normal hücre AYRI SINGLE_BLOCK paket (bkz. 20260921090000).
    // Gruplama anahtarına BLOK da girer.
    const pkgKeys = new Set<string>();
    for (const r of rows) {
      if (!r.teacher_source_id || !["generated", "manual"].includes(r.assignment_kind)) continue;
      pkgKeys.add(`${r.day_order}|${r.duty_location_id}|${r.duty_block_id}|${r.teacher_source_id}`);
    }
    const normalCount = new Map<string, number>();
    for (const k of pkgKeys) {
      const t = k.split("|")[3];
      normalCount.set(t, (normalCount.get(t) ?? 0) + 1);
    }
    const fixedDays = (await client.query("select teacher_source_id, count(distinct day_order)::int as n from public.fixed_duty_assignments where academic_year_id=$1 group by 1", [yearId])).rows as {
      teacher_source_id: string;
      n: number;
    }[];
    const fixedMap = new Map(fixedDays.map((r) => [r.teacher_source_id, r.n]));
    const teacherLoads = universe
      .slice()
      .sort()
      .map((t) => {
        const normalDutyCount = normalCount.get(t) ?? 0;
        const fixedDutyDayCount = fixedMap.get(t) ?? 0;
        return { teacherSourceId: t, normalDutyCount, fixedDutyDayCount, totalDutyCount: normalDutyCount + fixedDutyDayCount };
      });
    return {
      totalTaskCount: rows.length,
      fixedTaskCount: rows.filter((r) => r.assignment_kind === "fixed" || (r.assignment_kind === "unassigned" && r.duty_location_id === loc.ILKOKUL1 && r.duty_block_id !== block.LONG_BREAK_1)).length,
      fixedCoveredCount: rows.filter((r) => r.assignment_kind === "fixed").length,
      normalTaskCount: rows.filter((r) => !(r.duty_location_id === loc.ILKOKUL1 && r.duty_block_id !== block.LONG_BREAK_1)).length,
      normalCoveredCount: rows.filter((r) => r.assignment_kind === "generated").length,
      uncoveredCount: rows.filter((r) => r.assignment_kind === "unassigned").length,
      teacherLoads,
    };
  }

  async function callSave(rows: ReturnType<typeof row>[], algorithm = V3) {
    return rpc<{ status: string; reason?: string }>("save_duty_plan_draft", {
      p_campus_name: campusName,
      p_academic_year_name: yearName,
      p_expected_source_fingerprint: await currentFingerprint(),
      p_algorithm_version: algorithm,
      p_generation_seed: 1,
      p_generation_options: { maxWeeklyDuties: 5 },
      p_assignments: rows,
      p_summary: await summaryFor(rows),
      p_allow_partial: true,
      p_expected_plan_id: null,
    });
  }

  beforeAll(async () => {
    client = new Client({ connectionString: DB_URL });
    await client.connect();
    await client.query("begin");

    campusName = `Kabul Kampus ${sfx}`;
    yearName = `2026-2027 ${sfx}`;
    campusId = (await client.query("insert into public.campuses (name, code) values ($1,$2) returning id", [campusName, `K${sfx}`])).rows[0].id;
    yearId = (await client.query("insert into public.academic_years (campus_id, name) values ($1,$2) returning id", [campusId, yearName])).rows[0].id;
    importId = (
      await client.query(
        "insert into public.timetable_imports (campus_id, academic_year_id, source_format, source_filename, status, imported_at) values ($1,$2,'asc','f.xml','imported', now()) returning id",
        [campusId, yearId],
      )
    ).rows[0].id;

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
    for (const r of (await client.query("select code, id from public.duty_blocks")).rows as { code: string; id: string }[]) block[r.code] = r.id;

    for (const src of ["HD1", "HD0", "FX", "FREE"]) {
      await client.query("insert into public.teachers (timetable_import_id, source_id, name) values ($1,$2,$3)", [importId, src, `Ogretmen ${src}`]);
    }

    for (const [key, code] of [
      ["ILKOKUL1", "ILKOKUL1"],
      ["LOBI", `LOBI${sfx}`],
      ["BALKON", `BALKON${sfx}`],
    ] as const) {
      loc[key] = (await client.query("select (public.create_duty_location($1,$2,$3,'corridor',1,null,true)).id as id", [campusId, `${key} ${sfx}`, code.slice(0, 16)])).rows[0].id;
    }

    for (const [src, halfDay] of [
      ["HD1", true],
      ["HD0", false],
      ["FX", true],
      ["FREE", true],
    ] as const) {
      settingId[src] = (
        await client.query(
          `insert into public.teacher_duty_settings (campus_id, academic_year_id, teacher_source_id, teacher_name_snapshot, is_included, half_day_rule_enabled)
           values ($1,$2,$3,$4,true,$5) returning id`,
          [campusId, yearId, src, `Ogretmen ${src}`, halfDay],
        )
      ).rows[0].id;
    }

    // Herkes her günde her normal hücreyi tercih etsin (aday evreni serbest).
    for (const src of ["HD1", "HD0", "FX", "FREE"]) {
      for (const [locKey, codes] of [
        ["LOBI", ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"]],
        ["BALKON", ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"]],
        ["ILKOKUL1", ["LONG_BREAK_1"]],
      ] as const) {
        for (const code of codes) {
          for (let d = 1; d <= 5; d += 1) {
            await client.query(
              `insert into public.teacher_duty_block_availabilities (campus_id, teacher_duty_setting_id, day_order, duty_location_id, duty_block_id)
               values ($1,$2,$3,$4,$5) on conflict do nothing`,
              [campusId, settingId[src], d, loc[locKey], block[code]],
            );
          }
        }
      }
    }

    // FX gün 2'de İLKOKUL1'de sabit nöbetli.
    await client.query(
      `insert into public.fixed_duty_assignments (campus_id, academic_year_id, teacher_source_id, teacher_name_snapshot, duty_location_id, day_order)
       values ($1,$2,'FX','Ogretmen FX',$3,2)`,
      [campusId, yearId, loc.ILKOKUL1],
    );
    await client.query("set constraints all deferred");
  }, 60000);

  afterAll(async () => {
    if (client) {
      await client.query("rollback");
      await client.end();
    }
  });

  // Her test KENDİ savepoint'inde çalışır ve testin sonucundan BAĞIMSIZ olarak
  // geri alınır — böylece başarısız bir test sonrakini kirletmez
  // (duty_plans_one_active_draft_uq gibi kısıtlar yanlış hata üretmez).
  beforeEach(async () => {
    await client.query("savepoint sp");
  });

  afterEach(async () => {
    await client.query("rollback to savepoint sp");
  });

  // =========================================================================
  // save_duty_plan_draft
  // =========================================================================
  describe("save_duty_plan_draft", () => {
    it("v4 TENEFFÜS çiftini tek günlük görev paketi sayar ve tam planı yayımlar", async () => {
      // Görev evrenini bu kabul testi için yalnız LOBI × (Sabah, Öğleden
      // Sonra) olarak daralt. Her günün iki hücresi TEK TENEFFÜS paketidir.
      await client.query("delete from public.fixed_duty_assignments where academic_year_id=$1", [yearId]);
      await client.query("update public.duty_locations set is_active=false where id = any($1::uuid[])", [[loc.BALKON, loc.ILKOKUL1]]);
      await client.query(
        `delete from public.duty_location_blocks
          where duty_location_id=$1 and duty_block_id = any($2::uuid[])`,
        [loc.LOBI, [block.LONG_BREAK_1, block.LONG_BREAK_2]],
      );

      const rows = [];
      for (let day = 1; day <= 5; day += 1) {
        const teacher = day <= 3 ? "HD1" : "HD0";
        rows.push(row(day, "LOBI", "MORNING_BREAKS", teacher, "generated"));
        rows.push(row(day, "LOBI", "AFTERNOON_BREAKS", teacher, "generated"));
      }

      const summary = {
        totalTaskCount: 10,
        fixedTaskCount: 0,
        fixedCoveredCount: 0,
        normalTaskCount: 10,
        normalCoveredCount: 10,
        uncoveredCount: 0,
        teacherLoads: [
          { teacherSourceId: "FREE", normalDutyCount: 0, fixedDutyDayCount: 0, totalDutyCount: 0 },
          { teacherSourceId: "FX", normalDutyCount: 0, fixedDutyDayCount: 0, totalDutyCount: 0 },
          { teacherSourceId: "HD0", normalDutyCount: 2, fixedDutyDayCount: 0, totalDutyCount: 2 },
          { teacherSourceId: "HD1", normalDutyCount: 3, fixedDutyDayCount: 0, totalDutyCount: 3 },
        ],
      };
      const fingerprint = await currentFingerprint();
      const saved = await rpc<{ status: string; reason?: string; planId?: string; version?: number }>("save_duty_plan_draft", {
        p_campus_name: campusName,
        p_academic_year_name: yearName,
        p_expected_source_fingerprint: fingerprint,
        p_algorithm_version: "duty-plan-solver-v4-three-packages",
        p_generation_seed: 9,
        p_generation_options: { minWeeklyDuties: 0, targetWeeklyDuties: 2, maxWeeklyDuties: 3 },
        p_assignments: rows,
        p_summary: summary,
        p_allow_partial: false,
        p_expected_plan_id: null,
        p_expected_plan_version: null,
      });

      expect(saved).toMatchObject({ status: "ok", version: 1 });
      expect(saved.reason).toBeUndefined();

      const persisted = await client.query(
        `select count(distinct p.id)::int as package_count,
                count(a.id)::int as cell_count,
                array_agg(distinct p.coverage_mode order by p.coverage_mode) as modes
           from public.duty_plan_assignment_packages p
           join public.duty_plan_assignments a on a.package_id=p.id
          where p.plan_id=$1`,
        [saved.planId],
      );
      expect(persisted.rows[0]).toEqual({ package_count: 5, cell_count: 10, modes: ["SHORT_BREAKS"] });

      const published = await rpc<{ status: string; reason?: string }>("publish_duty_plan_draft", {
        p_plan_id: saved.planId,
        p_campus_name: campusName,
        p_academic_year_name: yearName,
        p_expected_plan_version: 1,
      });
      expect(published).toMatchObject({ status: "ok" });
    });

    it("v3: half-day KAPALI öğretmen AYNI yerde iki blok alabilir (20260921090000)", async () => {
      // 20260919090000 bunu AÇIKÇA meşru sayar; eski R3 kontrolü yanlışlıkla
      // reddediyordu. Artık kabul edilir ve HER hücre AYRI SINGLE_BLOCK paket olur.
      const rows = fullUniverse((d, l, c) => (d === 1 && l === "LOBI" && (c === "MORNING_BREAKS" || c === "AFTERNOON_BREAKS") ? "HD0" : null));
      const r = await callSave(rows);
      expect(r.status).toBe("ok");

      const pkgs = await client.query(
        `select k.coverage_mode, (select count(*) from public.duty_plan_assignments a where a.package_id = k.id)::int as cells
           from public.duty_plan_assignment_packages k
           join public.duty_plans p on p.id = k.plan_id
          where p.campus_id = $1 and k.teacher_source_id = 'HD0' and k.day_order = 1`,
        [campusId],
      );
      expect(pkgs.rows).toHaveLength(2);
      for (const row of pkgs.rows as { coverage_mode: string; cells: number }[]) {
        expect(row.coverage_mode).toBe("SINGLE_BLOCK");
        expect(row.cells).toBe(1);
      }
    });

    it("half-day AÇIK öğretmene aynı gün iki normal blok → teacher_day_conflict/half_day_rule", async () => {
      const before = await stateHash();
      const rows = fullUniverse((d, l, c) => {
        if (d !== 1) return null;
        if (l === "LOBI" && c === "MORNING_BREAKS") return "HD1";
        if (l === "BALKON" && c === "LONG_BREAK_1") return "HD1";
        return null;
      });
      const r = await callSave(rows);
      expect(r).toMatchObject({ status: "teacher_day_conflict", reason: "half_day_rule" });
      expect(await stateHash()).toBe(before);
    });

    it("half-day KAPALI öğretmene aynı gün FARKLI bloklar kabul edilir", async () => {
      const rows = fullUniverse((d, l, c) => {
        if (d !== 1) return null;
        if (l === "LOBI" && c === "MORNING_BREAKS") return "HD0";
        if (l === "BALKON" && c === "LONG_BREAK_1") return "HD0";
        return null;
      });
      const r = await callSave(rows);
      expect(r.status).toBe("ok");
    });

    it("aynı gün AYNI BLOK'ta iki farklı yer → teacher_block_conflict", async () => {
      const before = await stateHash();
      const rows = fullUniverse((d, l, c) => (d === 1 && c === "MORNING_BREAKS" && (l === "LOBI" || l === "BALKON") ? "HD0" : null));
      const r = await callSave(rows);
      expect(r.status).toBe("teacher_block_conflict");
      expect(await stateHash()).toBe(before);
    });

    it("sabit öğretmene sabit gününde normal görev → teacher_has_fixed_duty", async () => {
      const before = await stateHash();
      const rows = fullUniverse((d, l, c) => (d === 2 && l === "LOBI" && c === "MORNING_BREAKS" ? "FX" : null));
      const r = await callSave(rows);
      expect(r.status).toBe("teacher_has_fixed_duty");
      expect(await stateHash()).toBe(before);
    });
  });

  // =========================================================================
  // update_duty_plan_assignment
  // =========================================================================
  describe("update_duty_plan_assignment", () => {
    let planId: string;

    async function target(args: { day: number; locKey: string; blockCode: string }) {
      return cell(planId, args);
    }

    async function assign(taskId: string, teacher: string) {
      return rpc<{ status: string; reason?: string }>("update_duty_plan_assignment", {
        p_plan_id: planId,
        p_task_id: taskId,
        p_campus_name: campusName,
        p_academic_year_name: yearName,
        p_teacher_source_id: teacher,
        p_expected_plan_version: 1,
      });
    }

    beforeEach(async () => {
      planId = await makePlan();
    });

    it("fixed_only hücre → cell_not_open_for_normal", async () => {
      const t = await target({ day: 1, locKey: "ILKOKUL1", blockCode: "MORNING_BREAKS" });
      const before = await stateHash();
      expect((await assign(t, "FREE")).status).toBe("cell_not_open_for_normal");
      expect(await stateHash()).toBe(before);
    });

    it("eşlemesi olmayan (not_required) hücre → cell_not_open_for_normal", async () => {
      const t = await target({ day: 1, locKey: "ILKOKUL1", blockCode: "LONG_BREAK_2" });
      const before = await stateHash();
      expect((await assign(t, "FREE")).status).toBe("cell_not_open_for_normal");
      expect(await stateHash()).toBe(before);
    });

    it("half-day AÇIK ikinci görev → teacher_day_conflict/half_day_rule, hiçbir şey değişmez", async () => {
      await cell(planId, { day: 1, locKey: "LOBI", blockCode: "MORNING_BREAKS", teacher: "HD1" });
      const t = await target({ day: 1, locKey: "BALKON", blockCode: "LONG_BREAK_1" });
      const before = await stateHash();
      const r = await assign(t, "HD1");
      expect(r.status).toBe("teacher_day_conflict");
      expect(await stateHash()).toBe(before);
    });

    it("half-day KAPALI FARKLI blok → kabul", async () => {
      await cell(planId, { day: 1, locKey: "LOBI", blockCode: "MORNING_BREAKS", teacher: "HD0" });
      const t = await target({ day: 1, locKey: "BALKON", blockCode: "LONG_BREAK_1" });
      expect((await assign(t, "HD0")).status).toBe("ok");
    });

    it("half-day KAPALI AYNI blok başka yer → teacher_block_conflict", async () => {
      await cell(planId, { day: 1, locKey: "LOBI", blockCode: "MORNING_BREAKS", teacher: "HD0" });
      const t = await target({ day: 1, locKey: "BALKON", blockCode: "MORNING_BREAKS" });
      const before = await stateHash();
      expect((await assign(t, "HD0")).status).toBe("teacher_block_conflict");
      expect(await stateHash()).toBe(before);
    });

    it("sabit gün → teacher_has_fixed_duty", async () => {
      const t = await target({ day: 2, locKey: "LOBI", blockCode: "MORNING_BREAKS" });
      const before = await stateHash();
      expect((await assign(t, "FX")).status).toBe("teacher_has_fixed_duty");
      expect(await stateHash()).toBe(before);
    });
  });

  // =========================================================================
  // preview / set_duty_plan_manual_package
  // =========================================================================
  describe("manuel paket (preview + set)", () => {
    let planId: string;

    beforeEach(async () => {
      planId = await makePlan();
      for (let d = 1; d <= 2; d += 1) {
        for (const [locKey, codes] of [
          ["LOBI", ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"]],
          ["BALKON", ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"]],
        ] as const) {
          for (const c of codes) await cell(planId, { day: d, locKey, blockCode: c });
        }
      }
    });

    const preview = (args: { day: number; locKey: string; teacher: string; mode: string; blockCode?: string }) =>
      rpc<{ eligible: boolean; reasons: string[] }>("preview_duty_plan_manual_package", {
        p_plan_id: planId,
        p_campus_name: campusName,
        p_academic_year_name: yearName,
        p_day_order: args.day,
        p_duty_location_id: loc[args.locKey],
        p_teacher_source_id: args.teacher,
        p_coverage_mode: args.mode,
        p_duty_block_id: args.blockCode ? block[args.blockCode] : null,
      });

    /** Plan sürümü her başarılı yazımda artar — çağrı öncesi GÜNCEL sürüm okunur. */
    async function planVersion(): Promise<number> {
      return (await client.query("select version from public.duty_plans where id=$1", [planId])).rows[0].version as number;
    }

    const set = (args: { day: number; locKey: string; teacher: string; mode: string; blockCode?: string; version?: number }) =>
      rpc<{ status: string; reason?: string }>("set_duty_plan_manual_package", {
        p_plan_id: planId,
        p_campus_name: campusName,
        p_academic_year_name: yearName,
        p_day_order: args.day,
        p_duty_location_id: loc[args.locKey],
        p_teacher_source_id: args.teacher,
        p_coverage_mode: args.mode,
        p_expected_plan_version: args.version ?? 1,
        p_expected_affected_task_ids: null,
        p_duty_block_id: args.blockCode ? block[args.blockCode] : null,
      });

    it("v3: FULL_DAY ve SHORT_BREAKS preview + set YAPILANDIRILMIŞ reddedilir", async () => {
      for (const mode of ["FULL_DAY", "SHORT_BREAKS"]) {
        const p = await preview({ day: 1, locKey: "LOBI", teacher: "FREE", mode });
        expect(p.eligible).toBe(false);
        expect(p.reasons).toContain("normal_package_must_be_single_block");
        const s = await set({ day: 1, locKey: "LOBI", teacher: "FREE", mode });
        expect(s.status).toBe("normal_package_must_be_single_block");
      }
    });

    it("v3: SINGLE_BLOCK kabul edilir", async () => {
      const s = await set({ day: 1, locKey: "LOBI", teacher: "FREE", mode: "SINGLE_BLOCK", blockCode: "MORNING_BREAKS" });
      expect(s.status).toBe("ok");
    });

    it("fixed_only hedef blok → cell_not_open_for_normal (ham exception yok)", async () => {
      await cell(planId, { day: 1, locKey: "ILKOKUL1", blockCode: "MORNING_BREAKS" });
      const s = await set({ day: 1, locKey: "ILKOKUL1", teacher: "FREE", mode: "SINGLE_BLOCK", blockCode: "MORNING_BREAKS" });
      expect(s.status).toBe("cell_not_open_for_normal");
    });

    it("half-day AÇIK ikinci paket → teacher_day_conflict", async () => {
      await set({ day: 1, locKey: "LOBI", teacher: "HD1", mode: "SINGLE_BLOCK", blockCode: "MORNING_BREAKS" });
      const before = await stateHash();
      const s = await set({ day: 1, locKey: "BALKON", teacher: "HD1", mode: "SINGLE_BLOCK", blockCode: "LONG_BREAK_1", version: await planVersion() });
      expect(s.status).toBe("teacher_day_conflict");
      expect(await stateHash()).toBe(before);
    });

    it("half-day KAPALI aynı blok başka yer → teacher_block_conflict", async () => {
      await set({ day: 1, locKey: "LOBI", teacher: "HD0", mode: "SINGLE_BLOCK", blockCode: "MORNING_BREAKS" });
      const before = await stateHash();
      const s = await set({ day: 1, locKey: "BALKON", teacher: "HD0", mode: "SINGLE_BLOCK", blockCode: "MORNING_BREAKS", version: await planVersion() });
      expect(s.status).toBe("teacher_block_conflict");
      expect(await stateHash()).toBe(before);
    });

    it("sabit gün → teacher_has_fixed_duty", async () => {
      const before = await stateHash();
      const s = await set({ day: 2, locKey: "LOBI", teacher: "FX", mode: "SINGLE_BLOCK", blockCode: "MORNING_BREAKS" });
      expect(s.status).toBe("teacher_has_fixed_duty");
      expect(await stateHash()).toBe(before);
    });
  });

  // =========================================================================
  // publish_duty_plan_draft
  // =========================================================================
  describe("publish_duty_plan_draft", () => {
    /** Tam, GEÇERLİ bir v3 planı kurar (38 hücre × 5 gün eşdeğeri, bu fixture'da 11 hücre/gün). */
    async function buildValidPlan(): Promise<string> {
      // Kapsama için yarım gün kuralı KAPALI iki öğretmen gerekir (günde 9
      // normal hücre var). HD1 yarım gün AÇIK kalır ve günde TEK blok alır.
      await client.query("update public.teacher_duty_settings set half_day_rule_enabled=false where id = any($1)", [[settingId.HD0, settingId.FREE]]);
      // Gerçek modelde İLKOKUL1 her gün sabit atamayla kapanır; bu fixture'da
      // FX yalnız gün 2'de sabitti. Publish açık görev İSTEMEDİĞİ için kalan
      // dört güne de sabit atama eklenir (yalnız bu testin savepoint'inde).
      for (const d of [1, 3, 4, 5]) {
        await client.query(
          `insert into public.fixed_duty_assignments (campus_id, academic_year_id, teacher_source_id, teacher_name_snapshot, duty_location_id, day_order)
           values ($1,$2,'FX','Ogretmen FX',$3,$4)`,
          [campusId, yearId, loc.ILKOKUL1, d],
        );
      }
      const planId = await makePlan();
      // Haftalık paket sınırı: her gün 4 paket alan öğretmen 20'ye çıkar.
      await client.query("update public.duty_plans set generation_options='{\"maxWeeklyDuties\": 50}'::jsonb where id=$1", [planId]);

      // AÇIK atama tablosu: aynı gün+blokta AYNI öğretmen iki kez geçmez,
      // yarım gün AÇIK öğretmen (HD1) günde yalnız bir blok alır.
      const plan: [string, string, string][] = [
        ["LOBI", "MORNING_BREAKS", "HD0"],
        ["BALKON", "MORNING_BREAKS", "FREE"],
        ["LOBI", "LONG_BREAK_1", "HD0"],
        ["BALKON", "LONG_BREAK_1", "FREE"],
        ["ILKOKUL1", "LONG_BREAK_1", "HD1"],
        ["LOBI", "LONG_BREAK_2", "HD0"],
        ["BALKON", "LONG_BREAK_2", "FREE"],
        ["LOBI", "AFTERNOON_BREAKS", "HD0"],
        ["BALKON", "AFTERNOON_BREAKS", "FREE"],
      ];
      for (let d = 1; d <= 5; d += 1) {
        for (const [locKey, code, teacher] of plan) {
          await cell(planId, { day: d, locKey, blockCode: code, teacher });
        }
        // İLKOKUL1 sabit hücreleri: her gün FX tarafından kapsanır.
        for (const code of ["MORNING_BREAKS", "AFTERNOON_BREAKS"]) {
          await cell(planId, { day: d, locKey: "ILKOKUL1", blockCode: code, teacher: "FX", kind: "fixed" });
        }
      }
      return planId;
    }

    const publish = (planId: string, version = 1) =>
      rpc<{ status: string; reason?: string }>("publish_duty_plan_draft", {
        p_plan_id: planId,
        p_campus_name: campusName,
        p_academic_year_name: yearName,
        p_expected_plan_version: version,
      });

    it("normal görev fixed_only hücredeyse reddedilir ve plan draft KALIR", async () => {
      const planId = await makePlan();
      await cell(planId, { day: 1, locKey: "ILKOKUL1", blockCode: "MORNING_BREAKS", teacher: "FREE" });
      const r = await publish(planId);
      expect(r.status).toBe("rule_violation");
      const st = (await client.query("select status from public.duty_plans where id=$1", [planId])).rows[0].status;
      expect(st).toBe("draft");
    });

    it("aynı öğretmen aynı gün aynı blokta iki yerdeyse reddedilir", async () => {
      const planId = await makePlan();
      await cell(planId, { day: 1, locKey: "LOBI", blockCode: "MORNING_BREAKS", teacher: "HD0" });
      // duty_plan_assignments_teacher_day_block_uq bunu DB'de zaten engeller;
      // publish yolunun da yapılandırılmış hata döndürdüğü doğrulanır.
      await expect(cell(planId, { day: 1, locKey: "BALKON", blockCode: "MORNING_BREAKS", teacher: "HD0" })).rejects.toThrow(/teacher_day_block_uq/);
    });

    it("half-day AÇIK günlük sınır ihlalinde reddedilir", async () => {
      const planId = await makePlan();
      await cell(planId, { day: 1, locKey: "LOBI", blockCode: "MORNING_BREAKS", teacher: "HD1" });
      await cell(planId, { day: 1, locKey: "BALKON", blockCode: "LONG_BREAK_1", teacher: "HD1" });
      const r = await publish(planId);
      expect(r).toMatchObject({ status: "rule_violation" });
      expect((await client.query("select status from public.duty_plans where id=$1", [planId])).rows[0].status).toBe("draft");
    });

    it("sabit gün normal görevinde reddedilir", async () => {
      const planId = await makePlan();
      await cell(planId, { day: 2, locKey: "LOBI", blockCode: "MORNING_BREAKS", teacher: "FX" });
      const r = await publish(planId);
      expect(r.status).toBe("rule_violation");
      expect((await client.query("select status from public.duty_plans where id=$1", [planId])).rows[0].status).toBe("draft");
    });

    it("v3 çok bloklu normal pakette reddedilir", async () => {
      // BEFORE trigger'ı v3 planda FULL_DAY yazımını zaten engeller (savunma
      // derinliği). Publish'in KENDİ kontrolünü sınamak için durum ESKİ (v2)
      // sürümde kurulur, sonra plan v3'e taşınır — tarihsel bir v2 planın v3
      // olarak yayımlanmaya çalışılması senaryosu.
      const planId = await makePlan("duty-plan-solver-v2");
      await client.query(
        `insert into public.duty_plan_assignment_packages
           (plan_id, campus_id, day_order, duty_location_id, teacher_source_id, teacher_name_snapshot, coverage_mode, assignment_kind)
         values ($1,$2,1,$3,'FREE','Ogretmen FREE','FULL_DAY','generated')`,
        [planId, campusId, loc.LOBI],
      );
      await client.query("update public.duty_plans set algorithm_version=$2 where id=$1", [planId, V3]);
      const r = await publish(planId);
      expect(r.status).toBe("rule_violation");
      expect((await client.query("select status from public.duty_plans where id=$1", [planId])).rows[0].status).toBe("draft");
    });

    it("ret ATOMİKTİR: önceki published plan DEĞİŞMEZ", async () => {
      const publishedId = await makePlan(V3, "draft");
      await client.query("update public.duty_plans set status='published' where id=$1", [publishedId]);
      const publishedHash = (await client.query("select md5(status || version::text || summary::text) as h from public.duty_plans where id=$1", [publishedId])).rows[0].h;

      const bad = await makePlan();
      await cell(bad, { day: 2, locKey: "LOBI", blockCode: "MORNING_BREAKS", teacher: "FX" });
      expect((await publish(bad)).status).toBe("rule_violation");

      const after = (await client.query("select md5(status || version::text || summary::text) as h from public.duty_plans where id=$1", [publishedId])).rows[0].h;
      expect(after).toBe(publishedHash);
    });

    it("geçerli tam v3 plan YAYIMLANABİLİR", async () => {
      const planId = await buildValidPlan();
      const r = await publish(planId);
      expect(r.status).toBe("ok");
      expect((await client.query("select status from public.duty_plans where id=$1", [planId])).rows[0].status).toBe("published");
    });
  });

  // =========================================================================
  // Fingerprint kapsamı
  // =========================================================================
  describe("fingerprint etkin girdi kapsamı", () => {
    it("DAHİL öğretmenin halfDayRuleEnabled değişikliği fingerprint'i DEĞİŞTİRİR", async () => {
      const before = await currentFingerprint();
      await client.query("update public.teacher_duty_settings set half_day_rule_enabled = not half_day_rule_enabled where id=$1", [settingId.HD1]);
      expect(await currentFingerprint()).not.toBe(before);
    });

    it("HARİÇ öğretmenin halfDayRuleEnabled değişikliği fingerprint'i DEĞİŞTİRMEZ", async () => {
      await client.query("update public.teacher_duty_settings set is_included=false where id=$1", [settingId.FREE]);
      const before = await currentFingerprint();
      await client.query("update public.teacher_duty_settings set half_day_rule_enabled = not half_day_rule_enabled where id=$1", [settingId.FREE]);
      expect(await currentFingerprint()).toBe(before);
    });

    it("HARİÇ öğretmen tekrar DAHİL edilince fingerprint değişir ve güncel yarım gün değeri etkili olur", async () => {
      await client.query("update public.teacher_duty_settings set is_included=false where id=$1", [settingId.FREE]);
      const excluded = await currentFingerprint();

      // Hariçken toggle değiştir — fingerprint sabit.
      await client.query("update public.teacher_duty_settings set half_day_rule_enabled=false where id=$1", [settingId.FREE]);
      expect(await currentFingerprint()).toBe(excluded);

      // Yeniden dahil et — fingerprint DEĞİŞİR.
      await client.query("update public.teacher_duty_settings set is_included=true where id=$1", [settingId.FREE]);
      const included = await currentFingerprint();
      expect(included).not.toBe(excluded);

      // Ve GÜNCEL yarım gün değeri artık etkili: geri çevirince yine değişir.
      await client.query("update public.teacher_duty_settings set half_day_rule_enabled=true where id=$1", [settingId.FREE]);
      expect(await currentFingerprint()).not.toBe(included);
    });
  });
});
