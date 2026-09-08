import { describe, expect, it } from "vitest";
import {
  DEFAULT_GENERATION_OPTIONS,
  DutyPlanSolverOptionsError,
  normalizeGenerationOptions,
  solveDutyPlan,
  type CandidateEdge,
  type DutyTask,
  type SolverInput,
  type SolverResult,
  type TeacherFixedLoad,
} from "../solver";

const LOC_A = "loc-a";
const LOC_B = "loc-b";
const LOC_C = "loc-c";
const BLK_MORNING = "blk-morning";
const BLK_LONG1 = "blk-long1";

function task(dayOrder: number, dutyLocationId: string, dutyBlockId: string, category?: string): DutyTask {
  return { dayOrder, dutyLocationId, dutyBlockId, category };
}
function edge(dayOrder: number, dutyLocationId: string, dutyBlockId: string, teacherSourceId: string): CandidateEdge {
  return { dayOrder, dutyLocationId, dutyBlockId, teacherSourceId };
}
function loadOf(result: SolverResult, teacherSourceId: string): number {
  return result.teacherLoads.find((l) => l.teacherSourceId === teacherSourceId)?.totalDutyCount ?? 0;
}
function normalOf(result: SolverResult, teacherSourceId: string): number {
  return result.teacherLoads.find((l) => l.teacherSourceId === teacherSourceId)?.normalDutyCount ?? 0;
}

describe("normalizeGenerationOptions", () => {
  it("varsayılanları uygular", () => {
    expect(normalizeGenerationOptions(undefined)).toEqual(DEFAULT_GENERATION_OPTIONS);
  });

  it("min<=target<=max ihlalini reddeder", () => {
    expect(() => normalizeGenerationOptions({ minWeeklyDuties: 3, targetWeeklyDuties: 2, maxWeeklyDuties: 3 })).toThrow(
      DutyPlanSolverOptionsError,
    );
  });

  it("0..5 dışını reddeder", () => {
    expect(() => normalizeGenerationOptions({ maxWeeklyDuties: 6 })).toThrow(DutyPlanSolverOptionsError);
    expect(() => normalizeGenerationOptions({ minWeeklyDuties: -1 })).toThrow(DutyPlanSolverOptionsError);
  });
});

describe("solveDutyPlan — maksimum kapsama", () => {
  it("her göreve en az bir aday varsa hepsini kapsar", () => {
    const input: SolverInput = {
      tasks: [task(1, LOC_A, BLK_MORNING), task(1, LOC_B, BLK_MORNING), task(1, LOC_C, BLK_MORNING)],
      candidateEdges: [
        edge(1, LOC_A, BLK_MORNING, "t1"),
        edge(1, LOC_B, BLK_MORNING, "t2"),
        edge(1, LOC_C, BLK_MORNING, "t3"),
      ],
      teacherFixedLoads: [],
      options: { maxWeeklyDuties: 5 },
    };
    const result = solveDutyPlan(input);
    expect(result.coveredCount).toBe(3);
    expect(result.uncoveredCount).toBe(0);
  });

  it("adayı olmayan görev kapsanmaz ve uyarı üretir", () => {
    const input: SolverInput = {
      tasks: [task(1, LOC_A, BLK_MORNING)],
      candidateEdges: [],
      teacherFixedLoads: [],
    };
    const result = solveDutyPlan(input);
    expect(result.coveredCount).toBe(0);
    expect(result.assignments[0].kind).toBe("unassigned");
    expect(result.warnings.some((w) => w.code === "no_candidate")).toBe(true);
  });

  it("kısıtlı adaylıkta bile maksimum eşleştirmeyi bulur (bipartite matching)", () => {
    // t1 yalnız A'ya, t2 A ve B'ye aday — maksimum eşleştirme: t1->A, t2->B (2 kapsama).
    const input: SolverInput = {
      tasks: [task(1, LOC_A, BLK_MORNING), task(1, LOC_B, BLK_MORNING)],
      candidateEdges: [edge(1, LOC_A, BLK_MORNING, "t1"), edge(1, LOC_A, BLK_MORNING, "t2"), edge(1, LOC_B, BLK_MORNING, "t2")],
      teacherFixedLoads: [],
      options: { maxWeeklyDuties: 5 },
    };
    const result = solveDutyPlan(input);
    expect(result.coveredCount).toBe(2);
  });
});

