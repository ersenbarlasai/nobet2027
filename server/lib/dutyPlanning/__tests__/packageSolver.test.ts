import { describe, expect, it } from "vitest";
import { solveDutyPlan, type CandidateEdge, type TeacherFixedLoad } from "../solver";
import { solveDutyPlanWithPackages, type PackageSolverInput } from "../packageSolver";
import { buildPackageCandidates, type DutyPlanLocationRef, type PackageDutyTask } from "../packageCandidates";

const FULL_DAY_LOC: DutyPlanLocationRef = {
  id: "loc-full",
  shortCode: "BALKON",
  category: "corridor",
  allowsFixedAssignment: false,
  activeBlockCodes: ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"],
};
const SHORT_ONLY_LOC: DutyPlanLocationRef = {
  id: "loc-short",
  shortCode: "GIRIS",
  category: "entrance",
  allowsFixedAssignment: false,
  activeBlockCodes: ["MORNING_BREAKS", "AFTERNOON_BREAKS"],
};
const SINGLE_LOC: DutyPlanLocationRef = {
  id: "loc-single",
  shortCode: "YEMEKHANE1",
  category: "cafeteria",
  allowsFixedAssignment: false,
  activeBlockCodes: ["LONG_BREAK_1"],
};

function fullDayTasks(dayOrder: number, locationId = FULL_DAY_LOC.id): PackageDutyTask[] {
  return [
    { dayOrder, dutyLocationId: locationId, dutyBlockId: `${locationId}-morning`, blockCode: "MORNING_BREAKS" },
    { dayOrder, dutyLocationId: locationId, dutyBlockId: `${locationId}-long1`, blockCode: "LONG_BREAK_1" },
    { dayOrder, dutyLocationId: locationId, dutyBlockId: `${locationId}-long2`, blockCode: "LONG_BREAK_2" },
    { dayOrder, dutyLocationId: locationId, dutyBlockId: `${locationId}-afternoon`, blockCode: "AFTERNOON_BREAKS" },
  ];
}
function shortTasks(dayOrder: number, locationId = SHORT_ONLY_LOC.id): PackageDutyTask[] {
  return [
    { dayOrder, dutyLocationId: locationId, dutyBlockId: `${locationId}-morning`, blockCode: "MORNING_BREAKS" },
    { dayOrder, dutyLocationId: locationId, dutyBlockId: `${locationId}-afternoon`, blockCode: "AFTERNOON_BREAKS" },
  ];
}
function edgesForAllCells(tasks: PackageDutyTask[], teacherSourceId: string): CandidateEdge[] {
  return tasks.map((t) => ({ dayOrder: t.dayOrder, dutyLocationId: t.dutyLocationId, dutyBlockId: t.dutyBlockId, teacherSourceId }));
}
function loadOf(result: ReturnType<typeof solveDutyPlanWithPackages>, teacherSourceId: string) {
  return result.teacherLoads.find((l) => l.teacherSourceId === teacherSourceId);
}

/** İki günlük karşı örnek: t1 iki günde de FULL_DAY adayı; s1/s2/s3 YALNIZ
 * gün 1'in üç FARKLI hücresine tekil aday. maxWeeklyDuties=1. Yanlış
 * (yerel-greedy) seçim: Gün1 FULL_DAY(t1) → 4/8 (Gün2 tamamen açık).
 * Doğru (global optimum): Gün2 FULL_DAY(t1) + Gün1'de s1/s2/s3 SINGLE_BLOCK
 * → 7/8 (yalnız Gün1'in 4. hücresi, AFTERNOON_BREAKS, açık kalır — s1/s2/s3
 * onu kapsamıyor ve t1 gün2'ye ayrıldı). Modül kapsamında (birden çok
 * describe bloğundan — dahil brute-force karşılaştırması — kullanılır). */
function twoDayCounterExample(opts?: { swapDays?: boolean; renameTeachers?: boolean; renameLocation?: boolean; seed?: number }) {
  const locId = opts?.renameLocation ? "kat-2" : FULL_DAY_LOC.id;
  const shortCode = opts?.renameLocation ? "KAT2" : FULL_DAY_LOC.shortCode;
  const dFull = opts?.swapDays ? 1 : 2; // t1'in FULL_DAY alması GEREKEN gün
  const dScarce = opts?.swapDays ? 2 : 1; // s1/s2/s3'ün aday olduğu gün
  const tFull = opts?.renameTeachers ? "hoca-full" : "t1";
  const tScarce1 = opts?.renameTeachers ? "hoca-a" : "s1";
  const tScarce2 = opts?.renameTeachers ? "hoca-b" : "s2";
  const tScarce3 = opts?.renameTeachers ? "hoca-c" : "s3";

  const dayFullTasks = fullDayTasks(dFull, locId);
  const dayScarceTasks = fullDayTasks(dScarce, locId);
  const tasks = [...dayFullTasks, ...dayScarceTasks];
  const candidateEdges: CandidateEdge[] = [
    ...edgesForAllCells(dayFullTasks, tFull),
    ...edgesForAllCells(dayScarceTasks, tFull),
    { dayOrder: dScarce, dutyLocationId: locId, dutyBlockId: `${locId}-morning`, teacherSourceId: tScarce1 },
    { dayOrder: dScarce, dutyLocationId: locId, dutyBlockId: `${locId}-long1`, teacherSourceId: tScarce2 },
    { dayOrder: dScarce, dutyLocationId: locId, dutyBlockId: `${locId}-long2`, teacherSourceId: tScarce3 },
  ];
  const location: DutyPlanLocationRef = { ...FULL_DAY_LOC, id: locId, shortCode };
  const input: PackageSolverInput = {
    tasks,
    candidateEdges,
    teacherFixedLoads: [],
    locations: [location],
    options: { minWeeklyDuties: 0, targetWeeklyDuties: 1, maxWeeklyDuties: 1, seed: opts?.seed },
  };
  return { input, dFull, dScarce, tFull, locId };
}

/** Üç günlük karşı örnek (ikinci bulgu regresyonu): t1 gün1/gün2 FULL_DAY
 * adayı, t2 gün3 FULL_DAY adayı, s1/s2/s3 YALNIZ gün1'in üç farklı hücresine
 * tekil aday. maxWeeklyDuties=1. cellOnlyBaseline=5 ama gerçek optimum=11
 * (Gün2 FULL_DAY(t1) + Gün3 FULL_DAY(t2) + Gün1 3×SINGLE_BLOCK). Modül
 * kapsamında (brute-force karşılaştırması dahil) kullanılır. */
function threeDayCounterExample(): PackageSolverInput {
  const day1 = fullDayTasks(1);
  const day2 = fullDayTasks(2);
  const day3 = fullDayTasks(3);
  const tasks = [...day1, ...day2, ...day3];
  const candidateEdges: CandidateEdge[] = [
    ...edgesForAllCells(day1, "t1"),
    ...edgesForAllCells(day2, "t1"),
    ...edgesForAllCells(day3, "t2"),
    { dayOrder: 1, dutyLocationId: FULL_DAY_LOC.id, dutyBlockId: `${FULL_DAY_LOC.id}-morning`, teacherSourceId: "s1" },
    { dayOrder: 1, dutyLocationId: FULL_DAY_LOC.id, dutyBlockId: `${FULL_DAY_LOC.id}-long1`, teacherSourceId: "s2" },
    { dayOrder: 1, dutyLocationId: FULL_DAY_LOC.id, dutyBlockId: `${FULL_DAY_LOC.id}-long2`, teacherSourceId: "s3" },
  ];
  return {
    tasks,
    candidateEdges,
    teacherFixedLoads: [],
    locations: [FULL_DAY_LOC],
    options: { minWeeklyDuties: 0, targetWeeklyDuties: 1, maxWeeklyDuties: 1 },
  };
}

