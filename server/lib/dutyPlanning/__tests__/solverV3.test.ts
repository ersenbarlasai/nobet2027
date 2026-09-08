import { describe, expect, it } from "vitest";
import {
  DUTY_PLAN_SOLVER_V3_VERSION,
  analyzeV3Capacity,
  solveDutyPlanV3,
  type V3CapacityAnalysis,
  type V3Result,
  type V3SolverInput,
  type V3SolverResult,
} from "../solverV3";
import { marginalCostForLoad, type CandidateEdge } from "../solver";

/**
 * solver-v3 (öğretmen bazlı yarım gün kuralı) testleri. v1/v2 davranış
 * testleri AYRI dosyalardadır ve DEĞİŞTİRİLMEMİŞTİR.
 */

const B = { M: "blk-morning", L1: "blk-long1", L2: "blk-long2", A: "blk-afternoon" } as const;
const ALL_BLOCKS = [B.M, B.L1, B.L2, B.A];

function ok(result: V3Result): V3SolverResult {
  if (result.status !== "ok") throw new Error(`Beklenen 'ok', gelen '${result.status}'`);
  return result;
}

function task(dayOrder: number, dutyLocationId: string, dutyBlockId: string, category?: string) {
  return { dayOrder, dutyLocationId, dutyBlockId, category };
}

function edge(dayOrder: number, dutyLocationId: string, dutyBlockId: string, teacherSourceId: string): CandidateEdge {
  return { dayOrder, dutyLocationId, dutyBlockId, teacherSourceId };
}

/** Her göreve, verilen öğretmenlerin tamamını aday yapar. */
function fullEdges(tasks: ReturnType<typeof task>[], teachers: string[]): CandidateEdge[] {
  return tasks.flatMap((t) => teachers.map((id) => edge(t.dayOrder, t.dutyLocationId, t.dutyBlockId, id)));
}

function baseInput(over: Partial<V3SolverInput> = {}): V3SolverInput {
  return {
    tasks: [],
    candidateEdges: [],
    teachers: [],
    teacherFixedLoads: [],
    options: { minWeeklyDuties: 0, targetWeeklyDuties: 2, maxWeeklyDuties: 5, balanceWorkload: true, diversifyAreas: false, allowPartial: true, seed: 1 },
    ...over,
  };
}

const halfDayOn = (id: string) => ({ teacherSourceId: id, halfDayRuleEnabled: true, maxDailyNormalBlocks: 1 });
const halfDayOff = (id: string) => ({ teacherSourceId: id, halfDayRuleEnabled: false, maxDailyNormalBlocks: 4 });

