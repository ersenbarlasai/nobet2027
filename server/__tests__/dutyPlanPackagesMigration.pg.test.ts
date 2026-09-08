import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import fs from "node:fs";
import path from "node:path";

/**
 * GERÇEK PostgreSQL testi: 20260918090000_create_duty_plan_packages.sql'in
 * DOLU (draft + published + archived planları İÇEREN) bir duty_plan_
 * assignments üzerinde ÇALIŞTIĞINI doğrular. Yöntem: normal `supabase db
 * reset` migration'ı zaten bir kez uygulamış olduğu için, bu test önce
 * şemayı BİLEREK 20260918'den ÖNCEKİ hale geri döndürür (paket tablosunu/
 * sütununu/tetikleyicilerini DROP eder — fonksiyonlar dokunulmadan kalır,
 * onlar CREATE OR REPLACE olduğu için zararsızdır), GERÇEKÇİ draft/
 * published/archived fixture verisi YAZAR, sonra migration dosyasının TAM
 * SQL içeriğini TEK bir sorgu olarak (psql -f ile AYNI davranış — node-pg
 * simple query protokolü çoklu ifadeyi destekler) yeniden çalıştırır.
 *
 *   DUTY_PLAN_PG_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
 */
const DB_URL = process.env.DUTY_PLAN_PG_TEST_DB_URL;
const enabled = Boolean(DB_URL);

const MIGRATION_PATH = path.join(__dirname, "..", "..", "supabase", "migrations", "20260918090000_create_duty_plan_packages.sql");

interface AssignmentSnapshotRow {
  id: string;
  day_order: number;
  duty_location_id: string;
  duty_block_id: string;
  teacher_source_id: string | null;
  teacher_name_snapshot: string | null;
  duty_location_name_snapshot: string;
  duty_block_name_snapshot: string;
  assignment_kind: string;
}