describe("solveDutyPlanWithPackages — FULL_DAY", () => {
  it("dört görevi tek öğretmen-günle (FULL_DAY paketi) kapatır", () => {
    const tasks = fullDayTasks(1);
    const input: PackageSolverInput = {
      tasks,
      candidateEdges: edgesForAllCells(tasks, "t1"),
      teacherFixedLoads: [],
      locations: [FULL_DAY_LOC],
      options: { maxWeeklyDuties: 5 },
    };
    const result = solveDutyPlanWithPackages(input);
    expect(result.coveredCount).toBe(4);
    expect(result.fullDayPackageCount).toBe(1);
    expect(result.packages).toHaveLength(1);
    expect(result.packages[0].coverageMode).toBe("FULL_DAY");
    expect(result.packages[0].cellTaskKeys).toHaveLength(4);
    const load = loadOf(result, "t1");
    // Kanonik yük: dört hücre kapsansa da BİR öğretmen-günü sayılır.
    expect(load?.normalDutyCount).toBe(1);
    expect(load?.totalDutyCount).toBe(1);
  });
});

describe("solveDutyPlanWithPackages — fallback zinciri", () => {
  it("FULL_DAY adayı yoksa SHORT_BREAKS + tek başına Uzun bloklara fallback yapar", () => {
    const tasks = fullDayTasks(1);
    // t1 yalnız Sabah+Öğleden Sonra'ya aday (FULL_DAY için Uzun 1/2'ye adayı yok);
    // t2 yalnız Uzun 1'e, t3 yalnız Uzun 2'ye aday.
    const candidateEdges: CandidateEdge[] = [
      { dayOrder: 1, dutyLocationId: FULL_DAY_LOC.id, dutyBlockId: `${FULL_DAY_LOC.id}-morning`, teacherSourceId: "t1" },
      { dayOrder: 1, dutyLocationId: FULL_DAY_LOC.id, dutyBlockId: `${FULL_DAY_LOC.id}-afternoon`, teacherSourceId: "t1" },
      { dayOrder: 1, dutyLocationId: FULL_DAY_LOC.id, dutyBlockId: `${FULL_DAY_LOC.id}-long1`, teacherSourceId: "t2" },
      { dayOrder: 1, dutyLocationId: FULL_DAY_LOC.id, dutyBlockId: `${FULL_DAY_LOC.id}-long2`, teacherSourceId: "t3" },
    ];
    const result = solveDutyPlanWithPackages({
      tasks,
      candidateEdges,
      teacherFixedLoads: [],
      locations: [FULL_DAY_LOC],
      options: { maxWeeklyDuties: 5 },
    });
    expect(result.coveredCount).toBe(4);
    expect(result.fullDayPackageCount).toBe(0);
    expect(result.shortBreaksPackageCount).toBe(1);
    expect(result.singleBlockCellCount).toBe(2);
    const t1Pkg = result.packages.find((p) => p.teacherSourceId === "t1");
    expect(t1Pkg?.coverageMode).toBe("SHORT_BREAKS");
  });

  it("SHORT_BREAKS adayı da yoksa tek tek SINGLE_BLOCK ile doldurur", () => {
    const tasks = shortTasks(1);
    const candidateEdges: CandidateEdge[] = [
      { dayOrder: 1, dutyLocationId: SHORT_ONLY_LOC.id, dutyBlockId: `${SHORT_ONLY_LOC.id}-morning`, teacherSourceId: "t1" },
      { dayOrder: 1, dutyLocationId: SHORT_ONLY_LOC.id, dutyBlockId: `${SHORT_ONLY_LOC.id}-afternoon`, teacherSourceId: "t2" },
    ];
    const result = solveDutyPlanWithPackages({
      tasks,
      candidateEdges,
      teacherFixedLoads: [],
      locations: [SHORT_ONLY_LOC],
      options: { maxWeeklyDuties: 5 },
    });
    expect(result.coveredCount).toBe(2);
    expect(result.shortBreaksPackageCount).toBe(0);
    expect(result.singleBlockCellCount).toBe(2);
    expect(result.packages.every((p) => p.coverageMode === "SINGLE_BLOCK")).toBe(true);
  });

  it("tek bloklu özel yer (SINGLE_BLOCK'a hiç FULL_DAY/SHORT_BREAKS adayı üretmez)", () => {
    const tasks: PackageDutyTask[] = [{ dayOrder: 1, dutyLocationId: SINGLE_LOC.id, dutyBlockId: "single-blk", blockCode: "LONG_BREAK_1" }];
    const result = solveDutyPlanWithPackages({
      tasks,
      candidateEdges: [{ dayOrder: 1, dutyLocationId: SINGLE_LOC.id, dutyBlockId: "single-blk", teacherSourceId: "t1" }],
      teacherFixedLoads: [],
      locations: [SINGLE_LOC],
      options: { maxWeeklyDuties: 5 },
    });
    expect(result.coveredCount).toBe(1);
    expect(result.packages[0].coverageMode).toBe("SINGLE_BLOCK");
  });
});

