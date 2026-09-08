import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * GERÇEK PostgreSQL testleri — 20260919090000 ile gelen öğretmen bazlı yarım
 * gün kuralı ve blok düzeyinde sabitlik. Uzak projeye ASLA dokunulmaz.
 *
 *   DUTY_PLAN_PG_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
 *
 * Bağlantı bilgisi yoksa süit atlanır — `npm run test` bu dosya olmadan da
 * yeşil kalır. Paylaşılan veritabanına bağlanan diğer pg süitleriyle birlikte
 * `--no-file-parallelism` ile SERİ çalıştırılmalıdır.
 */
const DB_URL = process.env.DUTY_PLAN_PG_TEST_DB_URL;
const enabled = Boolean(DB_URL);

describe.skipIf(!enabled)("yarım gün nöbet kuralları — gerçek PostgreSQL", () => {
  let client: Client;
  let campusId: string;
  let yearId: string;
  let planId: string;
  const loc: Record<string, string> = {};
  const block: Record<string, string> = {};

  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();

  /** Tek bir normal görev hücresi + onu taşıyan SINGLE_BLOCK paketi yazar. */
  async function assign(args: { day: number; locKey: string; blockCode: string; teacher: string; packageId?: string }): Promise<string> {
    let packageId = args.packageId;
    if (!packageId) {
      const pkg = await client.query(
        `insert into public.duty_plan_assignment_packages
           (plan_id, campus_id, day_order, duty_location_id, teacher_source_id, teacher_name_snapshot, coverage_mode, assignment_kind)
         values ($1,$2,$3,$4,$5,$6,'SINGLE_BLOCK','generated') returning id`,
        [planId, campusId, args.day, loc[args.locKey], args.teacher, `Ogretmen ${args.teacher}`],
      );
      packageId = pkg.rows[0].id as string;
    }
    await client.query(
      `insert into public.duty_plan_assignments
         (plan_id, campus_id, day_order, duty_location_id, duty_block_id, teacher_source_id, teacher_name_snapshot,
          duty_location_name_snapshot, duty_block_name_snapshot, assignment_kind, package_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'generated',$10)`,
      [planId, campusId, args.day, loc[args.locKey], block[args.blockCode], args.teacher, `Ogretmen ${args.teacher}`, args.locKey, args.blockCode, packageId],
    );
    return packageId;
  }

  /**
   * Öğretmen×gün kuralları DEFERRABLE INITIALLY DEFERRED'dır — normalde
   * COMMIT anında çalışır. Test transaction içinde kaldığı için kuralları
   * burada AÇIKÇA tetikleriz; `set constraints all immediate` gerçek bir
   * commit ile aynı doğrulamayı yapar.
   */
  async function flushDeferred(): Promise<void> {
    await client.query("set constraints all immediate");
    await client.query("set constraints all deferred");
  }

  beforeAll(async () => {
    client = new Client({ connectionString: DB_URL });
    await client.connect();
    await client.query("begin");

    const campus = await client.query("insert into public.campuses (name, code) values ($1,$2) returning id", [`HalfDay ${suffix}`, `HD${suffix}`.slice(0, 16)]);
    campusId = campus.rows[0].id;
    const year = await client.query("insert into public.academic_years (campus_id, name) values ($1,$2) returning id", [campusId, `2026-2027 ${suffix}`]);
    yearId = year.rows[0].id;
    const imp = await client.query(
      "insert into public.timetable_imports (campus_id, academic_year_id, source_format, source_filename, status) values ($1,$2,'asc','fixture.xml','imported') returning id",
      [campusId, yearId],
    );

    for (const row of (await client.query("select code, id from public.duty_blocks")).rows as { code: string; id: string }[]) {
      block[row.code] = row.id;
    }

    // İki dört-bloklu normal yer + bir saf sabit yer.
    for (const [key, code, category] of [
      ["LOBI", `LOBI${suffix}`, "corridor"],
      ["BALKON", `BALKON${suffix}`, "corridor"],
    ] as const) {
      const res = await client.query("select (public.create_duty_location($1,$2,$3,$4,1,null,true)).id as id", [campusId, key, code.slice(0, 16), category]);
      loc[key] = res.rows[0].id;
    }

    const fixedLoc = await client.query(
      `insert into public.duty_locations (campus_id, name, short_code, category, capacity, is_active, sort_order, allows_fixed_assignment)
       values ($1,'Sabit Yer',$2,'corridor',1,true,
               (select coalesce(max(sort_order),0)+1 from public.duty_locations where campus_id=$1 and deleted_at is null), true)
       returning id`,
      [campusId, `SABIT${suffix}`.slice(0, 16)],
    );
    loc.SABIT = fixedLoc.rows[0].id;
    await client.query(
      `insert into public.duty_location_blocks (campus_id, duty_location_id, duty_block_id, assignment_mode)
       select $1, $2, b.id, 'fixed_only' from public.duty_blocks b where b.code in ('MORNING_BREAKS','AFTERNOON_BREAKS')`,
      [campusId, loc.SABIT],
    );

    // HD1: yarım gün AÇIK. HD0: KAPALI. FX: sabit nöbet günü olan öğretmen.
    await client.query(
      `insert into public.teacher_duty_settings (campus_id, academic_year_id, teacher_source_id, teacher_name_snapshot, half_day_rule_enabled)
       values ($1,$2,'HD1','Yarim Gun Acik',true), ($1,$2,'HD0','Yarim Gun Kapali',false), ($1,$2,'FX','Sabit Ogretmen',true)`,
      [campusId, yearId],
    );
    await client.query(
      `insert into public.fixed_duty_assignments (campus_id, academic_year_id, teacher_source_id, teacher_name_snapshot, duty_location_id, day_order)
       values ($1,$2,'FX','Sabit Ogretmen',$3,1)`,
      [campusId, yearId, loc.SABIT],
    );

    const plan = await client.query(
      `insert into public.duty_plans (campus_id, academic_year_id, timetable_import_id, status, source_fingerprint, algorithm_version)
       values ($1,$2,$3,'draft',$4,'duty-plan-solver-v3-teacher-half-day-rules') returning id`,
      [campusId, yearId, imp.rows[0].id, "d".repeat(64)],
    );
    planId = plan.rows[0].id;
    await client.query("set constraints all deferred");
  }, 60000);

  afterAll(async () => {
    if (client) {
      await client.query("rollback");
      await client.end();
    }
  });

  it("half_day_rule_enabled=false öğretmen AYNI GÜN AYNI YERDE Sabah ve Öğleden Sonra iki SINGLE_BLOCK paketi alabilir", async () => {
    await client.query("savepoint sp");
    await assign({ day: 2, locKey: "LOBI", blockCode: "MORNING_BREAKS", teacher: "HD0" });
    await assign({ day: 2, locKey: "LOBI", blockCode: "AFTERNOON_BREAKS", teacher: "HD0" });
    await expect(flushDeferred()).resolves.toBeUndefined();

    // İki AYRI paket oluştu — paket tablosunda teacher+day+location tekilliği YOK.
    const pkgs = await client.query(
      "select coverage_mode from public.duty_plan_assignment_packages where plan_id=$1 and day_order=2 and teacher_source_id='HD0' and duty_location_id=$2",
      [planId, loc.LOBI],
    );
    expect(pkgs.rows).toHaveLength(2);
    expect(pkgs.rows.every((r: { coverage_mode: string }) => r.coverage_mode === "SINGLE_BLOCK")).toBe(true);
    await client.query("rollback to savepoint sp");
  });

  it("half_day_rule_enabled=false öğretmen aynı gün FARKLI yerlerde farklı bloklar alabilir", async () => {
    await client.query("savepoint sp");
    await assign({ day: 3, locKey: "LOBI", blockCode: "MORNING_BREAKS", teacher: "HD0" });
    await assign({ day: 3, locKey: "BALKON", blockCode: "LONG_BREAK_1", teacher: "HD0" });
    await assign({ day: 3, locKey: "LOBI", blockCode: "LONG_BREAK_2", teacher: "HD0" });
    await assign({ day: 3, locKey: "BALKON", blockCode: "AFTERNOON_BREAKS", teacher: "HD0" });
    await expect(flushDeferred()).resolves.toBeUndefined();

    const count = await client.query("select count(*)::int as n from public.duty_plan_assignments where plan_id=$1 and day_order=3 and teacher_source_id='HD0'", [planId]);
    expect(count.rows[0].n).toBe(4);
    await client.query("rollback to savepoint sp");
  });

  it("aynı öğretmene aynı gün AYNI BLOKTA iki farklı yer verilemez", async () => {
    await client.query("savepoint sp");
    await assign({ day: 4, locKey: "LOBI", blockCode: "MORNING_BREAKS", teacher: "HD0" });
    await expect(assign({ day: 4, locKey: "BALKON", blockCode: "MORNING_BREAKS", teacher: "HD0" })).rejects.toThrow(/duty_plan_assignments_teacher_day_block_uq/);
    await client.query("rollback to savepoint sp");
  });

  it("half_day_rule_enabled=true öğretmenin aynı gün İKİNCİ normal görevi reddedilir", async () => {
    await client.query("savepoint sp");
    await assign({ day: 2, locKey: "LOBI", blockCode: "MORNING_BREAKS", teacher: "HD1" });
    await assign({ day: 2, locKey: "BALKON", blockCode: "LONG_BREAK_1", teacher: "HD1" });
    await expect(flushDeferred()).rejects.toThrow(/yarım gün kuralı açık/i);
    await client.query("rollback to savepoint sp");
  });

  it("half_day_rule_enabled=true öğretmen aynı gün TEK normal görev alabilir", async () => {
    await client.query("savepoint sp");
    await assign({ day: 5, locKey: "LOBI", blockCode: "MORNING_BREAKS", teacher: "HD1" });
    await expect(flushDeferred()).resolves.toBeUndefined();
    await client.query("rollback to savepoint sp");
  });

  it("sabit nöbet günü olan öğretmene o gün HİÇBİR normal görev verilemez", async () => {
    await client.query("savepoint sp");
    await assign({ day: 1, locKey: "LOBI", blockCode: "LONG_BREAK_1", teacher: "FX" });
    await expect(flushDeferred()).rejects.toThrow(/sabit nöbet günüdür/i);
    await client.query("rollback to savepoint sp");
  });

  it("sabit öğretmen BAŞKA bir günde normal görev alabilir", async () => {
    await client.query("savepoint sp");
    await assign({ day: 2, locKey: "LOBI", blockCode: "LONG_BREAK_1", teacher: "FX" });
    await expect(flushDeferred()).resolves.toBeUndefined();
    await client.query("rollback to savepoint sp");
  });

  it("paket tablosunda teacher+day+location tekillik indeksi BULUNMAZ", async () => {
    const res = await client.query(
      "select indexname from pg_indexes where tablename='duty_plan_assignment_packages' and indexname like '%teacher_day%'",
    );
    expect(res.rows.map((r: { indexname: string }) => r.indexname)).toEqual([]);
  });

  it("duty_plan_assignments üzerindeki gün+blok tekillik indeksi mevcuttur", async () => {
    const res = await client.query("select indexname from pg_indexes where indexname='duty_plan_assignments_teacher_day_block_uq'");
    expect(res.rows).toHaveLength(1);
  });

  it("v3 planda normal paket yalnız SINGLE_BLOCK olabilir; FULL_DAY reddedilir", async () => {
    await client.query("savepoint sp");
    await expect(
      client.query(
        `insert into public.duty_plan_assignment_packages
           (plan_id, campus_id, day_order, duty_location_id, teacher_source_id, teacher_name_snapshot, coverage_mode, assignment_kind)
         values ($1,$2,5,$3,'HD0','Yarim Gun Kapali','FULL_DAY','generated')`,
        [planId, campusId, loc.LOBI],
      ),
    ).rejects.toThrow(/yalnız SINGLE_BLOCK/i);
    await client.query("rollback to savepoint sp");
  });

  it("emekliye ayrılan short_code ile yeni nöbet yeri oluşturulamaz", async () => {
    await client.query("savepoint sp");
    for (const code of ["OGLEARASI1", "OGLEARASI2", "OGLEARASIILKOKUL", "YEMEKHANE2"]) {
      await expect(
        client.query("select public.create_duty_location($1,$2,$3,'other',1,null,true)", [campusId, `Yeni ${code}`, code]),
      ).rejects.toThrow(/emekliye ayrılmıştır/i);
      await client.query("rollback to savepoint sp");
      await client.query("savepoint sp");
    }
    await client.query("rollback to savepoint sp");
  });

  it("create_duty_location blok×mod kümesini short_code'a göre kurar", async () => {
    await client.query("savepoint sp");
    const cases: [string, string[]][] = [
      ["ILKOKUL1", ["AFTERNOON_BREAKS:fixed_only", "LONG_BREAK_1:normal", "MORNING_BREAKS:fixed_only"]],
      ["YEMEKHANE1", ["LONG_BREAK_1:normal", "LONG_BREAK_2:normal"]],
      ["ALTBAHCE", ["AFTERNOON_BREAKS:normal", "LONG_BREAK_2:normal", "MORNING_BREAKS:normal"]],
    ];
    for (const [code, expectedPairs] of cases) {
      const created = await client.query("select (public.create_duty_location($1,$2,$3,'other',1,null,true)).id as id", [campusId, `Test ${code}`, code]);
      const rows = await client.query(
        `select b.code || ':' || lb.assignment_mode as pair
           from public.duty_location_blocks lb join public.duty_blocks b on b.id = lb.duty_block_id
          where lb.duty_location_id = $1 order by b.code`,
        [created.rows[0].id],
      );
      expect(rows.rows.map((r: { pair: string }) => r.pair)).toEqual(expectedPairs);
      await client.query("rollback to savepoint sp");
      await client.query("savepoint sp");
    }
    await client.query("rollback to savepoint sp");
  });
});
