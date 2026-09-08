import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { generateDutyPlanDraft } from "../services/dutyPlanGeneration";
import { createServerSupabaseClient } from "../supabase";
import type { AppConfig } from "../config";

/**
 * GERÇEK PostgreSQL testleri (yerel `supabase start` — uzak projeye ASLA
 * dokunulmaz). Bkz. server/__tests__/dutyPlanDrafts.pg.test.ts için aynı
 * kurulum deseni ve gerekçe. Bu dosya YALNIZ 20260917090000_add_manual_
 * assignment_and_publish.sql'in eklediği manuel atama + yeniden üretme +
 * yayımlama RPC'lerini kapsar — taslak üretiminin KENDİSİ zaten diğer
 * dosyada test edilir.
 *
 *   DUTY_PLAN_PG_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
 *   DUTY_PLAN_PG_TEST_API_URL=http://127.0.0.1:54321
 *   DUTY_PLAN_PG_TEST_SERVICE_KEY=<npx supabase status'un SERVICE_ROLE_KEY'i>
 */
const DB_URL = process.env.DUTY_PLAN_PG_TEST_DB_URL;
const API_URL = process.env.DUTY_PLAN_PG_TEST_API_URL;
const SERVICE_KEY = process.env.DUTY_PLAN_PG_TEST_SERVICE_KEY;
const enabled = Boolean(DB_URL) && Boolean(API_URL) && Boolean(SERVICE_KEY);