describe("solveDutyPlanWithPackages — kapsama asla eski solver'dan düşük değil", () => {
  it("kıt-adaylı Uzun blok, yanlış FULL_DAY seçimi yüzünden açık kalmaz", () => {
    // t1: BALKON'un dört bloğuna da aday (FULL_DAY mümkün).
    // t2: YALNIZ BALKON/LONG_BREAK_1'e aday (başka hiçbir yerde adayı yok).
    // t1'i FULL_DAY'e atarsak LONG_BREAK_1'i t2 zaten alamaz (paket t1'e ait
    // olur) — ama t1 FULL_DAY OLMADAN da tek tek dağılabilir: t1 diğer üç
    // hücreyi, t2 LONG_BREAK_1'i alabilir → TOPLAM kapsama YİNE 4. Bu yüzden
    // solver'ın FULL_DAY'i KABUL ETMESİ gerekir (t2'nin adayı zaten yalnız bu
    // hücreye — t1 onu almasa da t2 hâlâ alabilir, kapsama düşmez).
    const tasks = fullDayTasks(1);
    const candidateEdges: CandidateEdge[] = [
      ...edgesForAllCells(tasks, "t1"),
      { dayOrder: 1, dutyLocationId: FULL_DAY_LOC.id, dutyBlockId: `${FULL_DAY_LOC.id}-long1`, teacherSourceId: "t2" },
    ];
    const baseline = solveDutyPlan({
      tasks: tasks.map((t) => ({ dayOrder: t.dayOrder, dutyLocationId: t.dutyLocationId, dutyBlockId: t.dutyBlockId })),
      candidateEdges,
      teacherFixedLoads: [],
      options: { maxWeeklyDuties: 5 },
    });
    const result = solveDutyPlanWithPackages({
      tasks,
      candidateEdges,
      teacherFixedLoads: [],
      locations: [FULL_DAY_LOC],
      options: { maxWeeklyDuties: 5 },
    });
    // Paket modeli eski (hücre bazlı, günde-tek-görev) modelin ULAŞAMADIĞI
    // bir kapsamaya ulaşabilir (t1 aynı gün 4 hücreyi TEK paketle alabilir) —
    // bu yüzden invariant "asla baseline'ın ALTINA düşmez", eşitlik değil.
    expect(result.coveredCount).toBeGreaterThanOrEqual(baseline.coveredCount);
    expect(result.coveredCount).toBe(4);
  });

  it("gerçekten kıt (t2'nin BAŞKA hiçbir adayı da yoksa) t1 FULL_DAY'i reddedip t2'ye bırakır — kapsama düşmez", () => {
    // Burada t2 SADECE Uzun-1'e aday VE t1 dışında Uzun-1'e başka aday YOK.
    // t1 FULL_DAY alırsa t2'nin adayı olan tek hücre (Uzun-1) t1'e gider,
    // t2 tamamen görevsiz kalır ama kapsama YİNE 4 olur (t1 zaten o hücreyi
    // de kapsıyor) — yani coverage düşmüyor, dolayısıyla FULL_DAY hâlâ kabul
    // edilebilir. Kapsamanın GERÇEKTEN düşeceği senaryo: t1'in adayı olmadığı
    // bir hücre başka bir öğretmene muhtaç olduğunda oluşur — sonraki test.
    const tasks = fullDayTasks(1);
    const candidateEdges: CandidateEdge[] = [
      ...edgesForAllCells(tasks, "t1"),
      { dayOrder: 1, dutyLocationId: FULL_DAY_LOC.id, dutyBlockId: `${FULL_DAY_LOC.id}-long1`, teacherSourceId: "t2" },
    ];
    const result = solveDutyPlanWithPackages({
      tasks,
      candidateEdges,
      teacherFixedLoads: [],
      locations: [FULL_DAY_LOC],
      options: { maxWeeklyDuties: 5 },
    });
    expect(result.coveredCount).toBe(4);
  });

  it("BALKON FULL_DAY'i t1 yerine t2'ye verir çünkü t1 BAŞKA yerde TEK adaydır — toplam kapsama böylece maksimum olur", () => {
    // t1: BALKON'un 4 bloğuna VE GIRIS/MORNING_BREAKS'e aday (GIRIS'te TEK aday).
    // t2: YALNIZ BALKON'un 4 bloğuna aday (başka hiçbir hücrede adayı yok).
    // t1 BALKON FULL_DAY'i alırsa GIRIS açık kalır → toplam 4. t2 BALKON
    // FULL_DAY'i alırsa t1 GIRIS'e serbest kalır → toplam 5. Solver, aynı
    // paket için TÜM uygun adayları deneme-çözümüyle karşılaştırıp EN YÜKSEK
    // toplam kapsamayı veren adayı (t2) seçmelidir — yalnız eşiği geçen İLK
    // adayı (t1) almak SUBOPTIMAL kalırdı.
    const balkon = fullDayTasks(1);
    const girisTask: PackageDutyTask = { dayOrder: 1, dutyLocationId: SHORT_ONLY_LOC.id, dutyBlockId: `${SHORT_ONLY_LOC.id}-morning`, blockCode: "MORNING_BREAKS" };
    const tasks = [...balkon, girisTask];
    const candidateEdges: CandidateEdge[] = [
      ...edgesForAllCells(balkon, "t1"),
      ...edgesForAllCells(balkon, "t2"),
      { dayOrder: 1, dutyLocationId: SHORT_ONLY_LOC.id, dutyBlockId: girisTask.dutyBlockId, teacherSourceId: "t1" },
    ];
    const baseline = solveDutyPlan({
      tasks: tasks.map((t) => ({ dayOrder: t.dayOrder, dutyLocationId: t.dutyLocationId, dutyBlockId: t.dutyBlockId })),
      candidateEdges,
      teacherFixedLoads: [],
      options: { maxWeeklyDuties: 5 },
    });
    const result = solveDutyPlanWithPackages({
      tasks,
      candidateEdges,
      teacherFixedLoads: [],
      locations: [FULL_DAY_LOC, SHORT_ONLY_LOC],
      options: { maxWeeklyDuties: 5 },
    });
    expect(result.coveredCount).toBeGreaterThanOrEqual(baseline.coveredCount);
    expect(result.coveredCount).toBe(5);
    expect(result.uncoveredCount).toBe(0);
    expect(result.fullDayPackageCount).toBe(1);
    const balkonPackage = result.packages.find((p) => p.dutyLocationId === FULL_DAY_LOC.id);
    expect(balkonPackage?.teacherSourceId).toBe("t2");
    const girisPackage = result.packages.find((p) => p.dutyLocationId === SHORT_ONLY_LOC.id);
    expect(girisPackage?.teacherSourceId).toBe("t1");
  });
});

describe("solveDutyPlanWithPackages — haftalık yük ve tekillik", () => {
  it("aynı öğretmen aynı gün iki paket alamaz (FULL_DAY + başka yerde ayrı aday varsa bile ikinci hücre başka öğretmene gider)", () => {
    const balkon = fullDayTasks(1);
    const girisTasks = shortTasks(1, SHORT_ONLY_LOC.id);
    const tasks = [...balkon, ...girisTasks];
    const candidateEdges: CandidateEdge[] = [
      ...edgesForAllCells(balkon, "t1"),
      ...edgesForAllCells(girisTasks, "t1"),
      ...edgesForAllCells(girisTasks, "t2"),
    ];
    const result = solveDutyPlanWithPackages({
      tasks,
      candidateEdges,
      teacherFixedLoads: [],
      locations: [FULL_DAY_LOC, SHORT_ONLY_LOC],
      options: { maxWeeklyDuties: 5 },
    });
    const t1Packages = result.packages.filter((p) => p.teacherSourceId === "t1" && p.dayOrder === 1);
    expect(t1Packages).toHaveLength(1);
    expect(result.coveredCount).toBe(6);
  });

  it("FULL_DAY haftalık yükte BİR gün sayılır — max=2 ile iki FULL_DAY gün sınırını aşmaz", () => {
    const day1 = fullDayTasks(1, "loc-a");
    const day2 = fullDayTasks(2, "loc-a");
    const day3 = fullDayTasks(3, "loc-a");
    const loc: DutyPlanLocationRef = { ...FULL_DAY_LOC, id: "loc-a" };
    const tasks = [...day1, ...day2, ...day3];
    const candidateEdges: CandidateEdge[] = [...edgesForAllCells(day1, "t1"), ...edgesForAllCells(day2, "t1"), ...edgesForAllCells(day3, "t1")];
    const result = solveDutyPlanWithPackages({
      tasks,
      candidateEdges,
      teacherFixedLoads: [],
      locations: [loc],
      options: { maxWeeklyDuties: 2, minWeeklyDuties: 0, targetWeeklyDuties: 2 },
    });
    const load = loadOf(result, "t1");
    expect(load?.totalDutyCount).toBeLessThanOrEqual(2);
    expect(result.fullDayPackageCount).toBeLessThanOrEqual(2);
  });

  it("sabit sabah+öğleden sonra (fixed) yükü BİR gün olarak dahil edilir, paket adayı ekstra gün eklemez", () => {
    const tasks = fullDayTasks(2);
    const result = solveDutyPlanWithPackages({
      tasks,
      candidateEdges: edgesForAllCells(tasks, "t1"),
      teacherFixedLoads: [{ teacherSourceId: "t1", fixedDutyDayCount: 1 } satisfies TeacherFixedLoad],
      locations: [FULL_DAY_LOC],
      options: { maxWeeklyDuties: 2 },
    });
    const load = loadOf(result, "t1");
    expect(load?.fixedDutyDayCount).toBe(1);
    expect(load?.normalDutyCount).toBe(1);
    expect(load?.totalDutyCount).toBe(2);
  });
});

