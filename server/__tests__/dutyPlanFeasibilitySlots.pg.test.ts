import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * GERÇEK PostgreSQL testleri — 20260922090000 ile gelen KAPASİTE SLOTU modeli.
 *
 * analyze_duty_plan_feasibility'nin günlük maksimum eşleştirmesi artık sağ
 * tarafta öğretmen değil SLOT kullanır:
 *   half_day_rule_enabled = true  → öğretmene günde TEK ortak slot
 *   half_day_rule_enabled = false → öğretmen × duty_block_id başına bir slot
 *
 * Uzak projeye ASLA dokunulmaz; yalnız yerel PostgreSQL kullanılır.
 *
 *   DUTY_PLAN_PG_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/feas22
 *
 * Tüm süit TEK transaction içinde çalışır ve sonunda rollback edilir. Testler
 * fixture'ı (tercihler, sabit nöbetler, ders kayıtları) aralarında değiştirir;
 * analiz SALT OKUNUR olduğu için bu güvenlidir.
 */
const DB_URL = process.env.DUTY_PLAN_PG_TEST_DB_URL;
const enabled = Boolean(DB_URL);

interface BlockSummary {
  blockId: string;
  blockCode: string;
  required: number;
  fixedRequired: number;
  fixedCovered: number;
  fixedMissing: number;
  normalRequired: number;
  matchingUncovered: number;
  candidateTeacherCount: number;
}
interface DayTotals {
  requiredTasks: number;
  coveredTasks: number;
  uncoveredTasks: number;
  fixedRequired: number;
  fixedCovered: number;
  fixedMissing: number;
  normalRequired: number;
  normalMatched: number;
  normalUncovered: number;
  candidateTeacherCount: number;
}
interface ExcludedEntry {
  blockId: string;
  blockCode: string;
  periodName: string;
  teacherCount: number;
}
interface FeasDay {
  order: number;
  totals: DayTotals;
  blocks: BlockSummary[];
  uncoveredTasks: { dutyLocationId: string; blockId: string; kind: string; reason: string; candidateCount: number | null }[];
  missingFixedAssignments: { dutyLocationId: string; blockCodes: string[] }[];
  excludedByLessonConflict: ExcludedEntry[];
  excludedByConfigurationError: ExcludedEntry[];
}
interface FeasResponse {
  hasImport: boolean;
  days: FeasDay[];
  summary: { totalRequiredTasks: number; totalCoveredTasks: number; totalUncoveredTasks: number; feasible: boolean };
}

