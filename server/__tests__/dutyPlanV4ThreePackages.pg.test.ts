import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL = process.env.DUTY_PLAN_PG_TEST_DB_URL;
const enabled = Boolean(DB_URL);

describe.skipIf(!enabled)("v4 üçlü paket ve yer×blok politikası — gerçek PostgreSQL", () => {
  let client: Client;
  let campusId: string;
  let yearId: string;
  let importId: string;
  let locationId: string;
  const blocks: Record<string, string> = {};

  beforeAll(async () => {
    client = new Client({ connectionString: DB_URL });
    await client.connect();
    campusId = (await client.query("insert into public.campuses(name) values ('V4 Paket Test') returning id")).rows[0].id;
    yearId = (await client.query("insert into public.academic_years(campus_id,name,is_active) values ($1,'V4-TEST',true) returning id", [campusId])).rows[0].id;
    importId = (await client.query(
      "insert into public.timetable_imports(campus_id,academic_year_id,source_format,status,imported_at) values ($1,$2,'xml','imported',now()) returning id",
      [campusId, yearId],
    )).rows[0].id;
    for (const row of (await client.query("select id, code from public.duty_blocks where is_active")).rows) blocks[row.code] = row.id;

    const policies = Object.entries(blocks).map(([code, duty_block_id]) => ({
      duty_block_id,
      assignment_mode: code === "LONG_BREAK_2" ? "off" : "normal",
    }));
    locationId = (await client.query(
      "select (public.create_duty_location_with_block_policies($1,'V4 Alan','V4ALAN','garden',1,null,true,$2::jsonb)).id as id",
      [campusId, JSON.stringify(policies)],
    )).rows[0].id;
  });

  afterAll(async () => {
    await client.query("delete from public.campuses where id=$1", [campusId]);
    await client.end();
  });

  async function newPlan(): Promise<string> {
    return (await client.query(
      `insert into public.duty_plans
       (campus_id,academic_year_id,timetable_import_id,status,source_fingerprint,algorithm_version,generation_options,summary)
       values ($1,$2,$3,'draft',$4,'duty-plan-solver-v4-three-packages','{}','{}') returning id`,
      [campusId, yearId, importId, "a".repeat(64)],
    )).rows[0].id;
  }

  async function addPackage(planId: string, mode: string, teacher = "T1"): Promise<string> {
    return (await client.query(
      `insert into public.duty_plan_assignment_packages
       (plan_id,campus_id,day_order,duty_location_id,teacher_source_id,teacher_name_snapshot,coverage_mode,assignment_kind)
       values ($1,$2,1,$3,$4,$4,$5,'generated') returning id`,
      [planId, campusId, locationId, teacher, mode],
    )).rows[0].id;
  }

  async function addCell(planId: string, packageId: string, code: string, teacher = "T1"): Promise<void> {
    await client.query(
      `insert into public.duty_plan_assignments
       (plan_id,campus_id,day_order,duty_location_id,duty_block_id,teacher_source_id,teacher_name_snapshot,
        duty_location_name_snapshot,duty_block_name_snapshot,assignment_kind,package_id)
       values ($1,$2,1,$3,$4,$5,$5,'V4 Alan',$6,'generated',$7)`,
      [planId, campusId, locationId, blocks[code], teacher, code, packageId],
    );
  }

  it("Teneffüs çiftini ve ayrı öğle politikalarını atomik kaydeder", async () => {
    let row = await client.query(
      `select b.code, lb.assignment_mode from public.duty_location_blocks lb
       join public.duty_blocks b on b.id=lb.duty_block_id where lb.duty_location_id=$1 order by b.block_order`,
      [locationId],
    );
    expect(row.rows).toEqual([
      { code: "MORNING_BREAKS", assignment_mode: "normal" },
      { code: "LONG_BREAK_1", assignment_mode: "normal" },
      { code: "AFTERNOON_BREAKS", assignment_mode: "normal" },
    ]);

    const current = (await client.query("select updated_at from public.duty_locations where id=$1", [locationId])).rows[0].updated_at;
    const policies = Object.entries(blocks).map(([code, duty_block_id]) => ({
      duty_block_id,
      assignment_mode: code === "LONG_BREAK_1" ? "normal" : code === "LONG_BREAK_2" ? "normal" : "fixed_only",
    }));
    await client.query("select public.set_duty_location_block_policies($1,$2,$3::jsonb,$4)", [campusId, locationId, JSON.stringify(policies), current]);
    row = await client.query(
      `select b.code, lb.assignment_mode from public.duty_location_blocks lb
       join public.duty_blocks b on b.id=lb.duty_block_id where lb.duty_location_id=$1 order by b.block_order`,
      [locationId],
    );
    expect(row.rows.map((r) => [r.code, r.assignment_mode])).toEqual([
      ["MORNING_BREAKS", "fixed_only"], ["LONG_BREAK_1", "normal"], ["LONG_BREAK_2", "normal"], ["AFTERNOON_BREAKS", "fixed_only"],
    ]);
  });

  it("geçersiz FULL_DAY ve tek başına Sabah paketini DB seviyesinde reddeder", async () => {
    for (const scenario of ["FULL_DAY", "MORNING_ONLY"] as const) {
      await client.query("begin");
      try {
        const planId = await newPlan();
        const packageId = await addPackage(planId, scenario === "FULL_DAY" ? "FULL_DAY" : "SINGLE_BLOCK");
        if (scenario === "MORNING_ONLY") await addCell(planId, packageId, "MORNING_BREAKS");
        await expect(client.query("set constraints all immediate")).rejects.toThrow(/v4_(unsupported_package_mode|invalid_package_cells)/);
      } finally {
        await client.query("rollback");
      }
    }
  });

  it("TENEFFÜS ile ÖĞLE_1 paketlerini kabul eder ama aynı öğretmene aynı gün ikisini vermez", async () => {
    await client.query("begin");
    try {
      const planId = await newPlan();
      const breakPackage = await addPackage(planId, "SHORT_BREAKS", "T2");
      await addCell(planId, breakPackage, "MORNING_BREAKS", "T2");
      await addCell(planId, breakPackage, "AFTERNOON_BREAKS", "T2");
      await client.query("set constraints all immediate");
      await client.query("set constraints all deferred");
      const lunchPackage = await addPackage(planId, "SINGLE_BLOCK", "T2");
      await addCell(planId, lunchPackage, "LONG_BREAK_1", "T2");
      await expect(client.query("set constraints all immediate")).rejects.toThrow(/v4_teacher_daily_package_limit/);
    } finally {
      await client.query("rollback");
    }
  });
});
