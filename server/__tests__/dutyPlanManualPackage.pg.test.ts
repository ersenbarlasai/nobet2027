import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createServerSupabaseClient } from "../supabase";
import type { AppConfig } from "../config";
import { generateDutyPlanDraft } from "../services/dutyPlanGeneration";

/**
 * GERÇEK PostgreSQL testleri — preview_duty_plan_manual_package / set_duty_
 * plan_manual_package RPC'lerini DOĞRUDAN çağırır (route/UI henüz YOK,
 * bilerek — bu tur yalnız migration+solver+servis çekirdeğini kapsıyor).
 * Aynı kurulum deseni: server/__tests__/dutyPlanManualAndPublish.pg.test.ts.
 *
 *   DUTY_PLAN_PG_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
 *   DUTY_PLAN_PG_TEST_API_URL=http://127.0.0.1:54321
 *   DUTY_PLAN_PG_TEST_SERVICE_KEY=<npx supabase status'un SERVICE_ROLE_KEY'i>
 */
const DB_URL = process.env.DUTY_PLAN_PG_TEST_DB_URL;
const API_URL = process.env.DUTY_PLAN_PG_TEST_API_URL;
const SERVICE_KEY = process.env.DUTY_PLAN_PG_TEST_SERVICE_KEY;
const enabled = Boolean(DB_URL) && Boolean(API_URL) && Boolean(SERVICE_KEY);

