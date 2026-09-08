/**
 * Sürüm 4 — yalnız üç normal görev paketi:
 *
 *   TENEFFUS = MORNING_BREAKS + AFTERNOON_BREAKS (aynı gün/yer/öğretmen)
 *   OGLE_1   = LONG_BREAK_1
 *   OGLE_2   = LONG_BREAK_2
 *
 * FULL_DAY, LONG_BREAK_1+LONG_BREAK_2 ve sabah+öğle+öğleden sonra
 * kombinasyonları bu modelin evreninde yoktur. Teneffüs çifti tek haftalık
 * yük birimidir; iki ayrı hücre olarak sayılmaz.
 *
 * Paketler önce atomik "birim görev"e dönüştürülür, sonra ortak kesin
 * min-cost max-flow motoru çalıştırılır. Bu nedenle kapsama paket sayısı
 * bakımından kesin maksimumdur. Bir TENEFFUS kenarı ancak öğretmen iki
 * hücrenin de yetkili candidateEdges kümesindeyse kurulur.
 */

import type { DutyBlockCode } from "../../services/dutyBlocks";
import {
  solveDutyPlan,
  taskKey,
  type CandidateEdge,
  type GenerationOptions,
  type SolverTeacherLoad,
  type SolverWarning,
  type TeacherFixedLoad,
  type TeacherRef,
} from "./solver";

export const DUTY_PLAN_SOLVER_V4_VERSION = "duty-plan-solver-v4-three-packages";

export type V4CoverageMode = "SHORT_BREAKS" | "SINGLE_BLOCK";

export interface V4TaskCell {
  dayOrder: number;
  dutyLocationId: string;
  dutyBlockId: string;
  blockCode: DutyBlockCode;
  category?: string | null;
}

export interface V4LockedPackage {
  teacherSourceId: string;
  dayOrder: number;
  dutyLocationId: string;
  coverageMode: V4CoverageMode;
  cells: V4TaskCell[];
}

export interface V4Input {
  tasks: V4TaskCell[];
  candidateEdges: CandidateEdge[];
  teachers: TeacherRef[];
  teacherFixedLoads: TeacherFixedLoad[];
  fixedDays?: { teacherSourceId: string; dayOrder: number }[];
  lockedPackages?: V4LockedPackage[];
  lessonPeriodCountByTeacherDay?: Map<string, number>;
  historicalDutyPointsByTeacher?: Map<string, number>;
  options?: Partial<GenerationOptions>;
}

export interface V4PackageAssignment {
  dayOrder: number;
  dutyLocationId: string;
  teacherSourceId: string;
  coverageMode: V4CoverageMode;
  cells: V4TaskCell[];
}

export interface V4Assignment extends V4TaskCell {
  teacherSourceId: string | null;
  kind: "generated" | "unassigned";
  coverageMode: V4CoverageMode | null;
}

export interface V4Result {
  status: "ok" | "invalid_configuration" | "invalid_locked_assignment";
  algorithmVersion: string;
  assignments: V4Assignment[];
  packages: V4PackageAssignment[];
  teacherLoads: SolverTeacherLoad[];
  warnings: SolverWarning[];
  totalTaskCount: number;
  assignedTaskCount: number;
  unassignedTaskCount: number;
  totalPackageCount: number;
  assignedPackageCount: number;
  unassignedPackageCount: number;
  fixedAssignmentCount: number;
  optimalityProven: boolean;
  coverageOptimalityProven: boolean;
  searchLimitReached: false;
  configurationErrors: { dayOrder: number; dutyLocationId: string; reason: string }[];
  lockedViolations: { teacherSourceId: string; dayOrder: number; reason: string }[];
}

interface Unit {
  id: string;
  dayOrder: number;
  dutyLocationId: string;
  coverageMode: V4CoverageMode;
  cells: V4TaskCell[];
  category?: string | null;
}

const teacherDayKey = (teacherSourceId: string, dayOrder: number) => `${teacherSourceId}|${dayOrder}`;

function intersection(sets: Set<string>[]): string[] {
  if (sets.length === 0) return [];
  const result = new Set(sets[0]);
  for (const set of sets.slice(1)) {
    for (const value of result) if (!set.has(value)) result.delete(value);
  }
  return [...result].sort((a, b) => a.localeCompare(b));
}

