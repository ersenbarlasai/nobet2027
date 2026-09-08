import { describe, expect, it } from "vitest";
import { solveDutyPlanV4, type V4Input, type V4TaskCell } from "../solverV4";

const M = "00000000-0000-4000-8000-000000000001";
const L1 = "00000000-0000-4000-8000-000000000002";
const L2 = "00000000-0000-4000-8000-000000000003";
const A = "00000000-0000-4000-8000-000000000004";

function cell(dayOrder: number, location: string, blockCode: V4TaskCell["blockCode"]): V4TaskCell {
  const ids = { MORNING_BREAKS: M, LONG_BREAK_1: L1, LONG_BREAK_2: L2, AFTERNOON_BREAKS: A };
  return { dayOrder, dutyLocationId: location, dutyBlockId: ids[blockCode], blockCode, category: "floor" };
}

function input(tasks: V4TaskCell[], edgeMap: Record<string, string[]>): V4Input {
  return {
    tasks,
    candidateEdges: tasks.flatMap((task) =>
      (edgeMap[`${task.dayOrder}|${task.dutyLocationId}|${task.blockCode}`] ?? []).map((teacherSourceId) => ({
        dayOrder: task.dayOrder,
        dutyLocationId: task.dutyLocationId,
        dutyBlockId: task.dutyBlockId,
        teacherSourceId,
      })),
    ),
    teachers: ["t1", "t2", "t3"].map((teacherSourceId) => ({ teacherSourceId })),
    teacherFixedLoads: [],
    options: { minWeeklyDuties: 0, targetWeeklyDuties: 2, maxWeeklyDuties: 3, balanceWorkload: true, diversifyAreas: false, allowPartial: true, seed: 1 },
  };
}