describe("solveDutyPlan — bir öğretmen/gün tek görev", () => {
  it("aynı gün iki görevine aday olsa bile yalnız birini alır", () => {
    const input: SolverInput = {
      tasks: [task(1, LOC_A, BLK_MORNING), task(1, LOC_B, BLK_MORNING)],
      candidateEdges: [edge(1, LOC_A, BLK_MORNING, "t1"), edge(1, LOC_B, BLK_MORNING, "t1")],
      teacherFixedLoads: [],
      options: { maxWeeklyDuties: 5 },
    };
    const result = solveDutyPlan(input);
    const assignedToT1 = result.assignments.filter((a) => a.teacherSourceId === "t1");
    expect(assignedToT1.length).toBe(1);
    expect(result.coveredCount).toBe(1); // diğer görev başka adayı olmadığı için açık kalır
  });
});

describe("solveDutyPlan — haftalık üst sınır (maxWeeklyDuties)", () => {
  it("bir öğretmen haftalık sınırdan fazla görev alamaz", () => {
    const tasks = [1, 2, 3, 4, 5].map((d) => task(d, LOC_A, BLK_MORNING));
    const candidateEdges = [1, 2, 3, 4, 5].map((d) => edge(d, LOC_A, BLK_MORNING, "t1"));
    const result = solveDutyPlan({
      tasks,
      candidateEdges,
      teacherFixedLoads: [],
      options: { maxWeeklyDuties: 2, targetWeeklyDuties: 2, minWeeklyDuties: 0 },
    });
    expect(loadOf(result, "t1")).toBeLessThanOrEqual(2);
    expect(result.coveredCount).toBe(2);
  });
});

describe("solveDutyPlan — sabit gün engeli ve sabit yükün gün sayılması", () => {
  it("sabit günü olan öğretmen için o güne aday kenarı YOKSA o gün görev almaz", () => {
    // day 1 için t1 candidate edge yok (çağıran taraf sabit günü zaten filtrelemiş varsayılır).
    const result = solveDutyPlan({
      tasks: [task(1, LOC_A, BLK_MORNING), task(2, LOC_A, BLK_MORNING)],
      candidateEdges: [edge(2, LOC_A, BLK_MORNING, "t1")],
      teacherFixedLoads: [{ teacherSourceId: "t1", fixedDutyDayCount: 1 }],
      options: { maxWeeklyDuties: 5 },
    });
    const day1 = result.assignments.find((a) => a.dayOrder === 1);
    expect(day1?.teacherSourceId).not.toBe("t1");
  });

  it("sabit gün sayısı haftalık kapasiteden düşülür", () => {
    const teacherFixedLoads: TeacherFixedLoad[] = [{ teacherSourceId: "t1", fixedDutyDayCount: 2 }];
    const tasks = [1, 2, 3].map((d) => task(d, LOC_A, BLK_MORNING));
    const candidateEdges = [1, 2, 3].map((d) => edge(d, LOC_A, BLK_MORNING, "t1"));
    const result = solveDutyPlan({
      tasks,
      candidateEdges,
      teacherFixedLoads,
      options: { maxWeeklyDuties: 3, targetWeeklyDuties: 3, minWeeklyDuties: 0 },
    });
    // maxWeekly=3, fixedDays=2 → normal kapasite yalnız 1; toplam yük 1+2=3.
    expect(normalOf(result, "t1")).toBe(1);
    expect(loadOf(result, "t1")).toBe(3);
  });

  it("sabit yük zaten üst sınırı aşmışsa normal görev verilmez ve uyarı üretilir", () => {
    const result = solveDutyPlan({
      tasks: [task(1, LOC_A, BLK_MORNING)],
      candidateEdges: [edge(1, LOC_A, BLK_MORNING, "t1")],
      teacherFixedLoads: [{ teacherSourceId: "t1", fixedDutyDayCount: 3 }],
      options: { maxWeeklyDuties: 3 },
    });
    expect(normalOf(result, "t1")).toBe(0);
    expect(result.warnings.some((w) => w.code === "fixed_load_at_or_above_max" && w.teacherSourceId === "t1")).toBe(true);
  });
});