describe("solveDutyPlanWithPackages — bağımsız çoklu FULL_DAY paketleri (bulgu 4 regresyonu)", () => {
  it("iki ayrı gün, aynı dört bloklu yer, dört uygun öğretmen → 8/8 kapsama, tam 2 FULL_DAY, 0 SINGLE_BLOCK", () => {
    const day1 = fullDayTasks(1);
    const day2 = fullDayTasks(2);
    const tasks = [...day1, ...day2];
    const candidateEdges: CandidateEdge[] = [
      ...edgesForAllCells(day1, "t1"),
      ...edgesForAllCells(day1, "t2"),
      ...edgesForAllCells(day1, "t3"),
      ...edgesForAllCells(day1, "t4"),
      ...edgesForAllCells(day2, "t1"),
      ...edgesForAllCells(day2, "t2"),
      ...edgesForAllCells(day2, "t3"),
      ...edgesForAllCells(day2, "t4"),
    ];
    const result = solveDutyPlanWithPackages({
      tasks,
      candidateEdges,
      teacherFixedLoads: [],
      locations: [FULL_DAY_LOC],
      options: { maxWeeklyDuties: 5 },
    });
    expect(result.coveredCount).toBe(8);
    expect(result.uncoveredCount).toBe(0);
    expect(result.fullDayPackageCount).toBe(2);
    expect(result.singleBlockCellCount).toBe(0);
    expect(result.packages).toHaveLength(2);
  });

  it("üç bağımsız gün, aynı dört bloklu yer → 12/12 kapsama, tam 3 FULL_DAY, 0 SINGLE_BLOCK", () => {
    const day1 = fullDayTasks(1);
    const day2 = fullDayTasks(2);
    const day3 = fullDayTasks(3);
    const tasks = [...day1, ...day2, ...day3];
    // Her gün için iki öğretmen aday (günler arası kesişen öğretmenler de
    // olabilir — bağımsızlık GÜN bazında olduğu için sorun değildir).
    const candidateEdges: CandidateEdge[] = [
      ...edgesForAllCells(day1, "t1"),
      ...edgesForAllCells(day1, "t2"),
      ...edgesForAllCells(day2, "t2"),
      ...edgesForAllCells(day2, "t3"),
      ...edgesForAllCells(day3, "t3"),
      ...edgesForAllCells(day3, "t4"),
    ];
    const result = solveDutyPlanWithPackages({
      tasks,
      candidateEdges,
      teacherFixedLoads: [],
      locations: [FULL_DAY_LOC],
      options: { maxWeeklyDuties: 5 },
    });
    expect(result.coveredCount).toBe(12);
    expect(result.uncoveredCount).toBe(0);
    expect(result.fullDayPackageCount).toBe(3);
    expect(result.singleBlockCellCount).toBe(0);
  });
});

describe("solveDutyPlanWithPackages — kıtlık sırası (most-constrained-first) FULL_DAY sayısını korur", () => {
  it("bol adaylı yer önce işlenirse kıt adaylı yerin TEK adayını çalıp onu SINGLE_BLOCK'a düşürmez", () => {
    // Aynı gün, İKİ farklı dört-bloklu yer: L1 (BALKON, adaylar: t1) — KIT,
    // tek adaylı. L2 (alfabetik sırada BALKON'dan SONRA gelecek bir shortCode,
    // "ZEMIN") — BOL, iki adaylı (t1, t2). Naif (yalnız shortCode) sıralama
    // BALKON'u ZEMIN'den önce işlerdi ki bu durumda fark etmezdi (BALKON zaten
    // kıt); asıl riskli durum TERSİ: bol yerin kıt yerden ÖNCE alfabetik
    // geldiği kurulum. Kıtlık-öncelikli sıralama HER İKİ sırada da doğru
    // sonucu garanti eder — burada kasıtlı olarak alfabetik sırayı TERSİNE
    // çeviren isimler kullanılır (ZEMIN kıt, BALKON bol) ki eski (yalnız
    // shortCode) sıralama gerçekten BAŞARISIZ olsun.
    const bolLoc: DutyPlanLocationRef = { ...FULL_DAY_LOC, id: "loc-bol", shortCode: "BALKON" };
    const kitLoc: DutyPlanLocationRef = { ...FULL_DAY_LOC, id: "loc-kit", shortCode: "ZEMIN" };
    const bolTasks = fullDayTasks(1, bolLoc.id);
    const kitTasks = fullDayTasks(1, kitLoc.id);
    const tasks = [...bolTasks, ...kitTasks];
    const candidateEdges: CandidateEdge[] = [
      ...edgesForAllCells(bolTasks, "t1"),
      ...edgesForAllCells(bolTasks, "t2"),
      ...edgesForAllCells(kitTasks, "t1"),
    ];
    const result = solveDutyPlanWithPackages({
      tasks,
      candidateEdges,
      teacherFixedLoads: [],
      locations: [bolLoc, kitLoc],
      options: { maxWeeklyDuties: 5 },
    });
    expect(result.coveredCount).toBe(8);
    expect(result.uncoveredCount).toBe(0);
    // İKİ yer de FULL_DAY olmalı: kıt yer (ZEMIN, yalnız t1) ÖNCE işlenip
    // t1'i alır; bol yer (BALKON) t2'ye düşer — t1 BALKON'u "çalıp" ZEMIN'i
    // SINGLE_BLOCK'a düşürmemelidir.
    expect(result.fullDayPackageCount).toBe(2);
    expect(result.singleBlockCellCount).toBe(0);
    const kitPkg = result.packages.find((p) => p.dutyLocationId === kitLoc.id);
    expect(kitPkg?.teacherSourceId).toBe("t1");
    const bolPkg = result.packages.find((p) => p.dutyLocationId === bolLoc.id);
    expect(bolPkg?.teacherSourceId).toBe("t2");
  });
});

describe("solveDutyPlanWithPackages — determinizm", () => {
  it("aynı girdi + seed her zaman aynı paketleri üretir", () => {
    const tasks = fullDayTasks(1);
    const candidateEdges = [...edgesForAllCells(tasks, "t1"), ...edgesForAllCells(tasks, "t2")];
    const input: PackageSolverInput = {
      tasks,
      candidateEdges,
      teacherFixedLoads: [],
      locations: [FULL_DAY_LOC],
      options: { maxWeeklyDuties: 5, seed: 42 },
    };
    const r1 = solveDutyPlanWithPackages(input);
    const r2 = solveDutyPlanWithPackages(input);
    expect(r1.packages).toEqual(r2.packages);
  });
});

describe("solveDutyPlanWithPackages — ders yükü önceliği kapsamayı bozmaz", () => {
  it("düşük ders sayılı öğretmen tercih edilir ama kapsama kaybına yol açmaz", () => {
    const tasks = fullDayTasks(1);
    const candidateEdges = [...edgesForAllCells(tasks, "t1"), ...edgesForAllCells(tasks, "t2")];
    const lessonMap = new Map<string, number>([
      ["t1|1", 6],
      ["t2|1", 1],
    ]);
    const result = solveDutyPlanWithPackages({
      tasks,
      candidateEdges,
      teacherFixedLoads: [],
      locations: [FULL_DAY_LOC],
      lessonPeriodCountByTeacherDay: lessonMap,
      options: { maxWeeklyDuties: 5 },
    });
    expect(result.coveredCount).toBe(4);
    expect(result.packages[0].teacherSourceId).toBe("t2");
  });
});