function buildUnits(tasks: V4TaskCell[]): { units: Unit[]; errors: V4Result["configurationErrors"] } {
  const groups = new Map<string, V4TaskCell[]>();
  for (const task of tasks) {
    const key = `${task.dayOrder}|${task.dutyLocationId}`;
    const list = groups.get(key) ?? [];
    list.push(task);
    groups.set(key, list);
  }

  const units: Unit[] = [];
  const errors: V4Result["configurationErrors"] = [];
  for (const cells of groups.values()) {
    const first = cells[0];
    const byCode = new Map(cells.map((cell) => [cell.blockCode, cell]));
    const morning = byCode.get("MORNING_BREAKS");
    const afternoon = byCode.get("AFTERNOON_BREAKS");
    if (Boolean(morning) !== Boolean(afternoon)) {
      errors.push({
        dayOrder: first.dayOrder,
        dutyLocationId: first.dutyLocationId,
        reason: "Sabah ve Öğleden Sonra normal blokları birlikte açılmalı veya birlikte kapatılmalıdır.",
      });
    } else if (morning && afternoon) {
      units.push({
        id: `TENEFFUS:${morning.dutyBlockId}:${afternoon.dutyBlockId}`,
        dayOrder: first.dayOrder,
        dutyLocationId: first.dutyLocationId,
        coverageMode: "SHORT_BREAKS",
        cells: [morning, afternoon],
        category: first.category,
      });
    }

    for (const code of ["LONG_BREAK_1", "LONG_BREAK_2"] as const) {
      const cell = byCode.get(code);
      if (!cell) continue;
      units.push({
        id: `OGLE:${cell.dutyBlockId}`,
        dayOrder: cell.dayOrder,
        dutyLocationId: cell.dutyLocationId,
        coverageMode: "SINGLE_BLOCK",
        cells: [cell],
        category: cell.category,
      });
    }
  }
  units.sort((a, b) => `${a.dayOrder}|${a.dutyLocationId}|${a.id}`.localeCompare(`${b.dayOrder}|${b.dutyLocationId}|${b.id}`));
  return { units, errors };
}