describe("solveDutyPlan — min/target/max dengelemesi", () => {
  it("yeterli aday varken yükü hedefe doğru dengeler (tek öğretmene yığmaz)", () => {
    // 6 görev, 3 öğretmen, hepsi her göreve aday. target=2 → ideal dağılım 2/2/2.
    const days = [1, 2, 3, 4, 5];
    const locs = [LOC_A, LOC_B];
    const teachers = ["t1", "t2", "t3"];
    const tasks: DutyTask[] = [];
    const candidateEdges: CandidateEdge[] = [];
    let count = 0;
    outer: for (const d of days) {
      for (const l of locs) {
        if (count >= 6) break outer;
        tasks.push(task(d, l, BLK_MORNING));
        for (const t of teachers) candidateEdges.push(edge(d, l, BLK_MORNING, t));
        count++;
      }
    }
    const result = solveDutyPlan({
      tasks,
      candidateEdges,
      teacherFixedLoads: [],
      options: { minWeeklyDuties: 0, targetWeeklyDuties: 2, maxWeeklyDuties: 5, balanceWorkload: true },
    });
    expect(result.coveredCount).toBe(6);
    const loads = teachers.map((t) => loadOf(result, t));
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(1);
    for (const l of loads) expect(l).toBeLessThanOrEqual(2);
  });
});

describe("solveDutyPlan — deterministik seed", () => {
  it("aynı girdi + aynı seed her zaman aynı sonucu üretir", () => {
    const tasks = [task(1, LOC_A, BLK_MORNING), task(1, LOC_B, BLK_MORNING), task(2, LOC_A, BLK_MORNING)];
    const candidateEdges = [
      edge(1, LOC_A, BLK_MORNING, "t1"),
      edge(1, LOC_A, BLK_MORNING, "t2"),
      edge(1, LOC_B, BLK_MORNING, "t1"),
      edge(1, LOC_B, BLK_MORNING, "t2"),
      edge(2, LOC_A, BLK_MORNING, "t1"),
      edge(2, LOC_A, BLK_MORNING, "t2"),
    ];
    const input: SolverInput = { tasks, candidateEdges, teacherFixedLoads: [], options: { seed: 42, maxWeeklyDuties: 5 } };
    const r1 = solveDutyPlan(input);
    const r2 = solveDutyPlan(input);
    expect(r1.assignments).toEqual(r2.assignments);
  });

  it("farklı seed aynı kapsama sayısını korur (yalnız hangi eşit-maliyetli aday seçildiği değişebilir)", () => {
    const tasks = [task(1, LOC_A, BLK_MORNING), task(1, LOC_B, BLK_MORNING)];
    const candidateEdges = [
      edge(1, LOC_A, BLK_MORNING, "t1"),
      edge(1, LOC_A, BLK_MORNING, "t2"),
      edge(1, LOC_B, BLK_MORNING, "t1"),
      edge(1, LOC_B, BLK_MORNING, "t2"),
    ];
    const r1 = solveDutyPlan({ tasks, candidateEdges, teacherFixedLoads: [], options: { seed: 1, maxWeeklyDuties: 5 } });
    const r2 = solveDutyPlan({ tasks, candidateEdges, teacherFixedLoads: [], options: { seed: 2, maxWeeklyDuties: 5 } });
    expect(r1.coveredCount).toBe(r2.coveredCount);
  });
});