describe.skipIf(!enabled)("nöbet planı — manuel paket RPC'leri (gerçek PostgreSQL)", () => {
  let client: Client;
  let client2: Client;
  let supabase: ReturnType<typeof createServerSupabaseClient>;
  let campusName: string;
  let academicYearName: string;
  let campusId: string;
  let yearId: string;
  let importId: string;
  let locA: string; // BALKON — 4 blok, FULL_DAY/SHORT_BREAKS test yeri
  let locB: string; // ZEMIN — 4 blok, "BAŞKA YER" regresyon testi
  let locFixed: string; // ILKOKUL — allows_fixed_assignment, sabit paket
  let blockIds: Record<string, string> = {};
  const teacherIds = new Map<string, string>();

  function toSqlParam(value: unknown): unknown {
    // uuid[]/text[] parametreleri (ör. p_expected_affected_task_ids) JS
    // dizisi olarak BIRAKILIR — node-pg bunu doğru pg dizi biçimine
    // (`{a,b}`) çevirir; JSON.stringify ("[\"a\",\"b\"]") YANLIŞ biçim
    // üretip "malformed array literal" hatası verirdi. Yalnız düz (dizi
    // OLMAYAN) nesneler jsonb parametreleri için JSON'a çevrilir.
    if (Array.isArray(value)) return value;
    if (value !== null && typeof value === "object") return JSON.stringify(value);
    return value;
  }
  async function rpc<T>(fn: string, args: Record<string, unknown>, c: Client = client): Promise<T> {
    const argNames = Object.keys(args);
    const namedArgs = argNames.map((name, i) => `${name} := $${i + 1}`).join(", ");
    const sql = `select public.${fn}(${namedArgs}) as result`;
    const res = await c.query(sql, argNames.map((name) => toSqlParam(args[name])));
    return res.rows[0].result as T;
  }

  async function createLocation(name: string, shortCode: string, category: string): Promise<string> {
    await rpc("create_duty_location", { p_campus_id: campusId, p_name: name, p_short_code: shortCode, p_category: category, p_capacity: 1, p_description: null, p_is_active: true });
    const res = await client.query("select id from public.duty_locations where campus_id=$1 and upper(short_code)=upper($2)", [campusId, shortCode]);
    return res.rows[0].id as string;
  }

  async function addPreference(teacherSourceId: string, locId: string, dayOrder: number, blockCode: string): Promise<void> {
    const settingRes = await client.query("select id from public.teacher_duty_settings where academic_year_id=$1 and teacher_source_id=$2", [yearId, teacherSourceId]);
    await client.query(
      `insert into public.teacher_duty_block_availabilities (campus_id, teacher_duty_setting_id, duty_location_id, day_order, duty_block_id)
       values ($1,$2,$3,$4,$5) on conflict do nothing`,
      [campusId, settingRes.rows[0].id, locId, dayOrder, blockIds[blockCode]],
    );
  }

  async function currentPlan(): Promise<{ id: string; version: number } | null> {
    const res = await client.query("select id, version from public.duty_plans where campus_id=$1 and academic_year_id=$2 and status='draft'", [campusId, yearId]);
    return res.rows[0] ?? null;
  }

  async function generateFreshDraft(): Promise<{ id: string; version: number }> {
    await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2 and status='draft'", [campusId, yearId]);
    const result = await generateDutyPlanDraft(supabase, campusName, academicYearName, { allowPartial: true, maxWeeklyDuties: 5, targetWeeklyDuties: 2, minWeeklyDuties: 0 }, null);
    if (result.status !== "ok") throw new Error(`beklenmeyen generate durumu: ${result.status}`);
    return { id: result.planId, version: result.version };
  }

  /** Verilen plan+gün+yer+öğretmen için manuel paket yazar (affectedTasks gerekmiyorsa doğrudan başarır). */
  async function setPackage(args: {
    planId: string;
    version: number;
    dayOrder: number;
    dutyLocationId: string;
    teacherSourceId: string | null;
    coverageMode: string;
    dutyBlockId?: string | null;
    expectedAffectedTaskIds?: string[] | null;
  }) {
    return rpc<{ status: string; [k: string]: unknown }>("set_duty_plan_manual_package", {
      p_plan_id: args.planId,
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_day_order: args.dayOrder,
      p_duty_location_id: args.dutyLocationId,
      p_teacher_source_id: args.teacherSourceId,
      p_coverage_mode: args.coverageMode,
      p_expected_plan_version: args.version,
      p_expected_affected_task_ids: args.expectedAffectedTaskIds ?? null,
      p_duty_block_id: args.dutyBlockId ?? null,
    });
  }

  async function fullSnapshot(planId: string) {
    const assignments = (
      await client.query(
        `select id, day_order, duty_location_id, duty_block_id, teacher_source_id, teacher_name_snapshot, assignment_kind, package_id, updated_at
           from public.duty_plan_assignments where plan_id=$1 order by day_order, duty_location_id, duty_block_id`,
        [planId],
      )
    ).rows;
    const packages = (
      await client.query(
        `select id, day_order, duty_location_id, teacher_source_id, coverage_mode, assignment_kind, updated_at
           from public.duty_plan_assignment_packages where plan_id=$1 order by day_order, duty_location_id, teacher_source_id`,
        [planId],
      )
    ).rows;
    return { assignments, packages };
  }

  /**
   * Belirli bir (gün, yer) hücre grubunu YALIN unassigned durumuna sıfırlar
   * (raw SQL, RPC dışı) — generateFreshDraft solver'ı bu hücreleri OTOMATİK
   * doldurmuş olabileceği için, "temiz tahta" gerektiren testler bunu kendi
   * hedef (gün,yer) çiftinde açıkça çağırır.
   */
  async function clearCell(planId: string, dayOrder: number, dutyLocationId: string): Promise<void> {
    // ÖNCE hücreleri unassigned yap (package_id=null İLE assignment_kind=
    // 'unassigned' AYNI anda), SONRA paketi sil — ters sıra bir an için
    // ON DELETE SET NULL'ın package_id=null + assignment_kind='generated'
    // kombinasyonunu üretip presence CHECK'ini ihlal ederdi (bkz. migration'da
    // AYNI bulgu).
    const pkgIds = (
      await client.query("select distinct package_id from public.duty_plan_assignments where plan_id=$1 and day_order=$2 and duty_location_id=$3 and package_id is not null", [
        planId,
        dayOrder,
        dutyLocationId,
      ])
    ).rows.map((r: { package_id: string }) => r.package_id);
    await client.query(
      `update public.duty_plan_assignments
          set teacher_source_id=null, teacher_name_snapshot=null, assignment_kind='unassigned', package_id=null
        where plan_id=$1 and day_order=$2 and duty_location_id=$3`,
      [planId, dayOrder, dutyLocationId],
    );
    if (pkgIds.length > 0) {
      await client.query("delete from public.duty_plan_assignment_packages where id = any($1)", [pkgIds]);
    }
  }

  /** Bir öğretmenin plandaki TÜM paketlerini (ve o hücrelerini) temizler. */
  async function clearTeacherPackages(planId: string, teacherSourceId: string): Promise<void> {
    const pkgIds = (await client.query("select id from public.duty_plan_assignment_packages where plan_id=$1 and teacher_source_id=$2", [planId, teacherSourceId])).rows.map(
      (r: { id: string }) => r.id,
    );
    if (pkgIds.length === 0) return;
    await client.query(
      `update public.duty_plan_assignments
          set teacher_source_id=null, teacher_name_snapshot=null, assignment_kind='unassigned', package_id=null
        where package_id = any($1)`,
      [pkgIds],
    );
    await client.query("delete from public.duty_plan_assignment_packages where id = any($1)", [pkgIds]);
  }

  beforeAll(async () => {
    client = new Client({ connectionString: DB_URL });
    await client.connect();
    client2 = new Client({ connectionString: DB_URL });
    await client2.connect();
    await client.query("grant usage on schema public to service_role");
    await client.query("grant all on all tables in schema public to service_role");
    await client.query("grant all on all sequences in schema public to service_role");

    const config: AppConfig = {
      supabaseUrl: API_URL as string,
      supabaseSecretKey: SERVICE_KEY as string,
      port: 0,
      allowedOrigin: "http://127.0.0.1",
      campusName: "",
      academicYearName: "",
    };
    supabase = createServerSupabaseClient(config);

    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    campusName = `PG Manuel Paket Kampus ${suffix}`;
    academicYearName = `PG Manuel Paket Yil ${suffix}`;

    const campusRes = await client.query("insert into public.campuses (name) values ($1) returning id", [campusName]);
    campusId = campusRes.rows[0].id;
    const yearRes = await client.query("insert into public.academic_years (campus_id, name, is_active) values ($1,$2,true) returning id", [campusId, academicYearName]);
    yearId = yearRes.rows[0].id;

    const sourceSha256 = suffix.padEnd(64, "0").slice(0, 64);
    const importRes = await client.query(
      `insert into public.timetable_imports (campus_id, academic_year_id, source_format, source_filename, source_sha256, status, imported_at)
       values ($1,$2,'asc-xml','pg-test.xml',$3,'imported', now()) returning id`,
      [campusId, yearId, sourceSha256],
    );
    importId = importRes.rows[0].id;

    for (let d = 1; d <= 5; d++) {
      await client.query("insert into public.timetable_days (timetable_import_id, source_id, name, day_order) values ($1,$2,$3,$4)", [importId, `d${d}`, `Gun ${d}`, d]);
    }

    // 5-OO/5-IO komşu periyot kuralı için ZORUNLU: bu periyotlar importta
    // TANIMLI DEĞİLSE is_teacher_eligible_for_duty_block_time LONG_BREAK_1/2
    // için GÜVENLİ VARSAYILAN olarak HER ZAMAN false döner (period_
    // configuration_missing) — hiç ders atanmasa BİLE. Bu testler LONG_BREAK
    // bloklarını (FULL_DAY paketinin parçası) kullandığı için periyotlar
    // burada TANIMLANMALI (ders KARTI eklenmez — hiçbir öğretmen bu
    // periyotlarda meşgul değildir, dolayısıyla hepsi zaman kuralına uygun
    // kalır).
    for (const p of [
      { name: "4", order: 4 },
      { name: "5-OO", order: 5 },
      { name: "5-IO", order: 6 },
      { name: "6", order: 7 },
    ]) {
      await client.query("insert into public.lesson_periods (timetable_import_id, source_id, name, period_order) values ($1,$2,$3,$4)", [importId, p.name, p.name, p.order]);
    }

    for (const sourceId of ["T1", "T2", "T3", "T4", "T5"]) {
      const res = await client.query("insert into public.teachers (timetable_import_id, source_id, name) values ($1,$2,$3) returning id", [importId, sourceId, `Ogretmen ${sourceId}`]);
      teacherIds.set(sourceId, res.rows[0].id);
    }

    const blocksRes = await client.query("select id, code from public.duty_blocks where is_active");
    blockIds = Object.fromEntries(blocksRes.rows.map((r: { id: string; code: string }) => [r.code, r.id]));

    locA = await createLocation("Balkon", `BALKON${suffix}`.slice(0, 16), "corridor"); // dört blok (create_duty_location varsayılanı)
    locB = await createLocation("Zemin", `ZEMIN${suffix}`.slice(0, 16), "corridor"); // dört blok
    locFixed = await createLocation("Ilkokul", `ILKOKUL${suffix}`.slice(0, 16), "corridor");
    await client.query("update public.duty_locations set allows_fixed_assignment=true where id=$1", [locFixed]);
    await client.query("delete from public.duty_location_blocks where duty_location_id=$1 and duty_block_id not in ($2,$3)", [
      locFixed,
      blockIds.MORNING_BREAKS,
      blockIds.AFTERNOON_BREAKS,
    ]);

    for (const sourceId of ["T1", "T2", "T3", "T4", "T5"]) {
      await client.query(
        `insert into public.teacher_duty_settings (campus_id, academic_year_id, teacher_source_id, teacher_name_snapshot, is_included)
         values ($1,$2,$3,$4,true)`,
        [campusId, yearId, sourceId, `Ogretmen ${sourceId}`],
      );
    }

    // T1/T2: locA'nın dört bloğuna da gün 1,2 için aday (FULL_DAY mümkün).
    for (const t of ["T1", "T2"]) {
      for (const day of [1, 2]) {
        for (const code of ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"]) {
          await addPreference(t, locA, day, code);
        }
      }
    }
    // T3: locB'nin dört bloğuna gün 1 için aday (BAŞKA YER regresyonu).
    for (const code of ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"]) {
      await addPreference("T3", locB, 1, code);
    }
    // T4: locA Sabah+ÖS gün 1 (SHORT_BREAKS adayı — affectedTasks testi için).
    await addPreference("T4", locA, 1, "MORNING_BREAKS");
    await addPreference("T4", locA, 1, "AFTERNOON_BREAKS");

    // locFixed'de T5 için sabit nöbet (gün 1) — "başka yerdeki fixed paket
    // hedef işlemi engellemez" regresyonu (T5 BAŞKA hiçbir testte
    // kullanılmaz, çakışma riski olmasın diye).
    await rpc("create_fixed_duty_assignment", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_teacher_id: teacherIds.get("T5"),
      p_day_order: 1,
      p_duty_location_id: locFixed,
    });
  }, 60000);

  afterAll(async () => {
    if (client && campusId) {
      // BULGU (bkz. dutyPlanManualAndPublish.pg.test.ts): replica modu FK
      // CASCADE'i de devre dışı bırakır — çocuk tablolar burada AÇIKÇA,
      // ebeveynden ÖNCE silinir (aksi halde YETİM satırlar kalır ve bu,
      // BAŞKA pg test dosyalarını — özellikle migration testini — bozar).
      await client.query("set session_replication_role = replica");
      await client.query(
        "delete from public.duty_plan_assignment_packages where plan_id in (select id from public.duty_plans where campus_id=$1)",
        [campusId],
      );
      await client.query("delete from public.duty_plan_assignments where plan_id in (select id from public.duty_plans where campus_id=$1)", [campusId]);
      await client.query("delete from public.duty_plans where campus_id=$1", [campusId]);
      await client.query("delete from public.campuses where id=$1", [campusId]);
      await client.query("set session_replication_role = default");
    }
    if (client) await client.end();
    if (client2) await client2.end();
  });

  it("başka gün/yer paketi set_duty_plan_manual_package'tan ETKİLENMEZ (bulgu 2 regresyonu)", async () => {
    const draft = await generateFreshDraft();

    // locB/gün1'e T3'ü SHORT_BREAKS ata — bu paket "kontrol" (dokunulmaması
    // gereken) paket olacak. locB dört blok olduğu için FULL_DAY dener.
    const setB = await setPackage({ planId: draft.id, version: draft.version, dayOrder: 1, dutyLocationId: locB, teacherSourceId: "T3", coverageMode: "FULL_DAY" });
    expect(setB.status).toBe("ok");
    const afterB = await fullSnapshot(draft.id);
    const controlPkg = afterB.packages.find((p: { duty_location_id: string }) => p.duty_location_id === locB);
    expect(controlPkg).toBeTruthy();
    const controlSnapshotBefore = JSON.stringify(afterB.packages.find((p: { id: string }) => p.id === controlPkg.id));
    const controlAssignmentsBefore = JSON.stringify(afterB.assignments.filter((a: { duty_location_id: string }) => a.duty_location_id === locB));

    // ŞİMDİ locA/gün1'e (AYNI blok TÜRLERİNİ — MORNING_BREAKS/LONG_BREAK_1/2/
    // AFTERNOON_BREAKS — kullanan FARKLI bir yer) T1 FULL_DAY ata. Eski
    // (buggy) sürüm, duty_block_id eşleşmesiyle locB'nin paketini de
    // "dokunulan" sayardı.
    const planAfterB = await currentPlan();
    const setA = await setPackage({ planId: draft.id, version: planAfterB!.version, dayOrder: 1, dutyLocationId: locA, teacherSourceId: "T1", coverageMode: "FULL_DAY" });
    expect(setA.status).toBe("ok");

    const afterA = await fullSnapshot(draft.id);
    const controlPkgAfter = afterA.packages.find((p: { id: string }) => p.id === controlPkg.id);
    expect(JSON.stringify(controlPkgAfter)).toBe(controlSnapshotBefore);
    const controlAssignmentsAfter = JSON.stringify(afterA.assignments.filter((a: { duty_location_id: string }) => a.duty_location_id === locB));
    expect(controlAssignmentsAfter).toBe(controlAssignmentsBefore);
  });

  it("başka yerdeki FIXED paket (aynı blok türü) hedef işlemi yanlışlıkla engellemez", async () => {
    const draft = await generateFreshDraft();
    // locA/gün1 solver tarafından zaten doldurulmuş olabilir (T1/T2 FULL_DAY
    // adayı) — "temiz tahta" için bilerek sıfırlanır; asıl test edilen locA
    // İLE İLGİSİZ olan locFixed/gün1'deki T5 fixed paketinin bu işlemi
    // ETKİLEMEDİĞİDİR.
    await clearCell(draft.id, 1, locA);
    const planNow = await currentPlan();
    // locFixed/gün1'de T5 fixed (Sabah+ÖS) zaten var (beforeAll). locA/gün1'e
    // T1 SHORT_BREAKS (Sabah+ÖS — AYNI blok türleri) ata — eski (buggy)
    // sürüm bunu locFixed'in fixed paketine "dokunuyor" sanıp fixed_task_
    // immutable ile REDDEDERDİ.
    const res = await setPackage({ planId: draft.id, version: planNow!.version, dayOrder: 1, dutyLocationId: locA, teacherSourceId: "T1", coverageMode: "SHORT_BREAKS" });
    expect(res.status).toBe("ok");
  });

  it("geçersiz istekte (no_preference_for_cell) SIFIR kısmi yazma — hiçbir satır/hash değişmez", async () => {
    const draft = await generateFreshDraft();
    const before = await fullSnapshot(draft.id);

    // T2, locA/gün1'in TÜM bloklarına aday AMA burada BİLEREK locA/gün 5'e
    // (hiç tercihi olmayan bir güne) atanmaya çalışılıyor.
    const res = await setPackage({ planId: draft.id, version: draft.version, dayOrder: 5, dutyLocationId: locA, teacherSourceId: "T2", coverageMode: "FULL_DAY" });
    expect(res.status).toBe("no_preference_for_cell");

    const after = await fullSnapshot(draft.id);
    expect(after).toEqual(before);

    const planNow = await currentPlan();
    expect(planNow?.version).toBe(draft.version);
  });

  it("weekly_limit_exceeded durumunda da SIFIR kısmi yazma", async () => {
    const draft = await generateFreshDraft();
    // T1'in solver tarafından ÜRETİLMİŞ olabilecek TÜM paketlerini VE
    // locA/gün1-2 hücrelerini (başka bir öğretmenle dolu olabilir) temizle —
    // bu test T1'in yükünü SIFIRDAN, temiz bir tahtada kontrol etmek istiyor.
    await clearTeacherPackages(draft.id, "T1");
    await clearCell(draft.id, 1, locA);
    await clearCell(draft.id, 2, locA);
    // T1'i max=0 senaryosuna zorlamak yerine: T1'i locA/gün1 FULL_DAY'e ata,
    // sonra locA/gün2 FULL_DAY'i de T1'e vermeyi dene ama maxWeeklyDuties'i
    // aşacak şekilde plan'ın generation_options'ını 1'e indir.
    await client.query("update public.duty_plans set generation_options = generation_options || '{\"maxWeeklyDuties\":1}'::jsonb where id=$1", [draft.id]);
    const planBefore = await currentPlan();
    const first = await setPackage({ planId: draft.id, version: planBefore!.version, dayOrder: 1, dutyLocationId: locA, teacherSourceId: "T1", coverageMode: "FULL_DAY" });
    expect(first.status).toBe("ok");

    const before = await fullSnapshot(draft.id);
    const planNow = await currentPlan();
    const second = await setPackage({ planId: draft.id, version: planNow!.version, dayOrder: 2, dutyLocationId: locA, teacherSourceId: "T1", coverageMode: "FULL_DAY" });
    expect(second.status).toBe("weekly_limit_exceeded");

    const after = await fullSnapshot(draft.id);
    expect(after).toEqual(before);
  });

  it("affectedTasks YALNIZ gerçekten bölünecek hedef paket hücrelerinden oluşur", async () => {
    const draft = await generateFreshDraft();
    const t1Full = await setPackage({ planId: draft.id, version: draft.version, dayOrder: 1, dutyLocationId: locA, teacherSourceId: "T1", coverageMode: "FULL_DAY" });
    expect(t1Full.status).toBe("ok");

    const planNow = await currentPlan();
    // T4'ü AYNI gün/yerde SHORT_BREAKS'e atamayı dene — bu, T1'in FULL_DAY
    // paketinin MORNING/AFTERNOON hücrelerini hedefler, LONG_BREAK_1/2
    // hücreleri hedef DIŞINDA kalır → affectedTasks TAM OLARAK bu iki hücre
    // olmalı (T1'in paketinin TAMAMI değil, yalnız hedef dışı kalanlar).
    const preview = await setPackage({ planId: draft.id, version: planNow!.version, dayOrder: 1, dutyLocationId: locA, teacherSourceId: "T4", coverageMode: "SHORT_BREAKS" });
    expect(preview.status).toBe("requires_confirmation");
    const affected = (preview as unknown as { affectedTasks: { dutyBlockId: string }[] }).affectedTasks;
    expect(affected).toHaveLength(2);
    const affectedBlockIds = affected.map((a) => a.dutyBlockId).sort();
    expect(affectedBlockIds).toEqual([blockIds.LONG_BREAK_1, blockIds.LONG_BREAK_2].sort());

    // Onaylı çağrı: doğru affectedTaskIds ile geçmeli.
    const affectedIds = affected.map((a: { id?: string } & { dutyBlockId: string }) => (a as unknown as { id: string }).id);
    const confirmed = await setPackage({
      planId: draft.id,
      version: planNow!.version,
      dayOrder: 1,
      dutyLocationId: locA,
      teacherSourceId: "T4",
      coverageMode: "SHORT_BREAKS",
      expectedAffectedTaskIds: affectedIds,
    });
    expect(confirmed.status).toBe("ok");

    // T1'in eski paketi bölündü: LONG_BREAK_1/2 artık unassigned.
    const after = await fullSnapshot(draft.id);
    const longCells = after.assignments.filter(
      (a: { duty_block_id: string; day_order: number; duty_location_id: string }) =>
        a.day_order === 1 && a.duty_location_id === locA && (a.duty_block_id === blockIds.LONG_BREAK_1 || a.duty_block_id === blockIds.LONG_BREAK_2),
    );
    for (const cell of longCells as { assignment_kind: string; package_id: string | null }[]) {
      expect(cell.assignment_kind).toBe("unassigned");
      expect(cell.package_id).toBeNull();
    }
  });

  it("eşzamanlı iki manuel paket değişikliği: aynı expectedPlanVersion ile biri ok, diğeri version_conflict", async () => {
    const draft = await generateFreshDraft();
    const callA = setPackage({ planId: draft.id, version: draft.version, dayOrder: 1, dutyLocationId: locA, teacherSourceId: "T1", coverageMode: "FULL_DAY" });
    const callB = rpc<{ status: string }>(
      "set_duty_plan_manual_package",
      {
        p_plan_id: draft.id,
        p_campus_name: campusName,
        p_academic_year_name: academicYearName,
        p_day_order: 2,
        p_duty_location_id: locA,
        p_teacher_source_id: "T2",
        p_coverage_mode: "FULL_DAY",
        p_expected_plan_version: draft.version,
        p_expected_affected_task_ids: null,
        p_duty_block_id: null,
      },
      client2,
    );
    const [ra, rb] = await Promise.all([callA, callB]);
    const statuses = [ra.status, rb.status];
    expect(statuses.filter((s) => s === "ok")).toHaveLength(1);
    expect(statuses.filter((s) => s === "version_conflict")).toHaveLength(1);
  });

  it("iki bağımsız gün, dört uygun öğretmen → gerçek generate akışında 2 FULL_DAY paketi birlikte seçilir", async () => {
    await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2 and status='draft'", [campusId, yearId]);
    const result = await generateDutyPlanDraft(supabase, campusName, academicYearName, { allowPartial: true, maxWeeklyDuties: 5, targetWeeklyDuties: 2, minWeeklyDuties: 0 }, null);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const packagesA = await client.query(
      "select coverage_mode, day_order from public.duty_plan_assignment_packages where plan_id=$1 and duty_location_id=$2 order by day_order",
      [result.planId, locA],
    );
    const day1 = packagesA.rows.find((r: { day_order: number }) => r.day_order === 1);
    const day2 = packagesA.rows.find((r: { day_order: number }) => r.day_order === 2);
    expect(day1?.coverage_mode).toBe("FULL_DAY");
    expect(day2?.coverage_mode).toBe("FULL_DAY");
  });
});
