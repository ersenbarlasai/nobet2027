import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";
import { generateDutyPlanDraft } from "../services/dutyPlanGeneration";

/**
 * GERÇEK PostgreSQL testleri (yerel `supabase start` — uzak projeye ASLA
 * dokunulmaz). Postgres'e DOĞRUDAN bağlanır (RPC'ler için `select
 * public.fn(...)`, RLS/yetki testleri için `set local role`) — böylece
 * PostgREST/API-anahtarı katmanından bağımsız, tek kaynak Postgres'in
 * kendisidir. Bağlantı bilgisi yoksa (CI/sandbox'ta docker olmayabilir)
 * bütün süit atlanır — `npm run test` bu dosya olmadan da yeşil kalır.
 *
 *   DUTY_PLAN_PG_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
 *
 * `npx supabase start` sonrası bu değer `npx supabase status` çıktısında
 * (DB_URL).
 */
const DB_URL = process.env.DUTY_PLAN_PG_TEST_DB_URL;
const enabled = Boolean(DB_URL);

/**
 * Senaryo E (gerçek servis entegrasyonu) için: PostgREST/supabase-js
 * katmanından get_duty_plan_generation_snapshot/save_duty_plan_draft'ı
 * çağırmak amacıyla. Verilmezse yalnız o tek test atlanır (diğer tüm
 * gerçek-Postgres testleri düz `pg` bağlantısıyla, bu ikisi olmadan da çalışır).
 */
const API_URL = process.env.DUTY_PLAN_PG_TEST_API_URL;
const SERVICE_KEY = process.env.DUTY_PLAN_PG_TEST_SERVICE_KEY;
const serviceIntegrationEnabled = enabled && Boolean(API_URL) && Boolean(SERVICE_KEY);