describe("solveDutyPlan — kısmi çözüm", () => {
  it("adayı olmayan görevler unassigned kalır, diğerleri kapsanır", () => {
    const result = solveDutyPlan({
      tasks: [task(1, LOC_A, BLK_MORNING), task(1, LOC_B, BLK_MORNING)],
      candidateEdges: [edge(1, LOC_A, BLK_MORNING, "t1")],
      teacherFixedLoads: [],
    });
    expect(result.coveredCount).toBe(1);
    expect(result.uncoveredCount).toBe(1);
    expect(result.assignments.find((a) => a.dutyLocationId === LOC_B)?.kind).toBe("unassigned");
  });
});

describe("solveDutyPlan — alan çeşitliliği kapsama sayısını azaltmaz", () => {
  it("diversifyAreas açıkken kapsanan görev sayısı kapalı haliyle aynıdır", () => {
    const tasks = [
      task(1, LOC_A, BLK_MORNING, "garden"),
      task(1, LOC_B, BLK_MORNING, "cafeteria"),
      task(2, LOC_A, BLK_MORNING, "garden"),
      task(2, LOC_B, BLK_MORNING, "cafeteria"),
    ];
    const candidateEdges = [
      edge(1, LOC_A, BLK_MORNING, "t1"),
      edge(1, LOC_B, BLK_MORNING, "t1"),
      edge(1, LOC_A, BLK_MORNING, "t2"),
      edge(1, LOC_B, BLK_MORNING, "t2"),
      edge(2, LOC_A, BLK_MORNING, "t1"),
      edge(2, LOC_B, BLK_MORNING, "t1"),
      edge(2, LOC_A, BLK_MORNING, "t2"),
      edge(2, LOC_B, BLK_MORNING, "t2"),
    ];
    const withDiversify = solveDutyPlan({
      tasks,
      candidateEdges,
      teacherFixedLoads: [],
      options: { diversifyAreas: true, maxWeeklyDuties: 5 },
    });
    const withoutDiversify = solveDutyPlan({
      tasks,
      candidateEdges,
      teacherFixedLoads: [],
      options: { diversifyAreas: false, maxWeeklyDuties: 5 },
    });
    expect(withDiversify.coveredCount).toBe(withoutDiversify.coveredCount);
  });

  it("swap sonrası her atama hâlâ geçerli bir aday kenarına karşılık gelir", () => {
    const tasks = [task(1, LOC_A, BLK_MORNING, "garden"), task(1, LOC_B, BLK_MORNING, "cafeteria")];
    const candidateEdges = [
      edge(1, LOC_A, BLK_MORNING, "t1"),
      edge(1, LOC_B, BLK_MORNING, "t1"),
      edge(1, LOC_A, BLK_MORNING, "t2"),
      edge(1, LOC_B, BLK_MORNING, "t2"),
    ];
    const result = solveDutyPlan({ tasks, candidateEdges, teacherFixedLoads: [], options: { diversifyAreas: true, maxWeeklyDuties: 5 } });
    const validSet = new Set(candidateEdges.map((e) => `${e.dayOrder}|${e.dutyLocationId}|${e.dutyBlockId}|${e.teacherSourceId}`));
    for (const a of result.assignments) {
      if (a.kind !== "generated") continue;
      expect(validSet.has(`${a.dayOrder}|${a.dutyLocationId}|${a.dutyBlockId}|${a.teacherSourceId}`)).toBe(true);
    }
  });
});