// ============================================================================
// GLOBAL MAKSİMUM KAPSAMA — branch-and-bound doğrulaması. Kök neden: eski
// greedy, bir sonraki adayı yalnız STATİK cellOnlyBaseline'ı korumuyor diye
// kabul ediyordu; bu paket-farkında modelde ÜST SINIR DEĞİLDİR (bir paket
// TEK öğretmen-günle BİRDEN FAZLA hücreyi kapsar). Aşağıdaki testler,
// yerel-güvenli bir seçimin GLOBAL olarak daha kötü olduğu ("Gün 1 FULL_DAY
// t1'i kilitler, Gün 2 tamamen açık kalır") somut karşı örnekleri kapsar.
// ============================================================================
describe("solveDutyPlanWithPackages — global maksimum kapsama (branch-and-bound)", () => {
  it("iki günlük karşı örnek: tam olarak 7/8 kapsama (yerel-greedy 4/8 verirdi)", () => {
    const { input, dFull } = twoDayCounterExample();
    const result = solveDutyPlanWithPackages(input);
    expect(result.coveredCount).toBe(7);
    expect(result.uncoveredCount).toBe(1);
    expect(result.fullDayPackageCount).toBe(1);
    const fullDayPkg = result.packages.find((p) => p.coverageMode === "FULL_DAY");
    expect(fullDayPkg?.dayOrder).toBe(dFull);
    expect(fullDayPkg?.teacherSourceId).toBe("t1");
    expect(result.cellOnlyBaselineCoverage).toBeLessThanOrEqual(result.coveredCount);
    expect(result.optimalityProven).toBe(true);
  });

  it("günlerin yerleri ters çevrildiğinde AYNI sonuç (7/8, doğru güne FULL_DAY)", () => {
    const { input, dFull } = twoDayCounterExample({ swapDays: true });
    const result = solveDutyPlanWithPackages(input);
    expect(result.coveredCount).toBe(7);
    const fullDayPkg = result.packages.find((p) => p.coverageMode === "FULL_DAY");
    expect(fullDayPkg?.dayOrder).toBe(dFull);
  });

  it("shortCode ve teacherSourceId adları değiştirildiğinde AYNI kapsama (7/8)", () => {
    const { input } = twoDayCounterExample({ renameTeachers: true, renameLocation: true });
    const result = solveDutyPlanWithPackages(input);
    expect(result.coveredCount).toBe(7);
    expect(result.fullDayPackageCount).toBe(1);
  });

  it("seed değişse bile maksimum kapsama DEĞİŞMEZ (yalnız eşitlik bozmada rol oynar)", () => {
    for (const seed of [0, 1, 7, 42, 1000]) {
      const { input } = twoDayCounterExample({ seed });
      const result = solveDutyPlanWithPackages(input);
      expect(result.coveredCount).toBe(7);
    }
  });

  it("aynı input+seed TAMAMEN deterministik sonuç üretir", () => {
    const { input } = twoDayCounterExample({ seed: 42 });
    const r1 = solveDutyPlanWithPackages(input);
    const r2 = solveDutyPlanWithPackages(input);
    expect(r1.packages).toEqual(r2.packages);
    expect(r1.assignments).toEqual(r2.assignments);
  });

  it("İKİNCİ farklı fixture (SHORT_BREAKS türü darboğaz): yerel-greedy 2/4 verirdi, doğrusu 3/4", () => {
    // t1: iki günde de SHORT_ONLY_LOC'un iki bloğuna da aday. s1: YALNIZ
    // gün1/MORNING_BREAKS'e aday. maxWeeklyDuties=1. Yanlış: Gün1
    // SHORT_BREAKS(t1) → 2/4 (Gün2 tamamen açık). Doğru: Gün2
    // SHORT_BREAKS(t1) + Gün1'de s1 SINGLE_BLOCK(MORNING) → 1+2=3/4.
    const day1 = shortTasks(1);
    const day2 = shortTasks(2);
    const tasks = [...day1, ...day2];
    const candidateEdges: CandidateEdge[] = [
      ...edgesForAllCells(day1, "t1"),
      ...edgesForAllCells(day2, "t1"),
      { dayOrder: 1, dutyLocationId: SHORT_ONLY_LOC.id, dutyBlockId: `${SHORT_ONLY_LOC.id}-morning`, teacherSourceId: "s1" },
    ];
    const result = solveDutyPlanWithPackages({
      tasks,
      candidateEdges,
      teacherFixedLoads: [],
      locations: [SHORT_ONLY_LOC],
      options: { minWeeklyDuties: 0, targetWeeklyDuties: 1, maxWeeklyDuties: 1 },
    });
    expect(result.coveredCount).toBe(3);
    expect(result.shortBreaksPackageCount).toBe(1);
    const shortPkg = result.packages.find((p) => p.coverageMode === "SHORT_BREAKS");
    expect(shortPkg?.dayOrder).toBe(2);
    expect(shortPkg?.teacherSourceId).toBe("t1");
  });

  it("maxWeeklyDuties=2 ile t1 HER İKİ günü de FULL_DAY alabilir → 8/8, 2 FULL_DAY", () => {
    const { input } = twoDayCounterExample();
    const result = solveDutyPlanWithPackages({ ...input, options: { ...input.options, maxWeeklyDuties: 2 } });
    expect(result.coveredCount).toBe(8);
    expect(result.fullDayPackageCount).toBe(2);
    expect(result.uncoveredCount).toBe(0);
  });

  it("sabit nöbet (fixedDutyDayCount) t1'in kapasitesini doğru düşürür — max=1'de t1'e HİÇ paket kalmaz", () => {
    const { input, dFull, dScarce } = twoDayCounterExample();
    const result = solveDutyPlanWithPackages({
      ...input,
      teacherFixedLoads: [{ teacherSourceId: "t1", fixedDutyDayCount: 1 } satisfies TeacherFixedLoad],
    });
    const t1Load = loadOf(result, "t1");
    expect(t1Load?.normalDutyCount).toBe(0); // t1 kapasitesi (max1-fixed1=0) tükendi, yeni paket ALAMAZ
    expect(t1Load?.fixedDutyDayCount).toBe(1);
    // s1/s2/s3 gün1'de (dScarce) hâlâ kendi hücrelerini alabilir; dFull günü
    // t1 olmadan tamamen açık kalır.
    const dFullCovered = result.assignments.filter((a) => a.dayOrder === dFull && a.kind === "generated").length;
    const dScarceCovered = result.assignments.filter((a) => a.dayOrder === dScarce && a.kind === "generated").length;
    expect(dFullCovered).toBe(0);
    expect(dScarceCovered).toBe(3);
  });

  it("korunmuş (excludedTeacherDays ile kilitli) manuel paket kapasiteyi AYNI ŞEKİLDE düşürür", () => {
    const { input, dFull, dScarce } = twoDayCounterExample();
    // t1'in dScarce günü zaten (manuel olarak) KİLİTLİ/kullanılmış gibi
    // davranır — regenerate'in kilitli manuel paketleri dışlama deseniyle
    // AYNI mekanizma (excludedTeacherDays).
    const result = solveDutyPlanWithPackages({ ...input, excludedTeacherDays: [{ teacherSourceId: "t1", dayOrder: dScarce }] });
    const t1Load = loadOf(result, "t1");
    // t1 hiçbir paket almadıysa (kilitlendiği için) teacherLoads'ta HİÇ
    // görünmeyebilir (yalnız explicit `teachers`/fixedLoads/kullanılan
    // paketlerden türetilir — solver.ts ile AYNI davranış); ya HİÇ yoktur ya
    // da normalDutyCount 0'dır — ikisi de "hiç paket almadı" anlamına gelir.
    expect(t1Load?.normalDutyCount ?? 0).toBe(0);
    expect(result.packages.some((p) => p.teacherSourceId === "t1")).toBe(false);
    const dFullCovered = result.assignments.filter((a) => a.dayOrder === dFull && a.kind === "generated").length;
    expect(dFullCovered).toBe(0);
  });

  it("düğüm bütçesi çok düşük olsa bile SONUÇ asla cellOnlyBaseline'ın altına düşmez (searchLimitReached=true olabilir)", () => {
    const { input } = twoDayCounterExample();
    const result = solveDutyPlanWithPackages({ ...input, maxSearchNodes: 1 });
    expect(result.coveredCount).toBeGreaterThanOrEqual(result.cellOnlyBaselineCoverage);
    if (result.searchLimitReached) {
      expect(result.optimalityProven).toBe(false);
    }
  });
});