describe.skipIf(!enabled)("planlanabilirlik kapasite slotu modeli — gerçek PostgreSQL", () => {
  let client: Client;
  let campusId: string;
  let campusName: string;
  let yearName: string;
  let yearId: string;
  let importId: string;
  /** Nöbet yerleri: FL1 dört blok normal, FL2 yalnız Sabah, FL3 karma politika. */
  const loc: Record<string, string> = {};
  const block: Record<string, string> = {};
  const teacher: Record<string, string> = {};
  const settingId: Record<string, string> = {};

  const sfx = Math.random().toString(36).slice(2, 7).toUpperCase();

  async function analyze(): Promise<FeasResponse> {
    const res = await client.query("select public.analyze_duty_plan_feasibility($1, $2) as r", [campusName, yearName]);
    return res.rows[0].r as FeasResponse;
  }

  /** Gün 1 analizini döner — tüm senaryolar gün 1 üzerinde kurulur. */
  async function day1(): Promise<FeasDay> {
    const r = await analyze();
    expect(r.hasImport).toBe(true);
    return r.days.find((d) => d.order === 1)!;
  }

  function blockOf(day: FeasDay, code: string): BlockSummary {
    return day.blocks.find((b) => b.blockCode === code)!;
  }

  /** Tüm tercihleri ve sabit nöbetleri siler — her senaryo temiz başlar. */
  async function resetFixture(): Promise<void> {
    await client.query("delete from public.teacher_duty_block_availabilities where teacher_duty_setting_id = any($1::uuid[])", [Object.values(settingId)]);
    await client.query("delete from public.fixed_duty_assignments where academic_year_id = $1", [yearId]);
    await client.query("delete from public.timetable_assignments where timetable_import_id = $1", [importId]);
  }

  async function setHalfDay(src: string, enabledFlag: boolean): Promise<void> {
    await client.query("update public.teacher_duty_settings set half_day_rule_enabled = $3 where academic_year_id = $1 and teacher_source_id = $2", [yearId, src, enabledFlag]);
  }

  /** Gün 1 için tercih satırı ekler. */
  async function pref(src: string, locKey: string, blockCode: string, dayOrder = 1): Promise<void> {
    await client.query(
      `insert into public.teacher_duty_block_availabilities (campus_id, teacher_duty_setting_id, duty_location_id, duty_block_id, day_order)
       values ($1,$2,$3,$4,$5)`,
      [campusId, settingId[src], loc[locKey], block[blockCode], dayOrder],
    );
  }

  /** Öğretmene belirli gün+periyotta ders yazar (zaman kuralı senaryoları için). */
  let lessonSeq = 0;
  async function addLesson(src: string, periodName: string, dayOrder: number): Promise<void> {
    lessonSeq += 1;
    const periodId = (await client.query("select id from public.lesson_periods where timetable_import_id = $1 and name = $2", [importId, periodName])).rows[0].id;
    const dayId = (await client.query("select id from public.timetable_days where timetable_import_id = $1 and day_order = $2", [importId, dayOrder])).rows[0].id;
    const cardId = (
      await client.query(
        `insert into public.timetable_cards (timetable_import_id, lesson_id, source_index, source_card_key, timetable_day_id, lesson_period_id)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [importId, lessonId, lessonSeq, `card-${lessonSeq}`, dayId, periodId],
      )
    ).rows[0].id;
    await client.query(
      `insert into public.timetable_assignments
         (timetable_import_id, timetable_card_id, lesson_id, teacher_id, school_class_id, timetable_day_id, lesson_period_id, subject_id, mapping_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'exact')`,
      [importId, cardId, lessonId, teacher[src], classId, dayId, periodId, subjectId],
    );
  }

  let subjectId: string;
  let classId: string;
  let lessonId: string;

  beforeAll(async () => {
    client = new Client({ connectionString: DB_URL });
    await client.connect();
    await client.query("begin");

    campusName = `Slot Kampus ${sfx}`;
    yearName = `2026-2027 SLOT ${sfx}`;
    campusId = (await client.query("insert into public.campuses (name, code) values ($1,$2) returning id", [campusName, `S${sfx}`])).rows[0].id;
    yearId = (await client.query("insert into public.academic_years (campus_id, name) values ($1,$2) returning id", [campusId, yearName])).rows[0].id;
    importId = (
      await client.query(
        `insert into public.timetable_imports (campus_id, academic_year_id, source_format, source_filename, status, imported_at)
         values ($1,$2,'asc','slot.xml','imported', now()) returning id`,
        [campusId, yearId],
      )
    ).rows[0].id;

    // Zaman kuralı için periyotlar. Öğretmenlere ders YAZILMAZ ⇒ hedef ve komşu
    // periyotlar boştur ⇒ zaman kuralı geçer. Böylece testler SLOT modeline
    // odaklanır; ders çakışması yalnız bilerek kurulan senaryoda görünür.
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

    // Nöbet yerleri DOĞRUDAN SQL ile kurulur: create_duty_location short_code'a
    // göre sabit bir blok kümesi dayatır; burada görev evreninin tam denetimi
    // gerekiyor.
    const locSpec: [string, string, [string, string][]][] = [
      [
        "FL1",
        "corridor",
        [
          ["MORNING_BREAKS", "normal"],
          ["LONG_BREAK_1", "normal"],
          ["LONG_BREAK_2", "normal"],
          ["AFTERNOON_BREAKS", "normal"],
        ],
      ],
      ["FL2", "garden", [["MORNING_BREAKS", "normal"]]],
      [
        "FL3",
        "corridor",
        [
          ["MORNING_BREAKS", "fixed_only"],
          ["AFTERNOON_BREAKS", "fixed_only"],
          ["LONG_BREAK_1", "normal"],
        ],
      ],
    ];
    let sortOrder = 0;
    for (const [key, category, pairs] of locSpec) {
      sortOrder += 1;
      loc[key] = (
        await client.query(
          `insert into public.duty_locations (campus_id, name, short_code, category, capacity, is_active, sort_order, allows_fixed_assignment)
           values ($1,$2,$3,$4,1,true,$5,$6) returning id`,
          [campusId, `${key} ${sfx}`, `${key}${sfx}`.slice(0, 16), category, sortOrder, key === "FL3"],
        )
      ).rows[0].id;
      for (const [code, mode] of pairs) {
        await client.query(
          "insert into public.duty_location_blocks (campus_id, duty_location_id, duty_block_id, assignment_mode) values ($1,$2,$3,$4)",
          [campusId, loc[key], block[code], mode],
        );
      }
    }

    subjectId = (await client.query("insert into public.subjects (timetable_import_id, source_id, name) values ($1,'subj-1','Ders') returning id", [importId])).rows[0].id;
    classId = (await client.query("insert into public.school_classes (timetable_import_id, source_id, name) values ($1,'class-1','1A') returning id", [importId])).rows[0].id;
    lessonId = (
      await client.query("insert into public.lessons (timetable_import_id, source_id, subject_id) values ($1,'lesson-1',$2) returning id", [importId, subjectId])
    ).rows[0].id;

    for (const src of ["ON", "OFF", "OFF2", "FIX"]) {
      teacher[src] = (
        await client.query("insert into public.teachers (timetable_import_id, source_id, name) values ($1,$2,$3) returning id", [importId, src, `Ogretmen ${src}`])
      ).rows[0].id;
      settingId[src] = (
        await client.query(
          `insert into public.teacher_duty_settings (campus_id, academic_year_id, teacher_source_id, teacher_name_snapshot, is_included, half_day_rule_enabled)
           values ($1,$2,$3,$4,true,true) returning id`,
          [campusId, yearId, src, `Ogretmen ${src}`],
        )
      ).rows[0].id;
    }
  }, 60000);

  afterAll(async () => {
    if (client) {
      await client.query("rollback");
      await client.end();
    }
  });

  // -------------------------------------------------------------------------
  // Görev evreni — tüm senaryoların dayandığı temel
  // -------------------------------------------------------------------------
  it("görev evreni: 6 normal + 2 sabit görev; fixed_only bloklar normal görev üretmez", async () => {
    await resetFixture();
    const d = await day1();
    // FL1 dört blok + FL2 Sabah + FL3 Öğle Arası-1 = 6 normal.
    expect(d.totals.normalRequired).toBe(6);
    // FL3 Sabah + Öğleden Sonra = 2 sabit.
    expect(d.totals.fixedRequired).toBe(2);
    expect(d.totals.requiredTasks).toBe(8);
    // FL2'de eşlemesi olmayan bloklar HİÇ görev üretmez.
    expect(blockOf(d, "LONG_BREAK_2").required).toBe(1); // yalnız FL1
    expect(blockOf(d, "MORNING_BREAKS").required).toBe(3); // FL1 + FL2 + FL3(sabit)
    expect(blockOf(d, "MORNING_BREAKS").normalRequired).toBe(2);
    expect(blockOf(d, "MORNING_BREAKS").fixedRequired).toBe(1);
  });

  // -------------------------------------------------------------------------
  // SLOT modeli — asıl düzeltme
  // -------------------------------------------------------------------------
  it("1) kural AÇIK, iki FARKLI blokta iki görev, tek öğretmen → yalnız 1 görev karşılanır", async () => {
    await resetFixture();
    await setHalfDay("ON", true);
    await pref("ON", "FL1", "MORNING_BREAKS");
    await pref("ON", "FL1", "LONG_BREAK_1");

    const d = await day1();
    expect(d.totals.normalMatched).toBe(1);
    expect(d.totals.candidateTeacherCount).toBe(1);
  });

  it("2) kural KAPALI, iki FARKLI blokta iki görev, tek öğretmen → 2 görev de karşılanır", async () => {
    await resetFixture();
    await setHalfDay("OFF", false);
    await pref("OFF", "FL1", "MORNING_BREAKS");
    await pref("OFF", "FL1", "LONG_BREAK_1");

    const d = await day1();
    expect(d.totals.normalMatched).toBe(2);
    // Aday SAYISI öğretmen sayısıdır; slot sayısı DEĞİL.
    expect(d.totals.candidateTeacherCount).toBe(1);
  });

  it("3) kural KAPALI, AYNI blokta iki farklı yer, tek öğretmen → yalnız 1 görev karşılanır", async () => {
    await resetFixture();
    await setHalfDay("OFF", false);
    await pref("OFF", "FL1", "MORNING_BREAKS");
    await pref("OFF", "FL2", "MORNING_BREAKS");

    const d = await day1();
    expect(d.totals.normalMatched).toBe(1);
    expect(blockOf(d, "MORNING_BREAKS").matchingUncovered).toBe(1);
  });

  it("4) kural KAPALI, dört FARKLI blok → en fazla 4 görev", async () => {
    await resetFixture();
    await setHalfDay("OFF", false);
    for (const code of ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"]) await pref("OFF", "FL1", code);
    // Beşinci bir hücre daha tercih edilse bile (FL2 Sabah) Sabah slotu DOLU.
    await pref("OFF", "FL2", "MORNING_BREAKS");

    const d = await day1();
    expect(d.totals.normalMatched).toBe(4);
    expect(d.totals.candidateTeacherCount).toBe(1);
  });

  it("5) o gün SABİT nöbeti olan öğretmen — toggle KAPALI olsa bile — 0 normal görev alır", async () => {
    await resetFixture();
    await setHalfDay("FIX", false);
    for (const code of ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"]) await pref("FIX", "FL1", code);
    await client.query(
      `insert into public.fixed_duty_assignments (campus_id, academic_year_id, teacher_source_id, teacher_name_snapshot, duty_location_id, day_order)
       values ($1,$2,'FIX','Ogretmen FIX',$3,1)`,
      [campusId, yearId, loc.FL3],
    );

    const d = await day1();
    expect(d.totals.normalMatched).toBe(0);
    expect(d.totals.candidateTeacherCount).toBe(0);
    // Sabit görevler ise ATANMIŞ sayılır.
    expect(d.totals.fixedCovered).toBe(2);
    expect(d.totals.fixedMissing).toBe(0);
  });

  it("6) darboğaz: kuralı AÇIK ve KAPALI öğretmen birlikte, yeniden eşleştirmeyle maksimum kapsam", async () => {
    await resetFixture();
    await setHalfDay("ON", true);
    await setHalfDay("OFF", false);
    // ON yalnız FL1 Sabah'ı tercih ediyor; OFF üç hücreyi de.
    await pref("ON", "FL1", "MORNING_BREAKS");
    await pref("OFF", "FL1", "MORNING_BREAKS");
    await pref("OFF", "FL2", "MORNING_BREAKS");
    await pref("OFF", "FL1", "LONG_BREAK_1");

    const d = await day1();
    // Maksimum: FL1×Sabah → ON, FL2×Sabah → OFF(Sabah slotu), FL1×Uzun1 → OFF(Uzun1 slotu).
    // Naif "öğretmen başına tek slot" modeli burada 2 bulurdu.
    expect(d.totals.normalMatched).toBe(3);
    expect(d.totals.candidateTeacherCount).toBe(2);
    expect(blockOf(d, "MORNING_BREAKS").matchingUncovered).toBe(0);
    // Uzun Nöbet 1'de İKİ normal görev var (FL1 ve FL3); yalnız FL1 tercih
    // edildiği için FL3 açık kalır — bu eşleştirme değil TERCİH eksikliğidir.
    expect(blockOf(d, "LONG_BREAK_1").matchingUncovered).toBe(1);
    expect(d.uncoveredTasks.find((t) => t.dutyLocationId === loc.FL3 && t.blockId === block.LONG_BREAK_1)).toMatchObject({ reason: "no_candidate", candidateCount: 0 });
  });

  it("7) candidateTeacherCount slotlarla ŞİŞMEZ: kuralı kapalı 2 öğretmen = 2 aday", async () => {
    await resetFixture();
    await setHalfDay("OFF", false);
    await setHalfDay("OFF2", false);
    for (const src of ["OFF", "OFF2"]) {
      for (const code of ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"]) await pref(src, "FL1", code);
    }

    const d = await day1();
    // İki öğretmenin toplam 8 slotu var, ama aday sayısı 2'dir.
    expect(d.totals.candidateTeacherCount).toBe(2);
    expect(blockOf(d, "MORNING_BREAKS").candidateTeacherCount).toBe(2);
    // Görev başına aday sayısı da öğretmen sayısıdır.
    const uncoveredMorning = d.uncoveredTasks.find((t) => t.blockId === block.MORNING_BREAKS && t.dutyLocationId === loc.FL2);
    expect(uncoveredMorning?.candidateCount ?? 0).toBe(0);
    // FL1 dört bloğu iki öğretmenle tam kapanır.
    expect(d.totals.normalMatched).toBe(4);
  });

  // -------------------------------------------------------------------------
  // Regresyonlar — anlamı korunması gereken sayaçlar
  // -------------------------------------------------------------------------
  it("8) fixed_only görev NORMAL aday üretmez; sabit atama yoksa missing_fixed_assignment", async () => {
    await resetFixture();
    await setHalfDay("OFF", false);
    // FL3 Sabah fixed_only — tercih edilse bile normal görev kapatmaz.
    await pref("OFF", "FL3", "MORNING_BREAKS");

    const d = await day1();
    expect(d.totals.normalMatched).toBe(0);
    expect(d.totals.fixedMissing).toBe(2);
    const missing = d.missingFixedAssignments.find((m) => m.dutyLocationId === loc.FL3)!;
    expect(missing.blockCodes.sort()).toEqual(["AFTERNOON_BREAKS", "MORNING_BREAKS"]);
    const fixedTask = d.uncoveredTasks.find((t) => t.dutyLocationId === loc.FL3 && t.blockId === block.MORNING_BREAKS)!;
    expect(fixedTask).toMatchObject({ kind: "fixed", reason: "missing_fixed_assignment", candidateCount: null });
  });

  it("9) ders çakışması: aday elenir ve excludedByLessonConflict'e yazılır", async () => {
    await resetFixture();
    await setHalfDay("OFF", false);
    await pref("OFF", "FL1", "LONG_BREAK_1");
    // 5-OO hedef periyodunda ders ⇒ target_period_busy.
    await addLesson("OFF", "5-OO", 1);

    const d = await day1();
    expect(d.totals.normalMatched).toBe(0);
    expect(d.totals.candidateTeacherCount).toBe(0);
    const conflict = d.excludedByLessonConflict.find((c) => c.blockCode === "LONG_BREAK_1")!;
    expect(conflict.teacherCount).toBe(1);
    // Yapılandırma hatası DEĞİL.
    expect(d.excludedByConfigurationError.find((c) => c.blockCode === "LONG_BREAK_1")!.teacherCount).toBe(0);
  });

  it("10) yapılandırma hatası ders çakışmasından AYRI sayılır", async () => {
    await resetFixture();
    await setHalfDay("OFF", false);
    await pref("OFF", "FL1", "LONG_BREAK_2");
    // 5-IO periyodu tanımı SİLİNİR ⇒ period_configuration_missing.
    await client.query("delete from public.lesson_periods where timetable_import_id = $1 and name = '5-IO'", [importId]);

    try {
      const d = await day1();
      expect(d.totals.normalMatched).toBe(0);
      const config = d.excludedByConfigurationError.find((c) => c.blockCode === "LONG_BREAK_2")!;
      expect(config.teacherCount).toBe(1);
      expect(d.excludedByLessonConflict.find((c) => c.blockCode === "LONG_BREAK_2")!.teacherCount).toBe(0);
    } finally {
      await client.query("insert into public.lesson_periods (timetable_import_id, source_id, name, period_order) values ($1,'p6','5-IO',6)", [importId]);
    }
  });

  it("11) haftalık özet gün toplamlarıyla tutarlı kalır", async () => {
    await resetFixture();
    await setHalfDay("OFF", false);
    for (const code of ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"]) await pref("OFF", "FL1", code);

    const r = await analyze();
    const sumRequired = r.days.reduce((n, d) => n + d.totals.requiredTasks, 0);
    const sumCovered = r.days.reduce((n, d) => n + d.totals.coveredTasks, 0);
    expect(r.summary.totalRequiredTasks).toBe(sumRequired);
    expect(r.summary.totalCoveredTasks).toBe(sumCovered);
    expect(r.summary.totalUncoveredTasks).toBe(sumRequired - sumCovered);
    expect(r.summary.feasible).toBe(sumRequired === sumCovered);
  });

  it("12) analyze_duty_plan_feasibility PUBLIC/anon/authenticated tarafından çağrılamaz", async () => {
    const rows = (
      await client.query(
        `select coalesce(bool_or(has_function_privilege(g.grantee, p.oid, 'EXECUTE')), false) as granted, g.grantee
           from pg_catalog.pg_proc p
           join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           cross join (values ('public'), ('anon'), ('authenticated')) as g(grantee)
          where n.nspname = 'public' and p.proname = 'analyze_duty_plan_feasibility'
            and exists (select 1 from pg_catalog.pg_roles r where r.rolname = g.grantee)
          group by g.grantee`,
      )
    ).rows as { granted: boolean; grantee: string }[];
    for (const row of rows) expect(row.granted, `${row.grantee} EXECUTE almamalı`).toBe(false);

    const own = (
      await client.query(
        `select p.prosecdef, p.proconfig
           from pg_catalog.pg_proc p
           join pg_catalog.pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'analyze_duty_plan_feasibility'`,
      )
    ).rows[0] as { prosecdef: boolean; proconfig: string[] };
    expect(own.prosecdef).toBe(false); // security invoker
    expect(own.proconfig).toContain("search_path=pg_catalog, public");
  });
});