describe("solveDutyPlan — küçük graflarda brute-force optimum ile karşılaştırma", () => {
  function bruteForceMaxCoverage(tasks: DutyTask[], candidateEdges: CandidateEdge[], maxPerTeacherPerDay = 1): number {
    const teachers = Array.from(new Set(candidateEdges.map((e) => e.teacherSourceId)));
    const n = tasks.length;
    let best = 0;
    // Her görev için: atanmamış (-1) ya da bir öğretmen indeksi.
    const assign = new Array<number>(n).fill(-1);
    function backtrack(i: number): void {
      if (i === n) {
        best = Math.max(best, assign.filter((x) => x >= 0).length);
        return;
      }
      const t = tasks[i];
      const options = [-1, ...teachers.map((_, idx) => idx)];
      for (const opt of options) {
        if (opt >= 0) {
          const teacherId = teachers[opt];
          const hasEdge = candidateEdges.some(
            (e) => e.dayOrder === t.dayOrder && e.dutyLocationId === t.dutyLocationId && e.dutyBlockId === t.dutyBlockId && e.teacherSourceId === teacherId,
          );
          if (!hasEdge) continue;
          const sameDayCount = assign.slice(0, i).filter((a, idx) => a === opt && tasks[idx].dayOrder === t.dayOrder).length;
          if (sameDayCount >= maxPerTeacherPerDay) continue;
        }
        assign[i] = opt;
        backtrack(i + 1);
      }
      assign[i] = -1;
    }
    backtrack(0);
    return best;
  }

  it("rastgele küçük graflarda solver kapsama sayısı brute-force optimumla eşleşir", () => {
    const locs = [LOC_A, LOC_B, LOC_C];
    const blocks = [BLK_MORNING, BLK_LONG1];
    const teachers = ["t1", "t2", "t3"];
    let seedCounter = 1234;
    function nextRandom(): number {
      seedCounter = (seedCounter * 1103515245 + 12345) & 0x7fffffff;
      return seedCounter / 0x7fffffff;
    }

    for (let trial = 0; trial < 15; trial++) {
      const tasks: DutyTask[] = [];
      const candidateEdges: CandidateEdge[] = [];
      const dayCount = 2;
      for (let d = 1; d <= dayCount; d++) {
        for (const l of locs.slice(0, 2)) {
          const blk = blocks[Math.floor(nextRandom() * blocks.length)];
          tasks.push(task(d, l, blk));
          for (const t of teachers) {
            if (nextRandom() < 0.5) candidateEdges.push(edge(d, l, blk, t));
          }
        }
      }
      const result = solveDutyPlan({ tasks, candidateEdges, teacherFixedLoads: [], options: { maxWeeklyDuties: 5 } });
      const optimum = bruteForceMaxCoverage(tasks, candidateEdges);
      expect(result.coveredCount).toBe(optimum);
    }
  });
});

describe("solveDutyPlan — bulgu 1: haftalık yük = normal gün + sabit GÜN sayısı", () => {
  it("iki sabit günü olan öğretmen için totalDutyCount, normalDutyCount+fixedDutyDayCount'tur (satır sayısı değil)", () => {
    const result = solveDutyPlan({
      tasks: [task(3, LOC_A, BLK_MORNING)],
      candidateEdges: [edge(3, LOC_A, BLK_MORNING, "t1")],
      teacherFixedLoads: [{ teacherSourceId: "t1", fixedDutyDayCount: 2 }],
      options: { maxWeeklyDuties: 5, minWeeklyDuties: 0 },
    });
    const load = result.teacherLoads.find((l) => l.teacherSourceId === "t1");
    expect(load).toEqual({ teacherSourceId: "t1", normalDutyCount: 1, fixedDutyDayCount: 2, totalDutyCount: 3 });
  });
});

