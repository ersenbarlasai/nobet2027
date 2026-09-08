import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * GERÇEK PostgreSQL testleri — 20260920090000 ile gelen RPC katmanı:
 * blok düzeyinde assignment_mode, halfDayRuleEnabled, matris v2, snapshot,
 * manuel atama ve publish doğrulamaları. Uzak projeye ASLA dokunulmaz.
 *
 *   DUTY_PLAN_PG_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
 *
 * Paylaşılan veritabanına bağlanan diğer pg süitleriyle birlikte
 * `--no-file-parallelism` ile SERİ çalıştırılmalıdır.
 */
const DB_URL = process.env.DUTY_PLAN_PG_TEST_DB_URL;
const enabled = Boolean(DB_URL);

describe.skipIf(!enabled)("yarım gün RPC katmanı — gerçek PostgreSQL", () => {
  let client: Client;
  let campusId: string;
  let campusName: string;
  let yearName: string;
  let yearId: string;
  let importId: string;
  const loc: Record<string, string> = {};
  const block: Record<string, string> = {};
  const teacher: Record<string, string> = {};

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

  beforeAll(async () => {
    client = new Client({ connectionString: DB_URL });
    await client.connect();
    await client.query("begin");

    campusName = `RPC Kampus ${sfx}`;
    yearName = `2026-2027 ${sfx}`;
    campusId = (await client.query("insert into public.campuses (name, code) values ($1,$2) returning id", [campusName, `R${sfx}`])).rows[0].id;
    yearId = (await client.query("insert into public.academic_years (campus_id, name) values ($1,$2) returning id", [campusId, yearName])).rows[0].id;
    importId = (
      await client.query(
        "insert into public.timetable_imports (campus_id, academic_year_id, source_format, source_filename, status, imported_at) values ($1,$2,'asc','f.xml','imported', now()) returning id",
        [campusId, yearId],
      )
    ).rows[0].id;

    // Zaman uygunluğu (komşu-periyot kuralı) için ders saatleri. Öğretmene
    // HİÇ ders yazılmaz ⇒ hedef ve komşu periyotlar boş ⇒ zaman kuralı geçer.
    // Böylece testler zaman kuralına değil, YENİ blok/yarım gün kurallarına odaklanır.
    const periods: [string, number][] = [
      ["4-OO", 4],
      ["5-OO", 5],
      ["5-IO", 6],
      ["6-IO", 7],
    ];
    for (const [name, order] of periods) {
      await client.query("insert into public.lesson_periods (timetable_import_id, source_id, name, period_order) values ($1,$2,$3,$4)", [importId, `p${order}`, name, order]);
    }

    for (let d = 1; d <= 5; d += 1) {
      await client.query("insert into public.timetable_days (timetable_import_id, source_id, name, day_order) values ($1,$2,$3,$4)", [importId, `d${d}`, `Gun ${d}`, d]);
    }
    for (const row of (await client.query("select code, id from public.duty_blocks")).rows as { code: string; id: string }[]) block[row.code] = row.id;

    for (const src of ["HD1", "HD0", "FX", "OTHER"]) {
      teacher[src] = (
        await client.query("insert into public.teachers (timetable_import_id, source_id, name) values ($1,$2,$3) returning id", [importId, src, `Ogretmen ${src}`])
      ).rows[0].id;
    }

    // İLKOKUL1 (karma: Sabah/ÖS fixed_only, Öğle Arası-1 normal) + iki normal yer.
    for (const [key, code] of [
      ["ILKOKUL1", "ILKOKUL1"],
      ["LOBI", `LOBI${sfx}`],
      ["BALKON", `BALKON${sfx}`],
    ] as const) {
      loc[key] = (
        await client.query("select (public.create_duty_location($1,$2,$3,'corridor',1,null,true)).id as id", [campusId, `${key} ${sfx}`, code.slice(0, 16)])
      ).rows[0].id;
    }

    for (const [src, halfDay] of [
      ["HD1", true],
      ["HD0", false],
      ["FX", true],
      ["OTHER", true],
    ] as const) {
      await client.query(
        `insert into public.teacher_duty_settings (campus_id, academic_year_id, teacher_source_id, teacher_name_snapshot, is_included, half_day_rule_enabled)
         values ($1,$2,$3,$4,true,$5)`,
        [campusId, yearId, src, `Ogretmen ${src}`, halfDay],
      );
    }

    // FX: gün 1'de İLKOKUL1'de sabit nöbet.
    await client.query(
      `insert into public.fixed_duty_assignments (campus_id, academic_year_id, teacher_source_id, teacher_name_snapshot, duty_location_id, day_order)
       values ($1,$2,'FX','Ogretmen FX',$3,1)`,
      [campusId, yearId, loc.ILKOKUL1],
    );
  }, 60000);

  afterAll(async () => {
    if (client) {
      await client.query("rollback");
      await client.end();
    }
  });

  // -------------------------------------------------------------------------
  // Uygunluk matrisi
  // -------------------------------------------------------------------------
  interface MatrixLocation {
    id: string;
    shortCode: string;
    blockPolicies: { dutyBlockId: string; blockCode: string; assignmentMode: string }[];
  }
  interface Matrix {
    hasImport: boolean;
    halfDayRuleEnabled: boolean;
    dutyLocations: MatrixLocation[];
    updatedAt: string | null;
    selectedBlockCells: { dutyLocationId: string; dayOrder: number; dutyBlockId: string }[];
  }

  async function matrix(src: string): Promise<Matrix> {
    return rpc<Matrix>("get_teacher_duty_matrix", { p_campus_name: campusName, p_academic_year_name: yearName, p_teacher_id: teacher[src] });
  }

  it("matris blockPolicies döner: İLKOKUL1 Sabah/ÖS fixed_only, Öğle Arası-1 normal, Öğle Arası-2 eşlemesiz", async () => {
    const m = await matrix("HD1");
    const ilkokul = m.dutyLocations.find((l) => l.id === loc.ILKOKUL1)!;
    const byCode = Object.fromEntries(ilkokul.blockPolicies.map((p) => [p.blockCode, p.assignmentMode]));
    expect(byCode).toEqual({ MORNING_BREAKS: "fixed_only", AFTERNOON_BREAKS: "fixed_only", LONG_BREAK_1: "normal" });
    // Eşlemesi olmayan blok listede HİÇ yer almaz ⇒ "nöbetçi gerekmiyor".
    expect(byCode.LONG_BREAK_2).toBeUndefined();
  });

  it("matris halfDayRuleEnabled döner (varsayılan açık, kapalı öğretmende false)", async () => {
    expect((await matrix("HD1")).halfDayRuleEnabled).toBe(true);
    expect((await matrix("HD0")).halfDayRuleEnabled).toBe(false);
  });

  it("İLKOKUL1 × Öğle Arası-1 tercih olarak SEÇİLEBİLİR, Sabah SEÇİLEMEZ", async () => {
    const m = await matrix("OTHER");
    const ok = await rpc<{ status: string }>("save_teacher_duty_matrix_v2", {
      p_campus_name: campusName,
      p_academic_year_name: yearName,
      p_teacher_id: teacher.OTHER,
      p_is_included: true,
      p_half_day_rule_enabled: null,
      p_cells: [{ duty_location_id: loc.ILKOKUL1, day_order: 2, duty_block_id: block.LONG_BREAK_1 }],
      p_expected_updated_at: m.updatedAt,
    });
    expect(ok.status).toBe("ok");

    const m2 = await matrix("OTHER");
    const bad = await rpc<{ status: string; reason: string }>("save_teacher_duty_matrix_v2", {
      p_campus_name: campusName,
      p_academic_year_name: yearName,
      p_teacher_id: teacher.OTHER,
      p_is_included: true,
      p_half_day_rule_enabled: null,
      p_cells: [{ duty_location_id: loc.ILKOKUL1, day_order: 2, duty_block_id: block.MORNING_BREAKS }],
      p_expected_updated_at: m2.updatedAt,
    });
    expect(bad).toMatchObject({ status: "invalid_cells", reason: "fixed_assignment_only_cell" });
  });

  it("halfDayRuleEnabled matris tercihleriyle AYNI çağrıda kaydedilir ve bayat updatedAt conflict verir", async () => {
    const m = await matrix("HD1");
    const saved = await rpc<{ status: string; halfDayRuleEnabled: boolean }>("save_teacher_duty_matrix_v2", {
      p_campus_name: campusName,
      p_academic_year_name: yearName,
      p_teacher_id: teacher.HD1,
      p_is_included: true,
      p_half_day_rule_enabled: false,
      p_cells: [{ duty_location_id: loc.LOBI, day_order: 3, duty_block_id: block.MORNING_BREAKS }],
      p_expected_updated_at: m.updatedAt,
    });
    expect(saved).toMatchObject({ status: "ok", halfDayRuleEnabled: false });
    expect((await matrix("HD1")).halfDayRuleEnabled).toBe(false);

    // Bayat updatedAt ⇒ hiçbir alan KISMİ yazılmadan conflict.
    // (Bütün süit TEK transaction içinde çalıştığı için now() sabittir ve
    // updated_at kendiliğinden ilerlemez — bu yüzden AÇIKÇA eski bir damga.)
    const stale = await rpc<{ status: string }>("save_teacher_duty_matrix_v2", {
      p_campus_name: campusName,
      p_academic_year_name: yearName,
      p_teacher_id: teacher.HD1,
      p_is_included: true,
      p_half_day_rule_enabled: true,
      p_cells: [],
      p_expected_updated_at: "2020-01-01T00:00:00.000Z",
    });
    expect(stale.status).toBe("conflict");
    expect((await matrix("HD1")).halfDayRuleEnabled).toBe(false);

    // Geri al (updatedAt sabit olduğu için m3 hâlâ geçerlidir).
    const m3 = await matrix("HD1");
    await rpc("save_teacher_duty_matrix_v2", {
      p_campus_name: campusName,
      p_academic_year_name: yearName,
      p_teacher_id: teacher.HD1,
      p_is_included: true,
      p_half_day_rule_enabled: true,
      p_cells: [{ duty_location_id: loc.LOBI, day_order: 3, duty_block_id: block.MORNING_BREAKS }],
      p_expected_updated_at: m3.updatedAt,
    });
    expect((await matrix("HD1")).halfDayRuleEnabled).toBe(true);
  });

  it("eski 6 parametreli sarmalayıcı half_day_rule_enabled'a DOKUNMAZ", async () => {
    const before = (await matrix("HD0")).halfDayRuleEnabled;
    const m = await matrix("HD0");
    const r = await rpc<{ status: string }>("save_teacher_duty_matrix", {
      p_campus_name: campusName,
      p_academic_year_name: yearName,
      p_teacher_id: teacher.HD0,
      p_is_included: true,
      p_cells: [],
      p_expected_updated_at: m.updatedAt,
    });
    expect(r.status).toBe("ok");
    expect((await matrix("HD0")).halfDayRuleEnabled).toBe(before);
    expect(before).toBe(false);
  });

  it("görünmeyen tarihsel tercih satırı fiziksel olarak KORUNUR ve matriste listelenmez", async () => {
    const setting = (await client.query("select id from public.teacher_duty_settings where academic_year_id=$1 and teacher_source_id='OTHER'", [yearId])).rows[0].id;
    // fixed_only hücreye ait TARİHSEL satır (kullanıcı bunu artık giremez).
    await client.query(
      `insert into public.teacher_duty_block_availabilities (campus_id, teacher_duty_setting_id, day_order, duty_location_id, duty_block_id)
       values ($1,$2,4,$3,$4)`,
      [campusId, setting, loc.ILKOKUL1, block.MORNING_BREAKS],
    );

    const m = await matrix("OTHER");
    expect(m.selectedBlockCells.some((c) => c.dutyBlockId === block.MORNING_BREAKS && c.dutyLocationId === loc.ILKOKUL1)).toBe(false);

    // Replace işlemi sonrası satır HÂLÂ tabloda.
    await rpc("save_teacher_duty_matrix_v2", {
      p_campus_name: campusName,
      p_academic_year_name: yearName,
      p_teacher_id: teacher.OTHER,
      p_is_included: true,
      p_half_day_rule_enabled: null,
      p_cells: [],
      p_expected_updated_at: m.updatedAt,
    });
    const kept = await client.query(
      "select count(*)::int as n from public.teacher_duty_block_availabilities where teacher_duty_setting_id=$1 and duty_block_id=$2 and duty_location_id=$3",
      [setting, block.MORNING_BREAKS, loc.ILKOKUL1],
    );
    expect(kept.rows[0].n).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------
  interface Snapshot {
    tasks: { dayOrder: number; dutyLocationId: string; dutyBlockId: string; blockCode: string; kind: string; fixedCoveredByTeacherSourceId: string | null }[];
    candidateEdges: { dayOrder: number; dutyLocationId: string; dutyBlockId: string; teacherSourceId: string }[];
    teachers: { teacherSourceId: string; halfDayRuleEnabled: boolean; maxDailyNormalBlocks: number }[];
    locations: { id: string; normalBlockCodes: string[]; fixedOnlyBlockCodes: string[] }[];
    sourceFingerprint: string;
  }
  const snapshot = () => rpc<Snapshot>("get_duty_plan_generation_snapshot", { p_campus_name: campusName, p_academic_year_name: yearName });

  it("snapshot: İLKOKUL1 Sabah/ÖS kind=fixed, Öğle Arası-1 kind=normal", async () => {
    const s = await snapshot();
    const day2 = s.tasks.filter((t) => t.dayOrder === 2 && t.dutyLocationId === loc.ILKOKUL1);
    const byCode = Object.fromEntries(day2.map((t) => [t.blockCode, t.kind]));
    expect(byCode).toEqual({ MORNING_BREAKS: "fixed", AFTERNOON_BREAKS: "fixed", LONG_BREAK_1: "normal" });
  });

  it("snapshot: sabit atama YALNIZ fixed_only blokları karşılar, normal bloğa yayılmaz", async () => {
    const s = await snapshot();
    const day1 = s.tasks.filter((t) => t.dayOrder === 1 && t.dutyLocationId === loc.ILKOKUL1);
    const covered = Object.fromEntries(day1.map((t) => [t.blockCode, t.fixedCoveredByTeacherSourceId]));
    expect(covered.MORNING_BREAKS).toBe("FX");
    expect(covered.AFTERNOON_BREAKS).toBe("FX");
    expect(covered.LONG_BREAK_1).toBeNull();
  });

  it("snapshot: İLKOKUL1 × Öğle Arası-1 NORMAL aday kenarı üretir, fixed_only bloklar üretmez", async () => {
    // Test BAĞIMSIZ olsun diye tercih burada kurulur (başka bir testin
    // bıraktığı duruma güvenilmez).
    const setting = (await client.query("select id from public.teacher_duty_settings where academic_year_id=$1 and teacher_source_id='OTHER'", [yearId])).rows[0].id;
    await client.query(
      `insert into public.teacher_duty_block_availabilities (campus_id, teacher_duty_setting_id, day_order, duty_location_id, duty_block_id)
       values ($1,$2,2,$3,$4) on conflict do nothing`,
      [campusId, setting, loc.ILKOKUL1, block.LONG_BREAK_1],
    );

    const s = await snapshot();
    const edges = s.candidateEdges.filter((e) => e.dutyLocationId === loc.ILKOKUL1);
    expect(edges.some((e) => e.dutyBlockId === block.LONG_BREAK_1 && e.teacherSourceId === "OTHER" && e.dayOrder === 2)).toBe(true);
    expect(edges.some((e) => e.dutyBlockId === block.MORNING_BREAKS)).toBe(false);
    expect(edges.some((e) => e.dutyBlockId === block.AFTERNOON_BREAKS)).toBe(false);
  });

  it("snapshot: sabit öğretmen o gün aday kenarı ÜRETMEZ, başka günlerde üretebilir", async () => {
    const setting = (await client.query("select id from public.teacher_duty_settings where academic_year_id=$1 and teacher_source_id='FX'", [yearId])).rows[0].id;
    await client.query(
      `insert into public.teacher_duty_block_availabilities (campus_id, teacher_duty_setting_id, day_order, duty_location_id, duty_block_id)
       values ($1,$2,1,$3,$4), ($1,$2,3,$3,$4)`,
      [campusId, setting, loc.LOBI, block.MORNING_BREAKS],
    );
    const s = await snapshot();
    const fx = s.candidateEdges.filter((e) => e.teacherSourceId === "FX");
    expect(fx.some((e) => e.dayOrder === 1)).toBe(false);
    expect(fx.some((e) => e.dayOrder === 3)).toBe(true);
  });

  it("snapshot: teachers[] halfDayRuleEnabled ve günlük kapasite taşır", async () => {
    const s = await snapshot();
    const hd1 = s.teachers.find((t) => t.teacherSourceId === "HD1")!;
    const hd0 = s.teachers.find((t) => t.teacherSourceId === "HD0")!;
    expect(hd1).toMatchObject({ halfDayRuleEnabled: true, maxDailyNormalBlocks: 1 });
    expect(hd0).toMatchObject({ halfDayRuleEnabled: false, maxDailyNormalBlocks: 4 });
  });

  it("snapshot: locations[] normal ve fixed_only blok kodlarını ayırır", async () => {
    const s = await snapshot();
    const ilkokul = s.locations.find((l) => l.id === loc.ILKOKUL1)!;
    expect(ilkokul.normalBlockCodes).toEqual(["LONG_BREAK_1"]);
    expect(ilkokul.fixedOnlyBlockCodes.slice().sort()).toEqual(["AFTERNOON_BREAKS", "MORNING_BREAKS"]);
  });

  // -------------------------------------------------------------------------
  // Fingerprint
  // -------------------------------------------------------------------------
  const fingerprint = () => rpc<string>("compute_duty_plan_source_fingerprint", { p_campus_name: campusName, p_academic_year_name: yearName });

  it("fingerprint half_day_rule_enabled değişince DEĞİŞİR", async () => {
    const before = await fingerprint();
    await client.query("update public.teacher_duty_settings set half_day_rule_enabled = not half_day_rule_enabled where academic_year_id=$1 and teacher_source_id='OTHER'", [yearId]);
    expect(await fingerprint()).not.toBe(before);
    await client.query("update public.teacher_duty_settings set half_day_rule_enabled = not half_day_rule_enabled where academic_year_id=$1 and teacher_source_id='OTHER'", [yearId]);
    expect(await fingerprint()).toBe(before);
  });

  it("fingerprint assignment_mode değişince DEĞİŞİR", async () => {
    const before = await fingerprint();
    await client.query("update public.duty_location_blocks set assignment_mode='fixed_only' where duty_location_id=$1 and duty_block_id=$2", [loc.LOBI, block.LONG_BREAK_2]);
    expect(await fingerprint()).not.toBe(before);
    await client.query("update public.duty_location_blocks set assignment_mode='normal' where duty_location_id=$1 and duty_block_id=$2", [loc.LOBI, block.LONG_BREAK_2]);
    expect(await fingerprint()).toBe(before);
  });

  it("fingerprint GÖRÜNMEYEN (fixed_only) tarihsel tercih satırından ETKİLENMEZ", async () => {
    const before = await fingerprint();
    const setting = (await client.query("select id from public.teacher_duty_settings where academic_year_id=$1 and teacher_source_id='HD1'", [yearId])).rows[0].id;
    await client.query(
      `insert into public.teacher_duty_block_availabilities (campus_id, teacher_duty_setting_id, day_order, duty_location_id, duty_block_id)
       values ($1,$2,5,$3,$4)`,
      [campusId, setting, loc.ILKOKUL1, block.AFTERNOON_BREAKS],
    );
    expect(await fingerprint()).toBe(before);
  });
});
