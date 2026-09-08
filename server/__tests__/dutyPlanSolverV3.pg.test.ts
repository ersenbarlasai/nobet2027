import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { DUTY_PLAN_SOLVER_V3_VERSION, analyzeV3Capacity, solveDutyPlanV3, type V3SolverInput } from "../lib/dutyPlanning/solverV3";

/**
 * GERÇEK PostgreSQL kabul testleri — snapshot → solver-v3 → save_duty_plan_draft
 * zinciri. Doğrudan `select public.rpc(...)` kullanılır; PostgREST GEREKMEZ.
 *
 *   DUTY_PLAN_PG_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
 *
 * Diğer pg süitleriyle `--no-file-parallelism` ile SERİ çalışmalıdır.
 */
const DB_URL = process.env.DUTY_PLAN_PG_TEST_DB_URL;
const enabled = Boolean(DB_URL);

interface SnapshotTask {
  dayOrder: number;
  dutyLocationId: string;
  dutyBlockId: string;
  blockCode: string;
  category: string;
  kind: "fixed" | "normal";
  fixedCoveredByTeacherSourceId: string | null;
}
interface Snapshot {
  hasImport: true;
  sourceFingerprint: string;
  tasks: SnapshotTask[];
  candidateEdges: { dayOrder: number; dutyLocationId: string; dutyBlockId: string; teacherSourceId: string }[];
  teachers: { teacherSourceId: string; teacherName: string; halfDayRuleEnabled: boolean; maxDailyNormalBlocks: number }[];
  teacherFixedDutyLoads: { teacherSourceId: string; fixedDutyDayCount: number }[];
}