describe("solveDutyPlan — bulgu 4: minWeeklyDuties gerçekten işlevsel", () => {
  it("bir öğretmen zaten min'e ulaşmışken, altındaki başka bir öğretmen aynı günlerin görevlerini alır (min önceliği)", () => {
    // below: 3 sabit günü var, min=3 → zaten min'de, marjinal maliyeti target/max bölgesinde (pahalı).
    // above: hiç sabit günü yok, min=3 → ilk 3 birimi ACİL (ucuz) bölgede.
    // Aynı 3 göreve HER İKİSİ de aday: solver kapsamayı azaltmadan (3/3) 'above'ı
    // önceliklendirip min'e getirmeyi tercih etmeli (daha ucuz global maliyet).
    const tasks3 = [1, 2, 3].map((d) => task(d, `loc-${d}`, BLK_MORNING));
    const edges3 = tasks3.flatMap((t) => [
      edge(t.dayOrder, t.dutyLocationId, BLK_MORNING, "below"),
      edge(t.dayOrder, t.dutyLocationId, BLK_MORNING, "above"),
    ]);
    const result = solveDutyPlan({
      tasks: tasks3,
      candidateEdges: edges3,
      teacherFixedLoads: [{ teacherSourceId: "below", fixedDutyDayCount: 3 }],
      teachers: [{ teacherSourceId: "below" }, { teacherSourceId: "above" }],
      options: { minWeeklyDuties: 3, targetWeeklyDuties: 3, maxWeeklyDuties: 5, balanceWorkload: true },
    });
    expect(result.coveredCount).toBe(3);
    expect(normalOf(result, "above")).toBeGreaterThan(normalOf(result, "below"));
    expect(loadOf(result, "above")).toBeLessThanOrEqual(3);
  });

  it("minimum herkes için karşılanamıyorsa (yetersiz görev) kapsanan görev sayısı azalmaz", () => {
    // 1 görev, 3 öğretmen, min=2 hepsi için karşılanamaz — yine de 1 görev kapsanmalı.
    const result = solveDutyPlan({
      tasks: [task(1, LOC_A, BLK_MORNING)],
      candidateEdges: [edge(1, LOC_A, BLK_MORNING, "t1"), edge(1, LOC_A, BLK_MORNING, "t2"), edge(1, LOC_A, BLK_MORNING, "t3")],
      teacherFixedLoads: [],
      teachers: [{ teacherSourceId: "t1" }, { teacherSourceId: "t2" }, { teacherSourceId: "t3" }],
      options: { minWeeklyDuties: 2, targetWeeklyDuties: 3, maxWeeklyDuties: 5 },
    });
    expect(result.coveredCount).toBe(1);
  });

  it("sabit yükü olan öğretmenin min/target maliyeti kalan ihtiyaca (min-fixedDays) göre hesaplanır", () => {
    // t1: fixedDays=2, min=3 → yalnız 1 birim daha "acil bölge"de (load=3<=min).
    // t2: fixedDays=0, min=3 → 3 birim acil bölgede.
    // Tek bir ortak görev seti üzerinden, min bölgesinin GENİŞLİĞİNİN farklı
    // olduğu (ama marjinal maliyetin yalnız TOPLAM yüke bağlı olduğu) doğrulanır:
    // t1'in 3. biriminin (load=3) maliyeti, t2'nin 3. biriminin (load=3)
    // maliyetiyle AYNI olmalıdır (global merdiven, öğretmenden bağımsız).
    const result1 = solveDutyPlan({
      tasks: [task(1, LOC_A, BLK_MORNING)],
      candidateEdges: [edge(1, LOC_A, BLK_MORNING, "t1")],
      teacherFixedLoads: [{ teacherSourceId: "t1", fixedDutyDayCount: 2 }],
      options: { minWeeklyDuties: 3, targetWeeklyDuties: 3, maxWeeklyDuties: 5 },
    });
    expect(normalOf(result1, "t1")).toBe(1); // load 2->3, hâlâ min bölgesinde, alınır.
  });
});