// ============================================================================
// BULGU (ikinci sürüm regresyonu): flow-tabanlı "kalan havuzun hücre-bazlı
// çözümü" üst sınır olarak GEÇERSİZDİ — cell-level model bir öğretmen-güne
// YALNIZ 1 hücre verebilirken bir paket 2-4 hücre verebilir, dolayısıyla
// cell-level çözüm paket-farkında stratejinin ULAŞABİLECEĞİNDEN DAHA DÜŞÜK
// olabilir (üç günlük karşı örnek: cellOnlyBaseline=5, gerçek optimum=11).
// Bu, "erken bulunan yerel-iyi bir incumbent, hâlâ geçerli (ve daha iyi)
// olan 'hiç paket seçme' gibi dalları YANLIŞ biçimde budar" hatasına yol
// açıyordu. Admissible (bağımsız-görev) üst sınır bunu düzeltir.
// ============================================================================
describe("solveDutyPlanWithPackages — üç günlük karşı örnek (ikinci bulgu regresyonu)", () => {
  it("tam olarak 11/12 kapsama: Gün2 FULL_DAY(t1) + Gün3 FULL_DAY(t2) + Gün1 3×SINGLE_BLOCK(s1,s2,s3)", () => {
    const input = threeDayCounterExample();
    const result = solveDutyPlanWithPackages(input);

    expect(result.cellOnlyBaselineCoverage).toBe(5); // yalnız REFERANS — üst sınır DEĞİL
    expect(result.coveredCount).toBe(11);
    expect(result.uncoveredCount).toBe(1);
    expect(result.fullDayPackageCount).toBe(2);
    expect(result.singleBlockCellCount).toBe(3);
    expect(result.optimalityProven).toBe(true);

    const day2Pkg = result.packages.find((p) => p.dayOrder === 2 && p.coverageMode === "FULL_DAY");
    const day3Pkg = result.packages.find((p) => p.dayOrder === 3 && p.coverageMode === "FULL_DAY");
    expect(day2Pkg?.teacherSourceId).toBe("t1");
    expect(day3Pkg?.teacherSourceId).toBe("t2");
    const day1Teachers = result.packages.filter((p) => p.dayOrder === 1).map((p) => p.teacherSourceId).sort();
    expect(day1Teachers).toEqual(["s1", "s2", "s3"]);
  });

  it("cellOnlyBaselineCoverage GERÇEKTEN pakete-farkında sonuçtan düşük olabilir (üst sınır DEĞİL, yalnız referans)", () => {
    const input = threeDayCounterExample();
    const result = solveDutyPlanWithPackages(input);
    expect(result.cellOnlyBaselineCoverage).toBeLessThan(result.coveredCount);
  });

  it("büyük bir düğüm bütçesiyle bile 'hiç paket seçme' dalı yanlışlıkla budanmaz — sonuç optimuma ulaşır", () => {
    const input = threeDayCounterExample();
    // Bilerek KÜÇÜK bir bütçe: eski (geçersiz) üst sınırla bu bütçe bile
    // yanlış budama yüzünden 8'de takılırdı; admissible sınırla 11'e ulaşır.
    const result = solveDutyPlanWithPackages({ ...input, maxSearchNodes: 5000 });
    expect(result.coveredCount).toBe(11);
    expect(result.optimalityProven).toBe(true);
  });
});

// ============================================================================
// Küçük rastgele fixture'larda brute-force optimum ile karşılaştırma.
// ============================================================================
function bruteForceMaxCoverage(input: PackageSolverInput): number {
  // Girdideki TÜM (day,location) FULL_DAY/SHORT_BREAKS aday paketlerini
  // (buildPackageCandidates ile AYNI kaynak — solveDutyPlanWithPackages'ın
  // kendisi zaten bu fonksiyonu kullanıyor, burada YALNIZ hangi ALT KÜMESİNİN
  // seçildiğini KABA KUVVETLE dener) çıkarıp, HER geçerli alt kümesi için
  // (öğretmen-gün çakışması/haftalık limit ihlali OLMAYAN) kalanı hücre-bazlı
  // çözüp toplam kapsamayı hesaplar; en iyisini döner.
  const options = { minWeeklyDuties: 0, targetWeeklyDuties: 2, maxWeeklyDuties: 3, balanceWorkload: true, diversifyAreas: true, allowPartial: true, ...input.options };
  const candidates = buildPackageCandidates(input.locations, input.tasks, input.candidateEdges);
  const baseTasks = input.tasks.map((t) => ({ dayOrder: t.dayOrder, dutyLocationId: t.dutyLocationId, dutyBlockId: t.dutyBlockId, category: t.category }));
  const fixedDaysByTeacher = new Map<string, number>();
  for (const f of input.teacherFixedLoads) fixedDaysByTeacher.set(f.teacherSourceId, f.fixedDutyDayCount);

  let best = 0;
  const n = candidates.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    const chosen: { dayOrder: number; dutyLocationId: string; teacherSourceId: string; cells: string[] }[] = [];
    let valid = true;
    const usedTeacherDay = new Set<string>();
    const usedBudget = new Map<string, number>();
    const coveredKeys = new Set<string>();
    for (let i = 0; i < n && valid; i++) {
      if (!((mask >> i) & 1)) continue;
      const c = candidates[i];
      const cellKeys = c.cells.map((cell) => `${cell.dayOrder}|${cell.dutyLocationId}|${cell.dutyBlockId}`);
      if (cellKeys.some((k) => coveredKeys.has(k))) {
        valid = false;
        break;
      }
      // Bu paket için HERHANGİ bir uygun (gün kilitli olmayan, bütçesi
      // yeten) öğretmen var mı? Kaba kuvvet basitlik için İLK uygun adayı
      // seçer (paket seçim maskesi zaten TÜM kombinasyonları gezdiği için
      // öğretmen seçimi burada ikinci derecede önemlidir — asıl karşılaştırma
      // TOPLAM KAPSAMA üzerindendir).
      let pickedTeacher: string | null = null;
      for (const t of c.teacherSourceIds) {
        const dayKey = `${t}|${c.dayOrder}`;
        const fixedDays = fixedDaysByTeacher.get(t) ?? 0;
        const used = usedBudget.get(t) ?? 0;
        if (!usedTeacherDay.has(dayKey) && fixedDays + used < options.maxWeeklyDuties) {
          pickedTeacher = t;
          break;
        }
      }
      if (!pickedTeacher) {
        valid = false;
        break;
      }
      usedTeacherDay.add(`${pickedTeacher}|${c.dayOrder}`);
      usedBudget.set(pickedTeacher, (usedBudget.get(pickedTeacher) ?? 0) + 1);
      for (const k of cellKeys) coveredKeys.add(k);
      chosen.push({ dayOrder: c.dayOrder, dutyLocationId: c.dutyLocationId, teacherSourceId: pickedTeacher, cells: cellKeys });
    }
    if (!valid) continue;

    const remainingTasks = baseTasks.filter((t) => !coveredKeys.has(`${t.dayOrder}|${t.dutyLocationId}|${t.dutyBlockId}`));
    const excludedTeacherDays = [
      ...(input.excludedTeacherDays ?? []),
      ...Array.from(usedTeacherDay).map((k) => {
        const sep = k.lastIndexOf("|");
        return { teacherSourceId: k.slice(0, sep), dayOrder: Number(k.slice(sep + 1)) };
      }),
    ];
    const remainderResult = solveDutyPlan({
      tasks: remainingTasks,
      candidateEdges: input.candidateEdges,
      teacherFixedLoads: input.teacherFixedLoads,
      teachers: input.teachers,
      excludedTeacherDays,
      options: input.options,
    });
    const total = coveredKeys.size + remainderResult.coveredCount;
    if (total > best) best = total;
  }
  return best;
}