describe.skipIf(!enabled)("duty plan drafts — gerçek PostgreSQL", () => {
  let client: Client;
  let campusName: string;
  let academicYearName: string;
  let campusId: string;
  let yearId: string;
  let importId: string;
  let locBahce1: string;
  let locYemekhane1: string;
  let locYemekhane2: string;
  let locIlkokul1: string;
  let locRemoved: string;
  let blockIds: Record<string, string> = {};

  function toSqlParam(value: unknown): unknown {
    if (value !== null && typeof value === "object") return JSON.stringify(value);
    return value;
  }

  async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const argNames = Object.keys(args);
    const namedArgs = argNames.map((name, i) => `${name} := $${i + 1}`).join(", ");
    const sql = `select public.${fn}(${namedArgs}) as result`;
    const res = await client.query(sql, argNames.map((name) => toSqlParam(args[name])));
    return res.rows[0].result as T;
  }

  interface SnapshotTask {
    dayOrder: number;
    dutyLocationId: string;
    dutyBlockId: string;
    kind: "fixed" | "normal";
    fixedCoveredByTeacherSourceId: string | null;
  }

  /**
   * Test yardımcı: p_assignments + YETKİLİ p_summary'yi (save_duty_plan_
   * draft'ın kendi yeniden hesaplamasıyla BİREBİR aynı formülle) birlikte
   * kurar. `assignNormal` normal görevler için hangi öğretmenin (varsa)
   * atandığını belirler; fixed görevler snapshot'taki mevcut kapsanma
   * durumunu AYNEN yansıtır (RPC bunu zaten böyle bekler).
   *
   * `teacherUniverse` — RPC'nin teacher_universe'ı (is_included=true TÜM
   * öğretmenler ∪ o yılın TÜM sabit atama öğretmenleri) ile BİREBİR aynı
   * kümedir; verilmezse yalnız assignments'ta GÖRÜNEN öğretmenler kullanılır
   * (eski, HATALI davranışı yeniden üretmemek için çağıran taraf bunu HER
   * ZAMAN vermeli — bkz. bulgu: "teacherLoads evren uyumsuzluğu").
   */
  function buildAssignmentsAndSummary(
    tasks: SnapshotTask[],
    assignNormal: (task: SnapshotTask) => string | null,
    teacherUniverse: string[] = [],
  ) {
    const rows = tasks.map((t) => {
      const teacherSourceId = t.kind === "fixed" ? t.fixedCoveredByTeacherSourceId : assignNormal(t);
      const assignmentKind = t.kind === "fixed" ? (teacherSourceId ? "fixed" : "unassigned") : teacherSourceId ? "generated" : "unassigned";
      return {
        day_order: t.dayOrder,
        duty_location_id: t.dutyLocationId,
        duty_block_id: t.dutyBlockId,
        teacher_source_id: teacherSourceId,
        assignment_kind: assignmentKind,
        score_details: {},
      };
    });

    const totalTaskCount = rows.length;
    const fixedTaskCount = tasks.filter((t) => t.kind === "fixed").length;
    const fixedCoveredCount = rows.filter((r) => r.assignment_kind === "fixed").length;
    const normalTaskCount = tasks.filter((t) => t.kind === "normal").length;
    const normalCoveredCount = rows.filter((r) => r.assignment_kind === "generated").length;
    const uncoveredCount = rows.filter((r) => r.assignment_kind === "unassigned").length;

    const fixedDaysByTeacher = new Map<string, Set<number>>();
    const normalByTeacher = new Map<string, number>();
    for (const r of rows) {
      if (!r.teacher_source_id) continue;
      if (r.assignment_kind === "fixed") {
        const set = fixedDaysByTeacher.get(r.teacher_source_id) ?? new Set<number>();
        set.add(r.day_order);
        fixedDaysByTeacher.set(r.teacher_source_id, set);
      } else if (r.assignment_kind === "generated" || r.assignment_kind === "manual") {
        normalByTeacher.set(r.teacher_source_id, (normalByTeacher.get(r.teacher_source_id) ?? 0) + 1);
      }
    }
    const teacherIds = new Set([...fixedDaysByTeacher.keys(), ...normalByTeacher.keys(), ...teacherUniverse]);
    const teacherLoads = Array.from(teacherIds)
      .sort((a, b) => a.localeCompare(b))
      .map((teacherSourceId) => {
        const normalDutyCount = normalByTeacher.get(teacherSourceId) ?? 0;
        const fixedDutyDayCount = fixedDaysByTeacher.get(teacherSourceId)?.size ?? 0;
        return { teacherSourceId, normalDutyCount, fixedDutyDayCount, totalDutyCount: normalDutyCount + fixedDutyDayCount };
      });

    const summary = { totalTaskCount, fixedTaskCount, fixedCoveredCount, normalTaskCount, normalCoveredCount, uncoveredCount, teacherLoads };
    return { rows, summary };
  }

  /** create_duty_location composite (public.duty_locations) döner — yalnız id gerekir. */
  async function createDutyLocationId(args: {
    name: string;
    shortCode: string;
    category: string;
  }): Promise<string> {
    const res = await client.query(
      "select (public.create_duty_location($1,$2,$3,$4,$5,$6,$7)).id as id",
      [campusId, args.name, args.shortCode, args.category, 1, null, true],
    );
    return res.rows[0].id as string;
  }

  /** RPC'nin teacher_universe'ıyla BİREBİR aynı sorgu — testin kendi authoritative kaynağı. */
  async function fetchTeacherUniverse(): Promise<string[]> {
    const res = await client.query(
      `select teacher_source_id from public.teacher_duty_settings where academic_year_id=$1 and is_included
       union
       select teacher_source_id from public.fixed_duty_assignments where academic_year_id=$1`,
      [yearId],
    );
    return res.rows.map((r: { teacher_source_id: string }) => r.teacher_source_id);
  }

  async function callSave(args: {
    sourceFingerprint: string;
    assignments: unknown[];
    summary: unknown;
    allowPartial?: boolean;
    expectedPlanId?: string | null;
  }): Promise<{ status: string; [key: string]: unknown }> {
    return rpc("save_duty_plan_draft", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_expected_source_fingerprint: args.sourceFingerprint,
      p_algorithm_version: "test-v1",
      p_generation_seed: 1,
      p_generation_options: {},
      p_assignments: args.assignments,
      p_summary: args.summary,
      p_allow_partial: args.allowPartial ?? true,
      p_expected_plan_id: args.expectedPlanId ?? null,
    });
  }

  beforeAll(async () => {
    client = new Client({ connectionString: DB_URL });
    await client.connect();

    // YEREL supabase CLI'nin varsayılan seed'i (roles.sql), gerçek bir
    // hosted Supabase projesinin service_role'a normalde OTOMATİK verdiği
    // taban tablo yetkilerini vermiyor (yalnız RPC EXECUTE + BYPASSRLS var —
    // fonksiyon gövdesi yine de temel SELECT/INSERT gerektirir). Bu, YALNIZ
    // bu yerel test veritabanı için, gerçek üretim yetkisini taklit eder;
    // hiçbir migration dosyasını DEĞİŞTİRMEZ, remote'a hiç dokunmaz.
    await client.query("grant usage on schema public to service_role");
    await client.query("grant all on all tables in schema public to service_role");
    await client.query("grant all on all sequences in schema public to service_role");

    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    campusName = `PG Test Kampus ${suffix}`;
    academicYearName = `PG Test Yil ${suffix}`;

    const campusRes = await client.query("insert into public.campuses (name) values ($1) returning id", [campusName]);
    campusId = campusRes.rows[0].id;

    const yearRes = await client.query(
      "insert into public.academic_years (campus_id, name, is_active) values ($1, $2, true) returning id",
      [campusId, academicYearName],
    );
    yearId = yearRes.rows[0].id;

    const sourceSha256 = suffix.padEnd(64, "0").slice(0, 64);
    const importRes = await client.query(
      `insert into public.timetable_imports
         (campus_id, academic_year_id, source_format, source_filename, source_sha256, status, imported_at)
       values ($1, $2, 'asc-xml', 'pg-test.xml', $3, 'imported', now())
       returning id`,
      [campusId, yearId, sourceSha256],
    );
    importId = importRes.rows[0].id;

    for (let d = 1; d <= 5; d++) {
      await client.query("insert into public.timetable_days (timetable_import_id, source_id, name, day_order) values ($1,$2,$3,$4)", [
        importId,
        `d${d}`,
        `Gun ${d}`,
        d,
      ]);
    }

    // 5-OO/5-IO komşu periyot kuralı için: 4, 5-OO, 5-IO, 6 sıralı.
    for (const p of [
      { name: "4", order: 4 },
      { name: "5-OO", order: 5 },
      { name: "5-IO", order: 6 },
      { name: "6", order: 7 },
    ]) {
      await client.query("insert into public.lesson_periods (timetable_import_id, source_id, name, period_order) values ($1,$2,$3,$4)", [
        importId,
        p.name,
        p.name,
        p.order,
      ]);
    }

    const teacherIds = new Map<string, string>();
    // T4: yalnız sabit nöbeti bulunan (hiç uygunluk beyanı olmayan) öğretmen —
    // "senaryo C". T5: 2 sabit gün + 2 normal aday günü — "senaryo D".
    for (const sourceId of ["T1", "T2", "T3", "T4", "T5"]) {
      const res = await client.query(
        "insert into public.teachers (timetable_import_id, source_id, name) values ($1,$2,$3) returning id",
        [importId, sourceId, `Ogretmen ${sourceId}`],
      );
      teacherIds.set(sourceId, res.rows[0].id);
    }

    // t2 için 5-OO periyodunda ders (LONG_BREAK_1 zaman kuralı testleri için).
    const subjectRes = await client.query(
      "insert into public.subjects (timetable_import_id, source_id, name) values ($1,'subj-1','Ders') returning id",
      [importId],
    );
    const classRes = await client.query(
      "insert into public.school_classes (timetable_import_id, source_id, name) values ($1,'class-1','1A') returning id",
      [importId],
    );
    const lessonRes = await client.query(
      "insert into public.lessons (timetable_import_id, source_id, subject_id) values ($1,'lesson-1',$2) returning id",
      [importId, subjectRes.rows[0].id],
    );
    const day1Res = await client.query("select id from public.timetable_days where timetable_import_id=$1 and day_order=1", [importId]);
    const period5ooRes = await client.query("select id from public.lesson_periods where timetable_import_id=$1 and name='5-OO'", [importId]);

    const cardRes = await client.query(
      `insert into public.timetable_cards
         (timetable_import_id, lesson_id, source_index, source_card_key, timetable_day_id, lesson_period_id)
       values ($1,$2,1,'card-1',$3,$4) returning id`,
      [importId, lessonRes.rows[0].id, day1Res.rows[0].id, period5ooRes.rows[0].id],
    );

    await client.query(
      `insert into public.timetable_assignments
         (timetable_import_id, timetable_card_id, lesson_id, teacher_id, school_class_id, timetable_day_id, lesson_period_id, subject_id, mapping_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'exact')`,
      [
        importId,
        cardRes.rows[0].id,
        lessonRes.rows[0].id,
        teacherIds.get("T2"),
        classRes.rows[0].id,
        day1Res.rows[0].id,
        period5ooRes.rows[0].id,
        subjectRes.rows[0].id,
      ],
    );

    const blocksRes = await client.query("select id, code from public.duty_blocks where is_active");
    blockIds = Object.fromEntries(blocksRes.rows.map((r: { id: string; code: string }) => [r.code, r.id]));

    async function createLocation(name: string, shortCode: string, category: string) {
      return rpc<string>("create_duty_location", {
        p_campus_id: campusId,
        p_name: name,
        p_short_code: shortCode,
        p_category: category,
        p_capacity: 1,
        p_description: null,
        p_is_active: true,
      }).then(async () => {
        const res = await client.query("select id from public.duty_locations where campus_id=$1 and upper(short_code)=upper($2)", [campusId, shortCode]);
        return res.rows[0].id as string;
      });
    }

    /**
     * TARİHSEL nöbet yeri kaydı — 20260919090000 ÖNCESİNDEKİ yapılandırmayı
     * DOĞRUDAN kurar, create_duty_location RPC'sini KULLANMAZ.
     *
     * Gerekçe: bu süit paket/görev evreni davranışını eski (henüz
     * güncellenmemiş) RPC katmanı üzerinde doğrular. Yeni RPC ise
     *   - emekli kodları (YEMEKHANE2) reddeder,
     *   - YEMEKHANE1'e iki öğle arası bloğu verir,
     *   - ILKOKUL1'i KARMA yer yapar (Sabah/Öğleden Sonra fixed_only +
     *     Öğle Arası-1 normal).
     * Bu üç kayıt fixture'da geçmiş veriyi temsil ettiği için üretim kuralını
     * GEVŞETMEK yerine satırlar elle kurulur. Böylece testin doğruladığı şey
     * değişmez: görev evreni yer×blok EŞLEMESİNDEN türer, short_code'dan değil.
     */
    async function createLegacyLocationDirectly(args: {
      name: string;
      shortCode: string;
      category: string;
      blocks: { code: string; mode: "normal" | "fixed_only" }[];
      allowsFixedAssignment?: boolean;
    }): Promise<string> {
      const res = await client.query(
        `insert into public.duty_locations (campus_id, name, short_code, category, capacity, description, is_active, sort_order, allows_fixed_assignment)
         values ($1,$2,$3,$4,1,null,true,
                 (select coalesce(max(sort_order),0)+1 from public.duty_locations where campus_id=$1 and deleted_at is null),
                 $5)
         returning id`,
        [campusId, args.name, args.shortCode, args.category, args.allowsFixedAssignment ?? false],
      );
      const id = res.rows[0].id as string;
      for (const block of args.blocks) {
        await client.query(
          `insert into public.duty_location_blocks (campus_id, duty_location_id, duty_block_id, assignment_mode)
           select $1, $2, b.id, $4 from public.duty_blocks b where b.code = $3`,
          [campusId, id, block.code, block.mode],
        );
      }
      return id;
    }

    locBahce1 = await createLocation("Bahce 1", `BAHCE${suffix}`.slice(0, 16), "garden");
    // Eski model: her yemekhane kaydı YALNIZ kendi uzun teneffüs bloğunu taşır.
    locYemekhane1 = await createLegacyLocationDirectly({
      name: "Yemekhane 1",
      shortCode: "YEMEKHANE1",
      category: "cafeteria",
      blocks: [{ code: "LONG_BREAK_1", mode: "normal" }],
    });
    locYemekhane2 = await createLegacyLocationDirectly({
      name: "Yemekhane 2",
      shortCode: "YEMEKHANE2",
      category: "cafeteria",
      blocks: [{ code: "LONG_BREAK_2", mode: "normal" }],
    });
    // Eski model: SAF sabit yer — yalnız Sabah + Öğleden Sonra, normal blok YOK.
    locIlkokul1 = await createLegacyLocationDirectly({
      name: "Ilkokul Koridor 1",
      shortCode: "ILKOKUL1",
      category: "corridor",
      blocks: [
        { code: "MORNING_BREAKS", mode: "fixed_only" },
        { code: "AFTERNOON_BREAKS", mode: "fixed_only" },
      ],
      allowsFixedAssignment: true,
    });
    locRemoved = await createLocation(`Kaldirilan ${suffix}`.slice(0, 60), `SILINEN${suffix}`.slice(0, 16), "floor");

    const settingIds = new Map<string, string>();
    // T4 KASITLI OLARAK dahil edilmez — teacher_universe'a yalnız
    // fixed_duty_assignments üzerinden girmesi gerektiğini doğrular
    // (senaryo C: "yalnız sabit nöbeti bulunan öğretmen").
    for (const sourceId of ["T1", "T2", "T3", "T5"]) {
      const res = await client.query(
        `insert into public.teacher_duty_settings (campus_id, academic_year_id, teacher_source_id, teacher_name_snapshot, is_included)
         values ($1,$2,$3,$4,true) returning id`,
        [campusId, yearId, sourceId, `Ogretmen ${sourceId}`],
      );
      settingIds.set(sourceId, res.rows[0].id);
    }

    const availabilityRows: { teacher: string; loc: string; day: number; block: string }[] = [
      { teacher: "T1", loc: locBahce1, day: 1, block: blockIds.MORNING_BREAKS },
      { teacher: "T1", loc: locBahce1, day: 2, block: blockIds.MORNING_BREAKS },
      { teacher: "T3", loc: locBahce1, day: 1, block: blockIds.MORNING_BREAKS },
      { teacher: "T2", loc: locYemekhane1, day: 1, block: blockIds.LONG_BREAK_1 },
      { teacher: "T3", loc: locYemekhane1, day: 1, block: blockIds.LONG_BREAK_1 },
      { teacher: "T3", loc: locYemekhane2, day: 1, block: blockIds.LONG_BREAK_2 },
      { teacher: "T1", loc: locRemoved, day: 1, block: blockIds.MORNING_BREAKS },
      // T5 — senaryo D: 2 sabit gün (day3, day4 aşağıda) + 2 normal aday günü.
      { teacher: "T5", loc: locBahce1, day: 1, block: blockIds.MORNING_BREAKS },
      { teacher: "T5", loc: locBahce1, day: 2, block: blockIds.MORNING_BREAKS },
    ];
    for (const r of availabilityRows) {
      await client.query(
        `insert into public.teacher_duty_block_availabilities (campus_id, teacher_duty_setting_id, duty_location_id, day_order, duty_block_id)
         values ($1,$2,$3,$4,$5)`,
        [campusId, settingIds.get(r.teacher), r.loc, r.day, r.block],
      );
    }

    await rpc("create_fixed_duty_assignment", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_teacher_id: teacherIds.get("T1"),
      p_day_order: 1,
      p_duty_location_id: locIlkokul1,
    });
    // T4 — senaryo C: hiç uygunluk beyanı / teacher_duty_settings satırı
    // YOK, yalnız sabit nöbeti var (day5 — day2 başka bir test tarafından
    // "boş" varsayılıyor, çakışmasın diye kullanılmadı).
    await rpc("create_fixed_duty_assignment", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_teacher_id: teacherIds.get("T4"),
      p_day_order: 5,
      p_duty_location_id: locIlkokul1,
    });
    // T5 — senaryo D: iki AYRI sabit gün (day3, day4) — her biri MORNING+
    // AFTERNOON iki hücreyle karşılanır, ama fixedDutyDayCount yine de 2
    // olmalıdır (gün sayısı, hücre sayısı DEĞİL).
    await rpc("create_fixed_duty_assignment", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_teacher_id: teacherIds.get("T5"),
      p_day_order: 3,
      p_duty_location_id: locIlkokul1,
    });
    await rpc("create_fixed_duty_assignment", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_teacher_id: teacherIds.get("T5"),
      p_day_order: 4,
      p_duty_location_id: locIlkokul1,
    });
  }, 60000);

  afterAll(async () => {
    if (client && campusId) {
      // duty_plan_assignments -> duty_locations FK RESTRICT (kasıtlı: bir
      // yer, kullanan bir plan ataması varken hard-delete edilemez) — önce
      // planları (cascade ile atamaları) sil, sonra kampüsü.
      await client.query("delete from public.duty_plans where campus_id=$1", [campusId]);
      await client.query("delete from public.campuses where id=$1", [campusId]);
    }
    if (client) await client.end();
  });

  it("fingerprint kararlıdır ve yalnız etkin veri değiştiğinde değişir", async () => {
    const fp1 = await rpc<string>("compute_duty_plan_source_fingerprint", { p_campus_name: campusName, p_academic_year_name: academicYearName });
    const fp2 = await rpc<string>("compute_duty_plan_source_fingerprint", { p_campus_name: campusName, p_academic_year_name: academicYearName });
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);

    await client.query("update public.teacher_duty_settings set is_included=false where academic_year_id=$1 and teacher_source_id='T3'", [yearId]);
    const fp3 = await rpc<string>("compute_duty_plan_source_fingerprint", { p_campus_name: campusName, p_academic_year_name: academicYearName });
    expect(fp3).not.toBe(fp1);
    await client.query("update public.teacher_duty_settings set is_included=true where academic_year_id=$1 and teacher_source_id='T3'", [yearId]);
  });

  it("görev sayısı güncel konfigürasyonla tutarlıdır (günlük × 5 = haftalık)", async () => {
    const countRes = await client.query(
      `select count(*)::int as c from public.duty_location_blocks lb
         join public.duty_locations dl on dl.id = lb.duty_location_id
        where dl.campus_id = $1 and dl.is_active and dl.deleted_at is null`,
      [campusId],
    );
    const expectedDaily = countRes.rows[0].c as number;

    const snapshot = await rpc<{ tasks: { dayOrder: number }[] }>("get_duty_plan_generation_snapshot", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
    });
    expect(snapshot.tasks.length).toBe(expectedDaily * 5);
    for (let d = 1; d <= 5; d++) {
      expect(snapshot.tasks.filter((t) => t.dayOrder === d).length).toBe(expectedDaily);
    }
  });

  it("sabit görevler doğru yansır: ILKOKUL1 gün 1'de MORNING+AFTERNOON fixed/covered, diğer günler fixed/missing", async () => {
    const snapshot = await rpc<{ tasks: { dayOrder: number; dutyLocationId: string; kind: string; fixedCoveredByTeacherSourceId: string | null }[] }>(
      "get_duty_plan_generation_snapshot",
      { p_campus_name: campusName, p_academic_year_name: academicYearName },
    );
    const day1Fixed = snapshot.tasks.filter((t) => t.dutyLocationId === locIlkokul1 && t.dayOrder === 1);
    expect(day1Fixed).toHaveLength(2);
    for (const t of day1Fixed) {
      expect(t.kind).toBe("fixed");
      expect(t.fixedCoveredByTeacherSourceId).toBe("T1");
    }
    const day2Fixed = snapshot.tasks.filter((t) => t.dutyLocationId === locIlkokul1 && t.dayOrder === 2);
    for (const t of day2Fixed) {
      expect(t.fixedCoveredByTeacherSourceId).toBeNull();
    }
  });

  it("5-OO dersi olan öğretmen LONG_BREAK_1 aday kenarında görünmez", async () => {
    const snapshot = await rpc<{ candidateEdges: { dayOrder: number; dutyLocationId: string; teacherSourceId: string }[] }>(
      "get_duty_plan_generation_snapshot",
      { p_campus_name: campusName, p_academic_year_name: academicYearName },
    );
    const t2 = snapshot.candidateEdges.some((e) => e.dayOrder === 1 && e.dutyLocationId === locYemekhane1 && e.teacherSourceId === "T2");
    expect(t2).toBe(false);
    const t3 = snapshot.candidateEdges.some((e) => e.dayOrder === 1 && e.dutyLocationId === locYemekhane1 && e.teacherSourceId === "T3");
    expect(t3).toBe(true);
  });

  it("YEMEKHANE1/YEMEKHANE2 eşlemeleri yalnız kendi LONG_BREAK blokları için görev üretir", async () => {
    const snapshot = await rpc<{ tasks: { dutyLocationId: string; blockCode: string }[] }>("get_duty_plan_generation_snapshot", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
    });
    const yemekhane1Blocks = new Set(snapshot.tasks.filter((t) => t.dutyLocationId === locYemekhane1).map((t) => t.blockCode));
    const yemekhane2Blocks = new Set(snapshot.tasks.filter((t) => t.dutyLocationId === locYemekhane2).map((t) => t.blockCode));
    expect(yemekhane1Blocks).toEqual(new Set(["LONG_BREAK_1"]));
    expect(yemekhane2Blocks).toEqual(new Set(["LONG_BREAK_2"]));
  });

  it("kaldırılan yer (soft-delete) görev üretmez", async () => {
    await client.query("update public.duty_locations set deleted_at=now(), is_active=false where id=$1", [locRemoved]);
    const snapshot = await rpc<{ tasks: { dutyLocationId: string }[] }>("get_duty_plan_generation_snapshot", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
    });
    expect(snapshot.tasks.some((t) => t.dutyLocationId === locRemoved)).toBe(false);
  });

  it("feasibility ile snapshot GÖREV/ADAY evreni birebir aynıdır", async () => {
    const snapshot = await rpc<{ tasks: unknown[]; feasibility: { summary: { totalRequiredTasks: number } } }>(
      "get_duty_plan_generation_snapshot",
      { p_campus_name: campusName, p_academic_year_name: academicYearName },
    );
    const feasibility = await rpc<{ summary: { totalRequiredTasks: number } }>("analyze_duty_plan_feasibility", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
    });
    expect(snapshot.tasks.length).toBe(feasibility.summary.totalRequiredTasks);
    expect(snapshot.feasibility.summary.totalRequiredTasks).toBe(feasibility.summary.totalRequiredTasks);
  });

  it("stale fingerprint ile save_duty_plan_draft rollback eder — hiçbir satır yazılmaz", async () => {
    const beforeCount = (await client.query("select count(*)::int as c from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId])).rows[0].c;

    const result = await rpc<{ status: string }>("save_duty_plan_draft", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_expected_source_fingerprint: "0".repeat(64),
      p_algorithm_version: "test-v1",
      p_generation_seed: 1,
      p_generation_options: {},
      p_assignments: [],
      p_summary: {},
      p_allow_partial: true,
      p_expected_plan_id: null,
    });
    expect(result.status).toBe("source_changed");

    const afterCount = (await client.query("select count(*)::int as c from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId])).rows[0].c;
    expect(afterCount).toBe(beforeCount);
  });

  it("bulgu 3: iki eşzamanlı generate isteği (expectedPlanId=null) — biri ok, diğeri version_conflict; sessiz ezme yok", async () => {
    await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId]);

    const snapshot = await rpc<{ sourceFingerprint: string; tasks: SnapshotTask[] }>("get_duty_plan_generation_snapshot", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
    });
    const teacherUniverse = await fetchTeacherUniverse();
    const { rows: assignments, summary } = buildAssignmentsAndSummary(snapshot.tasks, () => null, teacherUniverse);

    // İki AYRI bağlantı: gerçek eşzamanlılık için (tek client seri çalışır).
    const client2 = new Client({ connectionString: DB_URL });
    await client2.connect();
    let statuses: string[];
    try {
      const call = (c: Client) =>
        c.query("select public.save_duty_plan_draft($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as result", [
          campusName,
          academicYearName,
          snapshot.sourceFingerprint,
          "test-v1",
          1,
          "{}",
          JSON.stringify(assignments),
          JSON.stringify(summary),
          true,
          null,
        ]);
      const [r1, r2] = await Promise.all([call(client), call(client2)]);
      statuses = [(r1.rows[0].result as { status: string }).status, (r2.rows[0].result as { status: string }).status];
    } finally {
      await client2.end();
    }

    // Tam olarak biri 'ok', diğeri 'version_conflict' olmalı — İKİSİ DE 'ok' OLAMAZ
    // (ilk taslak sessizce ezilmiş olurdu).
    expect(statuses.filter((s) => s === "ok")).toHaveLength(1);
    expect(statuses.filter((s) => s === "version_conflict")).toHaveLength(1);

    const draftCount = (
      await client.query("select count(*)::int as c from public.duty_plans where campus_id=$1 and academic_year_id=$2 and status='draft'", [campusId, yearId])
    ).rows[0].c;
    expect(draftCount).toBe(1);
  });

  it("bulgu 3: doğru expectedPlanId ile bilinçli replacement başarılı, yanlış/bayat id ile conflict", async () => {
    await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId]);

    const snapshot = await rpc<{ sourceFingerprint: string; tasks: SnapshotTask[] }>("get_duty_plan_generation_snapshot", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
    });
    const teacherUniverse = await fetchTeacherUniverse();
    const built = buildAssignmentsAndSummary(snapshot.tasks, () => null, teacherUniverse);

    const first = await callSave({ sourceFingerprint: snapshot.sourceFingerprint, assignments: built.rows, summary: built.summary, expectedPlanId: null });
    expect(first.status).toBe("ok");
    const firstPlanId = first.planId as string;

    // Yanlış id → conflict.
    const wrong = await callSave({
      sourceFingerprint: snapshot.sourceFingerprint,
      assignments: built.rows,
      summary: built.summary,
      expectedPlanId: "00000000-0000-4000-8000-000000000000",
    });
    expect(wrong.status).toBe("version_conflict");
    expect(wrong.currentPlanId).toBe(firstPlanId);

    // Doğru id → bilinçli replacement başarılı, yeni bir plan id üretir.
    const replaced = await callSave({ sourceFingerprint: snapshot.sourceFingerprint, assignments: built.rows, summary: built.summary, expectedPlanId: firstPlanId });
    expect(replaced.status).toBe("ok");
    expect(replaced.planId).not.toBe(firstPlanId);

    const draftCount = (
      await client.query("select count(*)::int as c from public.duty_plans where campus_id=$1 and academic_year_id=$2 and status='draft'", [campusId, yearId])
    ).rows[0].c;
    expect(draftCount).toBe(1);
  });

  it("bulgu 1: haftalık yük = normal gün + AYRI sabit gün sayısı — RPC tüm isteği atomik reddeder/kabul eder", async () => {
    await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId]);
    // T1'in zaten 1 sabit günü var (day 1, ILKOKUL1). T1'e BAHCE1 üzerinden
    // 2 ayrı NORMAL gün (day 2 zaten uygunluğu var) + 1 hayali gün daha
    // eklemek yerine gerçek uygunluk satırlarını kullanıyoruz: T1'in yalnız
    // day1(fixed)+day2(normal, BAHCE1) uygunluğu var — bu yüzden burada
    // doğrudan iki farklı öğretmenin normal günlerini simüle etmek yerine,
    // T1'e AYNI anda hem sabit (day1) hem tek normal (day2) gün vererek
    // toplam yükün 1(sabit)+1(normal)=2 <= maxWeeklyDuties=3 olduğunu, sonra
    // maxWeeklyDuties=1 ile AYNI isteğin reddedildiğini doğruluyoruz (1
    // sabit gün zaten sınırı doldurur).
    const snapshot = await rpc<{ sourceFingerprint: string; tasks: SnapshotTask[] }>("get_duty_plan_generation_snapshot", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
    });
    const day2Bahce = snapshot.tasks.find((t) => t.kind === "normal" && t.dutyLocationId === locBahce1 && t.dayOrder === 2);
    expect(day2Bahce).toBeDefined();

    const assignNormal = (t: SnapshotTask) => (t === day2Bahce ? "T1" : null);
    const teacherUniverse = await fetchTeacherUniverse();
    const built = buildAssignmentsAndSummary(snapshot.tasks, assignNormal, teacherUniverse);

    // maxWeeklyDuties=1: T1'in toplamı (1 sabit + 1 normal = 2) sınırı AŞAR → tüm istek reddedilir.
    const rejected = await rpc<{ status: string }>("save_duty_plan_draft", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_expected_source_fingerprint: snapshot.sourceFingerprint,
      p_algorithm_version: "test-v1",
      p_generation_seed: 1,
      p_generation_options: { maxWeeklyDuties: 1, targetWeeklyDuties: 1, minWeeklyDuties: 0 },
      p_assignments: built.rows,
      p_summary: built.summary,
      p_allow_partial: true,
      p_expected_plan_id: null,
    });
    expect(rejected.status).toBe("weekly_limit_exceeded");
    const countAfterReject = (
      await client.query("select count(*)::int as c from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId])
    ).rows[0].c;
    expect(countAfterReject).toBe(0);

    // maxWeeklyDuties=2: toplam (1+1=2) sınıra tam uyar → kabul edilir.
    const accepted = await rpc<{ status: string }>("save_duty_plan_draft", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_expected_source_fingerprint: snapshot.sourceFingerprint,
      p_algorithm_version: "test-v1",
      p_generation_seed: 1,
      p_generation_options: { maxWeeklyDuties: 2, targetWeeklyDuties: 2, minWeeklyDuties: 0 },
      p_assignments: built.rows,
      p_summary: built.summary,
      p_allow_partial: true,
      p_expected_plan_id: null,
    });
    expect(accepted.status).toBe("ok");

    await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId]);
  });

  it("bulgu 7: istemcinin özeti yetkili yeniden hesaplamayla uyuşmazsa invalid_summary döner, hiçbir satır yazılmaz", async () => {
    await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId]);
    const snapshot = await rpc<{ sourceFingerprint: string; tasks: SnapshotTask[] }>("get_duty_plan_generation_snapshot", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
    });
    const teacherUniverse = await fetchTeacherUniverse();
    const built = buildAssignmentsAndSummary(snapshot.tasks, () => null, teacherUniverse);
    const wrongSummary = { ...built.summary, uncoveredCount: (built.summary.uncoveredCount as number) + 999 };

    const result = await callSave({ sourceFingerprint: snapshot.sourceFingerprint, assignments: built.rows, summary: wrongSummary });
    expect(result.status).toBe("invalid_summary");
    expect((result.authoritative as { uncoveredCount: number }).uncoveredCount).toBe(built.summary.uncoveredCount);

    const countAfter = (
      await client.query("select count(*)::int as c from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId])
    ).rows[0].c;
    expect(countAfter).toBe(0);

    // Doğru özetle aynı istek kabul edilir.
    const ok = await callSave({ sourceFingerprint: snapshot.sourceFingerprint, assignments: built.rows, summary: built.summary });
    expect(ok.status).toBe("ok");
    await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId]);
  });

  it("bulgu 2: sabit atama silinince taslak satırı KORUNUR, bağlantı NULL olur, plan stale görünür", async () => {
    await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId]);

    // Bu test için AYRI bir sabit atama kurulur (mevcut ILKOKUL1/T1 diğer
    // testleri etkilemesin diye) — ILKOKUL1 zaten yalnız bir sabit yer,
    // bu yüzden AYNI atamayı kullanıp test sonunda YENİDEN oluşturuyoruz.
    const snapshot = await rpc<{ sourceFingerprint: string; tasks: SnapshotTask[] }>("get_duty_plan_generation_snapshot", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
    });
    const teacherUniverse = await fetchTeacherUniverse();
    const built = buildAssignmentsAndSummary(snapshot.tasks, () => null, teacherUniverse);
    const saved = await callSave({ sourceFingerprint: snapshot.sourceFingerprint, assignments: built.rows, summary: built.summary });
    expect(saved.status).toBe("ok");
    const planId = saved.planId as string;

    const fixedRowBefore = await client.query(
      "select id, fixed_duty_assignment_id, assignment_kind from public.duty_plan_assignments where plan_id=$1 and duty_location_id=$2 and day_order=1",
      [planId, locIlkokul1],
    );
    expect(fixedRowBefore.rows).toHaveLength(2); // MORNING_BREAKS + AFTERNOON_BREAKS
    for (const row of fixedRowBefore.rows) {
      expect(row.fixed_duty_assignment_id).not.toBeNull();
      expect(row.assignment_kind).toBe("fixed");
    }

    // Kaynak sabit atamayı sil — CHECK (duty_plan_assignments_fixed_link_ck)
    // yalnız 'generated/manual/unassigned' + non-null id kombinasyonunu
    // yasaklar; 'fixed' + null id İZİNLİDİR, bu yüzden ON DELETE SET NULL
    // hatasız çalışmalı.
    const fixedAssignmentIdRes = await client.query(
      "select id from public.fixed_duty_assignments where academic_year_id=$1 and teacher_source_id='T1' and day_order=1",
      [yearId],
    );
    const deleteResult = await rpc<{ status: string }>("delete_fixed_duty_assignment", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_assignment_id: fixedAssignmentIdRes.rows[0].id,
    });
    expect(deleteResult.status).toBe("ok");

    const fixedRowAfter = await client.query(
      "select id, fixed_duty_assignment_id, assignment_kind, duty_location_name_snapshot from public.duty_plan_assignments where plan_id=$1 and duty_location_id=$2 and day_order=1",
      [planId, locIlkokul1],
    );
    expect(fixedRowAfter.rows).toHaveLength(2);
    for (const row of fixedRowAfter.rows) {
      expect(row.fixed_duty_assignment_id).toBeNull();
      expect(row.assignment_kind).toBe("fixed"); // satır SİLİNMEDİ, yalnız bağlantı null oldu.
    }

    const draftAfterDelete = await rpc<{ isStale: boolean; savedSourceFingerprint: string; currentSourceFingerprint: string }>("get_duty_plan_draft", {
      p_plan_id: planId,
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
    });
    expect(draftAfterDelete.isStale).toBe(true);
    expect(draftAfterDelete.currentSourceFingerprint).not.toBe(draftAfterDelete.savedSourceFingerprint);

    // Test sonrası: sabit atamayı ve taslağı geri kur ki sonraki testler etkilenmesin.
    const teacherIdRes = await client.query("select id from public.teachers where timetable_import_id=$1 and source_id='T1'", [importId]);
    await rpc("create_fixed_duty_assignment", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_teacher_id: teacherIdRes.rows[0].id,
      p_day_order: 1,
      p_duty_location_id: locIlkokul1,
    });
    await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId]);
  });

  it("bulgu 6: aynı short_code ile yeniden oluşturulan yer (yeni uuid) fingerprint'i değiştirir", async () => {
    const fpBefore = await rpc<string>("compute_duty_plan_source_fingerprint", { p_campus_name: campusName, p_academic_year_name: academicYearName });

    const tempShortCode = `TMPUUID${Date.now()}`.slice(0, 16);
    const tempId1 = await createDutyLocationId({ name: "Gecici Yer", shortCode: tempShortCode, category: "other" });
    const fpWithTemp = await rpc<string>("compute_duty_plan_source_fingerprint", { p_campus_name: campusName, p_academic_year_name: academicYearName });
    expect(fpWithTemp).not.toBe(fpBefore);

    // Soft-delete + AYNI short_code ile YENİDEN oluştur (yeni uuid, aynı içerik).
    await client.query("update public.duty_locations set deleted_at=now(), is_active=false where id=$1", [tempId1]);
    const fpAfterSoftDelete = await rpc<string>("compute_duty_plan_source_fingerprint", { p_campus_name: campusName, p_academic_year_name: academicYearName });
    expect(fpAfterSoftDelete).toBe(fpBefore); // pasif yer artık hash'e girmiyor — orijinal duruma döndü.

    // short_code immutable olduğu ve create_duty_location aynı kampüste
    // AKTİF bir short_code çakışmasını reddettiği için (partial unique index
    // yalnız deleted_at is null satırları kapsar) aynı kodla YENİDEN
    // oluşturma mümkündür.
    const tempId2 = await createDutyLocationId({ name: "Gecici Yer", shortCode: tempShortCode, category: "other" });
    expect(tempId2).not.toBe(tempId1);
    const fpAfterRecreate = await rpc<string>("compute_duty_plan_source_fingerprint", { p_campus_name: campusName, p_academic_year_name: academicYearName });
    // AYNI içerik (short_code/ad/kategori), FARKLI uuid → fingerprint fpWithTemp
    // ile AYNI OLMAMALI (id dahil edildiği için) ama fpBefore'dan da FARKLI olmalı.
    expect(fpAfterRecreate).not.toBe(fpBefore);
    expect(fpAfterRecreate).not.toBe(fpWithTemp);

    await client.query("update public.duty_locations set deleted_at=now(), is_active=false where id=$1", [tempId2]);
  });

  it("bulgu 6: is_included=false öğretmenin tercih değişikliği fingerprint'i değiştirmez; tekrar true yapınca değişir", async () => {
    await client.query("update public.teacher_duty_settings set is_included=false where academic_year_id=$1 and teacher_source_id='T3'", [yearId]);
    const fpExcluded = await rpc<string>("compute_duty_plan_source_fingerprint", { p_campus_name: campusName, p_academic_year_name: academicYearName });

    // T3 dışlanmışken tercih satırı ekle/kaldır — GÖRÜNMEZ olmalı.
    await client.query(
      `insert into public.teacher_duty_block_availabilities (campus_id, teacher_duty_setting_id, duty_location_id, day_order, duty_block_id)
       select $1, s.id, $2, 4, $3 from public.teacher_duty_settings s where s.academic_year_id=$4 and s.teacher_source_id='T3'`,
      [campusId, locBahce1, blockIds.MORNING_BREAKS, yearId],
    );
    const fpAfterPrefChange = await rpc<string>("compute_duty_plan_source_fingerprint", { p_campus_name: campusName, p_academic_year_name: academicYearName });
    expect(fpAfterPrefChange).toBe(fpExcluded);

    await client.query(
      "delete from public.teacher_duty_block_availabilities where duty_location_id=$1 and day_order=4 and duty_block_id=$2",
      [locBahce1, blockIds.MORNING_BREAKS],
    );

    // Tekrar dahil et — fingerprint DEĞİŞMELİ (settings bölümü zaten is_included'ı hash'liyor).
    await client.query("update public.teacher_duty_settings set is_included=true where academic_year_id=$1 and teacher_source_id='T3'", [yearId]);
    const fpReincluded = await rpc<string>("compute_duty_plan_source_fingerprint", { p_campus_name: campusName, p_academic_year_name: academicYearName });
    expect(fpReincluded).not.toBe(fpExcluded);
  });

  it("bulgu (teacherLoads evren uyumsuzluğu) senaryo A: sıfır yüklü dahil öğretmen (T2) özet içinde korunur", async () => {
    await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId]);
    const snapshot = await rpc<{ sourceFingerprint: string; tasks: SnapshotTask[] }>("get_duty_plan_generation_snapshot", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
    });
    const day2Bahce = snapshot.tasks.find((t) => t.kind === "normal" && t.dutyLocationId === locBahce1 && t.dayOrder === 2);
    expect(day2Bahce).toBeDefined();

    const teacherUniverse = await fetchTeacherUniverse();
    expect(teacherUniverse).toEqual(expect.arrayContaining(["T1", "T2", "T3", "T4", "T5"]));

    const built = buildAssignmentsAndSummary(snapshot.tasks, (t) => (t === day2Bahce ? "T1" : null), teacherUniverse);
    const t2Load = built.summary.teacherLoads.find((l) => l.teacherSourceId === "T2");
    expect(t2Load).toEqual({ teacherSourceId: "T2", normalDutyCount: 0, fixedDutyDayCount: 0, totalDutyCount: 0 });

    const saved = await callSave({ sourceFingerprint: snapshot.sourceFingerprint, assignments: built.rows, summary: built.summary });
    expect(saved.status).toBe("ok");

    const draft = await rpc<{ summary: { teacherLoads: { teacherSourceId: string }[] } }>("get_duty_plan_draft", {
      p_plan_id: saved.planId,
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
    });
    expect(draft.summary.teacherLoads.some((l) => l.teacherSourceId === "T2")).toBe(true);

    await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId]);
  });

  it("bulgu (teacherLoads evren uyumsuzluğu) senaryo B: sıfır-yüklü öğretmen özetten eksikse invalid_summary, hiçbir satır yazılmaz", async () => {
    await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId]);
    const snapshot = await rpc<{ sourceFingerprint: string; tasks: SnapshotTask[] }>("get_duty_plan_generation_snapshot", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
    });
    const day2Bahce = snapshot.tasks.find((t) => t.kind === "normal" && t.dutyLocationId === locBahce1 && t.dayOrder === 2);
    const teacherUniverse = await fetchTeacherUniverse();
    const built = buildAssignmentsAndSummary(snapshot.tasks, (t) => (t === day2Bahce ? "T1" : null), teacherUniverse);

    const summaryMissingT2 = { ...built.summary, teacherLoads: built.summary.teacherLoads.filter((l) => l.teacherSourceId !== "T2") };
    const result = await callSave({ sourceFingerprint: snapshot.sourceFingerprint, assignments: built.rows, summary: summaryMissingT2 });
    expect(result.status).toBe("invalid_summary");
    const authoritativeLoads = (result.authoritative as { teacherLoads: { teacherSourceId: string }[] }).teacherLoads;
    expect(authoritativeLoads.some((l) => l.teacherSourceId === "T2")).toBe(true);

    const countAfter = (
      await client.query("select count(*)::int as c from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId])
    ).rows[0].c;
    expect(countAfter).toBe(0);
  });

  it("bulgu (teacherLoads evren uyumsuzluğu) senaryo C: yalnız sabit nöbeti bulunan öğretmen (T4) doğru yükle görünür", async () => {
    await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId]);
    const snapshot = await rpc<{ sourceFingerprint: string; tasks: SnapshotTask[] }>("get_duty_plan_generation_snapshot", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
    });
    // T4'ün candidateEdges'te HİÇ görünmediğini doğrula (hiç uygunluk beyanı yok).
    const candidateEdges = await rpc<{ candidateEdges: { teacherSourceId: string }[] }>("get_duty_plan_generation_snapshot", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
    });
    expect(candidateEdges.candidateEdges.some((e) => e.teacherSourceId === "T4")).toBe(false);

    const teacherUniverse = await fetchTeacherUniverse();
    const built = buildAssignmentsAndSummary(snapshot.tasks, () => null, teacherUniverse);
    const t4Load = built.summary.teacherLoads.find((l) => l.teacherSourceId === "T4");
    expect(t4Load).toEqual({ teacherSourceId: "T4", normalDutyCount: 0, fixedDutyDayCount: 1, totalDutyCount: 1 });

    const saved = await callSave({ sourceFingerprint: snapshot.sourceFingerprint, assignments: built.rows, summary: built.summary });
    expect(saved.status).toBe("ok");
    await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId]);
  });

  it("bulgu (teacherLoads evren uyumsuzluğu) senaryo D: 2 sabit gün + 2 normal görev — max=3 reddeder, 1 normale düşünce kabul eder", async () => {
    await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId]);
    const snapshot = await rpc<{ sourceFingerprint: string; tasks: SnapshotTask[] }>("get_duty_plan_generation_snapshot", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
    });
    const t5NormalTasks = snapshot.tasks.filter(
      (t) => t.kind === "normal" && t.dutyLocationId === locBahce1 && t.dutyBlockId === blockIds.MORNING_BREAKS && (t.dayOrder === 1 || t.dayOrder === 2),
    );
    expect(t5NormalTasks).toHaveLength(2);
    const teacherUniverse = await fetchTeacherUniverse();

    // 2 sabit (day3,day4) + 2 normal (day1,day2) = 4 > max(3) → tüm istek atomik reddedilir.
    const builtTwoNormal = buildAssignmentsAndSummary(snapshot.tasks, (t) => (t5NormalTasks.includes(t) ? "T5" : null), teacherUniverse);
    const t5LoadTwoNormal = builtTwoNormal.summary.teacherLoads.find((l) => l.teacherSourceId === "T5");
    // fixedDutyDayCount İKİ AYRI GÜN'den (day3,day4) gelir — 4 hücreden değil, 2'dir.
    expect(t5LoadTwoNormal).toEqual({ teacherSourceId: "T5", normalDutyCount: 2, fixedDutyDayCount: 2, totalDutyCount: 4 });

    const rejected = await rpc<{ status: string }>("save_duty_plan_draft", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_expected_source_fingerprint: snapshot.sourceFingerprint,
      p_algorithm_version: "test-v1",
      p_generation_seed: 1,
      p_generation_options: { maxWeeklyDuties: 3, targetWeeklyDuties: 3, minWeeklyDuties: 0 },
      p_assignments: builtTwoNormal.rows,
      p_summary: builtTwoNormal.summary,
      p_allow_partial: true,
      p_expected_plan_id: null,
    });
    expect(rejected.status).toBe("weekly_limit_exceeded");
    const countAfterReject = (
      await client.query("select count(*)::int as c from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId])
    ).rows[0].c;
    expect(countAfterReject).toBe(0);

    // Yalnız 1 normal (day1) + 2 sabit = 3 <= max(3) → kabul edilir.
    const builtOneNormal = buildAssignmentsAndSummary(snapshot.tasks, (t) => (t === t5NormalTasks[0] ? "T5" : null), teacherUniverse);
    const t5LoadOneNormal = builtOneNormal.summary.teacherLoads.find((l) => l.teacherSourceId === "T5");
    expect(t5LoadOneNormal).toEqual({ teacherSourceId: "T5", normalDutyCount: 1, fixedDutyDayCount: 2, totalDutyCount: 3 });

    const accepted = await rpc<{ status: string }>("save_duty_plan_draft", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_expected_source_fingerprint: snapshot.sourceFingerprint,
      p_algorithm_version: "test-v1",
      p_generation_seed: 1,
      p_generation_options: { maxWeeklyDuties: 3, targetWeeklyDuties: 3, minWeeklyDuties: 0 },
      p_assignments: builtOneNormal.rows,
      p_summary: builtOneNormal.summary,
      p_allow_partial: true,
      p_expected_plan_id: null,
    });
    expect(accepted.status).toBe("ok");
    await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId]);
  });

  it.skipIf(!serviceIntegrationEnabled)(
    "bulgu (teacherLoads evren uyumsuzluğu) senaryo E: gerçek servis zinciri (snapshot→solver→save) adaysız dahil öğretmenle ok döner",
    async () => {
      await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId]);
      const supabase = createClient(API_URL as string, SERVICE_KEY as string, { auth: { persistSession: false } });

      // Elle DB formülünü kopyalayan bir test yardımcı KULLANILMAZ — gerçek
      // server/services/dutyPlanGeneration.ts zinciri (snapshot RPC → solveDutyPlan
      // → save_duty_plan_draft RPC) doğrudan çağrılır.
      const result = await generateDutyPlanDraft(supabase, campusName, academicYearName, { allowPartial: true }, null);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        const t2Load = result.summary.teacherLoads.find((l) => l.teacherSourceId === "T2");
        expect(t2Load).toEqual({ teacherSourceId: "T2", normalDutyCount: 0, fixedDutyDayCount: 0, totalDutyCount: 0 });
      }

      await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2", [campusId, yearId]);
    },
  );

  it("RLS: anon rolü tablolara veya RPC'lere erişemez", async () => {
    await client.query("begin");
    try {
      await client.query("set local role anon");
      await expect(client.query("select id from public.duty_plans limit 1")).rejects.toThrow();
    } finally {
      await client.query("rollback");
    }
  });

  it("yetki: anon rolü RPC'leri çağıramaz (execute yok)", async () => {
    await client.query("begin");
    try {
      await client.query("set local role anon");
      await expect(
        client.query("select public.get_duty_plan_generation_snapshot($1,$2) as result", [campusName, academicYearName]),
      ).rejects.toThrow();
    } finally {
      await client.query("rollback");
    }
  });
});