export function solveDutyPlanV4(input: V4Input): V4Result {
  const { units, errors } = buildUnits(input.tasks);
  const emptyAssignments = input.tasks.map((t) => ({ ...t, teacherSourceId: null, kind: "unassigned" as const, coverageMode: null }));
  if (errors.length > 0) {
    return {
      status: "invalid_configuration",
      algorithmVersion: DUTY_PLAN_SOLVER_V4_VERSION,
      assignments: emptyAssignments,
      packages: [],
      teacherLoads: [],
      warnings: [],
      totalTaskCount: input.tasks.length,
      assignedTaskCount: 0,
      unassignedTaskCount: input.tasks.length,
      totalPackageCount: units.length,
      assignedPackageCount: 0,
      unassignedPackageCount: units.length,
      fixedAssignmentCount: input.teacherFixedLoads.reduce((sum, f) => sum + f.fixedDutyDayCount, 0),
      optimalityProven: false,
      coverageOptimalityProven: false,
      searchLimitReached: false,
      configurationErrors: errors,
      lockedViolations: [],
    };
  }

  const candidateByCell = new Map<string, Set<string>>();
  for (const edge of input.candidateEdges) {
    const key = taskKey(edge);
    const set = candidateByCell.get(key) ?? new Set<string>();
    set.add(edge.teacherSourceId);
    candidateByCell.set(key, set);
  }

  const unitBySyntheticKey = new Map<string, Unit>();
  const solverTasks = units.map((unit) => {
    const task = { dayOrder: unit.dayOrder, dutyLocationId: unit.dutyLocationId, dutyBlockId: unit.id, category: unit.category };
    unitBySyntheticKey.set(taskKey(task), unit);
    return task;
  });
  const solverEdges: CandidateEdge[] = units.flatMap((unit) =>
    intersection(unit.cells.map((cell) => candidateByCell.get(taskKey(cell)) ?? new Set<string>())).map((teacherSourceId) => ({
      dayOrder: unit.dayOrder,
      dutyLocationId: unit.dutyLocationId,
      dutyBlockId: unit.id,
      teacherSourceId,
    })),
  );

  const locked = input.lockedPackages ?? [];
  const lockedDaySeen = new Set<string>();
  const lockedViolations: V4Result["lockedViolations"] = [];
  for (const pkg of locked) {
    const key = teacherDayKey(pkg.teacherSourceId, pkg.dayOrder);
    if (lockedDaySeen.has(key)) lockedViolations.push({ teacherSourceId: pkg.teacherSourceId, dayOrder: pkg.dayOrder, reason: "Aynı günde birden fazla kilitli normal paket var." });
    lockedDaySeen.add(key);
    if (pkg.coverageMode === "SHORT_BREAKS") {
      const codes = new Set(pkg.cells.map((c) => c.blockCode));
      if (!(codes.size === 2 && codes.has("MORNING_BREAKS") && codes.has("AFTERNOON_BREAKS"))) {
        lockedViolations.push({ teacherSourceId: pkg.teacherSourceId, dayOrder: pkg.dayOrder, reason: "Kilitli TENEFFÜS paketi Sabah + Öğleden Sonra çiftini kapsamıyor olmalı." });
      }
    } else if (pkg.cells.length !== 1 || !["LONG_BREAK_1", "LONG_BREAK_2"].includes(pkg.cells[0]?.blockCode)) {
      lockedViolations.push({ teacherSourceId: pkg.teacherSourceId, dayOrder: pkg.dayOrder, reason: "Tekli normal paket yalnız Öğle Arası-1 veya Öğle Arası-2 olabilir." });
    }
  }
  if (lockedViolations.length > 0) {
    return {
      status: "invalid_locked_assignment",
      algorithmVersion: DUTY_PLAN_SOLVER_V4_VERSION,
      assignments: emptyAssignments,
      packages: [],
      teacherLoads: [],
      warnings: [],
      totalTaskCount: input.tasks.length,
      assignedTaskCount: 0,
      unassignedTaskCount: input.tasks.length,
      totalPackageCount: units.length,
      assignedPackageCount: 0,
      unassignedPackageCount: units.length,
      fixedAssignmentCount: input.teacherFixedLoads.reduce((sum, f) => sum + f.fixedDutyDayCount, 0),
      optimalityProven: false,
      coverageOptimalityProven: false,
      searchLimitReached: false,
      configurationErrors: [],
      lockedViolations,
    };
  }

  const excludedDays = [...(input.fixedDays ?? []), ...locked.map((p) => ({ teacherSourceId: p.teacherSourceId, dayOrder: p.dayOrder }))];
  const lockedLoadByTeacher = new Map<string, number>();
  for (const pkg of locked) lockedLoadByTeacher.set(pkg.teacherSourceId, (lockedLoadByTeacher.get(pkg.teacherSourceId) ?? 0) + 1);
  const solved = solveDutyPlan({
    tasks: solverTasks,
    candidateEdges: solverEdges,
    teachers: input.teachers,
    teacherFixedLoads: input.teacherFixedLoads,
    excludedTeacherDays: excludedDays,
    lessonPeriodCountByTeacherDay: input.lessonPeriodCountByTeacherDay,
    historicalDutyPointsByTeacher: input.historicalDutyPointsByTeacher,
    taskCoverageWeightByKey: new Map(solverTasks.map((task) => [taskKey(task), unitBySyntheticKey.get(taskKey(task))?.cells.length ?? 1])),
    options: input.options,
  });

  const generatedPackages: V4PackageAssignment[] = [];
  for (const assignment of solved.assignments) {
    if (!assignment.teacherSourceId) continue;
    const unit = unitBySyntheticKey.get(taskKey(assignment));
    if (!unit) continue;
    generatedPackages.push({
      dayOrder: unit.dayOrder,
      dutyLocationId: unit.dutyLocationId,
      teacherSourceId: assignment.teacherSourceId,
      coverageMode: unit.coverageMode,
      cells: unit.cells,
    });
  }

  const packageByCell = new Map<string, V4PackageAssignment>();
  for (const pkg of generatedPackages) for (const cell of pkg.cells) packageByCell.set(taskKey(cell), pkg);
  const assignments: V4Assignment[] = input.tasks.map((cell) => {
    const pkg = packageByCell.get(taskKey(cell));
    return pkg
      ? { ...cell, teacherSourceId: pkg.teacherSourceId, kind: "generated", coverageMode: pkg.coverageMode }
      : { ...cell, teacherSourceId: null, kind: "unassigned", coverageMode: null };
  });

  const lockedCount = new Map(locked.map((p) => [p.teacherSourceId, 0]));
  for (const pkg of locked) lockedCount.set(pkg.teacherSourceId, (lockedCount.get(pkg.teacherSourceId) ?? 0) + 1);
  const originalFixed = new Map(input.teacherFixedLoads.map((f) => [f.teacherSourceId, f.fixedDutyDayCount]));
  const teacherLoads = solved.teacherLoads.map((load) => ({
    teacherSourceId: load.teacherSourceId,
    normalDutyCount: load.normalDutyCount + (lockedCount.get(load.teacherSourceId) ?? 0),
    fixedDutyDayCount: originalFixed.get(load.teacherSourceId) ?? 0,
    totalDutyCount: load.normalDutyCount + (lockedCount.get(load.teacherSourceId) ?? 0) + (originalFixed.get(load.teacherSourceId) ?? 0),
  }));

  const assignedTaskCount = assignments.filter((a) => a.kind === "generated").length;
  return {
    status: "ok",
    algorithmVersion: DUTY_PLAN_SOLVER_V4_VERSION,
    assignments,
    packages: generatedPackages,
    teacherLoads,
    warnings: solved.warnings,
    totalTaskCount: assignments.length,
    assignedTaskCount,
    unassignedTaskCount: assignments.length - assignedTaskCount,
    totalPackageCount: units.length,
    assignedPackageCount: generatedPackages.length,
    unassignedPackageCount: units.length - generatedPackages.length,
    fixedAssignmentCount: input.teacherFixedLoads.reduce((sum, f) => sum + f.fixedDutyDayCount, 0),
    optimalityProven: true,
    coverageOptimalityProven: true,
    searchLimitReached: false,
    configurationErrors: [],
    lockedViolations: [],
  };
}