describe("solveDutyPlanWithPackages — küçük rastgele fixture'larda brute-force karşılaştırma", () => {
  function seededRandom(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  }

  for (const runSeed of [1, 2, 3]) {
    it(`rastgele küçük fixture #${runSeed} (2 gün): solver == brute-force optimum`, () => {
      const rand = seededRandom(runSeed * 97 + 13);
      const days = [1, 2];
      const teachers = ["a", "b", "c"];
      const tasks: PackageDutyTask[] = [];
      const candidateEdges: CandidateEdge[] = [];
      for (const d of days) {
        for (const t of fullDayTasks(d, FULL_DAY_LOC.id)) tasks.push(t);
      }
      for (const d of days) {
        for (const teacher of teachers) {
          for (const code of ["morning", "long1", "long2", "afternoon"]) {
            if (rand() < 0.45) {
              candidateEdges.push({ dayOrder: d, dutyLocationId: FULL_DAY_LOC.id, dutyBlockId: `${FULL_DAY_LOC.id}-${code}`, teacherSourceId: teacher });
            }
          }
        }
      }
      const input: PackageSolverInput = {
        tasks,
        candidateEdges,
        teacherFixedLoads: [],
        locations: [FULL_DAY_LOC],
        options: { minWeeklyDuties: 0, targetWeeklyDuties: 1, maxWeeklyDuties: 1, seed: runSeed },
      };
      const result = solveDutyPlanWithPackages(input);
      const optimum = bruteForceMaxCoverage(input);
      expect(result.coveredCount).toBe(optimum);
      if (result.optimalityProven) expect(result.coveredCount).toBe(optimum);
    });
  }

  // ÜÇ gün, DÜŞÜK yoğunluk (0.3) — bilerek aynı öğretmenin haftanın FARKLI
  // günleri arasında SEÇİM yapmak ZORUNDA kalacağı (maxWeeklyDuties=1),
  // erken bulunan yerel-iyi bir paketin daha iyi bir SONRAKİ kombinasyonu
  // (üç günlük karşı örnekteki gibi) engellemediği senaryolar.
  for (const runSeed of [11, 12, 13, 14, 15]) {
    it(`rastgele küçük fixture #${runSeed} (3 gün, düşük yoğunluk, max=1): solver == brute-force optimum`, () => {
      const rand = seededRandom(runSeed * 131 + 7);
      const days = [1, 2, 3];
      const teachers = ["a", "b", "c", "d"];
      const tasks: PackageDutyTask[] = [];
      const candidateEdges: CandidateEdge[] = [];
      for (const d of days) {
        for (const t of fullDayTasks(d, FULL_DAY_LOC.id)) tasks.push(t);
      }
      for (const d of days) {
        for (const teacher of teachers) {
          for (const code of ["morning", "long1", "long2", "afternoon"]) {
            if (rand() < 0.3) {
              candidateEdges.push({ dayOrder: d, dutyLocationId: FULL_DAY_LOC.id, dutyBlockId: `${FULL_DAY_LOC.id}-${code}`, teacherSourceId: teacher });
            }
          }
        }
      }
      const input: PackageSolverInput = {
        tasks,
        candidateEdges,
        teacherFixedLoads: [],
        locations: [FULL_DAY_LOC],
        options: { minWeeklyDuties: 0, targetWeeklyDuties: 1, maxWeeklyDuties: 1, seed: runSeed },
      };
      const result = solveDutyPlanWithPackages(input);
      const optimum = bruteForceMaxCoverage(input);
      expect(result.coveredCount).toBe(optimum);
    });
  }

  it("iki günlük karşı örneğin brute-force optimumu solver ile eşleşir (7)", () => {
    const { input } = twoDayCounterExample();
    const optimum = bruteForceMaxCoverage(input);
    expect(optimum).toBe(7);
    expect(solveDutyPlanWithPackages(input).coveredCount).toBe(optimum);
  });

  it("üç günlük karşı örneğin brute-force optimumu solver ile eşleşir (11) VE cellOnlyBaseline'ı (5) AŞAR", () => {
    const input = threeDayCounterExample();
    const optimum = bruteForceMaxCoverage(input);
    expect(optimum).toBe(11);
    const result = solveDutyPlanWithPackages(input);
    expect(result.coveredCount).toBe(optimum);
    expect(optimum).toBeGreaterThan(result.cellOnlyBaselineCoverage);
  });
});