describe.skipIf(!enabled)("nöbet planı — manuel atama + yeniden üretme + yayımlama (gerçek PostgreSQL)", () => {
  let client: Client;
  let supabase: ReturnType<typeof createServerSupabaseClient>;
  let config: AppConfig;
  let campusName: string;
  let academicYearName: string;
  let campusId: string;
  let yearId: string;
  let importId: string;
  let locBahce: string;
  let locIlkokul: string;
  let blockIds: Record<string, string> = {};
  let teacherIds: Map<string, string> = new Map();

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

  /** BAHCE1'de MORNING_BREAKS bloğunda, verilen günler için taslak görev satırının id'sini bulur. */
  async function taskIdFor(planId: string, dayOrder: number, dutyLocationId: string, blockCode: string): Promise<string> {
    const res = await client.query(
      "select id from public.duty_plan_assignments where plan_id=$1 and day_order=$2 and duty_location_id=$3 and duty_block_id=$4",
      [planId, dayOrder, dutyLocationId, blockIds[blockCode]],
    );
    return res.rows[0].id as string;
  }

  async function currentPlan(): Promise<{ id: string; version: number; status: string } | null> {
    const res = await client.query(
      "select id, version, status from public.duty_plans where campus_id=$1 and academic_year_id=$2 and status='draft'",
      [campusId, yearId],
    );
    return res.rows[0] ?? null;
  }

  async function generateFreshDraft(): Promise<{ id: string; version: number }> {
    await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2 and status='draft'", [campusId, yearId]);
    const result = await generateDutyPlanDraft(supabase, campusName, academicYearName, { allowPartial: true, maxWeeklyDuties: 3, targetWeeklyDuties: 2, minWeeklyDuties: 0 }, null);
    if (result.status !== "ok") throw new Error(`beklenmeyen generate durumu: ${result.status}`);
    return { id: result.planId, version: result.version };
  }

  beforeAll(async () => {
    client = new Client({ connectionString: DB_URL });
    await client.connect();
    await client.query("grant usage on schema public to service_role");
    await client.query("grant all on all tables in schema public to service_role");
    await client.query("grant all on all sequences in schema public to service_role");

    config = {
      supabaseUrl: API_URL as string,
      supabaseSecretKey: SERVICE_KEY as string,
      port: 0,
      allowedOrigin: "http://127.0.0.1",
      campusName: "",
      academicYearName: "",
    };
    supabase = createServerSupabaseClient(config);

    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    campusName = `PG Manuel/Yayim Kampus ${suffix}`;
    academicYearName = `PG Manuel/Yayim Yil ${suffix}`;

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

    for (const sourceId of ["T1", "T2", "T3", "T5"]) {
      const res = await client.query("insert into public.teachers (timetable_import_id, source_id, name) values ($1,$2,$3) returning id", [
        importId,
        sourceId,
        `Ogretmen ${sourceId}`,
      ]);
      teacherIds.set(sourceId, res.rows[0].id);
    }

    const blocksRes = await client.query("select id, code from public.duty_blocks where is_active");
    blockIds = Object.fromEntries(blocksRes.rows.map((r: { id: string; code: string }) => [r.code, r.id]));

    async function createLocation(name: string, shortCode: string, category: string): Promise<string> {
      await rpc("create_duty_location", { p_campus_id: campusId, p_name: name, p_short_code: shortCode, p_category: category, p_capacity: 1, p_description: null, p_is_active: true });
      const res = await client.query("select id from public.duty_locations where campus_id=$1 and upper(short_code)=upper($2)", [campusId, shortCode]);
      return res.rows[0].id as string;
    }

    // create_duty_location YENİ yeri OTOMATİK olarak dört aktif bloğun
    // TAMAMINA bağlar (bkz. 20260910090000 create_duty_location). Test
    // sadeliği için burada yalnız İSTENEN blok(lar) BIRAKILIR, gerisi
    // silinir — aksi halde ör. BAHCE için LONG_BREAK_1/2 hücreleri hiç
    // adayı olmadan sonsuza dek açık kalır ve "tam plan publish" testi
    // asla uncoveredCount=0'a ulaşamaz.
    locBahce = await createLocation("Bahce", `BAHCE${suffix}`.slice(0, 16), "garden");
    await client.query("delete from public.duty_location_blocks where duty_location_id=$1 and duty_block_id<>$2", [locBahce, blockIds.MORNING_BREAKS]);

    locIlkokul = await createLocation("Ilkokul Koridor", `ILKOKUL${suffix}`.slice(0, 16), "corridor");
    await client.query("update public.duty_locations set allows_fixed_assignment=true where id=$1", [locIlkokul]);
    // Gerçek iş kuralı: sabit yer yalnız MORNING_BREAKS+AFTERNOON_BREAKS
    // çiftine bağlıdır (bkz. dutyPlanDrafts.pg.test.ts ILKOKUL1 kullanımı).
    await client.query("delete from public.duty_location_blocks where duty_location_id=$1 and duty_block_id not in ($2,$3)", [
      locIlkokul,
      blockIds.MORNING_BREAKS,
      blockIds.AFTERNOON_BREAKS,
    ]);

    const settingIds = new Map<string, string>();
    for (const sourceId of ["T1", "T2", "T3"]) {
      const res = await client.query(
        `insert into public.teacher_duty_settings (campus_id, academic_year_id, teacher_source_id, teacher_name_snapshot, is_included)
         values ($1,$2,$3,$4,$5) returning id`,
        [campusId, yearId, sourceId, `Ogretmen ${sourceId}`, sourceId !== "T3"],
      );
      settingIds.set(sourceId, res.rows[0].id);
    }
    // T3 KASITLI OLARAK is_included=false — teacher_not_included testi için.

    // T1: BAHCE/MORNING_BREAKS günler 1..4 (haftalık max testi için 4 aday günü).
    for (const day of [1, 2, 3, 4]) {
      await client.query(
        `insert into public.teacher_duty_block_availabilities (campus_id, teacher_duty_setting_id, duty_location_id, day_order, duty_block_id)
         values ($1,$2,$3,$4,$5)`,
        [campusId, settingIds.get("T1"), locBahce, day, blockIds.MORNING_BREAKS],
      );
    }
    // T2: BAHCE/MORNING_BREAKS yalnız gün 2 (swap/conflict testleri için).
    await client.query(
      `insert into public.teacher_duty_block_availabilities (campus_id, teacher_duty_setting_id, duty_location_id, day_order, duty_block_id)
       values ($1,$2,$3,$4,$5)`,
      [campusId, settingIds.get("T2"), locBahce, 2, blockIds.MORNING_BREAKS],
    );
    // T3 (is_included=false) yine de bir tercih satırına sahip — "dahil değil" testinin adaylık nedeniyle değil, dahillik nedeniyle reddedildiğini kanıtlamak için.
    await client.query(
      `insert into public.teacher_duty_block_availabilities (campus_id, teacher_duty_setting_id, duty_location_id, day_order, duty_block_id)
       values ($1,$2,$3,$4,$5)`,
      [campusId, settingIds.get("T3"), locBahce, 1, blockIds.MORNING_BREAKS],
    );

    // T5: gün 1'de ILKOKUL'de sabit nöbeti var (teacher_has_fixed_duty testi için).
    await rpc("create_fixed_duty_assignment", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_teacher_id: teacherIds.get("T5"),
      p_day_order: 1,
      p_duty_location_id: locIlkokul,
    });
  }, 60000);

  afterAll(async () => {
    if (client && campusId) {
      // Published/archived planlar enforce_duty_plan_lifecycle trigger'ı ile
      // KASITLI olarak silinemez (DB seviyesinde immutability) — bu test
      // fixture'ını temizlemek için yalnız burada, superuser bağlantısıyla,
      // trigger'lar geçici olarak devre dışı bırakılır (üretimde ASLA
      // yapılmaz; bu yalnız yerel test veritabanı temizliğidir).
      // BULGU: `session_replication_role = replica` normal tetikleyicilerin
      // YANI SIRA Postgres'in FK ON DELETE CASCADE mekanizmasını da (iç
      // tetikleyici olarak uygulanır) DEVRE DIŞI BIRAKIR — bu yüzden
      // duty_plan_assignments/duty_plan_assignment_packages satırları
      // duty_plans silinince OTOMATİK silinmez, YETİM (orphan, var olmayan
      // bir plan_id'ye işaret eden) satır olarak KALIR. Bu yüzden ÇOCUK
      // tablolar burada AÇIKÇA, ebeveynden ÖNCE silinir.
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
  });

  it("uygun manuel atama: T2'yi BAHCE/gün2'ye atar, summary/version güncellenir", async () => {
    const draft = await generateFreshDraft();
    const taskId = await taskIdFor(draft.id, 2, locBahce, "MORNING_BREAKS");

    const result = await rpc<{ status: string; version: number; assignment: { teacherSourceId: string; assignmentKind: string } }>("update_duty_plan_assignment", {
      p_plan_id: draft.id,
      p_task_id: taskId,
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_teacher_source_id: "T2",
      p_expected_plan_version: draft.version,
    });
    expect(result.status).toBe("ok");
    expect(result.assignment.teacherSourceId).toBe("T2");
    expect(result.assignment.assignmentKind).toBe("manual");
    expect(result.version).toBe(draft.version + 1);

    const row = await client.query("select assignment_kind, teacher_source_id from public.duty_plan_assignments where id=$1", [taskId]);
    expect(row.rows[0].assignment_kind).toBe("manual");
    expect(row.rows[0].teacher_source_id).toBe("T2");
  });

  it("uygun olmayan öğretmen reddi: importta olmayan kaynak id → teacher_not_in_import", async () => {
    const draft = await generateFreshDraft();
    const taskId = await taskIdFor(draft.id, 3, locBahce, "MORNING_BREAKS");
    const result = await rpc<{ status: string }>("update_duty_plan_assignment", {
      p_plan_id: draft.id,
      p_task_id: taskId,
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_teacher_source_id: "GHOST-NOT-A-TEACHER",
      p_expected_plan_version: draft.version,
    });
    expect(result.status).toBe("teacher_not_in_import");
  });

  it("dahil olmayan öğretmen reddi: is_included=false → teacher_not_included", async () => {
    const draft = await generateFreshDraft();
    const taskId = await taskIdFor(draft.id, 1, locBahce, "MORNING_BREAKS");
    const result = await rpc<{ status: string }>("update_duty_plan_assignment", {
      p_plan_id: draft.id,
      p_task_id: taskId,
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_teacher_source_id: "T3",
      p_expected_plan_version: draft.version,
    });
    expect(result.status).toBe("teacher_not_included");
  });

  it("hücreyi tercih etmemiş öğretmen reddi → no_preference_for_cell", async () => {
    const draft = await generateFreshDraft();
    // T2'nin yalnız gün2 tercihi var — gün1'e atamayı dene.
    const taskId = await taskIdFor(draft.id, 1, locBahce, "MORNING_BREAKS");
    const result = await rpc<{ status: string }>("update_duty_plan_assignment", {
      p_plan_id: draft.id,
      p_task_id: taskId,
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_teacher_source_id: "T2",
      p_expected_plan_version: draft.version,
    });
    expect(result.status).toBe("no_preference_for_cell");
  });

  it("sabit nöbeti olan öğretmen reddi → teacher_has_fixed_duty (T5, gün1)", async () => {
    const draft = await generateFreshDraft();
    const taskId = await taskIdFor(draft.id, 1, locBahce, "MORNING_BREAKS");
    // T5'in BAHCE için hiç tercihi yoktur ama önce fixed kontrolü daha
    // önce çalışsın diye T5'e ayrıca gün1 BAHCE tercihi de EKLEMİYORUZ —
    // no_preference_for_cell'den ÖNCE teacher_has_fixed_duty dönmelidir
    // (RPC sırası: fixed → conflict → preference → time).
    await client.query(
      `insert into public.teacher_duty_settings (campus_id, academic_year_id, teacher_source_id, teacher_name_snapshot, is_included)
       values ($1,$2,'T5','Ogretmen T5', true)
       on conflict do nothing`,
      [campusId, yearId],
    );
    const settingRes = await client.query("select id from public.teacher_duty_settings where academic_year_id=$1 and teacher_source_id='T5'", [yearId]);
    await client.query(
      `insert into public.teacher_duty_block_availabilities (campus_id, teacher_duty_setting_id, duty_location_id, day_order, duty_block_id)
       values ($1,$2,$3,1,$4) on conflict do nothing`,
      [campusId, settingRes.rows[0].id, locBahce, blockIds.MORNING_BREAKS],
    );

    const freshDraft = await generateFreshDraft();
    const freshTaskId = await taskIdFor(freshDraft.id, 1, locBahce, "MORNING_BREAKS");
    const result = await rpc<{ status: string }>("update_duty_plan_assignment", {
      p_plan_id: freshDraft.id,
      p_task_id: freshTaskId,
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_teacher_source_id: "T5",
      p_expected_plan_version: freshDraft.version,
    });
    expect(result.status).toBe("teacher_has_fixed_duty");

    await client.query("delete from public.teacher_duty_block_availabilities where teacher_duty_setting_id=$1", [settingRes.rows[0].id]);
    await client.query("delete from public.teacher_duty_settings where id=$1", [settingRes.rows[0].id]);
    void taskId;
  });

  it("aynı gün ikinci görev reddi: T2 zaten gün2'de görevliyken başka hücreye de T2 atanamaz → teacher_day_conflict + conflictingPackage", async () => {
    // İkinci bir BAHCE benzeri yer daha ekleyip aynı gün için ikinci bir
    // hücre kurulur (gerçek evrende BAHCE zaten tek hücre/gün olduğu için).
    const locBahce2 = await (async () => {
      const suffix2 = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
      await rpc("create_duty_location", {
        p_campus_id: campusId,
        p_name: "Bahce 2",
        p_short_code: `BAHCE2${suffix2}`.slice(0, 16),
        p_category: "garden",
        p_capacity: 1,
        p_description: null,
        p_is_active: true,
      });
      const res = await client.query("select id from public.duty_locations where campus_id=$1 and name='Bahce 2'", [campusId]);
      return res.rows[0].id as string;
    })();
    // create_duty_location dört bloğun tamamına otomatik bağlar — yalnız MORNING_BREAKS bırakılır.
    await client.query("delete from public.duty_location_blocks where duty_location_id=$1 and duty_block_id<>$2", [locBahce2, blockIds.MORNING_BREAKS]);
    // T2'ye BAHCE2/gün2 tercihi de ekle.
    const t2Setting = await client.query("select id from public.teacher_duty_settings where academic_year_id=$1 and teacher_source_id='T2'", [yearId]);
    await client.query(
      `insert into public.teacher_duty_block_availabilities (campus_id, teacher_duty_setting_id, duty_location_id, day_order, duty_block_id)
       values ($1,$2,$3,2,$4)`,
      [campusId, t2Setting.rows[0].id, locBahce2, blockIds.MORNING_BREAKS],
    );

    const draft = await generateFreshDraft();
    const taskBahce = await taskIdFor(draft.id, 2, locBahce, "MORNING_BREAKS");
    const taskBahce2 = await taskIdFor(draft.id, 2, locBahce2, "MORNING_BREAKS");

    // T2, artık iki aday hücresi olduğundan üretim solver'ı onu ikisinden
    // BİRİNE otomatik atamış olabilir — deterministik bir başlangıç için
    // her iki hücreyi de önce unassigned'a çekiyoruz.
    let currentVersion = draft.version;
    for (const taskId of [taskBahce, taskBahce2]) {
      const row = await client.query("select teacher_source_id from public.duty_plan_assignments where id=$1", [taskId]);
      if (row.rows[0].teacher_source_id === null) continue;
      const reset = await rpc<{ status: string; version: number }>("update_duty_plan_assignment", {
        p_plan_id: draft.id,
        p_task_id: taskId,
        p_campus_name: campusName,
        p_academic_year_name: academicYearName,
        p_teacher_source_id: null,
        p_expected_plan_version: currentVersion,
      });
      expect(reset.status).toBe("ok");
      currentVersion = reset.version;
    }

    const first = await rpc<{ status: string; version: number }>("update_duty_plan_assignment", {
      p_plan_id: draft.id,
      p_task_id: taskBahce,
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_teacher_source_id: "T2",
      p_expected_plan_version: currentVersion,
    });
    expect(first.status).toBe("ok");

    const second = await rpc<{ status: string; conflictingPackage: { dutyLocationId: string } }>("update_duty_plan_assignment", {
      p_plan_id: draft.id,
      p_task_id: taskBahce2,
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_teacher_source_id: "T2",
      p_expected_plan_version: first.version,
    });
    expect(second.status).toBe("teacher_day_conflict");
    expect(second.conflictingPackage.dutyLocationId).toBe(locBahce);

    // Temizlik: geçici BAHCE2 yerini ve T2'nin oraya eklenen tercihini kaldır.
    await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2 and status='draft'", [campusId, yearId]);
    await client.query("delete from public.teacher_duty_block_availabilities where duty_location_id=$1", [locBahce2]);
    await client.query("update public.duty_locations set deleted_at=now(), is_active=false where id=$1", [locBahce2]);
  });

  it("sabit görev düzenleme reddi → fixed_task_immutable", async () => {
    const draft = await generateFreshDraft();
    const fixedRow = await client.query(
      "select id from public.duty_plan_assignments where plan_id=$1 and duty_location_id=$2 and day_order=1 and assignment_kind='fixed'",
      [draft.id, locIlkokul],
    );
    expect(fixedRow.rows.length).toBeGreaterThan(0);
    const result = await rpc<{ status: string }>("update_duty_plan_assignment", {
      p_plan_id: draft.id,
      p_task_id: fixedRow.rows[0].id,
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_teacher_source_id: "T2",
      p_expected_plan_version: draft.version,
    });
    expect(result.status).toBe("fixed_task_immutable");

    // DB seviyesinde de: doğrudan UPDATE dahi engellenmelidir (trigger).
    await expect(
      client.query("update public.duty_plan_assignments set teacher_source_id='T2', assignment_kind='manual' where id=$1", [fixedRow.rows[0].id]),
    ).rejects.toThrow();
  });

  it("haftalık max reddi: T1'in 4. görevi (max=3 iken) → weekly_limit_exceeded", async () => {
    const draft = await generateFreshDraft();
    // Solver T1'i üretim sırasında zaten bazı günlere atamış olabilir —
    // deterministik bir başlangıç için T1'in 4 aday gününün TAMAMINI önce
    // unassigned'a çeker, sonra sırayla MANUEL olarak yeniden atar.
    let currentVersion = draft.version;
    const t1Days = [1, 2, 3, 4];
    for (const day of t1Days) {
      const taskId = await taskIdFor(draft.id, day, locBahce, "MORNING_BREAKS");
      const row = await client.query("select teacher_source_id from public.duty_plan_assignments where id=$1", [taskId]);
      if (row.rows[0].teacher_source_id === null) continue;
      const result = await rpc<{ status: string; version: number }>("update_duty_plan_assignment", {
        p_plan_id: draft.id,
        p_task_id: taskId,
        p_campus_name: campusName,
        p_academic_year_name: academicYearName,
        p_teacher_source_id: null,
        p_expected_plan_version: currentVersion,
      });
      expect(result.status).toBe("ok");
      currentVersion = result.version;
    }

    // İlk 3 gün: max=3 sınırı içinde kabul edilir.
    for (const day of [1, 2, 3]) {
      const taskId = await taskIdFor(draft.id, day, locBahce, "MORNING_BREAKS");
      const result = await rpc<{ status: string; version: number }>("update_duty_plan_assignment", {
        p_plan_id: draft.id,
        p_task_id: taskId,
        p_campus_name: campusName,
        p_academic_year_name: academicYearName,
        p_teacher_source_id: "T1",
        p_expected_plan_version: currentVersion,
      });
      expect(result.status).toBe("ok");
      currentVersion = result.version;
    }

    // 4. gün: toplam 4 > max(3) → reddedilir.
    const taskDay4 = await taskIdFor(draft.id, 4, locBahce, "MORNING_BREAKS");
    const rejected = await rpc<{ status: string }>("update_duty_plan_assignment", {
      p_plan_id: draft.id,
      p_task_id: taskDay4,
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_teacher_source_id: "T1",
      p_expected_plan_version: currentVersion,
    });
    expect(rejected.status).toBe("weekly_limit_exceeded");
  });

  it("stale source: fixed atama üretim sonrası değişince source_changed döner", async () => {
    const draft = await generateFreshDraft();
    const taskId = await taskIdFor(draft.id, 2, locBahce, "MORNING_BREAKS");

    // Kaynak veriyi değiştir (yeni bir sabit atama ekle) — fingerprint değişir.
    await rpc("create_fixed_duty_assignment", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_teacher_id: teacherIds.get("T2"),
      p_day_order: 4,
      p_duty_location_id: locIlkokul,
    });

    const result = await rpc<{ status: string; currentSourceFingerprint: string }>("update_duty_plan_assignment", {
      p_plan_id: draft.id,
      p_task_id: taskId,
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_teacher_source_id: "T2",
      p_expected_plan_version: draft.version,
    });
    expect(result.status).toBe("source_changed");

    // Temizle.
    const fixedRes = await client.query("select id from public.fixed_duty_assignments where academic_year_id=$1 and teacher_source_id='T2' and day_order=4", [yearId]);
    await rpc("delete_fixed_duty_assignment", { p_campus_name: campusName, p_academic_year_name: academicYearName, p_assignment_id: fixedRes.rows[0].id });
  });

  it("version conflict: bayat expectedPlanVersion → version_conflict", async () => {
    const draft = await generateFreshDraft();
    const taskId = await taskIdFor(draft.id, 2, locBahce, "MORNING_BREAKS");
    const result = await rpc<{ status: string; currentVersion: number }>("update_duty_plan_assignment", {
      p_plan_id: draft.id,
      p_task_id: taskId,
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_teacher_source_id: "T2",
      p_expected_plan_version: draft.version + 99,
    });
    expect(result.status).toBe("version_conflict");
    expect(result.currentVersion).toBe(draft.version);
  });

  it("eşzamanlı iki manuel değişiklik: aynı expectedPlanVersion ile iki AYRI bağlantı — biri ok, diğeri version_conflict", async () => {
    const draft = await generateFreshDraft();
    const taskA = await taskIdFor(draft.id, 1, locBahce, "MORNING_BREAKS");
    const taskB = await taskIdFor(draft.id, 2, locBahce, "MORNING_BREAKS");

    const client2 = new Client({ connectionString: DB_URL });
    await client2.connect();
    try {
      const callA = client.query(
        "select public.update_duty_plan_assignment($1,$2,$3,$4,$5,$6) as result",
        [draft.id, taskA, campusName, academicYearName, null, draft.version],
      );
      const callB = client2.query(
        "select public.update_duty_plan_assignment($1,$2,$3,$4,$5,$6) as result",
        [draft.id, taskB, campusName, academicYearName, "T2", draft.version],
      );
      const [ra, rb] = await Promise.all([callA, callB]);
      const statuses = [(ra.rows[0].result as { status: string }).status, (rb.rows[0].result as { status: string }).status];
      expect(statuses.filter((s) => s === "ok")).toHaveLength(1);
      expect(statuses.filter((s) => s === "version_conflict")).toHaveLength(1);
    } finally {
      await client2.end();
    }
  });

  it("eksik plan publish reddi: açık görev varken → open_tasks_remaining", async () => {
    const draft = await generateFreshDraft();
    const plan = await currentPlan();
    const result = await rpc<{ status: string; uncoveredCount: number }>("publish_duty_plan_draft", {
      p_plan_id: draft.id,
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_expected_plan_version: plan?.version,
    });
    expect(result.status).toBe("open_tasks_remaining");
    expect(result.uncoveredCount).toBeGreaterThan(0);
  });

  it("tam plan publish: tüm hücreler dolunca yayımlanır, önceki published archived olur, plan immutable hale gelir", async () => {
    await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2 and status='draft'", [campusId, yearId]);

    // BAHCE/gün5 için hiç tercih YOK — T1'e gün5 tercihi de EKLEYEREK
    // (maxWeeklyDuties=5 ile üreterek) T1'in tüm haftayı tek başına
    // kapatmasını sağlıyoruz; böylece açık görev sıfıra iner.
    const t1Setting = await client.query("select id from public.teacher_duty_settings where academic_year_id=$1 and teacher_source_id='T1'", [yearId]);
    await client.query(
      `insert into public.teacher_duty_block_availabilities (campus_id, teacher_duty_setting_id, duty_location_id, day_order, duty_block_id)
       values ($1,$2,$3,5,$4) on conflict do nothing`,
      [campusId, t1Setting.rows[0].id, locBahce, blockIds.MORNING_BREAKS],
    );

    // ILKOKUL (fixed) yalnız gün1 için sabit atamaya sahip — gün 2..5 için
    // de T5'e sabit nöbet vererek TÜM fixed hücreleri kapatıyoruz (aksi
    // halde bu haftalar sonsuza dek açık kalır ve uncoveredCount hiç 0'a inmez).
    for (const day of [2, 3, 4, 5]) {
      await rpc("create_fixed_duty_assignment", {
        p_campus_name: campusName,
        p_academic_year_name: academicYearName,
        p_teacher_id: teacherIds.get("T5"),
        p_day_order: day,
        p_duty_location_id: locIlkokul,
      });
    }

    const full = await generateDutyPlanDraft(supabase, campusName, academicYearName, { allowPartial: true, maxWeeklyDuties: 5, targetWeeklyDuties: 5, minWeeklyDuties: 0 }, null);
    expect(full.status).toBe("ok");
    if (full.status !== "ok") return;

    const uncovered = await client.query("select count(*)::int as c from public.duty_plan_assignments where plan_id=$1 and assignment_kind='unassigned'", [full.planId]);
    expect(uncovered.rows[0].c).toBe(0);

    const publishResult = await rpc<{ status: string; planId: string; version: number }>("publish_duty_plan_draft", {
      p_plan_id: full.planId,
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_expected_plan_version: full.version,
    });
    expect(publishResult.status).toBe("ok");
    expect(publishResult.planId).toBe(full.planId);

    const planRow = await client.query("select status from public.duty_plans where id=$1", [full.planId]);
    expect(planRow.rows[0].status).toBe("published");

    // Published planın atamaları DB seviyesinde immutable — doğrudan UPDATE reddedilmeli.
    const anyAssignment = await client.query("select id from public.duty_plan_assignments where plan_id=$1 limit 1", [full.planId]);
    await expect(
      client.query("update public.duty_plan_assignments set score_details='{}' where id=$1", [anyAssignment.rows[0].id]),
    ).rejects.toThrow();
    // Plan satırının kendisi de immutable (yalnız archived'a geçebilir).
    await expect(client.query("update public.duty_plans set generation_seed=999 where id=$1", [full.planId])).rejects.toThrow();
    await expect(client.query("delete from public.duty_plans where id=$1", [full.planId])).rejects.toThrow();

    // === İkinci bir tam taslak üret ve yayımla — öncekinin archived olduğunu doğrula ===
    // save_duty_plan_draft yalnız status='draft' bir plan varken çalışır;
    // yayımlanmış plan aktif draft SAYILMAZ (duty_plans_one_active_draft_uq
    // yalnız status='draft'ı kapsar), bu yüzden doğrudan yeni bir draft
    // üretebiliriz (expectedPlanId=null, mevcut aktif draft yok).
    const second = await generateDutyPlanDraft(supabase, campusName, academicYearName, { allowPartial: true, maxWeeklyDuties: 5, targetWeeklyDuties: 5, minWeeklyDuties: 0 }, null);
    expect(second.status).toBe("ok");
    if (second.status !== "ok") return;
    const secondPublish = await rpc<{ status: string; archivedPreviousPlanId: string | null }>("publish_duty_plan_draft", {
      p_plan_id: second.planId,
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_expected_plan_version: second.version,
    });
    expect(secondPublish.status).toBe("ok");
    expect(secondPublish.archivedPreviousPlanId).toBe(full.planId);

    const firstAfter = await client.query("select status from public.duty_plans where id=$1", [full.planId]);
    expect(firstAfter.rows[0].status).toBe("archived");
    const secondAfter = await client.query("select status from public.duty_plans where id=$1", [second.planId]);
    expect(secondAfter.rows[0].status).toBe("published");

    // Yalnız bir tane published plan olabilir.
    const publishedCount = await client.query("select count(*)::int as c from public.duty_plans where campus_id=$1 and academic_year_id=$2 and status='published'", [campusId, yearId]);
    expect(publishedCount.rows[0].c).toBe(1);

    // get_published_duty_plan yayımlanmış (en son) planı döner.
    const publishedDto = await rpc<{ found: boolean; id: string }>("get_published_duty_plan", { p_campus_name: campusName, p_academic_year_name: academicYearName });
    expect(publishedDto.found).toBe(true);
    expect(publishedDto.id).toBe(second.planId);

    // Temizlik: T1 gün5 tercihini ve T5'in bu test için eklenen gün2-5 sabit
    // nöbetlerini kaldır — aksi halde T5'in fixedDutyDayCount'u (4) sonraki
    // testlerin varsayılan maxWeeklyDuties=3'ünü aşar ve generateFreshDraft
    // weekly_limit_exceeded ile başarısız olur.
    await client.query("delete from public.teacher_duty_block_availabilities where teacher_duty_setting_id=$1 and day_order=5", [t1Setting.rows[0].id]);
    const t5ExtraFixed = await client.query(
      "select id from public.fixed_duty_assignments where academic_year_id=$1 and teacher_source_id='T5' and day_order in (2,3,4,5)",
      [yearId],
    );
    for (const row of t5ExtraFixed.rows) {
      await rpc("delete_fixed_duty_assignment", { p_campus_name: campusName, p_academic_year_name: academicYearName, p_assignment_id: row.id });
    }
  }, 30000);

  it("regenerate + eşzamanlı manuel PUT: FOR UPDATE ile serileşir, hiçbiri diğerini sessizce ezmez (iki gerçek bağlantı, deterministik yarış)", async () => {
    const draft = await generateFreshDraft();

    // "Regenerate" burada Node tarafında solver'ın SÜRE aldığı, snapshot
    // v0'dan hesaplanan bir sonucu save_duty_plan_draft'a p_expected_plan_
    // version=v0 ile gönderdiği anı simüle eder: DB'den o AN geçerli (v0)
    // atama+summary'yi okuyup AYNEN geri gönderiyoruz.
    const rows = await client.query(
      "select day_order, duty_location_id, duty_block_id, teacher_source_id, assignment_kind, score_details from public.duty_plan_assignments where plan_id=$1",
      [draft.id],
    );
    const planRow = await client.query(
      "select generation_options, summary, algorithm_version, generation_seed, source_fingerprint from public.duty_plans where id=$1",
      [draft.id],
    );
    const assignments = rows.rows.map((r) => ({
      day_order: r.day_order,
      duty_location_id: r.duty_location_id,
      duty_block_id: r.duty_block_id,
      teacher_source_id: r.teacher_source_id,
      assignment_kind: r.assignment_kind,
      score_details: r.score_details,
    }));
    const { generation_options: genOptions, summary, algorithm_version: algoVersion, generation_seed: genSeed, source_fingerprint: fingerprint } = planRow.rows[0];

    const taskId = await taskIdFor(draft.id, 2, locBahce, "MORNING_BREAKS");

    const client2 = new Client({ connectionString: DB_URL });
    await client2.connect();
    try {
      const putCall = client2.query("select public.update_duty_plan_assignment($1,$2,$3,$4,$5,$6) as result", [
        draft.id,
        taskId,
        campusName,
        academicYearName,
        "T2",
        draft.version,
      ]);
      const regenerateCall = client.query(
        "select public.save_duty_plan_draft($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as result",
        [
          campusName,
          academicYearName,
          fingerprint,
          algoVersion,
          genSeed,
          JSON.stringify(genOptions),
          JSON.stringify(assignments),
          JSON.stringify(summary),
          true,
          draft.id,
          draft.version,
        ],
      );
      const [putRes, regenRes] = await Promise.all([putCall, regenerateCall]);
      const put = putRes.rows[0].result as { status: string };
      const regen = regenRes.rows[0].result as { status: string; planId?: string };

      // İki gerçek bağlantı, AYNI plan satırı üzerinde FOR UPDATE ile
      // serileşir — İKİSİ BİRDEN 'ok' OLAMAZ. Deterministik davranış uzayı:
      //  (a) PUT önce commit ederse → regenerate onun ARTMIŞ versiyonunu
      //      görür → version_conflict (plan AYNI id'de kalır, manuel atama
      //      KORUNUR — sessiz ezme YOK);
      //  (b) regenerate önce commit ederse → eski planı silip YENİ id ile
      //      yazar → PUT'un hedeflediği ESKİ plan id'si artık yok →
      //      plan_not_found (yine sessiz ezme YOK, PUT açıkça başarısız olur).
      if (put.status === "ok") {
        expect(regen.status).toBe("version_conflict");
        const row = await client.query("select assignment_kind, teacher_source_id from public.duty_plan_assignments where id=$1", [taskId]);
        expect(row.rows[0].assignment_kind).toBe("manual");
        expect(row.rows[0].teacher_source_id).toBe("T2");
        const plan = await client.query(
          "select id, version from public.duty_plans where campus_id=$1 and academic_year_id=$2 and status='draft'",
          [campusId, yearId],
        );
        expect(plan.rows[0].id).toBe(draft.id);
        expect(plan.rows[0].version).toBe(draft.version + 1);
      } else {
        expect(put.status).toBe("plan_not_found");
        expect(regen.status).toBe("ok");
      }
    } finally {
      await client2.end();
    }
  });

  it("DB seviyesi: published/archived plana assignment INSERT (dahil) hiçbir normal yazma yapılamaz; ON DELETE SET NULL istisnası dar kalır; archive geçişinde yalnız status/updated_at değişebilir; doğrudan published/archived INSERT yasak", async () => {
    await client.query("delete from public.duty_plans where campus_id=$1 and academic_year_id=$2 and status='draft'", [campusId, yearId]);
    const t1Setting = await client.query("select id from public.teacher_duty_settings where academic_year_id=$1 and teacher_source_id='T1'", [yearId]);
    await client.query(
      `insert into public.teacher_duty_block_availabilities (campus_id, teacher_duty_setting_id, duty_location_id, day_order, duty_block_id)
       values ($1,$2,$3,5,$4) on conflict do nothing`,
      [campusId, t1Setting.rows[0].id, locBahce, blockIds.MORNING_BREAKS],
    );
    // ILKOKUL (fixed) tüm günler için sabit atamaya sahip olmalı (aksi
    // halde uncoveredCount hiç 0'a inmez) — T5'in gün2-5 sabit nöbetlerini
    // burada YENİDEN kurarız (önceki test kendi sonunda temizlemişti).
    for (const day of [2, 3, 4, 5]) {
      await rpc("create_fixed_duty_assignment", {
        p_campus_name: campusName,
        p_academic_year_name: academicYearName,
        p_teacher_id: teacherIds.get("T5"),
        p_day_order: day,
        p_duty_location_id: locIlkokul,
      });
    }

    const draftResult = await generateDutyPlanDraft(supabase, campusName, academicYearName, { allowPartial: true, maxWeeklyDuties: 5, targetWeeklyDuties: 5, minWeeklyDuties: 0 }, null);
    expect(draftResult.status).toBe("ok");
    if (draftResult.status !== "ok") return;
    const publishRes = await rpc<{ status: string }>("publish_duty_plan_draft", {
      p_plan_id: draftResult.planId,
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_expected_plan_version: draftResult.version,
    });
    expect(publishRes.status).toBe("ok");

    // --- (4) ON DELETE SET NULL: yayımlanmış planda satır KORUNUR, yalnız bağlantı null olur ---
    const fixedRowsBefore = await client.query(
      "select id, fixed_duty_assignment_id, teacher_source_id, assignment_kind from public.duty_plan_assignments where plan_id=$1 and duty_location_id=$2 and day_order=1 and assignment_kind='fixed'",
      [draftResult.planId, locIlkokul],
    );
    expect(fixedRowsBefore.rows.length).toBe(2); // MORNING + AFTERNOON
    for (const r of fixedRowsBefore.rows) expect(r.fixed_duty_assignment_id).not.toBeNull();

    const fixedAssignmentIdRes = await client.query(
      "select id from public.fixed_duty_assignments where academic_year_id=$1 and teacher_source_id='T5' and day_order=1",
      [yearId],
    );
    const del = await rpc<{ status: string }>("delete_fixed_duty_assignment", {
      p_campus_name: campusName,
      p_academic_year_name: academicYearName,
      p_assignment_id: fixedAssignmentIdRes.rows[0].id,
    });
    expect(del.status).toBe("ok");

    const fixedRowsAfter = await client.query(
      "select id, fixed_duty_assignment_id, teacher_source_id, assignment_kind from public.duty_plan_assignments where plan_id=$1 and duty_location_id=$2 and day_order=1 and assignment_kind='fixed'",
      [draftResult.planId, locIlkokul],
    );
    expect(fixedRowsAfter.rows.length).toBe(2);
    for (const r of fixedRowsAfter.rows) {
      expect(r.fixed_duty_assignment_id).toBeNull();
      expect(r.teacher_source_id).toBe("T5"); // başka HİÇBİR alan değişmedi
      expect(r.assignment_kind).toBe("fixed");
    }

    // İstisna DAR: fixed_duty_assignment_id null'a düşmüşken AYNI ZAMANDA
    // başka bir alanı (ör. teacher_source_id) değiştirmeye çalışan bir
    // UPDATE reddedilmeli.
    await expect(
      client.query("update public.duty_plan_assignments set teacher_source_id='T1' where id=$1", [fixedRowsAfter.rows[0].id]),
    ).rejects.toThrow();

    // --- (2) Published plana INSERT (dahil) hiçbir normal yazma yapılamaz ---
    await expect(
      client.query(
        `insert into public.duty_plan_assignments
           (plan_id, campus_id, day_order, duty_location_id, duty_block_id, teacher_source_id, teacher_name_snapshot, duty_location_name_snapshot, duty_block_name_snapshot, assignment_kind, score_details)
         values ($1,$2,1,$3,$4,null,null,'Bahce','Uzun Nöbet 1','unassigned','{}')`,
        [draftResult.planId, campusId, locBahce, blockIds.LONG_BREAK_1],
      ),
    ).rejects.toThrow();

    // --- (3) Arşivleme geçişinde YALNIZ status+updated_at değişebilir ---
    await expect(
      client.query("update public.duty_plans set status='archived', summary='{}'::jsonb where id=$1", [draftResult.planId]),
    ).rejects.toThrow();
    // Plan hâlâ published (reddedilen UPDATE rollback oldu).
    const stillPublished = await client.query("select status from public.duty_plans where id=$1", [draftResult.planId]);
    expect(stillPublished.rows[0].status).toBe("published");

    // --- (3) Doğrudan published/archived INSERT yasak — yeni plan YALNIZ draft olarak oluşturulabilir ---
    await expect(
      client.query(
        `insert into public.duty_plans (campus_id, academic_year_id, timetable_import_id, status, source_fingerprint, algorithm_version, generation_options, summary, version)
         values ($1,$2,$3,'archived',$4,'test-v1','{}','{}',1)`,
        [campusId, yearId, importId, "1".repeat(64)],
      ),
    ).rejects.toThrow();

    await client.query("delete from public.teacher_duty_block_availabilities where teacher_duty_setting_id=$1 and day_order=5", [t1Setting.rows[0].id]);
  }, 30000);
});