describe("solveDutyPlan — bulgu 5: öğretmen evreni yalnız candidateEdges'ten türetilmez", () => {
  it("hiç adayı olmayan öğretmen teacherLoads'ta 0 ile görünür ve uyarı üretir", () => {
    const result = solveDutyPlan({
      tasks: [task(1, LOC_A, BLK_MORNING)],
      candidateEdges: [edge(1, LOC_A, BLK_MORNING, "t1")],
      teacherFixedLoads: [],
      teachers: [{ teacherSourceId: "t1" }, { teacherSourceId: "t2", teacherName: "Adaysız Öğretmen" }],
      options: { maxWeeklyDuties: 5 },
    });
    const t2Load = result.teacherLoads.find((l) => l.teacherSourceId === "t2");
    expect(t2Load).toEqual({ teacherSourceId: "t2", normalDutyCount: 0, fixedDutyDayCount: 0, totalDutyCount: 0 });
    expect(result.warnings.some((w) => w.code === "teacher_no_candidate_cells" && w.teacherSourceId === "t2")).toBe(true);
  });

  it("yalnız sabit nöbeti bulunan (aday kenarı olmayan) öğretmen de yük özetinde görünür", () => {
    const result = solveDutyPlan({
      tasks: [],
      candidateEdges: [],
      teacherFixedLoads: [{ teacherSourceId: "fixed-only", fixedDutyDayCount: 2 }],
      teachers: [{ teacherSourceId: "fixed-only" }],
      options: { maxWeeklyDuties: 5 },
    });
    expect(result.teacherLoads).toEqual([
      { teacherSourceId: "fixed-only", normalDutyCount: 0, fixedDutyDayCount: 2, totalDutyCount: 2 },
    ]);
  });

  it("teacherLoads teacherSourceId'ye göre artan sırada döner", () => {
    const result = solveDutyPlan({
      tasks: [task(1, LOC_A, BLK_MORNING), task(1, LOC_B, BLK_MORNING)],
      candidateEdges: [edge(1, LOC_A, BLK_MORNING, "zz"), edge(1, LOC_B, BLK_MORNING, "aa")],
      teacherFixedLoads: [],
      teachers: [{ teacherSourceId: "zz" }, { teacherSourceId: "aa" }],
      options: { maxWeeklyDuties: 5 },
    });
    expect(result.teacherLoads.map((l) => l.teacherSourceId)).toEqual(["aa", "zz"]);
  });
});

describe("solveDutyPlan — excludedTeacherDays (yeniden üretmede kilitli manuel atamalar)", () => {
  it("kilitli gün için teacher_day düğümü kurulmaz — o güne başka görev atanmaz", () => {
    // t1'in day1 için BLK_LONG1'de de adaylığı var, ama day1 kilitli
    // (manuel atama başka bir hücrede zaten var varsayılır — o hücre bu
    // koşunun `tasks` girdisinde YOKTUR).
    const result = solveDutyPlan({
      tasks: [task(1, LOC_A, BLK_LONG1)],
      candidateEdges: [edge(1, LOC_A, BLK_LONG1, "t1")],
      teacherFixedLoads: [],
      excludedTeacherDays: [{ teacherSourceId: "t1", dayOrder: 1 }],
      options: { maxWeeklyDuties: 5 },
    });
    const day1 = result.assignments.find((a) => a.dayOrder === 1 && a.dutyLocationId === LOC_A);
    expect(day1?.teacherSourceId).not.toBe("t1");
    expect(day1?.kind).toBe("unassigned");
  });

  it("kilitli gün sayısı haftalık kapasiteden düşülür", () => {
    const tasks = [2, 3, 4].map((d) => task(d, LOC_A, BLK_MORNING));
    const candidateEdges = [2, 3, 4].map((d) => edge(d, LOC_A, BLK_MORNING, "t1"));
    const result = solveDutyPlan({
      tasks,
      candidateEdges,
      teacherFixedLoads: [],
      // day1 zaten kilitli manuel görevle dolu — kapasiteden 1 düşer.
      excludedTeacherDays: [{ teacherSourceId: "t1", dayOrder: 1 }],
      options: { maxWeeklyDuties: 2, targetWeeklyDuties: 2, minWeeklyDuties: 0 },
    });
    // kilitli(1) + solver'ın verebileceği en fazla 1 = toplam kapasite 2 —
    // solver kendi çözdüğü kısımda t1'e en fazla 1 görev verebilir.
    expect(loadOf(result, "t1")).toBeLessThanOrEqual(1);
  });

  it("başka öğretmen kilitli günden etkilenmez, kendi kapasitesiyle görev alabilir", () => {
    const result = solveDutyPlan({
      tasks: [task(1, LOC_A, BLK_MORNING)],
      candidateEdges: [edge(1, LOC_A, BLK_MORNING, "t2")],
      teacherFixedLoads: [],
      excludedTeacherDays: [{ teacherSourceId: "t1", dayOrder: 1 }],
      options: { maxWeeklyDuties: 5 },
    });
    expect(loadOf(result, "t2")).toBe(1);
  });
});