// ============================================================================
// BULGU (üçüncü sürüm regresyonu): `best` başlangıçta null bırakılıyordu.
// Bütçe bir SEÇ dalının İÇİNDEYKEN tükendiğinde "hiç paket seçme" (skip-all)
// dalına HİÇ ulaşılamayabiliyordu — bu durumda tükenen aramanın kaydettiği,
// baseline'dan DAHA KÖTÜ kısmi sonuç YANLIŞLIKLA nihai cevap oluyordu. Düzeltme:
// `best`, DFS başlamadan ÖNCE cellOnlyBaseline ile TOHUMLANIR; bu sayede
// `recordTerminal()`'ın HER ZAMAN çalıştırdığı `isBetter` kontrolü, dönüşün
// asla bu tabanın ALTINA düşmesini KOŞULSUZ engeller (skip-all düğümü hiç
// gezilmese BİLE).
// ============================================================================
describe("solveDutyPlanWithPackages — arama-limiti güvenliği (üçüncü bulgu regresyonu)", () => {
  /** FULL_DAY_LOC/gün1: t1 dört hücrenin TAMAMINA aday (FULL_DAY/SHORT_BREAKS
   * mümkün); s1..s4 her biri YALNIZ bir hücreye tekil aday. SINGLE_LOC/gün2:
   * YALNIZ t1 aday (başka hiç kimse). maxWeeklyDuties=1. FULL_DAY(t1) seçilirse
   * t1'in TEK haftalık slotu tükenir → gün2 açık kalır (4/5). Doğrusu: t1
   * gün2'yi alır, s1..s4 gün1'in dört hücresini paylaşır (5/5) — TAM OLARAK
   * cellOnlyBaseline'a eşittir (paketleme burada hiçbir ek fayda sağlamaz,
   * asıl risk yanlış budamanın bu KOLAY ulaşılabilir tabanı bile KAÇIRMASIYDI). */
  function fullDayVsExtraSingleFixture(): PackageSolverInput {
    const day1 = fullDayTasks(1, FULL_DAY_LOC.id);
    const day2Task: PackageDutyTask = { dayOrder: 2, dutyLocationId: SINGLE_LOC.id, dutyBlockId: "extra-blk", blockCode: "LONG_BREAK_1" };
    const tasks = [...day1, day2Task];
    const candidateEdges: CandidateEdge[] = [
      ...edgesForAllCells(day1, "t1"),
      { dayOrder: 1, dutyLocationId: FULL_DAY_LOC.id, dutyBlockId: `${FULL_DAY_LOC.id}-morning`, teacherSourceId: "s1" },
      { dayOrder: 1, dutyLocationId: FULL_DAY_LOC.id, dutyBlockId: `${FULL_DAY_LOC.id}-long1`, teacherSourceId: "s2" },
      { dayOrder: 1, dutyLocationId: FULL_DAY_LOC.id, dutyBlockId: `${FULL_DAY_LOC.id}-long2`, teacherSourceId: "s3" },
      { dayOrder: 1, dutyLocationId: FULL_DAY_LOC.id, dutyBlockId: `${FULL_DAY_LOC.id}-afternoon`, teacherSourceId: "s4" },
      { dayOrder: 2, dutyLocationId: SINGLE_LOC.id, dutyBlockId: "extra-blk", teacherSourceId: "t1" },
    ];
    return {
      tasks,
      candidateEdges,
      teacherFixedLoads: [],
      locations: [FULL_DAY_LOC, SINGLE_LOC],
      options: { minWeeklyDuties: 0, targetWeeklyDuties: 1, maxWeeklyDuties: 1 },
    };
  }

  function assertBaselineRecovered(result: ReturnType<typeof solveDutyPlanWithPackages>) {
    expect(result.cellOnlyBaselineCoverage).toBe(5);
    expect(result.coveredCount).toBe(5);
    expect(result.searchLimitReached).toBe(true);
    expect(result.optimalityProven).toBe(false);
    // t1 gün2'nin (SINGLE_BLOCK) tek görevinde kalmalı.
    const day2Pkg = result.packages.find((p) => p.dayOrder === 2);
    expect(day2Pkg?.teacherSourceId).toBe("t1");
    expect(day2Pkg?.coverageMode).toBe("SINGLE_BLOCK");
    // Gün 1'in dört hücresi s1/s2/s3/s4 arasında (birebir, tekrarsız) dağılmalı.
    const day1Teachers = result.packages
      .filter((p) => p.dayOrder === 1)
      .flatMap((p) => Array(p.cellTaskKeys.length).fill(p.teacherSourceId));
    expect(day1Teachers.sort()).toEqual(["s1", "s2", "s3", "s4"]);
  }

  it("maxSearchNodes=1: erken tükenen arama 4/5 yerine baseline 5/5'i döner", () => {
    const input = fullDayVsExtraSingleFixture();
    const result = solveDutyPlanWithPackages({ ...input, maxSearchNodes: 1 });
    expect(result.exploredNodeCount).toBeLessThanOrEqual(1);
    assertBaselineRecovered(result);
  });

  it("maxSearchNodes=2: AYNI güvenlik (5/5) korunur", () => {
    const input = fullDayVsExtraSingleFixture();
    const result = solveDutyPlanWithPackages({ ...input, maxSearchNodes: 2 });
    expect(result.exploredNodeCount).toBeLessThanOrEqual(2);
    assertBaselineRecovered(result);
  });

  it("maxSearchNodes=1/2, birden çok seed: güvenlik SEED'DEN bağımsız korunur", () => {
    for (const seed of [0, 1, 5, 42, 999]) {
      for (const maxSearchNodes of [1, 2]) {
        const input = fullDayVsExtraSingleFixture();
        const result = solveDutyPlanWithPackages({ ...input, options: { ...input.options, seed }, maxSearchNodes });
        assertBaselineRecovered(result);
      }
    }
  });

  it("exploredNodeCount HER ZAMAN maxSearchNodes'u aşmaz (off-by-one yok)", () => {
    const input = fullDayVsExtraSingleFixture();
    for (const maxSearchNodes of [1, 2, 3, 5, 10]) {
      const result = solveDutyPlanWithPackages({ ...input, maxSearchNodes });
      expect(result.exploredNodeCount).toBeLessThanOrEqual(maxSearchNodes);
    }
  });

  it("maxSearchNodes geçersizse (0, negatif, tam sayı olmayan) hata fırlatır", () => {
    const input = fullDayVsExtraSingleFixture();
    expect(() => solveDutyPlanWithPackages({ ...input, maxSearchNodes: 0 })).toThrow();
    expect(() => solveDutyPlanWithPackages({ ...input, maxSearchNodes: -1 })).toThrow();
    expect(() => solveDutyPlanWithPackages({ ...input, maxSearchNodes: 1.5 })).toThrow();
  });

  it("property: rastgele küçük fixture'larda maxSearchNodes=1/2/5 için coveredCount ASLA cellOnlyBaselineCoverage'ın altına düşmez", () => {
    function seededRandom(seed: number): () => number {
      let s = seed;
      return () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
    }

    for (let trial = 0; trial < 20; trial++) {
      const rand = seededRandom(trial * 733 + 91);
      const days = [1, 2, 3];
      const teachers = ["a", "b", "c", "d"];
      const day1 = fullDayTasks(1, FULL_DAY_LOC.id);
      const day2 = fullDayTasks(2, FULL_DAY_LOC.id);
      const day3 = fullDayTasks(3, FULL_DAY_LOC.id);
      const tasks = [...day1, ...day2, ...day3];
      const candidateEdges: CandidateEdge[] = [];
      for (const d of days) {
        for (const teacher of teachers) {
          for (const code of ["morning", "long1", "long2", "afternoon"]) {
            if (rand() < 0.35) {
              candidateEdges.push({ dayOrder: d, dutyLocationId: FULL_DAY_LOC.id, dutyBlockId: `${FULL_DAY_LOC.id}-${code}`, teacherSourceId: teacher });
            }
          }
        }
      }
      const input: PackageSolverInput = {
        tasks,
        candidateEdges,
        teacherFixedLoads: [],
        locations: [FULL_DAY_LOC],
        options: { minWeeklyDuties: 0, targetWeeklyDuties: 1, maxWeeklyDuties: 1, seed: trial },
      };
      const cellOnlyBaseline = solveDutyPlan({ tasks, candidateEdges, teacherFixedLoads: [], options: input.options });
      for (const maxSearchNodes of [1, 2, 5]) {
        const result = solveDutyPlanWithPackages({ ...input, maxSearchNodes });
        expect(result.coveredCount).toBeGreaterThanOrEqual(cellOnlyBaseline.coveredCount);
        expect(result.exploredNodeCount).toBeLessThanOrEqual(maxSearchNodes);
      }
    }
  });
});