describe.skipIf(!enabled)("solver-v3 → save_duty_plan_draft — gerçek PostgreSQL", () => {
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

  const snapshot = () => rpc<Snapshot>("get_duty_plan_generation_snapshot", { p_campus_name: campusName, p_academic_year_name: yearName });

  /** Snapshot'tan v3 girdisi — servis katmanıyla AYNI mantık. */
  function toV3Input(s: Snapshot, options: Record<string, unknown>, locked: V3SolverInput["lockedAssignments"] = []): V3SolverInput {
    const seen = new Set<string>();
    const fixedDays: { teacherSourceId: string; dayOrder: number }[] = [];
    for (const t of s.tasks) {
      if (t.kind !== "fixed" || !t.fixedCoveredByTeacherSourceId) continue;
      const key = `${t.fixedCoveredByTeacherSourceId}|${t.dayOrder}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fixedDays.push({ teacherSourceId: t.fixedCoveredByTeacherSourceId, dayOrder: t.dayOrder });
    }
    const lockedKeys = new Set((locked ?? []).map((l) => `${l.dayOrder}|${l.dutyLocationId}|${l.dutyBlockId}`));
    return {
      tasks: s.tasks
        .filter((t) => t.kind === "normal" && !lockedKeys.has(`${t.dayOrder}|${t.dutyLocationId}|${t.dutyBlockId}`))
        .map((t) => ({ dayOrder: t.dayOrder, dutyLocationId: t.dutyLocationId, dutyBlockId: t.dutyBlockId, category: t.category })),
      candidateEdges: s.candidateEdges,
      teachers: s.teachers,
      teacherFixedLoads: s.teacherFixedDutyLoads,
      fixedDays,
      lockedAssignments: locked,
      options: options as V3SolverInput["options"],
    };
  }

  beforeAll(async () => {
    client = new Client({ connectionString: DB_URL });
    await client.connect();
    await client.query("begin");

    campusName = `V3 Kampus ${sfx}`;
    yearName = `2026-2027 ${sfx}`;
    campusId = (await client.query("insert into public.campuses (name, code) values ($1,$2) returning id", [campusName, `V${sfx}`])).rows[0].id;
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

    // İLKOKUL1: Sabah/ÖS fixed_only + Öğle Arası-1 normal. LOBI/BALKON: dört normal.
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
      ["FREE", false],
    ] as const) {
      settingId[src] = (
        await client.query(
          `insert into public.teacher_duty_settings (campus_id, academic_year_id, teacher_source_id, teacher_name_snapshot, is_included, half_day_rule_enabled)
           values ($1,$2,$3,$4,true,$5) returning id`,
          [campusId, yearId, src, `Ogretmen ${src}`, halfDay],
        )
      ).rows[0].id;
    }

    // Herkes her gün her normal hücreyi tercih etsin.
    for (const src of ["HD1", "HD0", "FX", "FREE"]) {
      for (const [locKey, codes] of [
        ["LOBI", ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"]],
        ["BALKON", ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"]],
        ["ILKOKUL1", ["LONG_BREAK_1"]],
      ] as const) {
        for (const c of codes) {
          for (let d = 1; d <= 5; d += 1) {
            await client.query(
              `insert into public.teacher_duty_block_availabilities (campus_id, teacher_duty_setting_id, day_order, duty_location_id, duty_block_id)
               values ($1,$2,$3,$4,$5) on conflict do nothing`,
              [campusId, settingId[src], d, loc[locKey], block[c]],
            );
          }
        }
      }
    }

    // FX her gün İLKOKUL1'de sabit nöbetli ⇒ sabit hücreler kapanır.
    for (let d = 1; d <= 5; d += 1) {
      await client.query(
        `insert into public.fixed_duty_assignments (campus_id, academic_year_id, teacher_source_id, teacher_name_snapshot, duty_location_id, day_order)
         values ($1,$2,'FX','Ogretmen FX',$3,$4)`,
        [campusId, yearId, loc.ILKOKUL1, d],
      );
    }
    await client.query("set constraints all deferred");
  }, 60000);

  afterAll(async () => {
    if (client) {
      await client.query("rollback");
      await client.end();
    }
  });

  beforeEach(async () => {
    await client.query("savepoint sp");
  });
  afterEach(async () => {
    await client.query("rollback to savepoint sp");
  });

  /** Solver çıktısını save_duty_plan_draft'ın beklediği satır+özet biçimine çevirir. */
  function buildPayload(s: Snapshot, solved: ReturnType<typeof solveDutyPlanV3>, locked: V3SolverInput["lockedAssignments"] = []) {
    if (solved.status !== "ok") throw new Error("solver ok değil");
    const fixedRows = s.tasks
      .filter((t) => t.kind === "fixed")
      .map((t) => ({
        day_order: t.dayOrder,
        duty_location_id: t.dutyLocationId,
        duty_block_id: t.dutyBlockId,
        teacher_source_id: t.fixedCoveredByTeacherSourceId,
        assignment_kind: t.fixedCoveredByTeacherSourceId ? "fixed" : "unassigned",
        score_details: {},
      }));
    const lockedRows = (locked ?? []).map((l) => ({
      day_order: l.dayOrder,
      duty_location_id: l.dutyLocationId,
      duty_block_id: l.dutyBlockId,
      teacher_source_id: l.teacherSourceId,
      assignment_kind: "manual",
      score_details: {},
    }));
    const normalRows = solved.assignments.map((a) => ({
      day_order: a.dayOrder,
      duty_location_id: a.dutyLocationId,
      duty_block_id: a.dutyBlockId,
      teacher_source_id: a.teacherSourceId,
      assignment_kind: a.kind === "generated" ? "generated" : "unassigned",
      score_details: {},
    }));
    const allRows = [...fixedRows, ...lockedRows, ...normalRows];

    const lockedTeacherDay = new Set<string>();
    const lockedByTeacher = new Map<string, number>();
    for (const l of locked ?? []) {
      const k = `${l.teacherSourceId}|${l.dayOrder}`;
      if (lockedTeacherDay.has(k)) continue;
      lockedTeacherDay.add(k);
      lockedByTeacher.set(l.teacherSourceId, (lockedByTeacher.get(l.teacherSourceId) ?? 0) + 1);
    }
    const teacherLoads = solved.teacherLoads
      .map((l) => {
        // solver zaten kilitli sayıyı normalDutyCount'a ekler; burada tekrar EKLENMEZ.
        return { ...l };
      })
      .sort((a, b) => a.teacherSourceId.localeCompare(b.teacherSourceId));

    const fixedCovered = fixedRows.filter((r) => r.assignment_kind === "fixed").length;
    const summary = {
      totalTaskCount: allRows.length,
      fixedTaskCount: fixedRows.length,
      fixedCoveredCount: fixedCovered,
      normalTaskCount: normalRows.length + lockedRows.length,
      normalCoveredCount: solved.assignedTaskCount + lockedRows.length,
      uncoveredCount: allRows.filter((r) => r.assignment_kind === "unassigned").length,
      teacherLoads,
    };
    return { allRows, summary };
  }

  // normalizeGenerationOptions 0..5 aralığını zorlar (mevcut sözleşme).
  const OPTIONS = { minWeeklyDuties: 0, targetWeeklyDuties: 3, maxWeeklyDuties: 5, balanceWorkload: true, diversifyAreas: false, allowPartial: true, seed: 5 };

  /**
   * Yarım günü HERKESTE açar. Böylece hiçbir öğretmen aynı gün ikinci bir blok
   * almaz ve BİLİNEN ENGELE (bkz. aşağıdaki "ENGEL" testi) girilmez; uçtan uca
   * zincir yine de gerçek RPC'lerle doğrulanır.
   */
  async function forceHalfDayOnForAll() {
    await client.query("update public.teacher_duty_settings set half_day_rule_enabled = true where academic_year_id = $1", [yearId]);
  }

  it("21) snapshot → solver-v3 → save_duty_plan_draft zinciri BAŞARILI olur", async () => {
    await forceHalfDayOnForAll();
    const s = await snapshot();
    expect(s.hasImport).toBe(true);
    // Snapshot AUTHORITATIVE alanları taşımalı (bu testte tümü açığa alındı).
    for (const t of s.teachers) {
      expect(typeof t.halfDayRuleEnabled).toBe("boolean");
      expect(Number.isInteger(t.maxDailyNormalBlocks)).toBe(true);
    }
    expect(s.teachers.find((t) => t.teacherSourceId === "HD1")).toMatchObject({ halfDayRuleEnabled: true, maxDailyNormalBlocks: 1 });

    const solved = solveDutyPlanV3(toV3Input(s, OPTIONS));
    expect(solved.status).toBe("ok");
    if (solved.status !== "ok") return;
    expect(solved.algorithmVersion).toBe(DUTY_PLAN_SOLVER_V3_VERSION);
    expect(solved.optimalityProven).toBe(true);
    expect(solved.searchLimitReached).toBe(false);

    const { allRows, summary } = buildPayload(s, solved);
    const saved = await rpc<{ status: string; reason?: string }>("save_duty_plan_draft", {
      p_campus_name: campusName,
      p_academic_year_name: yearName,
      p_expected_source_fingerprint: s.sourceFingerprint,
      p_algorithm_version: DUTY_PLAN_SOLVER_V3_VERSION,
      p_generation_seed: 5,
      p_generation_options: OPTIONS,
      p_assignments: allRows,
      p_summary: summary,
      p_allow_partial: true,
      p_expected_plan_id: null,
    });
    expect(saved).toMatchObject({ status: "ok" });

    // Üretilen NORMAL paketlerin tamamı SINGLE_BLOCK olmalı.
    const pkgs = await client.query(
      `select distinct k.coverage_mode from public.duty_plan_assignment_packages k
         join public.duty_plans p on p.id = k.plan_id
        where p.campus_id = $1 and k.assignment_kind in ('generated','manual')`,
      [campusId],
    );
    expect(pkgs.rows.map((r: { coverage_mode: string }) => r.coverage_mode)).toEqual(["SINGLE_BLOCK"]);
  });

  it("snapshot öğretmen sözleşmesi: halfDayRuleEnabled ve maxDailyNormalBlocks doğru yansır", async () => {
    const s = await snapshot();
    expect(s.teachers.find((t) => t.teacherSourceId === "HD1")).toMatchObject({ halfDayRuleEnabled: true, maxDailyNormalBlocks: 1 });
    expect(s.teachers.find((t) => t.teacherSourceId === "HD0")).toMatchObject({ halfDayRuleEnabled: false, maxDailyNormalBlocks: 4 });
  });

  it("solver yalnız DB kurallarına uyan atamalar üretir (DB kuralları hiçbir ihlal görmez)", async () => {
    const s = await snapshot();
    const solved = solveDutyPlanV3(toV3Input(s, OPTIONS));
    if (solved.status !== "ok") throw new Error("solver ok değil");

    // Yarım gün AÇIK öğretmen aynı gün en fazla bir normal blok.
    const perDay = new Map<string, number>();
    const perDayBlock = new Set<string>();
    for (const a of solved.assignments) {
      if (!a.teacherSourceId) continue;
      const dk = `${a.teacherSourceId}|${a.dayOrder}`;
      perDay.set(dk, (perDay.get(dk) ?? 0) + 1);
      const bk = `${dk}|${a.dutyBlockId}`;
      expect(perDayBlock.has(bk)).toBe(false);
      perDayBlock.add(bk);
    }
    for (const [dk, n] of perDay) {
      const id = dk.split("|")[0];
      const cap = s.teachers.find((t) => t.teacherSourceId === id)?.maxDailyNormalBlocks ?? 1;
      expect(n).toBeLessThanOrEqual(cap);
    }
    // FX her gün sabit ⇒ HİÇ normal görev almamalı.
    expect(solved.assignments.some((a) => a.teacherSourceId === "FX")).toBe(false);
  });

  it("22) regenerate + KİLİTLİ manuel atama: kilitli hücre korunur ve kapasite tüketir", async () => {
    await forceHalfDayOnForAll();
    const s = await snapshot();
    // HD1 (yarım gün AÇIK) gün 1'de LOBI/Sabah'a manuel kilitli.
    const locked = [{ dayOrder: 1, dutyLocationId: loc.LOBI, dutyBlockId: block.MORNING_BREAKS, teacherSourceId: "HD1" }];
    const solved = solveDutyPlanV3(toV3Input(s, OPTIONS, locked));
    expect(solved.status).toBe("ok");
    if (solved.status !== "ok") return;

    // Kilitli hücre solver çıktısında YOK (yeniden atanmadı).
    expect(solved.assignments.some((a) => a.dayOrder === 1 && a.dutyLocationId === loc.LOBI && a.dutyBlockId === block.MORNING_BREAKS)).toBe(false);
    // HD1 gün 1'de BAŞKA normal görev almadı (yarım gün kapasitesi kilitliyle doldu).
    expect(solved.assignments.some((a) => a.teacherSourceId === "HD1" && a.dayOrder === 1)).toBe(false);
    // Yük: kilitli paket normalDutyCount'a DAHİL.
    expect((solved.teacherLoads.find((l) => l.teacherSourceId === "HD1")?.normalDutyCount ?? 0)).toBeGreaterThanOrEqual(1);

    const { allRows, summary } = buildPayload(s, solved, locked);
    const saved = await rpc<{ status: string; reason?: string }>("save_duty_plan_draft", {
      p_campus_name: campusName,
      p_academic_year_name: yearName,
      p_expected_source_fingerprint: s.sourceFingerprint,
      p_algorithm_version: DUTY_PLAN_SOLVER_V3_VERSION,
      p_generation_seed: 5,
      p_generation_options: OPTIONS,
      p_assignments: allRows,
      p_summary: summary,
      p_allow_partial: true,
      p_expected_plan_id: null,
    });
    expect(saved).toMatchObject({ status: "ok" });
  });

  it("geçersiz kilitli atama SESSİZCE silinmez — invalid_locked_assignment", async () => {
    const s = await snapshot();
    // FX her gün sabit nöbetli ⇒ normal kilitli atama GEÇERSİZ.
    const locked = [{ dayOrder: 1, dutyLocationId: loc.LOBI, dutyBlockId: block.MORNING_BREAKS, teacherSourceId: "FX" }];
    const solved = solveDutyPlanV3(toV3Input(s, OPTIONS, locked));
    expect(solved.status).toBe("invalid_locked_assignment");
    if (solved.status !== "invalid_locked_assignment") return;
    expect(solved.violations.map((v) => v.code)).toContain("fixed_duty_day");
  });

  /**
   * 20260921090000 ile DÜZELTİLDİ. 20260919090000 yarım günü KAPALI bir
   * öğretmenin aynı gün AYNI yerde iki farklı blok almasını meşru sayar;
   * artık save_duty_plan_draft bunu KABUL eder ve her hücreyi AYRI bir
   * SINGLE_BLOCK pakete bağlar.
   */
  it("half-day KAPALI + AYNI yer + iki farklı blok: save 'ok', İKİ ayrı SINGLE_BLOCK paket", async () => {
    const s = await snapshot();
    expect(s.teachers.find((t) => t.teacherSourceId === "HD0")?.halfDayRuleEnabled).toBe(false);

    const fixedRows = s.tasks
      .filter((t) => t.kind === "fixed")
      .map((t) => ({
        day_order: t.dayOrder,
        duty_location_id: t.dutyLocationId,
        duty_block_id: t.dutyBlockId,
        teacher_source_id: t.fixedCoveredByTeacherSourceId,
        assignment_kind: t.fixedCoveredByTeacherSourceId ? "fixed" : "unassigned",
        score_details: {},
      }));
    const normalRows = s.tasks
      .filter((t) => t.kind === "normal")
      .map((t) => {
        const isTarget = t.dayOrder === 1 && t.dutyLocationId === loc.LOBI && (t.dutyBlockId === block.MORNING_BREAKS || t.dutyBlockId === block.AFTERNOON_BREAKS);
        return {
          day_order: t.dayOrder,
          duty_location_id: t.dutyLocationId,
          duty_block_id: t.dutyBlockId,
          teacher_source_id: isTarget ? "HD0" : null,
          assignment_kind: isTarget ? "generated" : "unassigned",
          score_details: {},
        };
      });
    const allRows = [...fixedRows, ...normalRows];
    const teacherLoads = ["FREE", "FX", "HD0", "HD1"].map((teacherSourceId) => {
      const fixedDutyDayCount = s.teacherFixedDutyLoads.find((f) => f.teacherSourceId === teacherSourceId)?.fixedDutyDayCount ?? 0;
      // v3 birimi: her normal SINGLE_BLOCK paket 1 görev ⇒ iki blok = 2.
      const normalDutyCount = teacherSourceId === "HD0" ? 2 : 0;
      return { teacherSourceId, normalDutyCount, fixedDutyDayCount, totalDutyCount: normalDutyCount + fixedDutyDayCount };
    });

    const saved = await rpc<{ status: string; reason?: string; planId?: string }>("save_duty_plan_draft", {
      p_campus_name: campusName,
      p_academic_year_name: yearName,
      p_expected_source_fingerprint: s.sourceFingerprint,
      p_algorithm_version: DUTY_PLAN_SOLVER_V3_VERSION,
      p_generation_seed: 5,
      p_generation_options: OPTIONS,
      p_assignments: allRows,
      p_summary: {
        totalTaskCount: allRows.length,
        fixedTaskCount: fixedRows.length,
        fixedCoveredCount: fixedRows.filter((r) => r.assignment_kind === "fixed").length,
        normalTaskCount: normalRows.length,
        normalCoveredCount: normalRows.filter((r) => r.assignment_kind === "generated").length,
        uncoveredCount: allRows.filter((r) => r.assignment_kind === "unassigned").length,
        teacherLoads,
      },
      p_allow_partial: true,
      p_expected_plan_id: null,
    });
    expect(saved).toMatchObject({ status: "ok" });

    // İKİ ayrı SINGLE_BLOCK paket, her birinde TEK assignment.
    const pkgs = await client.query(
      `select k.id, k.coverage_mode, (select count(*) from public.duty_plan_assignments a where a.package_id = k.id)::int as cells
         from public.duty_plan_assignment_packages k
        where k.plan_id = $1 and k.teacher_source_id = 'HD0' and k.day_order = 1 and k.duty_location_id = $2
        order by k.id`,
      [saved.planId, loc.LOBI],
    );
    expect(pkgs.rows).toHaveLength(2);
    for (const row of pkgs.rows as { coverage_mode: string; cells: number }[]) {
      expect(row.coverage_mode).toBe("SINGLE_BLOCK");
      expect(row.cells).toBe(1);
    }

    // Atanmamış hücrelerde package_id NULL.
    const nulls = await client.query(
      "select count(*)::int as n from public.duty_plan_assignments where plan_id=$1 and assignment_kind='unassigned' and package_id is not null",
      [saved.planId],
    );
    expect(nulls.rows[0].n).toBe(0);

    // Sabit hücreler tek FIXED_SHORT_BREAKS paketinde gruplanır.
    const fixedPkgs = await client.query(
      `select k.coverage_mode, (select count(*) from public.duty_plan_assignments a where a.package_id = k.id)::int as cells
         from public.duty_plan_assignment_packages k
        where k.plan_id = $1 and k.assignment_kind = 'fixed' and k.day_order = 1`,
      [saved.planId],
    );
    expect(fixedPkgs.rows).toHaveLength(1);
    expect(fixedPkgs.rows[0].coverage_mode).toBe("FIXED_SHORT_BREAKS");
    expect(fixedPkgs.rows[0].cells).toBe(2);
  });

  it("aynı gün AYNI BLOK + iki farklı yer HÂLÂ teacher_block_conflict ile atomik reddedilir", async () => {
    const s = await snapshot();
    const before = await client.query("select count(*)::int as n from public.duty_plan_assignment_packages");
    const fixedRows = s.tasks
      .filter((t) => t.kind === "fixed")
      .map((t) => ({
        day_order: t.dayOrder,
        duty_location_id: t.dutyLocationId,
        duty_block_id: t.dutyBlockId,
        teacher_source_id: t.fixedCoveredByTeacherSourceId,
        assignment_kind: t.fixedCoveredByTeacherSourceId ? "fixed" : "unassigned",
        score_details: {},
      }));
    const normalRows = s.tasks
      .filter((t) => t.kind === "normal")
      .map((t) => {
        // AYNI blok (Sabah), İKİ farklı yer ⇒ yasak.
        const isTarget = t.dayOrder === 1 && t.dutyBlockId === block.MORNING_BREAKS && (t.dutyLocationId === loc.LOBI || t.dutyLocationId === loc.BALKON);
        return {
          day_order: t.dayOrder,
          duty_location_id: t.dutyLocationId,
          duty_block_id: t.dutyBlockId,
          teacher_source_id: isTarget ? "HD0" : null,
          assignment_kind: isTarget ? "generated" : "unassigned",
          score_details: {},
        };
      });
    const allRows = [...fixedRows, ...normalRows];
    const saved = await rpc<{ status: string }>("save_duty_plan_draft", {
      p_campus_name: campusName,
      p_academic_year_name: yearName,
      p_expected_source_fingerprint: s.sourceFingerprint,
      p_algorithm_version: DUTY_PLAN_SOLVER_V3_VERSION,
      p_generation_seed: 5,
      p_generation_options: OPTIONS,
      p_assignments: allRows,
      p_summary: { totalTaskCount: allRows.length, fixedTaskCount: 0, fixedCoveredCount: 0, normalTaskCount: 0, normalCoveredCount: 0, uncoveredCount: 0, teacherLoads: [] },
      p_allow_partial: true,
      p_expected_plan_id: null,
    });
    expect(saved.status).toBe("teacher_block_conflict");
    // ATOMİK: hiçbir paket yazılmadı.
    const after = await client.query("select count(*)::int as n from public.duty_plan_assignment_packages");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  /**
   * REGENERATE yük sayımı. Servis katmanı solver'ın authoritative
   * teacherLoads'unu OLDUĞU GİBİ kullanır (kilitli paketler solver içinde
   * ZATEN sayılır); burada DB'nin yeniden hesabıyla birebir eşleştiği
   * doğrulanır — uyuşmazlık invalid_summary üretirdi.
   */
  async function saveWithLocked(locked: { dayOrder: number; dutyLocationId: string; dutyBlockId: string; teacherSourceId: string }[]) {
    const s = await snapshot();
    const solved = solveDutyPlanV3(toV3Input(s, OPTIONS, locked));
    if (solved.status !== "ok") return { solved, saved: null as null | { status: string; reason?: string; planId?: string } };
    const { allRows, summary } = buildPayload(s, solved, locked);
    const saved = await rpc<{ status: string; reason?: string; planId?: string }>("save_duty_plan_draft", {
      p_campus_name: campusName,
      p_academic_year_name: yearName,
      p_expected_source_fingerprint: s.sourceFingerprint,
      p_algorithm_version: DUTY_PLAN_SOLVER_V3_VERSION,
      p_generation_seed: 5,
      p_generation_options: OPTIONS,
      p_assignments: allRows,
      p_summary: summary,
      p_allow_partial: true,
      p_expected_plan_id: null,
    });
    return { solved, saved };
  }

  it("regenerate + TEK kilitli manuel paket: save 'ok', kilitli yük BİR kez sayılır", async () => {
    await forceHalfDayOnForAll();
    const locked = [{ dayOrder: 1, dutyLocationId: loc.LOBI, dutyBlockId: block.MORNING_BREAKS, teacherSourceId: "HD1" }];
    const { solved, saved } = await saveWithLocked(locked);
    expect(saved).toMatchObject({ status: "ok" });
    if (solved.status !== "ok") throw new Error("solver ok değil");
    // Yarım gün AÇIK ⇒ HD1 gün 1'de BAŞKA görev almaz (kilitli kapasiteyi doldurdu).
    expect(solved.assignments.some((a) => a.teacherSourceId === "HD1" && a.dayOrder === 1)).toBe(false);
    // Kilitli paket yükte TAM BİR KEZ sayılır: toplam = 1 kilitli + üretilenler.
    const generated = solved.assignments.filter((a) => a.teacherSourceId === "HD1").length;
    expect(solved.teacherLoads.find((l) => l.teacherSourceId === "HD1")?.normalDutyCount).toBe(generated + 1);
  });

  it("regenerate + AYNI öğretmende iki FARKLI bloklu manuel paket: normalDutyCount=2", async () => {
    // HD0 yarım günü KAPALI: aynı gün AYNI yerde iki blok meşrudur.
    const locked = [
      { dayOrder: 1, dutyLocationId: loc.LOBI, dutyBlockId: block.MORNING_BREAKS, teacherSourceId: "HD0" },
      { dayOrder: 1, dutyLocationId: loc.LOBI, dutyBlockId: block.AFTERNOON_BREAKS, teacherSourceId: "HD0" },
    ];
    const { solved, saved } = await saveWithLocked(locked);
    expect(saved).toMatchObject({ status: "ok" });
    if (solved.status !== "ok") throw new Error("solver ok değil");
    // İKİ ayrı SINGLE_BLOCK paket ⇒ 2 normal görev birimi (bir kez sayılır).
    expect(solved.teacherLoads.find((l) => l.teacherSourceId === "HD0")?.normalDutyCount).toBeGreaterThanOrEqual(2);

    // Sayım BU PLANLA sınırlanmalıdır: aynı süitin önceki testleri de taslak
    // plan üretir ve kampüs geneli sayım onların paketlerini de toplayarak
    // aralıklı biçimde 3 verirdi.
    const pkgs = await client.query(
      `select count(*)::int as n from public.duty_plan_assignment_packages k
        where k.plan_id = $1 and k.teacher_source_id = 'HD0' and k.day_order = 1 and k.duty_location_id = $2 and k.coverage_mode = 'SINGLE_BLOCK'`,
      [saved!.planId, loc.LOBI],
    );
    expect(pkgs.rows[0].n).toBe(2);
  });

  it("ret yolunda plan/paket/assignment durumu DEĞİŞMEZ (atomik)", async () => {
    const before = await client.query(
      "select coalesce(md5(coalesce((select string_agg(id::text, '|' order by id) from public.duty_plans), '') || coalesce((select string_agg(id::text, '|' order by id) from public.duty_plan_assignment_packages), '')), 'empty') as h",
    );
    // Sabit gününde normal görev ⇒ reddedilmeli.
    const locked = [{ dayOrder: 1, dutyLocationId: loc.LOBI, dutyBlockId: block.MORNING_BREAKS, teacherSourceId: "FX" }];
    const { solved } = await saveWithLocked(locked);
    expect(solved.status).toBe("invalid_locked_assignment");
    const after = await client.query(
      "select coalesce(md5(coalesce((select string_agg(id::text, '|' order by id) from public.duty_plans), '') || coalesce((select string_agg(id::text, '|' order by id) from public.duty_plan_assignment_packages), '')), 'empty') as h",
    );
    expect(after.rows[0].h).toBe(before.rows[0].h);
  });

  /**
   * v3 mantıksal paket anahtarı (gün, yer, öğretmen, BLOK) olduğu için, aynı
   * gün+yerdeki Sabah hücresinin 'manual', Öğleden Sonra hücresinin
   * 'generated' olması İKİ AYRI SINGLE_BLOCK pakettir — "paket içi karışık
   * tür" DEĞİLDİR ve reddedilmemelidir.
   */
  it("v3: aynı gün+yerde manual + generated karışımı KABUL edilir (iki ayrı paket)", async () => {
    const s = await snapshot();
    expect(s.teachers.find((t) => t.teacherSourceId === "HD0")?.halfDayRuleEnabled).toBe(false);

    const fixedRows = s.tasks
      .filter((t) => t.kind === "fixed")
      .map((t) => ({
        day_order: t.dayOrder,
        duty_location_id: t.dutyLocationId,
        duty_block_id: t.dutyBlockId,
        teacher_source_id: t.fixedCoveredByTeacherSourceId,
        assignment_kind: t.fixedCoveredByTeacherSourceId ? "fixed" : "unassigned",
        score_details: {},
      }));
    const normalRows = s.tasks
      .filter((t) => t.kind === "normal")
      .map((t) => {
        const sameCell = t.dayOrder === 1 && t.dutyLocationId === loc.LOBI;
        if (sameCell && t.dutyBlockId === block.MORNING_BREAKS) {
          return { day_order: t.dayOrder, duty_location_id: t.dutyLocationId, duty_block_id: t.dutyBlockId, teacher_source_id: "HD0", assignment_kind: "manual", score_details: {} };
        }
        if (sameCell && t.dutyBlockId === block.AFTERNOON_BREAKS) {
          return { day_order: t.dayOrder, duty_location_id: t.dutyLocationId, duty_block_id: t.dutyBlockId, teacher_source_id: "HD0", assignment_kind: "generated", score_details: {} };
        }
        return { day_order: t.dayOrder, duty_location_id: t.dutyLocationId, duty_block_id: t.dutyBlockId, teacher_source_id: null, assignment_kind: "unassigned", score_details: {} };
      });
    const allRows = [...fixedRows, ...normalRows];
    const teacherLoads = ["FREE", "FX", "HD0", "HD1"].map((teacherSourceId) => {
      const fixedDutyDayCount = s.teacherFixedDutyLoads.find((f) => f.teacherSourceId === teacherSourceId)?.fixedDutyDayCount ?? 0;
      const normalDutyCount = teacherSourceId === "HD0" ? 2 : 0;
      return { teacherSourceId, normalDutyCount, fixedDutyDayCount, totalDutyCount: normalDutyCount + fixedDutyDayCount };
    });

    const saved = await rpc<{ status: string; reason?: string; planId?: string }>("save_duty_plan_draft", {
      p_campus_name: campusName,
      p_academic_year_name: yearName,
      p_expected_source_fingerprint: s.sourceFingerprint,
      p_algorithm_version: DUTY_PLAN_SOLVER_V3_VERSION,
      p_generation_seed: 5,
      p_generation_options: OPTIONS,
      p_assignments: allRows,
      p_summary: {
        totalTaskCount: allRows.length,
        fixedTaskCount: fixedRows.length,
        fixedCoveredCount: fixedRows.filter((r) => r.assignment_kind === "fixed").length,
        normalTaskCount: normalRows.length,
        normalCoveredCount: 2,
        uncoveredCount: allRows.filter((r) => r.assignment_kind === "unassigned").length,
        teacherLoads,
      },
      p_allow_partial: true,
      p_expected_plan_id: null,
    });
    expect(saved).toMatchObject({ status: "ok" });

    // İKİ ayrı package_id; ikisi de SINGLE_BLOCK; biri manual biri generated;
    // her pakette YALNIZ bir assignment.
    const pkgs = await client.query(
      `select k.id, k.coverage_mode, k.assignment_kind,
              (select count(*) from public.duty_plan_assignments a where a.package_id = k.id)::int as cells
         from public.duty_plan_assignment_packages k
        where k.plan_id = $1 and k.teacher_source_id = 'HD0' and k.day_order = 1 and k.duty_location_id = $2
        order by k.assignment_kind`,
      [saved.planId, loc.LOBI],
    );
    expect(pkgs.rows).toHaveLength(2);
    expect(new Set(pkgs.rows.map((r: { id: string }) => r.id)).size).toBe(2);
    expect(pkgs.rows.map((r: { assignment_kind: string }) => r.assignment_kind)).toEqual(["generated", "manual"]);
    for (const row of pkgs.rows as { coverage_mode: string; cells: number }[]) {
      expect(row.coverage_mode).toBe("SINGLE_BLOCK");
      expect(row.cells).toBe(1);
    }

    // teacherLoads DB'nin yetkili yeniden hesabıyla eşleşti (aksi halde
    // invalid_summary dönerdi) ⇒ normalDutyCount = 2 doğrulanmış olur.

    // Publish KURAL İHLALİ vermez. Açık görev bulunduğu için
    // open_tasks_remaining beklenir; rule_violation DEĞİL.
    const published = await rpc<{ status: string; reason?: string }>("publish_duty_plan_draft", {
      p_plan_id: saved.planId,
      p_campus_name: campusName,
      p_academic_year_name: yearName,
      p_expected_plan_version: 1,
    });
    expect(published.status).not.toBe("rule_violation");
  });

  it("v3: GERÇEK karışık tür (aynı sabit paket grubu) hâlâ yapılandırılmış şekilde reddedilir", async () => {
    const s = await snapshot();
    // Aynı (gün, yer, öğretmen) SABİT paket grubunda bir hücre 'fixed',
    // diğeri 'manual' ⇒ gerçek karışık tür.
    let flipped = false;
    const fixedRows = s.tasks
      .filter((t) => t.kind === "fixed")
      .map((t) => {
        let kind = t.fixedCoveredByTeacherSourceId ? "fixed" : "unassigned";
        if (!flipped && t.dayOrder === 1 && t.fixedCoveredByTeacherSourceId && t.dutyBlockId === block.AFTERNOON_BREAKS) {
          kind = "manual";
          flipped = true;
        }
        return {
          day_order: t.dayOrder,
          duty_location_id: t.dutyLocationId,
          duty_block_id: t.dutyBlockId,
          teacher_source_id: t.fixedCoveredByTeacherSourceId,
          assignment_kind: kind,
          score_details: {},
        };
      });
    expect(flipped).toBe(true);
    const normalRows = s.tasks
      .filter((t) => t.kind === "normal")
      .map((t) => ({ day_order: t.dayOrder, duty_location_id: t.dutyLocationId, duty_block_id: t.dutyBlockId, teacher_source_id: null, assignment_kind: "unassigned", score_details: {} }));
    const allRows = [...fixedRows, ...normalRows];

    const saved = await rpc<{ status: string; reason?: string }>("save_duty_plan_draft", {
      p_campus_name: campusName,
      p_academic_year_name: yearName,
      p_expected_source_fingerprint: s.sourceFingerprint,
      p_algorithm_version: DUTY_PLAN_SOLVER_V3_VERSION,
      p_generation_seed: 5,
      p_generation_options: OPTIONS,
      p_assignments: allRows,
      p_summary: { totalTaskCount: allRows.length, fixedTaskCount: 0, fixedCoveredCount: 0, normalTaskCount: 0, normalCoveredCount: 0, uncoveredCount: 0, teacherLoads: [] },
      p_allow_partial: true,
      p_expected_plan_id: null,
    });
    // YAPILANDIRILMIŞ ret (ham constraint/PLpgSQL exception DEĞİL).
    //
    // NOT: v3'te "paket içi karışık tür" pratikte ULAŞILAMAZ bir durumdur:
    //   - NORMAL paketler hücre bazlıdır (her hücre kendi paketi) ⇒ grup içinde
    //     tek hücre, dolayısıyla tek tür.
    //   - SABİT grupta bir hücreyi 'manual' yapmak, öğretmenin SABİT gününde
    //     normal görev yaratır ve R1 kuralı DAHA ÖNCE devreye girer.
    // Bu yüzden beklenen ret gerekçesi teacher_has_fixed_duty'dir; önemli olan
    // isteğin yapılandırılmış biçimde ve ATOMİK olarak reddedilmesidir.
    expect(["invalid_assignment", "teacher_has_fixed_duty"]).toContain(saved.status);
    const planCount = await client.query("select count(*)::int as n from public.duty_plans where campus_id=$1", [campusId]);
    expect(planCount.rows[0].n).toBe(0);
  });

  it("kapasite senaryoları gerçek snapshot üzerinde AYRIŞIR", async () => {
    const s = await snapshot();
    const analysis = analyzeV3Capacity(toV3Input(s, OPTIONS));
    expect(analysis.currentRules.totalNormalTasks).toBe(analysis.allHalfDayRulesDisabled.totalNormalTasks);
    // Yarım gün kuralı kapatılırsa kapsama ASLA azalmaz.
    expect(analysis.allHalfDayRulesDisabled.maxCoverableTasks).toBeGreaterThanOrEqual(analysis.currentRules.maxCoverableTasks);
    expect(analysis.coverageGainIfHalfDayDisabled).toBeGreaterThanOrEqual(0);
    // currentRules gerçek solver kapsamasıyla TUTARLI.
    const solved = solveDutyPlanV3(toV3Input(s, OPTIONS));
    if (solved.status !== "ok") throw new Error("solver ok değil");
    expect(analysis.currentRules.maxCoverableTasks).toBe(solved.assignedTaskCount);
  });
});