describe("solver-v3 — zorunlu kurallar", () => {
  it("1) half-day AÇIK öğretmen aynı gün YALNIZ bir normal blok alır", () => {
    const tasks = [task(1, "L1", B.M), task(1, "L2", B.L1), task(1, "L3", B.A)];
    const r = ok(solveDutyPlanV3(baseInput({ tasks, candidateEdges: fullEdges(tasks, ["T1"]), teachers: [halfDayOn("T1")] })));
    expect(r.assignments.filter((a) => a.teacherSourceId === "T1")).toHaveLength(1);
    expect(r.assignedTaskCount).toBe(1);
  });

  it("2) half-day KAPALI öğretmen aynı gün FARKLI bloklarda görev alabilir", () => {
    const tasks = [task(1, "L1", B.M), task(1, "L1", B.L1), task(1, "L1", B.L2), task(1, "L1", B.A)];
    const r = ok(solveDutyPlanV3(baseInput({ tasks, candidateEdges: fullEdges(tasks, ["T1"]), teachers: [halfDayOff("T1")] })));
    expect(r.assignedTaskCount).toBe(4);
    expect(new Set(r.assignments.map((a) => a.dutyBlockId)).size).toBe(4);
  });

  it("3) half-day KAPALI öğretmen aynı blokta İKİ farklı yer alamaz", () => {
    const tasks = [task(1, "L1", B.M), task(1, "L2", B.M)];
    const r = ok(solveDutyPlanV3(baseInput({ tasks, candidateEdges: fullEdges(tasks, ["T1"]), teachers: [halfDayOff("T1")] })));
    expect(r.assignedTaskCount).toBe(1);
  });

  it("4) sabit nöbetli öğretmen sabit gününde normal görev almaz", () => {
    const tasks = [task(2, "L1", B.M), task(3, "L1", B.M)];
    const r = ok(
      solveDutyPlanV3(
        baseInput({
          tasks,
          candidateEdges: fullEdges(tasks, ["FX"]),
          teachers: [halfDayOff("FX")],
          teacherFixedLoads: [{ teacherSourceId: "FX", fixedDutyDayCount: 1 }],
          fixedDays: [{ teacherSourceId: "FX", dayOrder: 2 }],
        }),
      ),
    );
    expect(r.assignments.find((a) => a.dayOrder === 2)?.teacherSourceId).toBeNull();
    expect(r.assignments.find((a) => a.dayOrder === 3)?.teacherSourceId).toBe("FX");
  });

  it("5+6) fixed_only ve eşlemesi olmayan hücreler görev evrenine hiç girmez (snapshot süzgeci)", () => {
    // v3 solver YALNIZ kendisine verilen normal görevleri işler; fixed_only ve
    // eşlemesiz hücreler snapshot'ta zaten elenmiştir. Verilmeyen hücre için
    // solver ASLA atama üretmez.
    const tasks = [task(1, "L1", B.M)];
    const r = ok(
      solveDutyPlanV3(
        baseInput({
          tasks,
          // fixed_only bir hücreye ait aday kenarı YANLIŞLIKLA gelse bile
          // görev evreninde olmadığı için kullanılmaz.
          candidateEdges: [...fullEdges(tasks, ["T1"]), edge(1, "ILKOKUL", B.M, "T1")],
          teachers: [halfDayOff("T1")],
        }),
      ),
    );
    expect(r.assignments).toHaveLength(1);
    expect(r.assignments.every((a) => a.dutyLocationId === "L1")).toBe(true);
  });

  it("16) candidateEdges dışında hiçbir atama üretilmez", () => {
    const tasks = [task(1, "L1", B.M), task(1, "L2", B.L1)];
    const r = ok(
      solveDutyPlanV3(
        baseInput({
          tasks,
          candidateEdges: [edge(1, "L1", B.M, "T1")], // yalnız ilk görev için aday
          teachers: [halfDayOff("T1"), halfDayOff("T2")],
        }),
      ),
    );
    expect(r.assignments.find((a) => a.dutyLocationId === "L1")?.teacherSourceId).toBe("T1");
    expect(r.assignments.find((a) => a.dutyLocationId === "L2")?.teacherSourceId).toBeNull();
  });

  it("8) haftalık max; sabit gün + kilitli paket + üretilen paket toplamıyla aşılmaz", () => {
    const tasks = [task(1, "L1", B.M), task(2, "L1", B.M), task(3, "L1", B.M), task(4, "L1", B.M)];
    const locked = [{ dayOrder: 5, dutyLocationId: "L1", dutyBlockId: B.M, teacherSourceId: "T1" }];
    const r = ok(
      solveDutyPlanV3(
        baseInput({
          tasks,
          candidateEdges: [...fullEdges(tasks, ["T1"]), edge(5, "L1", B.M, "T1")],
          teachers: [halfDayOff("T1")],
          teacherFixedLoads: [{ teacherSourceId: "T1", fixedDutyDayCount: 1 }],
          fixedDays: [{ teacherSourceId: "T1", dayOrder: 4 }],
          lockedAssignments: locked,
          options: { minWeeklyDuties: 0, targetWeeklyDuties: 2, maxWeeklyDuties: 3, balanceWorkload: true, diversifyAreas: false, allowPartial: true, seed: 1 },
        }),
      ),
    );
    const load = r.teacherLoads.find((l) => l.teacherSourceId === "T1");
    // max=3: 1 sabit gün + 1 kilitli = 2 kullanılmış ⇒ en fazla 1 yeni görev.
    expect(load?.totalDutyCount).toBeLessThanOrEqual(3);
    expect(r.assignedTaskCount).toBe(1);
    const cap = r.teacherCapacities.find((c) => c.teacherSourceId === "T1");
    expect(cap).toMatchObject({ fixedDutyDayCount: 1, lockedNormalCount: 1, generatedNormalCount: 1, usedWeekly: 3, remainingWeekly: 0 });
  });

  it("7) v3 çıktısındaki bütün normal atamalar TEK hücreliktir (SINGLE_BLOCK)", () => {
    const tasks = [task(1, "L1", B.M), task(1, "L1", B.L1), task(1, "L1", B.L2), task(1, "L1", B.A)];
    const r = ok(solveDutyPlanV3(baseInput({ tasks, candidateEdges: fullEdges(tasks, ["T1"]), teachers: [halfDayOff("T1")] })));
    // Her atama TEK bir (gün, yer, blok) hücresidir — paket şablonu YOKTUR.
    const keys = r.assignments.filter((a) => a.teacherSourceId).map((a) => `${a.dayOrder}|${a.dutyLocationId}|${a.dutyBlockId}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(r.algorithmVersion).toBe(DUTY_PLAN_SOLVER_V3_VERSION);
  });
});

describe("solver-v3 — kilitli manuel atamalar", () => {
  it("12) kilitli atamalar korunur; kapasite tüketir ve yeniden atanmaz", () => {
    const tasks = [task(1, "L2", B.L1)];
    const r = ok(
      solveDutyPlanV3(
        baseInput({
          tasks,
          candidateEdges: [edge(1, "L2", B.L1, "T1"), edge(1, "L1", B.M, "T1")],
          teachers: [halfDayOn("T1")],
          lockedAssignments: [{ dayOrder: 1, dutyLocationId: "L1", dutyBlockId: B.M, teacherSourceId: "T1" }],
        }),
      ),
    );
    // T1'in yarım günü AÇIK ve gün 1 kilitli atamayla dolu ⇒ yeni görev YOK.
    expect(r.assignedTaskCount).toBe(0);
    expect(r.teacherLoads.find((l) => l.teacherSourceId === "T1")?.normalDutyCount).toBe(1);
  });

  it("13) geçersiz kilitli atama SESSİZCE silinmez — yapılandırılmış sonuç döner", () => {
    const tasks = [task(1, "L2", B.L1)];
    const result = solveDutyPlanV3(
      baseInput({
        tasks,
        candidateEdges: [edge(1, "L2", B.L1, "T1")],
        teachers: [halfDayOn("T1")],
        teacherFixedLoads: [{ teacherSourceId: "T1", fixedDutyDayCount: 1 }],
        fixedDays: [{ teacherSourceId: "T1", dayOrder: 1 }],
        // Sabit gününde kilitli normal atama ⇒ GEÇERSİZ.
        lockedAssignments: [{ dayOrder: 1, dutyLocationId: "L1", dutyBlockId: B.M, teacherSourceId: "T1" }],
      }),
    );
    expect(result.status).toBe("invalid_locked_assignment");
    if (result.status !== "invalid_locked_assignment") throw new Error("beklenmedik");
    expect(result.violations.map((v) => v.code)).toContain("fixed_duty_day");
    expect(result.violations.map((v) => v.code)).toContain("no_candidate_edge");
  });

  it("kilitli atama günlük kapasiteyi aşarsa yapılandırılmış hata döner", () => {
    const result = solveDutyPlanV3(
      baseInput({
        tasks: [],
        candidateEdges: [edge(1, "L1", B.M, "T1"), edge(1, "L2", B.L1, "T1")],
        teachers: [halfDayOn("T1")],
        lockedAssignments: [
          { dayOrder: 1, dutyLocationId: "L1", dutyBlockId: B.M, teacherSourceId: "T1" },
          { dayOrder: 1, dutyLocationId: "L2", dutyBlockId: B.L1, teacherSourceId: "T1" },
        ],
      }),
    );
    expect(result.status).toBe("invalid_locked_assignment");
    if (result.status !== "invalid_locked_assignment") throw new Error("beklenmedik");
    expect(result.violations.map((v) => v.code)).toContain("daily_capacity_exceeded");
  });
});

describe("solver-v3 — amaç sırası", () => {
  it("10) diğer koşullar eşitse AZ DERSLİ gün tercih edilir", () => {
    // İki ayrı gün, iki ayrı görev; T1 HAFTALIK olarak yalnız BİR görev
    // alabilir (maxWeeklyDuties=1). Kapsama her iki seçimde de 1 olduğundan
    // karar YALNIZ ders sayısına kalır: gün 2 (1 ders) tercih edilmeli.
    const tasks = [task(1, "L1", B.M), task(2, "L1", B.M)];
    const r = ok(
      solveDutyPlanV3(
        baseInput({
          tasks,
          candidateEdges: fullEdges(tasks, ["T1"]),
          teachers: [halfDayOn("T1")],
          lessonPeriodCountByTeacherDay: { "T1|1": 6, "T1|2": 1 },
          options: { minWeeklyDuties: 0, targetWeeklyDuties: 1, maxWeeklyDuties: 1, balanceWorkload: true, diversifyAreas: false, allowPartial: true, seed: 1 },
        }),
      ),
    );
    expect(r.assignments.find((a) => a.dayOrder === 2)?.teacherSourceId).toBe("T1");
    expect(r.assignments.find((a) => a.dayOrder === 1)?.teacherSourceId).toBeNull();
  });

  it("11) az dersli gün tercihi yüzünden görev AÇIK KALMAZ", () => {
    // T1 yarım günü KAPALI: her iki gün de alınabilir. Ders sayısı farkı
    // kapsamayı DÜŞÜRMEMELİ — ikisi de atanmalı.
    const tasks = [task(1, "L1", B.M), task(2, "L1", B.M)];
    const r = ok(
      solveDutyPlanV3(
        baseInput({
          tasks,
          candidateEdges: fullEdges(tasks, ["T1"]),
          teachers: [halfDayOff("T1")],
          lessonPeriodCountByTeacherDay: { "T1|1": 99, "T1|2": 0 },
        }),
      ),
    );
    expect(r.assignedTaskCount).toBe(2);
  });

  it("9) min/target yük dengesi kapsama kaybı YARATMAZ", () => {
    const tasks = [task(1, "L1", B.M), task(2, "L1", B.M), task(3, "L1", B.M)];
    const r = ok(
      solveDutyPlanV3(
        baseInput({
          tasks,
          candidateEdges: fullEdges(tasks, ["T1", "T2", "T3"]),
          teachers: [halfDayOn("T1"), halfDayOn("T2"), halfDayOn("T3")],
          options: { minWeeklyDuties: 1, targetWeeklyDuties: 1, maxWeeklyDuties: 3, balanceWorkload: true, diversifyAreas: false, allowPartial: true, seed: 7 },
        }),
      ),
    );
    expect(r.assignedTaskCount).toBe(3);
    // min=target=1 ⇒ üç öğretmene birer görev dağılmalı.
    expect(r.teacherLoads.map((l) => l.normalDutyCount).sort()).toEqual([1, 1, 1]);
  });

  it("17) öğretmen evrenindeki SIFIR yüklü öğretmen teacherLoads'ta kalır", () => {
    const tasks = [task(1, "L1", B.M)];
    const r = ok(
      solveDutyPlanV3(
        baseInput({
          tasks,
          candidateEdges: [edge(1, "L1", B.M, "T1")],
          teachers: [halfDayOn("T1"), halfDayOn("T_YOK")],
        }),
      ),
    );
    const zero = r.teacherLoads.find((l) => l.teacherSourceId === "T_YOK");
    expect(zero).toMatchObject({ normalDutyCount: 0, fixedDutyDayCount: 0, totalDutyCount: 0 });
    expect(r.warnings.some((w) => w.code === "teacher_no_candidate_cells" && w.teacherSourceId === "T_YOK")).toBe(true);
  });

  it("14+15) aynı seed birebir aynı sonuç; farklı seed KAPSAMAYI değiştirmez", () => {
    const tasks = [task(1, "L1", B.M), task(1, "L2", B.L1), task(2, "L1", B.M)];
    const edges = fullEdges(tasks, ["T1", "T2", "T3"]);
    const teachers = [halfDayOn("T1"), halfDayOn("T2"), halfDayOn("T3")];
    const runWith = (seed: number) =>
      ok(solveDutyPlanV3(baseInput({ tasks, candidateEdges: edges, teachers, options: { minWeeklyDuties: 0, targetWeeklyDuties: 2, maxWeeklyDuties: 5, balanceWorkload: true, diversifyAreas: false, allowPartial: true, seed } })));

    const a1 = runWith(11);
    const a2 = runWith(11);
    expect(a2.assignments).toEqual(a1.assignments);

    for (const seed of [1, 2, 3, 42, 99]) {
      expect(runWith(seed).assignedTaskCount).toBe(a1.assignedTaskCount);
    }
  });

  it("optimalityProven=true, searchLimitReached=false (kesin min-cost-flow)", () => {
    const tasks = [task(1, "L1", B.M)];
    const r = ok(solveDutyPlanV3(baseInput({ tasks, candidateEdges: fullEdges(tasks, ["T1"]), teachers: [halfDayOn("T1")] })));
    expect(r.optimalityProven).toBe(true);
    expect(r.searchLimitReached).toBe(false);
  });
});

// ============================================================================
// Brute-force karşılaştırması
// ============================================================================
/** Tüm atama kombinasyonlarını deneyip AZAMİ kapsamayı bulur (küçük fixture). */
function bruteForceMaxCoverage(input: V3SolverInput): number {
  const options = input.options as Required<V3SolverInput>["options"];
  const maxWeekly = options?.maxWeeklyDuties ?? 5;
  const tasks = input.tasks;
  const capById = new Map(input.teachers.map((t) => [t.teacherSourceId, t.maxDailyNormalBlocks ?? (t.halfDayRuleEnabled === false ? 4 : 1)]));
  const fixedCount = new Map(input.teacherFixedLoads.map((f) => [f.teacherSourceId, f.fixedDutyDayCount]));
  const fixedDays = new Set((input.fixedDays ?? []).map((d) => `${d.teacherSourceId}|${d.dayOrder}`));
  const edgeSet = new Set(input.candidateEdges.map((e) => `${e.dayOrder}|${e.dutyLocationId}|${e.dutyBlockId}>${e.teacherSourceId}`));
  const teacherIds = input.teachers.map((t) => t.teacherSourceId);

  let best = 0;
  const dayUse = new Map<string, number>();
  const blockUse = new Set<string>();
  const weekUse = new Map<string, number>();

  function recurse(i: number, covered: number) {
    if (covered + (tasks.length - i) <= best) return; // budama
    if (i === tasks.length) {
      best = Math.max(best, covered);
      return;
    }
    const t = tasks[i];
    recurse(i + 1, covered); // atama YOK
    for (const id of teacherIds) {
      if (!edgeSet.has(`${t.dayOrder}|${t.dutyLocationId}|${t.dutyBlockId}>${id}`)) continue;
      if (fixedDays.has(`${id}|${t.dayOrder}`)) continue;
      const dk = `${id}|${t.dayOrder}`;
      const bk = `${id}|${t.dayOrder}|${t.dutyBlockId}`;
      if (blockUse.has(bk)) continue;
      if ((dayUse.get(dk) ?? 0) + 1 > (capById.get(id) ?? 1)) continue;
      if ((weekUse.get(id) ?? 0) + (fixedCount.get(id) ?? 0) + 1 > maxWeekly) continue;

      dayUse.set(dk, (dayUse.get(dk) ?? 0) + 1);
      blockUse.add(bk);
      weekUse.set(id, (weekUse.get(id) ?? 0) + 1);
      recurse(i + 1, covered + 1);
      dayUse.set(dk, (dayUse.get(dk) as number) - 1);
      blockUse.delete(bk);
      weekUse.set(id, (weekUse.get(id) as number) - 1);
    }
  }
  recurse(0, 0);
  return best;
}

describe("solver-v3 — brute-force optimumu", () => {
  it("19) küçük elle kurulmuş fixture'larda kapsama brute-force optimumuna EŞİTTİR", () => {
    const cases: V3SolverInput[] = [
      baseInput({
        tasks: [task(1, "L1", B.M), task(1, "L2", B.M), task(1, "L1", B.L1)],
        candidateEdges: fullEdges([task(1, "L1", B.M), task(1, "L2", B.M), task(1, "L1", B.L1)], ["T1", "T2"]),
        teachers: [halfDayOn("T1"), halfDayOff("T2")],
      }),
      baseInput({
        tasks: [task(1, "L1", B.M), task(2, "L1", B.M), task(3, "L1", B.M)],
        candidateEdges: fullEdges([task(1, "L1", B.M), task(2, "L1", B.M), task(3, "L1", B.M)], ["T1"]),
        teachers: [halfDayOn("T1")],
        options: { minWeeklyDuties: 0, targetWeeklyDuties: 1, maxWeeklyDuties: 2, balanceWorkload: true, diversifyAreas: false, allowPartial: true, seed: 3 },
      }),
    ];
    for (const input of cases) {
      expect(ok(solveDutyPlanV3(input)).assignedTaskCount).toBe(bruteForceMaxCoverage(input));
    }
  });

  it("20) rastgele küçük fixture property testi — kurallar + brute-force azami kapsama", () => {
    let rng = 123456789;
    const rand = (n: number) => {
      rng = (Math.imul(rng, 1103515245) + 12345) & 0x7fffffff;
      return rng % n;
    };

    for (let iter = 0; iter < 60; iter++) {
      const locations = ["L1", "L2"];
      const days = [1, 2];
      const tasks: ReturnType<typeof task>[] = [];
      for (const d of days) {
        for (const l of locations) {
          for (const b of ALL_BLOCKS) {
            if (rand(100) < 45) tasks.push(task(d, l, b));
          }
        }
      }
      if (tasks.length === 0) continue;

      const teacherIds = ["A", "B", "C"];
      const teachers = teacherIds.map((id) => (rand(2) === 0 ? halfDayOn(id) : halfDayOff(id)));
      const candidateEdges: CandidateEdge[] = [];
      for (const t of tasks) for (const id of teacherIds) if (rand(100) < 70) candidateEdges.push(edge(t.dayOrder, t.dutyLocationId, t.dutyBlockId, id));

      const fixedDays = teacherIds.filter(() => rand(100) < 20).map((id) => ({ teacherSourceId: id, dayOrder: 1 + rand(2) }));
      const teacherFixedLoads = fixedDays.map((f) => ({ teacherSourceId: f.teacherSourceId, fixedDutyDayCount: 1 }));

      const input = baseInput({
        tasks,
        candidateEdges,
        teachers,
        fixedDays,
        teacherFixedLoads,
        options: { minWeeklyDuties: 0, targetWeeklyDuties: 2, maxWeeklyDuties: 4, balanceWorkload: true, diversifyAreas: false, allowPartial: true, seed: iter },
      });
      const r = ok(solveDutyPlanV3(input));

      // (a) duplicate görev yok
      const cellKeys = r.assignments.map((a) => `${a.dayOrder}|${a.dutyLocationId}|${a.dutyBlockId}`);
      expect(new Set(cellKeys).size).toBe(cellKeys.length);

      const edgeSet = new Set(candidateEdges.map((e) => `${e.dayOrder}|${e.dutyLocationId}|${e.dutyBlockId}>${e.teacherSourceId}`));
      const dayBlock = new Set<string>();
      const perDay = new Map<string, number>();
      const perWeek = new Map<string, number>();
      const fixedSet = new Set(fixedDays.map((f) => `${f.teacherSourceId}|${f.dayOrder}`));

      for (const a of r.assignments) {
        if (!a.teacherSourceId) continue;
        // (b) yalnız aday kenarı
        expect(edgeSet.has(`${a.dayOrder}|${a.dutyLocationId}|${a.dutyBlockId}>${a.teacherSourceId}`)).toBe(true);
        // (c) sabit günde görev yok
        expect(fixedSet.has(`${a.teacherSourceId}|${a.dayOrder}`)).toBe(false);
        // (d) teacher-day-block çakışması yok
        const bk = `${a.teacherSourceId}|${a.dayOrder}|${a.dutyBlockId}`;
        expect(dayBlock.has(bk)).toBe(false);
        dayBlock.add(bk);
        const dk = `${a.teacherSourceId}|${a.dayOrder}`;
        perDay.set(dk, (perDay.get(dk) ?? 0) + 1);
        perWeek.set(a.teacherSourceId, (perWeek.get(a.teacherSourceId) ?? 0) + 1);
      }
      // (e) günlük kapasite aşımı yok
      for (const [dk, n] of perDay) {
        const id = dk.split("|")[0];
        const cap = teachers.find((t) => t.teacherSourceId === id)?.maxDailyNormalBlocks ?? 1;
        expect(n).toBeLessThanOrEqual(cap);
      }
      // (f) haftalık max aşımı yok
      for (const [id, n] of perWeek) {
        const fixed = teacherFixedLoads.find((f) => f.teacherSourceId === id)?.fixedDutyDayCount ?? 0;
        expect(n + fixed).toBeLessThanOrEqual(4);
      }
      // (g) brute-force azami kapsamaya EŞİT
      expect(r.assignedTaskCount).toBe(bruteForceMaxCoverage(input));
    }
  });
});

describe("solver-v3 — kapasite senaryoları", () => {
  it("18) currentRules ve allHalfDayRulesDisabled doğru AYRIŞIR", () => {
    // Tek öğretmen, tek gün, dört blok. Yarım gün AÇIK ⇒ 1 kapsanır;
    // KAPALI kabul edilirse 4 kapsanır.
    const tasks = [task(1, "L1", B.M), task(1, "L1", B.L1), task(1, "L1", B.L2), task(1, "L1", B.A)];
    const analysis: V3CapacityAnalysis = analyzeV3Capacity(
      baseInput({ tasks, candidateEdges: fullEdges(tasks, ["T1"]), teachers: [halfDayOn("T1")] }),
    );
    expect(analysis.currentRules.maxCoverableTasks).toBe(1);
    expect(analysis.currentRules.uncoveredTasks).toBe(3);
    expect(analysis.allHalfDayRulesDisabled.maxCoverableTasks).toBe(4);
    expect(analysis.allHalfDayRulesDisabled.uncoveredTasks).toBe(0);
    expect(analysis.coverageGainIfHalfDayDisabled).toBe(3);
    expect(analysis.currentRules.shortfallByDay[1]).toBe(3);
  });

  it("kapasite analizi solver ile AYNI motoru kullanır — currentRules solver kapsamasıyla tutarlıdır", () => {
    const tasks = [task(1, "L1", B.M), task(1, "L2", B.M), task(2, "L1", B.L1)];
    const input = baseInput({ tasks, candidateEdges: fullEdges(tasks, ["T1", "T2"]), teachers: [halfDayOn("T1"), halfDayOn("T2")] });
    expect(analyzeV3Capacity(input).currentRules.maxCoverableTasks).toBe(ok(solveDutyPlanV3(input)).assignedTaskCount);
  });

  it("sabit gün kapasite senaryolarında da SIFIR kapasite üretir", () => {
    const tasks = [task(1, "L1", B.M)];
    const analysis = analyzeV3Capacity(
      baseInput({
        tasks,
        candidateEdges: fullEdges(tasks, ["FX"]),
        teachers: [halfDayOff("FX")],
        fixedDays: [{ teacherSourceId: "FX", dayOrder: 1 }],
        teacherFixedLoads: [{ teacherSourceId: "FX", fixedDutyDayCount: 1 }],
      }),
    );
    expect(analysis.currentRules.maxCoverableTasks).toBe(0);
    expect(analysis.allHalfDayRulesDisabled.maxCoverableTasks).toBe(0);
  });
});

// ============================================================================
// Kilitli atamalı kapasite analizi — REGRESYON
// ============================================================================
describe("solver-v3 — kapasite analizi kilitli atamaları hesaba katar", () => {
  /**
   * REGRESYON: eski analiz `lockedAssignments`'ı TAMAMEN yok sayıyordu ve
   * kapasiteyi AŞIRI tahmin ediyordu. Artık kilitli paketler haftalık ve
   * günlük kapasiteyi tüketir, ilgili teacher-day-block hücresini kapatır.
   */
  it("kilitli paket haftalık kapasiteyi TÜKETİR (aşırı tahmin yok)", () => {
    // T1 haftalık max=2, bir kilitli paketi var ⇒ yalnız 1 yeni görev kapanabilir.
    const tasks = [task(2, "L1", B.M), task(3, "L1", B.M)];
    const input = baseInput({
      tasks,
      candidateEdges: [...fullEdges(tasks, ["T1"]), edge(1, "L1", B.M, "T1")],
      teachers: [halfDayOff("T1")],
      lockedAssignments: [{ dayOrder: 1, dutyLocationId: "L1", dutyBlockId: B.M, teacherSourceId: "T1" }],
      options: { minWeeklyDuties: 0, targetWeeklyDuties: 1, maxWeeklyDuties: 2, balanceWorkload: true, diversifyAreas: false, allowPartial: true, seed: 1 },
    });
    const analysis = analyzeV3Capacity(input);
    expect(analysis.currentRules.maxCoverableTasks).toBe(1);
    // Yarım gün tavanı değişse bile HAFTALIK sınır aynı ⇒ yine 1.
    expect(analysis.allHalfDayRulesDisabled.maxCoverableTasks).toBe(1);
  });

  it("kilitli paket GÜNLÜK kapasiteyi tüketir", () => {
    // T1 yarım günü AÇIK (günde 1) ve gün 1 kilitli ⇒ gün 1'de yeni görev YOK.
    const tasks = [task(1, "L2", B.L1)];
    const input = baseInput({
      tasks,
      candidateEdges: [edge(1, "L2", B.L1, "T1"), edge(1, "L1", B.M, "T1")],
      teachers: [halfDayOn("T1")],
      lockedAssignments: [{ dayOrder: 1, dutyLocationId: "L1", dutyBlockId: B.M, teacherSourceId: "T1" }],
    });
    expect(analyzeV3Capacity(input).currentRules.maxCoverableTasks).toBe(0);
  });

  it("kilitli paket AYNI gün+blok hücresini KAPATIR", () => {
    // T1 yarım günü KAPALI; gün 1 Sabah kilitli ⇒ başka bir YERDE aynı blok alınamaz.
    const tasks = [task(1, "L2", B.M)];
    const input = baseInput({
      tasks,
      candidateEdges: [edge(1, "L2", B.M, "T1"), edge(1, "L1", B.M, "T1")],
      teachers: [halfDayOff("T1")],
      lockedAssignments: [{ dayOrder: 1, dutyLocationId: "L1", dutyBlockId: B.M, teacherSourceId: "T1" }],
    });
    expect(analyzeV3Capacity(input).currentRules.maxCoverableTasks).toBe(0);
  });

  it("allHalfDayRulesDisabled kilitleri, sabit günleri ve haftalık max'ı KORUR", () => {
    const tasks = [task(1, "L1", B.L1), task(2, "L1", B.M)];
    const input = baseInput({
      tasks,
      candidateEdges: [...fullEdges(tasks, ["FX"]), edge(1, "L1", B.M, "FX")],
      teachers: [halfDayOn("FX")],
      teacherFixedLoads: [{ teacherSourceId: "FX", fixedDutyDayCount: 1 }],
      fixedDays: [{ teacherSourceId: "FX", dayOrder: 2 }],
      lockedAssignments: [{ dayOrder: 1, dutyLocationId: "L1", dutyBlockId: B.M, teacherSourceId: "FX" }],
      options: { minWeeklyDuties: 0, targetWeeklyDuties: 1, maxWeeklyDuties: 3, balanceWorkload: true, diversifyAreas: false, allowPartial: true, seed: 1 },
    });
    const a = analyzeV3Capacity(input);
    // Gün 2 SABİT ⇒ kapasite 0. Gün 1'de kilitli var ama yarım gün kapatılırsa
    // ikinci blok (Öğle Arası-1) açılabilir.
    expect(a.currentRules.maxCoverableTasks).toBe(0);
    expect(a.allHalfDayRulesDisabled.maxCoverableTasks).toBe(1);
    // Gün 2 her iki senaryoda da kapalı kalır.
    expect(a.allHalfDayRulesDisabled.shortfallByDay[2]).toBe(1);
  });

  it("currentRules.maxCoverableTasks solver'ın ÜRETTİĞİ görev sayısıyla birebir eşleşir", () => {
    const tasks = [task(1, "L1", B.M), task(1, "L1", B.L1), task(2, "L2", B.M), task(2, "L1", B.L2)];
    const input = baseInput({
      tasks,
      candidateEdges: fullEdges(tasks, ["T1", "T2"]),
      teachers: [halfDayOn("T1"), halfDayOff("T2")],
      lockedAssignments: [{ dayOrder: 3, dutyLocationId: "L1", dutyBlockId: B.M, teacherSourceId: "T2" }],
      options: { minWeeklyDuties: 0, targetWeeklyDuties: 2, maxWeeklyDuties: 3, balanceWorkload: true, diversifyAreas: false, allowPartial: true, seed: 4 },
    });
    // Kilitli hücrenin aday kenarı olmalı, aksi halde invalid_locked_assignment.
    input.candidateEdges = [...input.candidateEdges, edge(3, "L1", B.M, "T2")];
    const solved = ok(solveDutyPlanV3(input));
    expect(analyzeV3Capacity(input).currentRules.maxCoverableTasks).toBe(solved.assignedTaskCount);
  });
});

// ============================================================================
// Lexicographic amaç demeti — brute-force karşılaştırması
// ============================================================================
describe("solver-v3 — lexicographic amaç demeti", () => {
  /**
   * (kapsama, -haftalıkMaliyet, -dersMaliyeti) demetini brute-force ile
   * karşılaştırır. Yalnız kapsama sayısı DEĞİL, amaç SIRASI da doğrulanır.
   */
  function bruteForceBestTuple(input: V3SolverInput): [number, number, number] {
    const options = input.options as Required<V3SolverInput>["options"];
    const maxWeekly = options?.maxWeeklyDuties ?? 5;
    const min = options?.minWeeklyDuties ?? 0;
    const target = options?.targetWeeklyDuties ?? 2;
    const balance = options?.balanceWorkload ?? true;
    const tasks = input.tasks;
    const capById = new Map(input.teachers.map((t) => [t.teacherSourceId, t.maxDailyNormalBlocks ?? (t.halfDayRuleEnabled === false ? 4 : 1)]));
    const fixedCount = new Map(input.teacherFixedLoads.map((f) => [f.teacherSourceId, f.fixedDutyDayCount]));
    const fixedDays = new Set((input.fixedDays ?? []).map((d) => `${d.teacherSourceId}|${d.dayOrder}`));
    const edgeSet = new Set(input.candidateEdges.map((e) => `${e.dayOrder}|${e.dutyLocationId}|${e.dutyBlockId}>${e.teacherSourceId}`));
    const lessons = input.lessonPeriodCountByTeacherDay ?? {};
    const teacherIds = input.teachers.map((t) => t.teacherSourceId);

    let best: [number, number, number] = [-1, 0, 0];
    const dayUse = new Map<string, number>();
    const blockUse = new Set<string>();
    const weekUse = new Map<string, number>();
    const chosen: { teacher: string; day: number }[] = [];

    const evaluate = (): [number, number, number] => {
      let weekly = 0;
      for (const id of teacherIds) {
        const fixed = fixedCount.get(id) ?? 0;
        const n = weekUse.get(id) ?? 0;
        for (let j = 1; j <= n; j++) weekly += marginalCostForLoad(fixed + j, min, target, balance);
      }
      let lesson = 0;
      for (const c of chosen) lesson += lessons[`${c.teacher}|${c.day}`] ?? 0;
      return [chosen.length, -weekly, -lesson];
    };
    const better = (a: [number, number, number], b: [number, number, number]) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

    function recurse(i: number) {
      if (i === tasks.length) {
        const tuple = evaluate();
        if (better(tuple, best)) best = tuple;
        return;
      }
      const t = tasks[i];
      recurse(i + 1);
      for (const id of teacherIds) {
        if (!edgeSet.has(`${t.dayOrder}|${t.dutyLocationId}|${t.dutyBlockId}>${id}`)) continue;
        if (fixedDays.has(`${id}|${t.dayOrder}`)) continue;
        const dk = `${id}|${t.dayOrder}`;
        const bk = `${id}|${t.dayOrder}|${t.dutyBlockId}`;
        if (blockUse.has(bk)) continue;
        if ((dayUse.get(dk) ?? 0) + 1 > (capById.get(id) ?? 1)) continue;
        if ((weekUse.get(id) ?? 0) + (fixedCount.get(id) ?? 0) + 1 > maxWeekly) continue;
        dayUse.set(dk, (dayUse.get(dk) ?? 0) + 1);
        blockUse.add(bk);
        weekUse.set(id, (weekUse.get(id) ?? 0) + 1);
        chosen.push({ teacher: id, day: t.dayOrder });
        recurse(i + 1);
        chosen.pop();
        dayUse.set(dk, (dayUse.get(dk) as number) - 1);
        blockUse.delete(bk);
        weekUse.set(id, (weekUse.get(id) as number) - 1);
      }
    }
    recurse(0);
    return best;
  }

  function solverTuple(input: V3SolverInput): [number, number, number] {
    const options = input.options as Required<V3SolverInput>["options"];
    const r = ok(solveDutyPlanV3(input));
    const lessons = input.lessonPeriodCountByTeacherDay ?? {};
    const fixedCount = new Map(input.teacherFixedLoads.map((f) => [f.teacherSourceId, f.fixedDutyDayCount]));
    const perTeacher = new Map<string, number>();
    let lesson = 0;
    for (const a of r.assignments) {
      if (!a.teacherSourceId) continue;
      perTeacher.set(a.teacherSourceId, (perTeacher.get(a.teacherSourceId) ?? 0) + 1);
      lesson += lessons[`${a.teacherSourceId}|${a.dayOrder}`] ?? 0;
    }
    let weekly = 0;
    for (const [id, n] of perTeacher) {
      const fixed = fixedCount.get(id) ?? 0;
      for (let j = 1; j <= n; j++) {
        weekly += marginalCostForLoad(fixed + j, options.minWeeklyDuties ?? 0, options.targetWeeklyDuties ?? 0, options.balanceWorkload ?? true);
      }
    }
    return [r.assignedTaskCount, -weekly, -lesson];
  }

  it("küçük rastgele fixture'larda TAM lexicographic demet brute-force ile eşleşir", () => {
    let rng = 987654321;
    const rand = (n: number) => {
      rng = (Math.imul(rng, 1103515245) + 12345) & 0x7fffffff;
      return rng % n;
    };
    for (let iter = 0; iter < 40; iter++) {
      const tasks: ReturnType<typeof task>[] = [];
      for (const d of [1, 2]) for (const l of ["L1", "L2"]) for (const b of [B.M, B.L1]) if (rand(100) < 55) tasks.push(task(d, l, b));
      if (tasks.length === 0) continue;
      const ids = ["A", "B"];
      const teachers = ids.map((id) => (rand(2) === 0 ? halfDayOn(id) : halfDayOff(id)));
      const candidateEdges: CandidateEdge[] = [];
      for (const t of tasks) for (const id of ids) if (rand(100) < 75) candidateEdges.push(edge(t.dayOrder, t.dutyLocationId, t.dutyBlockId, id));
      const lessonPeriodCountByTeacherDay: Record<string, number> = {};
      for (const id of ids) for (const d of [1, 2]) lessonPeriodCountByTeacherDay[`${id}|${d}`] = rand(7);

      const input = baseInput({
        tasks,
        candidateEdges,
        teachers,
        lessonPeriodCountByTeacherDay,
        options: { minWeeklyDuties: rand(2), targetWeeklyDuties: 2, maxWeeklyDuties: 3, balanceWorkload: true, diversifyAreas: false, allowPartial: true, seed: iter },
      });
      expect(solverTuple(input)).toEqual(bruteForceBestTuple(input));
    }
  });

  it("dominance ölçekleri veri büyüdükçe de sıralamayı korur (çok görevli fixture)", () => {
    // 40 görev, yüksek ders sayıları: sabit 1e6/1e3 ölçekleri taşabilirdi.
    const tasks: ReturnType<typeof task>[] = [];
    for (let d = 1; d <= 5; d++) for (let i = 0; i < 8; i++) tasks.push(task(d, `L${i}`, ALL_BLOCKS[i % 4]));
    const ids = ["A", "B", "C", "D", "E"];
    const lessonPeriodCountByTeacherDay: Record<string, number> = {};
    for (const id of ids) for (let d = 1; d <= 5; d++) lessonPeriodCountByTeacherDay[`${id}|${d}`] = 12;
    const input = baseInput({
      tasks,
      candidateEdges: fullEdges(tasks, ids),
      teachers: ids.map((id) => halfDayOff(id)),
      lessonPeriodCountByTeacherDay,
      options: { minWeeklyDuties: 1, targetWeeklyDuties: 3, maxWeeklyDuties: 5, balanceWorkload: true, diversifyAreas: false, allowPartial: true, seed: 9 },
    });
    const r = ok(solveDutyPlanV3(input));
    // Kapsama HÂLÂ azami: haftalık kapasite 5×5=25 ⇒ 25 görev kapanmalı.
    expect(r.assignedTaskCount).toBe(25);
    // Ders maliyeti kapsamayı DÜŞÜREMEZ.
    expect(r.unassignedTaskCount).toBe(tasks.length - 25);
  });
});

// ============================================================================
// Optimalite DÜRÜSTLÜĞÜ
// ============================================================================
describe("solver-v3 — optimalite alanlarının semantiği", () => {
  const tasksFor = () => [task(1, "L1", B.M, "garden"), task(1, "L2", B.M, "corridor"), task(2, "L1", B.M, "garden"), task(2, "L2", B.M, "corridor")];

  it("diversifyAreas=false ⇒ optimalityProven=true (saf min-cost-flow)", () => {
    const tasks = tasksFor();
    const r = ok(
      solveDutyPlanV3(
        baseInput({
          tasks,
          candidateEdges: fullEdges(tasks, ["T1", "T2"]),
          teachers: [halfDayOff("T1"), halfDayOff("T2")],
          options: { minWeeklyDuties: 0, targetWeeklyDuties: 2, maxWeeklyDuties: 5, balanceWorkload: true, diversifyAreas: false, allowPartial: true, seed: 3 },
        }),
      ),
    );
    expect(r.optimalityProven).toBe(true);
    expect(r.coverageOptimalityProven).toBe(true);
    expect(r.optimalityReason).toBeNull();
    expect(r.searchLimitReached).toBe(false);
  });

  it("diversifyAreas=true ⇒ optimalityProven=false, coverageOptimalityProven=true", () => {
    const tasks = tasksFor();
    const r = ok(
      solveDutyPlanV3(
        baseInput({
          tasks,
          candidateEdges: fullEdges(tasks, ["T1", "T2"]),
          teachers: [halfDayOff("T1"), halfDayOff("T2")],
          options: { minWeeklyDuties: 0, targetWeeklyDuties: 2, maxWeeklyDuties: 5, balanceWorkload: true, diversifyAreas: true, allowPartial: true, seed: 3 },
        }),
      ),
    );
    // Çeşitlilik SEZGİSELDİR ⇒ nihai sıralama kanıtlanmaz...
    expect(r.optimalityProven).toBe(false);
    expect(r.optimalityReason).toBe("diversification_heuristic");
    // ...ama KAPSAMA her durumda kesin maksimumdur.
    expect(r.coverageOptimalityProven).toBe(true);
    // Sorun arama limiti DEĞİLDİR.
    expect(r.searchLimitReached).toBe(false);
  });

  it("çeşitlilik geçişi KAPSAMAYI ve zorunlu kuralları bozmaz, skoru düşürmez", () => {
    const tasks = [
      task(1, "L1", B.M, "garden"),
      task(1, "L2", B.M, "corridor"),
      task(1, "L1", B.L1, "garden"),
      task(1, "L2", B.L1, "corridor"),
      task(2, "L1", B.M, "garden"),
      task(2, "L2", B.M, "corridor"),
    ];
    const edges = fullEdges(tasks, ["T1", "T2"]);
    const teachers = [halfDayOff("T1"), halfDayOff("T2")];
    const opts = { minWeeklyDuties: 0, targetWeeklyDuties: 3, maxWeeklyDuties: 5, balanceWorkload: true, allowPartial: true, seed: 8 };

    const plain = ok(solveDutyPlanV3(baseInput({ tasks, candidateEdges: edges, teachers, options: { ...opts, diversifyAreas: false } })));
    const diverse = ok(solveDutyPlanV3(baseInput({ tasks, candidateEdges: edges, teachers, options: { ...opts, diversifyAreas: true } })));

    // Kapsama AYNI.
    expect(diverse.assignedTaskCount).toBe(plain.assignedTaskCount);

    const score = (r: typeof plain) => {
      const per = new Map<string, Set<string>>();
      for (const a of r.assignments) {
        if (!a.teacherSourceId || !a.category) continue;
        const set = per.get(a.teacherSourceId) ?? new Set<string>();
        set.add(a.category);
        per.set(a.teacherSourceId, set);
      }
      return [...per.values()].reduce((n, s) => n + s.size, 0);
    };
    // GERÇEK çeşitlilik skoru ASLA azalmaz.
    expect(score(diverse)).toBeGreaterThanOrEqual(score(plain));

    // Zorunlu kurallar korunur: teacher+day+block tekilliği ve günlük kapasite.
    const seen = new Set<string>();
    const perDay = new Map<string, number>();
    for (const a of diverse.assignments) {
      if (!a.teacherSourceId) continue;
      const bk = `${a.teacherSourceId}|${a.dayOrder}|${a.dutyBlockId}`;
      expect(seen.has(bk)).toBe(false);
      seen.add(bk);
      const dk = `${a.teacherSourceId}|${a.dayOrder}`;
      perDay.set(dk, (perDay.get(dk) ?? 0) + 1);
    }
    for (const [, n] of perDay) expect(n).toBeLessThanOrEqual(4);
    // Haftalık yük değişmez.
    expect(diverse.teacherLoads.reduce((n, l) => n + l.normalDutyCount, 0)).toBe(plain.teacherLoads.reduce((n, l) => n + l.normalDutyCount, 0));
  });

  it("diversifyAreas=true deterministiktir (aynı input+seed ⇒ aynı sonuç)", () => {
    const tasks = tasksFor();
    const run = () =>
      ok(
        solveDutyPlanV3(
          baseInput({
            tasks,
            candidateEdges: fullEdges(tasks, ["T1", "T2", "T3"]),
            teachers: [halfDayOff("T1"), halfDayOff("T2"), halfDayOff("T3")],
            options: { minWeeklyDuties: 0, targetWeeklyDuties: 2, maxWeeklyDuties: 5, balanceWorkload: true, diversifyAreas: true, allowPartial: true, seed: 21 },
          }),
        ),
      );
    expect(run().assignments).toEqual(run().assignments);
  });
});

// ============================================================================
// YÜK BİRİMİ muhasebesi
// ============================================================================
describe("solver-v3 — yük birimi (hücre ≠ birim)", () => {
  /** Bir (gün, yer) sabit grubu: Sabah + Öğleden Sonra iki hücre. */
  function fixedGroup(dayOrder: number, dutyLocationId: string, teacher: string | null) {
    return [
      { dayOrder, dutyLocationId, dutyBlockId: B.M, fixedCoveredByTeacherSourceId: teacher },
      { dayOrder, dutyLocationId, dutyBlockId: B.A, fixedCoveredByTeacherSourceId: teacher },
    ];
  }

  it("sabit hücreler ikişerli paketlenir: 2 hücre = 1 yük birimi", () => {
    const tasks = [task(1, "L1", B.L1), task(2, "L1", B.L1)];
    const r = ok(
      solveDutyPlanV3(
        baseInput({
          tasks,
          candidateEdges: fullEdges(tasks, ["T1"]),
          teachers: [halfDayOff("T1")],
          teacherFixedLoads: [{ teacherSourceId: "FX", fixedDutyDayCount: 2 }],
          fixedDays: [
            { teacherSourceId: "FX", dayOrder: 1 },
            { teacherSourceId: "FX", dayOrder: 2 },
          ],
          fixedTaskCells: [...fixedGroup(1, "ILK", "FX"), ...fixedGroup(2, "ILK", "FX")],
        }),
      ),
    );
    expect(r.loadUnits.fixedRequiredUnits).toBe(2);
    expect(r.loadUnits.fixedCoveredUnits).toBe(2);
    expect(r.loadUnits.fixedUncoveredUnits).toBe(0);
    expect(r.loadUnits.normalRequiredUnits).toBe(2);
    expect(r.loadUnits.totalRequiredLoadUnits).toBe(4);
    // Ham hücre: 2 normal + 4 sabit hücre = 6 — birimden FARKLI.
    expect(r.loadUnits.rawTaskCells).toBe(6);
    expect(r.loadUnits.rawTaskCells).not.toBe(r.loadUnits.totalRequiredLoadUnits);
    expect(r.fixedAssignmentCount).toBe(2);
  });

  it("7) ÖĞRETMENİ ATANMAMIŞ sabit grup yine de GEREKLİ sayılır", () => {
    const tasks = [task(1, "L1", B.L1)];
    const r = ok(
      solveDutyPlanV3(
        baseInput({
          tasks,
          candidateEdges: fullEdges(tasks, ["T1"]),
          teachers: [halfDayOff("T1")],
          // Sabit ATAMA YOK: fixedDays ve teacherFixedLoads boş.
          fixedTaskCells: fixedGroup(1, "ILK", null),
          options: { minWeeklyDuties: 0, targetWeeklyDuties: 1, maxWeeklyDuties: 3, balanceWorkload: true, diversifyAreas: false, allowPartial: true, seed: 1 },
        }),
      ),
    );
    expect(r.loadUnits.fixedRequiredUnits).toBe(1);
    expect(r.loadUnits.fixedCoveredUnits).toBe(0);
    expect(r.loadUnits.fixedUncoveredUnits).toBe(1);
    // Ham hücre bu İKİ sabit hücreyi İÇERİR.
    expect(r.loadUnits.rawTaskCells).toBe(3);
    // Gerekli yük atanmamış olsa da DÜŞMEZ ⇒ yedek yapay olarak ARTMAZ.
    expect(r.loadUnits.totalRequiredLoadUnits).toBe(2);
    expect(r.loadUnits.aggregateCapacitySlack).toBe(1 * 3 - 2);
  });

  it("7b) atanmamış sabit grup yedeği ŞİŞİRMEZ (atanmışla AYNI gerekli yük)", () => {
    const tasks = [task(1, "L1", B.L1)];
    const mk = (teacher: string | null) =>
      ok(
        solveDutyPlanV3(
          baseInput({
            tasks,
            candidateEdges: fullEdges(tasks, ["T1"]),
            teachers: [halfDayOff("T1")],
            fixedTaskCells: fixedGroup(1, "ILK", teacher),
            options: { minWeeklyDuties: 0, targetWeeklyDuties: 1, maxWeeklyDuties: 3, balanceWorkload: true, diversifyAreas: false, allowPartial: true, seed: 1 },
          }),
        ),
      );
    const covered = mk("FX");
    const uncovered = mk(null);
    expect(uncovered.loadUnits.fixedRequiredUnits).toBe(covered.loadUnits.fixedRequiredUnits);
    expect(uncovered.loadUnits.totalRequiredLoadUnits).toBe(covered.loadUnits.totalRequiredLoadUnits);
    expect(uncovered.loadUnits.aggregateCapacitySlack).toBe(covered.loadUnits.aggregateCapacitySlack);
    expect(uncovered.loadUnits.rawTaskCells).toBe(covered.loadUnits.rawTaskCells);
  });

  it("8) birden fazla sabit YER ayrı birim sayılır", () => {
    const r = ok(
      solveDutyPlanV3(
        baseInput({
          tasks: [],
          candidateEdges: [],
          teachers: [halfDayOff("T1")],
          fixedTaskCells: [...fixedGroup(1, "ILK1", "FX"), ...fixedGroup(1, "ILK2", "FX2"), ...fixedGroup(2, "ILK1", null)],
        }),
      ),
    );
    expect(r.loadUnits.fixedRequiredUnits).toBe(3);
    expect(r.loadUnits.fixedCoveredUnits).toBe(2);
    expect(r.loadUnits.fixedUncoveredUnits).toBe(1);
    expect(r.loadUnits.rawTaskCells).toBe(6);
    expect(r.loadUnits.malformedFixedGroups).toEqual([]);
  });

  it("8b) KISMEN atanmış sabit grup sessizce karşılanmış SAYILMAZ", () => {
    const r = ok(
      solveDutyPlanV3(
        baseInput({
          tasks: [],
          candidateEdges: [],
          teachers: [halfDayOff("T1")],
          fixedTaskCells: [
            { dayOrder: 1, dutyLocationId: "ILK", dutyBlockId: B.M, fixedCoveredByTeacherSourceId: "FX" },
            { dayOrder: 1, dutyLocationId: "ILK", dutyBlockId: B.A, fixedCoveredByTeacherSourceId: null },
          ],
        }),
      ),
    );
    expect(r.loadUnits.fixedRequiredUnits).toBe(1);
    expect(r.loadUnits.fixedCoveredUnits).toBe(0); // KARŞILANMIŞ sayılmaz
    expect(r.loadUnits.fixedUncoveredUnits).toBe(1);
    expect(r.loadUnits.malformedFixedGroups).toEqual([
      { dayOrder: 1, dutyLocationId: "ILK", cellCount: 2, coveredCellCount: 1, distinctTeacherCount: 1, reason: "partially_covered" },
    ]);
  });

  it("8c) BOZUK sabit grup (iki farklı öğretmen) yapılandırılmış teşhis üretir", () => {
    const r = ok(
      solveDutyPlanV3(
        baseInput({
          tasks: [],
          candidateEdges: [],
          teachers: [halfDayOff("T1")],
          fixedTaskCells: [
            { dayOrder: 1, dutyLocationId: "ILK", dutyBlockId: B.M, fixedCoveredByTeacherSourceId: "FX" },
            { dayOrder: 1, dutyLocationId: "ILK", dutyBlockId: B.A, fixedCoveredByTeacherSourceId: "FX2" },
          ],
        }),
      ),
    );
    expect(r.loadUnits.fixedRequiredUnits).toBe(1);
    expect(r.loadUnits.fixedCoveredUnits).toBe(0);
    expect(r.loadUnits.malformedFixedGroups[0]).toMatchObject({ reason: "multiple_teachers", distinctTeacherCount: 2 });
  });

  it("6) gerçek yapı ölçeği: 170 normal + 10 sabit = 180 birim, 190 ham hücre", () => {
    // 34 normal hücre/gün × 5 gün = 170 normal birim.
    const tasks: ReturnType<typeof task>[] = [];
    for (let d = 1; d <= 5; d++) for (let i = 0; i < 34; i++) tasks.push(task(d, `L${i}`, ALL_BLOCKS[i % 4]));
    // 2 sabit yer × 5 gün = 10 sabit birim; her biri 2 hücre ⇒ 20 sabit hücre.
    const fixedTaskCells: { dayOrder: number; dutyLocationId: string; dutyBlockId: string; fixedCoveredByTeacherSourceId: string | null }[] = [];
    for (let d = 1; d <= 5; d++) for (const loc of ["ILK1", "ILK2"]) fixedTaskCells.push(...fixedGroup(d, loc, `FX${loc}`));

    // 36 öğretmen × maxWeeklyDuties 5 = 180 birim kapasite.
    const teacherIds = Array.from({ length: 36 }, (_, i) => `T${String(i).padStart(2, "0")}`);
    const r = ok(
      solveDutyPlanV3(
        baseInput({
          tasks,
          candidateEdges: fullEdges(tasks, teacherIds),
          teachers: teacherIds.map((id) => halfDayOff(id)),
          fixedTaskCells,
          options: { minWeeklyDuties: 0, targetWeeklyDuties: 3, maxWeeklyDuties: 5, balanceWorkload: true, diversifyAreas: false, allowPartial: true, seed: 2 },
        }),
      ),
    );
    expect(r.loadUnits.normalRequiredUnits).toBe(170);
    expect(r.loadUnits.fixedRequiredUnits).toBe(10);
    expect(r.loadUnits.totalRequiredLoadUnits).toBe(180);
    expect(r.loadUnits.aggregateTeacherCapacity).toBe(180);
    expect(r.loadUnits.aggregateCapacitySlack).toBe(0);
    expect(r.loadUnits.rawTaskCells).toBe(190);
  });

  it("toplam kapasite ve yedek yük BİRİMİ cinsinden hesaplanır", () => {
    const tasks = [task(1, "L1", B.M), task(1, "L2", B.M)];
    const r = ok(
      solveDutyPlanV3(
        baseInput({
          tasks,
          candidateEdges: fullEdges(tasks, ["T1", "T2"]),
          teachers: [halfDayOn("T1"), halfDayOn("T2")],
          options: { minWeeklyDuties: 0, targetWeeklyDuties: 1, maxWeeklyDuties: 3, balanceWorkload: true, diversifyAreas: false, allowPartial: true, seed: 1 },
        }),
      ),
    );
    expect(r.loadUnits.aggregateTeacherCapacity).toBe(6);
    expect(r.loadUnits.aggregateCapacitySlack).toBe(4);
  });

  it("matchingConstrainedUncoveredTasks EŞLEŞTİRME kaynaklı açığı gösterir (toplam kapasite farkını değil)", () => {
    const tasks = [task(1, "L1", B.M), task(1, "L2", B.M)];
    const r = ok(
      solveDutyPlanV3(
        baseInput({
          tasks,
          candidateEdges: [edge(1, "L1", B.M, "T1")],
          teachers: [halfDayOn("T1"), halfDayOn("T2")],
          options: { minWeeklyDuties: 0, targetWeeklyDuties: 2, maxWeeklyDuties: 5, balanceWorkload: true, diversifyAreas: false, allowPartial: true, seed: 1 },
        }),
      ),
    );
    expect(r.loadUnits.aggregateCapacitySlack).toBeGreaterThan(0);
    expect(r.matchingConstrainedUncoveredTasks).toBe(1);
    expect(r.weeklyCapacityShortfall).toBe(r.matchingConstrainedUncoveredTasks);
  });
});