describe.skipIf(!enabled)("duty plan packages migration — DOLU veri üzerinde (gerçek PostgreSQL)", () => {
  let client: Client;
  let campusId: string;
  let yearId: string;
  let importId: string;
  let locId: string;
  let blockIds: Record<string, string> = {};
  let campusName: string;

  let draftPlanId: string;
  let publishedPlanId: string;
  let archivedPlanId: string;

  async function insertPlan(status: "draft"): Promise<string> {
    const fp = "a".repeat(64);
    const res = await client.query(
      `insert into public.duty_plans
         (campus_id, academic_year_id, timetable_import_id, status, source_fingerprint, algorithm_version, generation_options, summary, version)
       values ($1,$2,$3,$4,$5,'test-migration-v1','{}'::jsonb,'{}'::jsonb,1)
       returning id`,
      [campusId, yearId, importId, status, fp],
    );
    return res.rows[0].id as string;
  }

  async function insertAssignment(args: {
    planId: string;
    dayOrder: number;
    dutyBlockId: string;
    blockName: string;
    teacherSourceId: string | null;
    assignmentKind: "generated" | "manual" | "fixed" | "unassigned";
  }): Promise<void> {
    await client.query(
      `insert into public.duty_plan_assignments
         (plan_id, campus_id, day_order, duty_location_id, duty_block_id,
          teacher_source_id, teacher_name_snapshot, duty_location_name_snapshot, duty_block_name_snapshot,
          assignment_kind, score_details)
       values ($1,$2,$3,$4,$5,$6,$7,'Test Yeri',$8,$9,'{}'::jsonb)`,
      [
        args.planId,
        campusId,
        args.dayOrder,
        locId,
        args.dutyBlockId,
        args.teacherSourceId,
        args.teacherSourceId ? `Ogretmen ${args.teacherSourceId}` : null,
        args.blockName,
        args.assignmentKind,
      ],
    );
  }

  beforeAll(async () => {
    client = new Client({ connectionString: DB_URL });
    await client.connect();
    await client.query("grant usage on schema public to service_role");
    await client.query("grant all on all tables in schema public to service_role");
    await client.query("grant all on all sequences in schema public to service_role");

    // KRİTİK İZOLASYON: bu test dosyası, migration'ın DOLU veri üzerindeki
    // davranışını simüle etmek için PAYLAŞILAN `public.duty_plan_assignment_
    // packages` tablosunu GEÇİCİ olarak DROP edip yeniden oluşturuyor.
    // vitest test DOSYALARINI VARSAYILAN olarak PARALEL (ayrı worker'larda,
    // AYNI harici Postgres'e) çalıştırdığı için, bu DDL'i normal (autocommit)
    // biçimde yapmak diğer pg test dosyalarını (aynı anda bu tabloyu okuyan/
    // yazan) SESSİZCE bozardı ("relation does not exist"). Çözüm: TÜM bu
    // dosyanın işlemleri TEK bir COMMIT EDİLMEYEN transaction içinde yapılır
    // (afterAll'da ROLLBACK) — DROP TABLE'ın aldığı ACCESS EXCLUSIVE kilit
    // yalnız BU transaction commit/rollback olana kadar diğer bağlantıları
    // KISA SÜRE bekletir (veri bozulması YOK, yalnız geçici sıralama), ve
    // rollback sayesinde test SONUNDA şema/veri HİÇ değişmemiş gibi kalır —
    // ayrıca manuel temizlik (afterAll DELETE) gerekmez.
    await client.query("begin");

    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    campusName = `PG Migration Test Kampus ${suffix}`;
    const campusRes = await client.query("insert into public.campuses (name) values ($1) returning id", [campusName]);
    campusId = campusRes.rows[0].id;

    const yearRes = await client.query(
      "insert into public.academic_years (campus_id, name, is_active) values ($1, $2, true) returning id",
      [campusId, `PG Migration Test Yil ${suffix}`],
    );
    yearId = yearRes.rows[0].id;

    const sourceSha256 = suffix.padEnd(64, "0").slice(0, 64);
    const importRes = await client.query(
      `insert into public.timetable_imports
         (campus_id, academic_year_id, source_format, source_filename, source_sha256, status, imported_at)
       values ($1, $2, 'asc-xml', 'pg-migration-test.xml', $3, 'imported', now())
       returning id`,
      [campusId, yearId, sourceSha256],
    );
    importId = importRes.rows[0].id;

    const locRes = await client.query(
      "select (public.create_duty_location($1,$2,$3,$4,$5,$6,$7)).id as id",
      [campusId, "Test Yeri", `MIGTEST${suffix}`.slice(0, 16), "corridor", 1, null, true],
    );
    locId = locRes.rows[0].id;

    const blocksRes = await client.query("select code, id from public.duty_blocks where is_active");
    for (const row of blocksRes.rows as { code: string; id: string }[]) blockIds[row.code] = row.id;

    // ------------------------------------------------------------------
    // Şemayı 20260918'den ÖNCEKİ hale BİLEREK geri döndür — fonksiyonlar
    // (create or replace) dokunulmadan bırakılır, yalnız paket tablosu/
    // sütunu/tetikleyicileri kaldırılır (yeniden migration TAM olarak
    // "dolu bir DB'ye YENİ iniyor" senaryosunu simüle etsin diye).
    // ------------------------------------------------------------------
    await client.query(`
      alter table public.duty_plans disable trigger record_published_duty_plan_scores;
      alter table public.duty_plan_assignments disable trigger enforce_duty_plan_v4_packages_on_assignments;
      alter table public.duty_plan_assignment_packages disable trigger enforce_duty_plan_v4_packages_on_packages;
      drop trigger if exists enforce_duty_plan_package_write_rules on public.duty_plan_assignment_packages;
      drop trigger if exists enforce_duty_plan_assignment_package_consistency on public.duty_plan_assignments;
      alter table public.duty_plan_assignments drop constraint if exists duty_plan_assignments_package_presence_ck;
      alter table public.duty_plan_assignments drop constraint if exists duty_plan_assignments_package_plan_fk;
      alter table public.duty_plan_assignments drop column if exists package_id;
      drop table if exists public.duty_plan_assignment_packages cascade;
    `);

    // ------------------------------------------------------------------
    // GERÇEKÇİ fixture: draft (SINGLE_BLOCK generated + unassigned + fixed
    // AM/PM çifti), published, archived planlar — HEPSİ migration ÇALIŞMADAN
    // ÖNCE var.
    // ------------------------------------------------------------------
    // Sıra ÖNEMLİ: duty_plans_one_active_draft_uq (kampüs+yıl başına EN
    // FAZLA bir 'draft') VE duty_plans_one_active_published_uq (EN FAZLA bir
    // 'published') aynı anda YALNIZ bir draft/bir published'a izin verir —
    // bu yüzden her plan kendi rolüne geçtikten (draft'tan çıktıktan) SONRA
    // bir SONRAKİ plan draft olarak eklenir; final draft fixture'ı EN SONA
    // bırakılır (böylece kalıcı olarak 'draft' kalabilir).
    archivedPlanId = await insertPlan("draft");
    await insertAssignment({ planId: archivedPlanId, dayOrder: 4, dutyBlockId: blockIds.AFTERNOON_BREAKS, blockName: "Öğleden Sonra", teacherSourceId: "T5", assignmentKind: "generated" });
    await client.query("update public.duty_plans set status='published' where id=$1", [archivedPlanId]);
    await client.query("update public.duty_plans set status='archived' where id=$1", [archivedPlanId]);

    publishedPlanId = await insertPlan("draft");
    await insertAssignment({ planId: publishedPlanId, dayOrder: 1, dutyBlockId: blockIds.MORNING_BREAKS, blockName: "Sabah", teacherSourceId: "T3", assignmentKind: "generated" });
    await insertAssignment({ planId: publishedPlanId, dayOrder: 3, dutyBlockId: blockIds.LONG_BREAK_2, blockName: "Uzun 2", teacherSourceId: "T4", assignmentKind: "manual" });
    await client.query("update public.duty_plans set status='published' where id=$1", [publishedPlanId]);

    draftPlanId = await insertPlan("draft");
    await insertAssignment({ planId: draftPlanId, dayOrder: 1, dutyBlockId: blockIds.MORNING_BREAKS, blockName: "Sabah", teacherSourceId: "T1", assignmentKind: "generated" });
    await insertAssignment({ planId: draftPlanId, dayOrder: 1, dutyBlockId: blockIds.LONG_BREAK_1, blockName: "Uzun 1", teacherSourceId: null, assignmentKind: "unassigned" });
    await insertAssignment({ planId: draftPlanId, dayOrder: 2, dutyBlockId: blockIds.MORNING_BREAKS, blockName: "Sabah", teacherSourceId: "T2", assignmentKind: "fixed" });
    await insertAssignment({ planId: draftPlanId, dayOrder: 2, dutyBlockId: blockIds.AFTERNOON_BREAKS, blockName: "Öğleden Sonra", teacherSourceId: "T2", assignmentKind: "fixed" });

    // 20260919090000 ile gelen öğretmen×gün kuralları DEFERRABLE INITIALLY
    // DEFERRED bir constraint trigger'dır; yukarıdaki DML transaction'ın
    // sonuna kadar BEKLEYEN tetikleyici olayları bırakır. PostgreSQL, bekleyen
    // olay varken aynı tabloda ALTER TABLE çalıştırmayı reddeder ("cannot
    // ALTER TABLE ... because it has pending trigger events") — testin
    // gövdesi ise tam olarak bunu yapan bir migration çalıştırıyor. Kuralları
    // GEVŞETMEK yerine bekleyen olayları burada, fixture tamamlandıktan hemen
    // sonra boşaltıyoruz: kurallar bu noktada gerçekten çalışır (fixture
    // onları ihlal etmiyor), ardından şema değişikliği serbest kalır.
    await client.query("set constraints all immediate");
  }, 60000);

  afterAll(async () => {
    if (client) {
      // ROLLBACK: beforeAll'daki "begin"i geri alır — hem fixture verisini
      // hem de şema DROP/CREATE'lerini TAMAMEN geri alır; başka temizliğe
      // gerek yoktur (paylaşılan tablo diğer pg test dosyaları için HİÇ
      // etkilenmemiş görünür).
      await client.query("rollback");
      await client.end();
    }
  });

  it("dolu draft+published+archived plan verisi üzerinde SIFIR veri kaybıyla tamamlanır", async () => {
    const allPlanIds = [draftPlanId, publishedPlanId, archivedPlanId];

    const beforeRows = (
      await client.query(
        `select id, day_order, duty_location_id, duty_block_id, teacher_source_id, teacher_name_snapshot,
                duty_location_name_snapshot, duty_block_name_snapshot, assignment_kind
           from public.duty_plan_assignments where plan_id = any($1) order by id`,
        [allPlanIds],
      )
    ).rows as AssignmentSnapshotRow[];
    expect(beforeRows).toHaveLength(7); // 4 draft + 2 published + 1 archived

    const beforeStatuses = (await client.query("select id, status from public.duty_plans where id = any($1) order by id", [allPlanIds])).rows;

    const migrationSql = fs.readFileSync(MIGRATION_PATH, "utf-8");
    await client.query(migrationSql);

    // (1) Satır sayısı ve İÇERİK birebir aynı — backfill yalnız package_id
    // sütununu doldurur, hiçbir satır eklemez/silmez/değiştirmez.
    const afterRows = (
      await client.query(
        `select id, day_order, duty_location_id, duty_block_id, teacher_source_id, teacher_name_snapshot,
                duty_location_name_snapshot, duty_block_name_snapshot, assignment_kind
           from public.duty_plan_assignments where plan_id = any($1) order by id`,
        [allPlanIds],
      )
    ).rows as AssignmentSnapshotRow[];
    expect(afterRows).toEqual(beforeRows);

    // (2) Plan durumları DEĞİŞMEDİ.
    const afterStatuses = (await client.query("select id, status from public.duty_plans where id = any($1) order by id", [allPlanIds])).rows;
    expect(afterStatuses).toEqual(beforeStatuses);

    // (3) package_id: unassigned ⇔ null, diğerleri ⇔ ZORUNLU dolu (backfill
    // TÜM atanmış hücreleri bir pakete bağladı).
    const badPresence = await client.query(
      `select count(*)::int as c from public.duty_plan_assignments
        where plan_id = any($1) and ((assignment_kind = 'unassigned') <> (package_id is null))`,
      [allPlanIds],
    );
    expect(badPresence.rows[0].c).toBe(0);

    const missingPackage = await client.query(
      `select count(*)::int as c from public.duty_plan_assignments
        where plan_id = any($1) and assignment_kind <> 'unassigned' and package_id is null`,
      [allPlanIds],
    );
    expect(missingPackage.rows[0].c).toBe(0);

    // (4) Fixed AM/PM çifti (draft planındaki T2) TEK bir FIXED_SHORT_BREAKS
    // pakette birleşti (iki hücre, aynı package_id).
    const fixedPkg = await client.query(
      `select distinct package_id from public.duty_plan_assignments
        where plan_id = $1 and teacher_source_id = 'T2' and assignment_kind = 'fixed'`,
      [draftPlanId],
    );
    expect(fixedPkg.rows).toHaveLength(1);
    const fixedPkgRow = await client.query("select coverage_mode, assignment_kind from public.duty_plan_assignment_packages where id=$1", [
      fixedPkg.rows[0].package_id,
    ]);
    expect(fixedPkgRow.rows[0].coverage_mode).toBe("FIXED_SHORT_BREAKS");
    expect(fixedPkgRow.rows[0].assignment_kind).toBe("fixed");

    // (5) Published/archived planların hücreleri backfill SONRASI da HÂLÂ
    // immutable — paket yazma-kuralı tetikleyicisi backfill'den SONRA
    // oluşturuldu ve normal enforce_duty_plan_assignment_write_rules
    // (yalnız GEÇİCİ olarak disable edilmişti) doğru şekilde yeniden aktif.
    // (Her deneme kendi SAVEPOINT'i içinde: BEKLENEN bir hata, transaction'ın
    // GERİ KALANINI "aborted" durumuna düşürüp sonraki sorguları/testi
    // BOZMAMALI.)
    async function expectRejectsWithinSavepoint(query: string, params: unknown[]): Promise<void> {
      await client.query("savepoint sp_immutable");
      await expect(client.query(query, params)).rejects.toThrow();
      await client.query("rollback to savepoint sp_immutable");
    }

    await expectRejectsWithinSavepoint("update public.duty_plan_assignments set teacher_name_snapshot='hack' where plan_id=$1", [publishedPlanId]);
    await expectRejectsWithinSavepoint("update public.duty_plan_assignments set teacher_name_snapshot='hack' where plan_id=$1", [archivedPlanId]);

    // (6) Paket tablosu da aynı şekilde immutable (yeni tetikleyici çalışıyor).
    const publishedPkgId = (
      await client.query("select package_id from public.duty_plan_assignments where plan_id=$1 and teacher_source_id='T3'", [publishedPlanId])
    ).rows[0].package_id;
    await expectRejectsWithinSavepoint("update public.duty_plan_assignment_packages set teacher_name_snapshot='hack' where id=$1", [publishedPkgId]);
  });

  it("backfill idempotenttir — migration'ı (fonksiyonlar create or replace, tablo zaten var) tekrar uygulamak hatasız geçer ve state'i bozmaz", async () => {
    const beforeCount = (await client.query("select count(*)::int as c from public.duty_plan_assignment_packages")).rows[0].c;
    // Yalnız fonksiyon/backfill kısmı tekrar çalıştırılabilir mi diye backfill
    // DO bloğunun kendisini tek başına tekrar çalıştırıyoruz (tablo/trigger
    // CREATE TABLE'ları artık var olduğu için TAM dosyanın ikinci kez
    // çalıştırılması `relation already exists` ile başarısız olur — bu
    // BEKLENEN bir davranıştır, migration'lar yalnız BİR KEZ uygulanır).
    // Burada test edilen, backfill'in KENDİSİNİN `where package_id is null`
    // koşuluyla re-run-safe olduğudur.
    await client.query(`
      do $$
      begin
        with grouped as (
          select
            a.plan_id, a.campus_id, a.day_order, a.duty_location_id,
            a.teacher_source_id, min(a.teacher_name_snapshot) as teacher_name_snapshot,
            a.assignment_kind,
            case when a.assignment_kind = 'fixed' then min(a.fixed_duty_assignment_id::text)::uuid else null end as fixed_duty_assignment_id,
            array_agg(distinct b.code) as block_codes
          from public.duty_plan_assignments a
          join public.duty_blocks b on b.id = a.duty_block_id
          where a.teacher_source_id is not null and a.package_id is null
          group by a.plan_id, a.campus_id, a.day_order, a.duty_location_id, a.teacher_source_id, a.assignment_kind
        ),
        inserted as (
          insert into public.duty_plan_assignment_packages (
            plan_id, campus_id, day_order, duty_location_id, teacher_source_id, teacher_name_snapshot,
            coverage_mode, assignment_kind, fixed_duty_assignment_id
          )
          select
            g.plan_id, g.campus_id, g.day_order, g.duty_location_id, g.teacher_source_id, g.teacher_name_snapshot,
            coalesce(
              public.classify_duty_plan_package_coverage(g.duty_location_id, g.assignment_kind, g.block_codes),
              case when g.assignment_kind = 'fixed' then 'FIXED_SHORT_BREAKS' else 'SINGLE_BLOCK' end
            ),
            g.assignment_kind, g.fixed_duty_assignment_id
          from grouped g
          returning id, plan_id, day_order, duty_location_id, teacher_source_id, assignment_kind
        )
        update public.duty_plan_assignments a
          set package_id = ins.id
          from inserted ins
          where a.plan_id = ins.plan_id and a.day_order = ins.day_order
            and a.duty_location_id = ins.duty_location_id and a.teacher_source_id = ins.teacher_source_id
            and a.assignment_kind = ins.assignment_kind and a.package_id is null;
      end
      $$;
    `);
    const afterCount = (await client.query("select count(*)::int as c from public.duty_plan_assignment_packages")).rows[0].c;
    expect(afterCount).toBe(beforeCount);
  });
});