describe("solveDutyPlanV4 — TENEFFÜS / ÖĞLE_1 / ÖĞLE_2", () => {
  it("Sabah ve Öğleden Sonra aynı öğretmene tek SHORT_BREAKS paketi olarak atanır", () => {
    const tasks = [cell(1, "loc", "MORNING_BREAKS"), cell(1, "loc", "AFTERNOON_BREAKS")];
    const result = solveDutyPlanV4(input(tasks, {
      "1|loc|MORNING_BREAKS": ["t1", "t2"],
      "1|loc|AFTERNOON_BREAKS": ["t1"],
    }));
    expect(result.status).toBe("ok");
    expect(result.packages).toEqual([expect.objectContaining({ coverageMode: "SHORT_BREAKS", teacherSourceId: "t1" })]);
    expect(result.assignments.map((a) => a.teacherSourceId)).toEqual(["t1", "t1"]);
    expect(result.teacherLoads.find((l) => l.teacherSourceId === "t1")?.normalDutyCount).toBe(1);
  });

  it("TENEFFÜS için iki hücrenin aday kesişimi yoksa ikisini de parçalı atamaz", () => {
    const tasks = [cell(1, "loc", "MORNING_BREAKS"), cell(1, "loc", "AFTERNOON_BREAKS")];
    const result = solveDutyPlanV4(input(tasks, {
      "1|loc|MORNING_BREAKS": ["t1"],
      "1|loc|AFTERNOON_BREAKS": ["t2"],
    }));
    expect(result.assignedTaskCount).toBe(0);
    expect(result.unassignedTaskCount).toBe(2);
    expect(result.assignedPackageCount).toBe(0);
  });

  it("ÖĞLE_1 ve ÖĞLE_2 yalnız ayrı SINGLE_BLOCK paketleridir", () => {
    const tasks = [cell(1, "loc", "LONG_BREAK_1"), cell(2, "loc", "LONG_BREAK_2")];
    const result = solveDutyPlanV4(input(tasks, {
      "1|loc|LONG_BREAK_1": ["t1"],
      "2|loc|LONG_BREAK_2": ["t1"],
    }));
    expect(result.packages.map((p) => p.coverageMode)).toEqual(["SINGLE_BLOCK", "SINGLE_BLOCK"]);
    expect(result.packages.every((p) => p.cells.length === 1)).toBe(true);
  });

  it("aynı öğretmene aynı gün ikinci normal paket vermez", () => {
    const tasks = [
      cell(1, "locA", "MORNING_BREAKS"), cell(1, "locA", "AFTERNOON_BREAKS"),
      cell(1, "locB", "LONG_BREAK_1"),
    ];
    const edgeMap = Object.fromEntries(tasks.map((t) => [`${t.dayOrder}|${t.dutyLocationId}|${t.blockCode}`, ["t1"]]));
    const result = solveDutyPlanV4(input(tasks, edgeMap));
    expect(result.assignedPackageCount).toBe(1);
    expect(result.assignedTaskCount).toBe(2);
    expect(result.packages[0]?.coverageMode).toBe("SHORT_BREAKS");
    expect(result.teacherLoads.find((l) => l.teacherSourceId === "t1")?.normalDutyCount).toBe(1);
  });

  it("Sabah/Öğleden Sonra tek taraflı açıksa yapılandırmayı reddeder", () => {
    const tasks = [cell(1, "loc", "MORNING_BREAKS")];
    const result = solveDutyPlanV4(input(tasks, { "1|loc|MORNING_BREAKS": ["t1"] }));
    expect(result.status).toBe("invalid_configuration");
    expect(result.configurationErrors[0]?.reason).toContain("birlikte");
  });

  it("haftalık hedef 2, sert tavan 3 ve az dersli gün önceliğini uygular", () => {
    const tasks = [1, 2, 3].map((day) => cell(day, `loc${day}`, "LONG_BREAK_1"));
    const edgeMap = Object.fromEntries(tasks.map((t) => [`${t.dayOrder}|${t.dutyLocationId}|${t.blockCode}`, ["t1", "t2"]]));
    const base = input(tasks, edgeMap);
    base.lessonPeriodCountByTeacherDay = new Map([
      ["t1|1", 9], ["t1|2", 1], ["t1|3", 8],
      ["t2|1", 2], ["t2|2", 9], ["t2|3", 3],
    ]);
    const result = solveDutyPlanV4(base);
    expect(result.assignedPackageCount).toBe(3);
    expect(Math.max(...result.teacherLoads.map((l) => l.totalDutyCount))).toBeLessThanOrEqual(2);
    expect(result.packages.find((p) => p.dayOrder === 2)?.teacherSourceId).toBe("t1");
  });

  it("sabit günde normal paket vermez", () => {
    const tasks = [cell(1, "loc", "LONG_BREAK_1")];
    const base = input(tasks, { "1|loc|LONG_BREAK_1": ["t1"] });
    base.fixedDays = [{ teacherSourceId: "t1", dayOrder: 1 }];
    base.teacherFixedLoads = [{ teacherSourceId: "t1", fixedDutyDayCount: 1 }];
    const result = solveDutyPlanV4(base);
    expect(result.assignedPackageCount).toBe(0);
  });

  it("eşit adaylar arasında geçmiş puanı düşük öğretmeni önceliklendirir", () => {
    const tasks = [cell(1, "loc", "LONG_BREAK_1")];
    const base = input(tasks, { "1|loc|LONG_BREAK_1": ["t1", "t2"] });
    base.historicalDutyPointsByTeacher = new Map([["t1", 7], ["t2", 2]]);
    const result = solveDutyPlanV4(base);
    expect(result.assignedTaskCount).toBe(1);
    expect(result.packages[0]?.teacherSourceId).toBe("t2");
  });

  it("geçmiş puan adaleti maksimum kapsamayı azaltmaz", () => {
    const tasks = [cell(1, "a", "LONG_BREAK_1"), cell(2, "b", "LONG_BREAK_2")];
    const base = input(tasks, {
      "1|a|LONG_BREAK_1": ["t1"],
      "2|b|LONG_BREAK_2": ["t1", "t2"],
    });
    base.historicalDutyPointsByTeacher = new Map([["t1", 100], ["t2", 0]]);
    const result = solveDutyPlanV4(base);
    expect(result.assignedTaskCount).toBe(2);
    expect(result.unassignedTaskCount).toBe(0);
  });
});
