/**
 * Paket-farkında solver — server/lib/dutyPlanning/solver.ts (hücre bazlı
 * min-cost-flow) SUBROUTINE olarak kullanılır, hiper-kenar (1 birim akış →
 * N hücre) modelini flow ağına ZORLAMAZ (bkz. plan dosyası "Solver
 * Tasarımı"). Yöntem: GERÇEK branch-and-bound arama, paket adayları
 * üzerinde "seç" / "atla" dallanmasıyla.
 *
 * ÖNEMLİ DÜZELTME #1 (ilk sürümdeki KÖK NEDEN): hücre-bazlı (paket OLMAYAN)
 * baseline çözüm, paket modeli için ÜST SINIR DEĞİLDİR — bir paket TEK bir
 * öğretmen-gün ile BİRDEN FAZLA hücreyi kapsadığı için, paket-farkında bir
 * strateji baseline'ı KOLAYCA AŞABİLİR.
 *
 * ÖNEMLİ DÜZELTME #2 (ikinci sürümdeki KÖK NEDEN — bu dosyanın MEVCUT
 * hâli): "kalan havuzun hücre-bazlı çözümü"nü branch-and-bound üst sınırı
 * olarak kullanmak da YANLIŞTIR. `packages ⊆ cell-level feasible set`
 * iddiası GEÇERSİZDİR — cell-level model bir öğretmen-güne YALNIZ BİR
 * hücre atayabilirken (solveDutyPlan'ın TEACHER_DAY kapasitesi kesinlikle
 * 1'dir), bir paket AYNI öğretmen-günle 2-4 hücreyi BİRDEN kapsar. Yani iki
 * modelin ulaşabilir kümeleri arasında bu yönde bir kapsama İLİŞKİSİ YOKTUR
 * — cell-level çözüm bazı durumlarda paket-farkında stratejinin
 * ULAŞABİLECEĞİNDEN DAHA DÜŞÜK bir sayı verebilir (bkz. testler "üç günlük
 * karşı örnek": cell-level=5 ama paket-farkında gerçek optimum=11), bu da
 * onu üst sınır olarak kullanmayı GÜVENSİZ (yanlış budama → optimumu
 * KAÇIRMA) kılar.
 *
 * DOĞRU (admissible) üst sınır: HER kalan görev hücresi BAĞIMSIZ olarak
 * değerlendirilir — "bu hücre için, günü henüz kilitlenmemiş VE haftalık
 * bütçesi kalan EN AZ bir aday öğretmen var mı?" Varsa hücre "+1" katkı
 * yapar (kapasite PAYLAŞIMI hesaba KATILMAZ — bilerek iyimser, bu yüzden
 * asla gerçek ulaşılabilir değerin ALTINA düşmez, yalnız üstünde kalabilir,
 * ki bu tam olarak bir üst sınırın gerektirdiği şeydir). Bu sınır HER ZAMAN
 * ≥ gerçek ulaşılabilir kapsamadır (kanıt: gerçek herhangi bir atama, her
 * kapsanan hücre için tam olarak bu koşulu — o hücreye o an kilitlenmemiş
 * ve bütçesi olan bir öğretmenin atanmış olmasını — GEREKTİRİR; sınır bunun
 * GEVŞETİLMİŞ/bağımsız halidir, dolayısıyla asla küçük olamaz).
 *
 * cellOnlyBaselineCoverage ARTIK yalnız REFERANS/karşılaştırma alanıdır —
 * hiçbir budama kararında KULLANILMAZ.
 *
 * Determinizm: arama YALNIZ deterministik düğüm bütçesiyle (maxSearchNodes)
 * sınırlanır — duvar-saati tabanlı bir sınır KASITLI olarak YOKTUR (makine
 * hızına göre değişen bir sonuç, aynı girdi+seed için FARKLI çıktı üretip
 * determinizmi bozardı).
 *
 * Öncelik sırası (lexicographic, spec'teki 1-9 ile birebir):
 *   1) Zorunlu kural ihlali yok (candidateEdges/duty_location_blocks zaten
 *      yalnız GEÇERLİ hücreleri üretir).
 *   2-3) Kapsanan hücre sayısı MAKSİMUM — branch-and-bound'un ARADIĞI
 *        birincil hedef; arama tükenirse (optimalityProven=true) KANITLANMIŞ
 *        maksimumdur, düğüm bütçesine çarpıp erken durursa
 *        (searchLimitReached=true) bulunan en iyi sonuç raporlanır ama
 *        KANITLANMIŞ optimum OLARAK sunulmaz.
 *   4) Aynı kapsamada FULL_DAY paket sayısı MAKSİMUM.
 *   5) Aynı kapsamada TOPLAM paket (öğretmen-gün) sayısı MİNİMUM.
 *   6-7) Ders yükü + haftalık denge — solver.ts'teki AYNI
 *        `marginalCostForLoad` fonksiyonu ile.
 *   8) Alan çeşitliliği — kalan SINGLE_BLOCK hücrelerde mevcut
 *      `applyDiversification` (solveDutyPlan içinde) aynen çalışır.
 *   9) Seed tabanlı deterministik tie-break.
 */

import {
  solveDutyPlan,
  normalizeGenerationOptions,
  DutyPlanSolverOptionsError,
  marginalCostForLoad,
  tieBreak,
  taskKey,
  type CandidateEdge,
  type GenerationOptions,
  type SolverAssignment,
  type SolverResult,
  type SolverTeacherLoad,
  type SolverWarning,
  type TeacherFixedLoad,
  type TeacherRef,
} from "./solver";
import { buildPackageCandidates, type DutyPlanLocationRef, type PackageDutyTask, type PackageCoverageMode } from "./packageCandidates";

export interface PackageSolverInput {
  /** Yalnız NORMAL (fixed olmayan) görevler — solveDutyPlan ile AYNI evren, yalnız blockCode eklenmiş. */
  tasks: PackageDutyTask[];
  candidateEdges: CandidateEdge[];
  teacherFixedLoads: TeacherFixedLoad[];
  teachers?: TeacherRef[];
  locations: DutyPlanLocationRef[];
  /** teacherSourceId|dayOrder → o günkü ders sayısı (öncelik 6, opsiyonel — verilmezse 0 kabul edilir). */
  lessonPeriodCountByTeacherDay?: Map<string, number>;
  excludedTeacherDays?: { teacherSourceId: string; dayOrder: number }[];
  options?: Partial<GenerationOptions>;
  /**
   * Arama düğüm bütçesi (opsiyonel, test/performans ayarı içindir).
   * Varsayılan yeterince büyük (gerçek okul ölçeğinde tükenmeden biter);
   * tükenirse arama en iyi bulduğu (GÜVENLİ, ama kanıtlanmamış-optimum)
   * sonucu döner ve `searchLimitReached=true` işaretler.
   */
  maxSearchNodes?: number;
}

export type PackageAssignmentCoverageMode = PackageCoverageMode | "SINGLE_BLOCK";

export interface PackageAssignment {
  dayOrder: number;
  dutyLocationId: string;
  coverageMode: PackageAssignmentCoverageMode;
  teacherSourceId: string;
  cellTaskKeys: string[];
}

export interface PackageSolverResult {
  /** Kapsanan HER hücre TAM OLARAK bir pakette görünür (SINGLE_BLOCK dahil). */
  packages: PackageAssignment[];
  /** Geriye dönük uyumlu düz liste — save_duty_plan_draft'a giden p_assignments ile AYNI şekil. */
  assignments: SolverAssignment[];
  totalTaskCount: number;
  coveredCount: number;
  uncoveredCount: number;
  fullDayPackageCount: number;
  shortBreaksPackageCount: number;
  singleBlockCellCount: number;
  /** teacherSourceId'ye göre artan sırayla; normalDutyCount artık PAKET-GÜN sayısıdır (satır değil). */
  teacherLoads: SolverTeacherLoad[];
  warnings: SolverWarning[];
  optionsUsed: GenerationOptions;
  /** true ⇔ arama TÜKENDİ (tüm seç/atla dalları budandı/gezildi) — coveredCount KANITLANMIŞ maksimumdur. */
  optimalityProven: boolean;
  /** true ⇔ arama düğüm bütçesine çarpıp ERKEN durdu — sonuç GÜVENLİDİR (asla cellOnlyBaselineCoverage'ın altında değil) ama kapsama/paket kompozisyonu KANITLANMIŞ optimum DEĞİLDİR. */
  searchLimitReached: boolean;
  /** Yalnız REFERANS/karşılaştırma: eski hücre-bazlı (paket kısıtı olmayan) modelin kapsaması. ARTIK üst sınır olarak kullanılmaz (bkz. dosya başı not) — paket-farkında sonuç bunu AŞABİLİR VEYA ALTINDA KALABİLİR (iki modelin ulaşabilir kümeleri arasında kapsama ilişkisi yoktur; solver sonucu YİNE DE bu değerin altına asla düşmez, çünkü "hiç paket seçme" dalı her zaman gezilebilir bir alt sınırdır). */
  cellOnlyBaselineCoverage: number;
  /** Aramanın gezdiği toplam düğüm sayısı — teşhis/gözlemlenebilirlik içindir. */
  exploredNodeCount: number;
}

function teacherDayKey(teacherSourceId: string, dayOrder: number): string {
  return `${teacherSourceId}|${dayOrder}`;
}

interface BestSolution {
  total: number;
  fullDayCount: number;
  packageCount: number;
  lessonLoadSum: number;
  balanceCost: number;
  tieHash: number;
  packages: PackageAssignment[];
  remainder: SolverResult;
}

const DEFAULT_MAX_SEARCH_NODES = 20000;

export function solveDutyPlanWithPackages(input: PackageSolverInput): PackageSolverResult {
  const options = normalizeGenerationOptions(input.options);
  const seed = options.seed ?? 0;
  if (input.maxSearchNodes !== undefined && (!Number.isInteger(input.maxSearchNodes) || input.maxSearchNodes < 1)) {
    throw new DutyPlanSolverOptionsError("maxSearchNodes 1 veya daha büyük bir tam sayı olmalıdır.");
  }
  const maxNodes = input.maxSearchNodes ?? DEFAULT_MAX_SEARCH_NODES;

  const baseTasks = input.tasks.map((t) => ({ dayOrder: t.dayOrder, dutyLocationId: t.dutyLocationId, dutyBlockId: t.dutyBlockId, category: t.category }));

  const fixedDaysByTeacher = new Map<string, number>();
  for (const f of input.teacherFixedLoads) fixedDaysByTeacher.set(f.teacherSourceId, f.fixedDutyDayCount);

  const externalExcluded = input.excludedTeacherDays ?? [];
  const externalLockedTeacherDays = new Set(externalExcluded.map((e) => teacherDayKey(e.teacherSourceId, e.dayOrder)));
  const externalLockedCountByTeacher = new Map<string, number>();
  for (const e of externalExcluded) externalLockedCountByTeacher.set(e.teacherSourceId, (externalLockedCountByTeacher.get(e.teacherSourceId) ?? 0) + 1);

  function baseRemainingBudget(teacherSourceId: string): number {
    const fixedDays = fixedDaysByTeacher.get(teacherSourceId) ?? 0;
    const externalLocked = externalLockedCountByTeacher.get(teacherSourceId) ?? 0;
    return Math.max(0, options.maxWeeklyDuties - fixedDays - externalLocked);
  }

  // Yalnız REFERANS: eski hücre-bazlı model, paket-farkında sonuçla
  // KARŞILAŞTIRMA için (bulgu 6 — asla bunun altına düşülmez). ÜST SINIR
  // OLARAK KULLANILMAZ.
  const cellOnlyBaseline = solveDutyPlan({
    tasks: baseTasks,
    candidateEdges: input.candidateEdges,
    teacherFixedLoads: input.teacherFixedLoads,
    teachers: input.teachers,
    excludedTeacherDays: input.excludedTeacherDays,
    options: input.options,
  });

  const candidates = buildPackageCandidates(input.locations, input.tasks, input.candidateEdges);

  // Görev → aday öğretmen kümesi (üst sınır hesabı için, TEK sefer kurulur).
  const teachersByTaskKey = new Map<string, Set<string>>();
  for (const e of input.candidateEdges) {
    const k = taskKey(e);
    const set = teachersByTaskKey.get(k);
    if (set) set.add(e.teacherSourceId);
    else teachersByTaskKey.set(k, new Set([e.teacherSourceId]));
  }

  // ---- Arama durumu (DFS + backtracking, mutasyonla) ----
  const coveredCellKeys = new Set<string>();
  const lockedTeacherDays = new Set<string>(externalLockedTeacherDays);
  const usedBudget = new Map<string, number>(); // teacherSourceId -> arama SIRASINDA kullanılan paket sayısı
  const acceptedPackages: PackageAssignment[] = [];

  let best: BestSolution | null = null;
  let nodeCount = 0;
  let limitReached = false;

  function remainingTasksList() {
    return baseTasks.filter((t) => !coveredCellKeys.has(taskKey(t)));
  }

  function currentExcludedTeacherDays(): { teacherSourceId: string; dayOrder: number }[] {
    const result = [...externalExcluded];
    for (const key of lockedTeacherDays) {
      if (externalLockedTeacherDays.has(key)) continue;
      const sep = key.lastIndexOf("|");
      result.push({ teacherSourceId: key.slice(0, sep), dayOrder: Number(key.slice(sep + 1)) });
    }
    return result;
  }

  function solveRemainderCellLevel(): SolverResult {
    return solveDutyPlan({
      tasks: remainingTasksList(),
      candidateEdges: input.candidateEdges,
      teacherFixedLoads: input.teacherFixedLoads,
      teachers: input.teachers,
      excludedTeacherDays: currentExcludedTeacherDays(),
      options: input.options,
    });
  }

  /**
   * ADMISSIBLE üst sınır — bkz. dosya başı not. Her kalan (henüz kapsanmamış)
   * görev BAĞIMSIZ değerlendirilir: en az bir aday öğretmeni varsa VE o
   * öğretmenin (öğretmen,gün) çifti henüz kilitlenmemişse VE öğretmenin
   * kalan haftalık bütçesi > 0 ise, hücre "kapsanabilir" sayılır (+1).
   * Öğretmenler arasında/görevler arasında kapasite PAYLAŞIMI hesaba
   * KATILMAZ — bu bilinçli bir gevşetmedir (iyimser üst sınır), gerçek
   * ulaşılabilir kapsamanın ASLA altına düşmez.
   */
  function computeUpperBound(): number {
    let bound = coveredCellKeys.size;
    for (const t of baseTasks) {
      const key = taskKey(t);
      if (coveredCellKeys.has(key)) continue;
      const candidateTeachers = teachersByTaskKey.get(key);
      if (!candidateTeachers) continue;
      for (const teacherId of candidateTeachers) {
        if (lockedTeacherDays.has(teacherDayKey(teacherId, t.dayOrder))) continue;
        const used = usedBudget.get(teacherId) ?? 0;
        if (used < baseRemainingBudget(teacherId)) {
          bound++;
          break;
        }
      }
    }
    return bound;
  }

  function scoreCandidateTeacher(teacherSourceId: string, dayOrder: number, packageKind: PackageCoverageMode): number {
    const currentPackages = usedBudget.get(teacherSourceId) ?? 0;
    const fixedDays = fixedDaysByTeacher.get(teacherSourceId) ?? 0;
    const externalLocked = externalLockedCountByTeacher.get(teacherSourceId) ?? 0;
    const loadAfter = fixedDays + externalLocked + currentPackages + 1;
    const lessonCount = input.lessonPeriodCountByTeacherDay?.get(teacherDayKey(teacherSourceId, dayOrder)) ?? 0;
    const loadCost = marginalCostForLoad(loadAfter, options.minWeeklyDuties, options.targetWeeklyDuties, options.balanceWorkload);
    const tie = tieBreak(seed, "pkg", packageKind, teacherSourceId, String(dayOrder));
    return lessonCount * 1_000_000 + loadCost * 1000 + tie;
  }

  function finalTeacherLoadsFor(packages: PackageAssignment[], remainder: SolverResult): Map<string, number> {
    const map = new Map<string, number>();
    for (const p of packages) map.set(p.teacherSourceId, (map.get(p.teacherSourceId) ?? 0) + 1);
    for (const a of remainder.assignments) {
      if (a.kind === "generated" && a.teacherSourceId) map.set(a.teacherSourceId, (map.get(a.teacherSourceId) ?? 0) + 1);
    }
    return map;
  }

  function balanceCostFor(packages: PackageAssignment[], remainder: SolverResult): number {
    const loads = finalTeacherLoadsFor(packages, remainder);
    let sum = 0;
    for (const [teacherSourceId, normalCount] of loads) {
      const fixedDays = fixedDaysByTeacher.get(teacherSourceId) ?? 0;
      sum += marginalCostForLoad(fixedDays + normalCount, options.minWeeklyDuties, options.targetWeeklyDuties, options.balanceWorkload);
    }
    return sum;
  }

  function lessonLoadSumFor(packages: PackageAssignment[], remainder: SolverResult): number {
    let sum = 0;
    for (const p of packages) sum += input.lessonPeriodCountByTeacherDay?.get(teacherDayKey(p.teacherSourceId, p.dayOrder)) ?? 0;
    for (const a of remainder.assignments) {
      if (a.kind === "generated" && a.teacherSourceId) sum += input.lessonPeriodCountByTeacherDay?.get(teacherDayKey(a.teacherSourceId, a.dayOrder)) ?? 0;
    }
    return sum;
  }

  function solutionTieHash(packages: PackageAssignment[], remainder: SolverResult): number {
    const parts = packages
      .map((p) => `${p.dayOrder}:${p.dutyLocationId}:${p.teacherSourceId}:${p.coverageMode}`)
      .sort();
    for (const a of remainder.assignments) {
      if (a.kind === "generated" && a.teacherSourceId) parts.push(`${a.dayOrder}:${a.dutyLocationId}:${a.dutyBlockId}:${a.teacherSourceId}:SINGLE`);
    }
    parts.sort();
    return tieBreak(seed, "solution", ...parts);
  }

  function isBetter(candidate: BestSolution, current: BestSolution | null): boolean {
    if (current === null) return true;
    if (candidate.total !== current.total) return candidate.total > current.total;
    if (candidate.fullDayCount !== current.fullDayCount) return candidate.fullDayCount > current.fullDayCount;
    if (candidate.packageCount !== current.packageCount) return candidate.packageCount < current.packageCount;
    if (candidate.lessonLoadSum !== current.lessonLoadSum) return candidate.lessonLoadSum < current.lessonLoadSum;
    if (candidate.balanceCost !== current.balanceCost) return candidate.balanceCost < current.balanceCost;
    return candidate.tieHash < current.tieHash;
  }

  function recordTerminal(): void {
    const remainder = solveRemainderCellLevel();
    const total = coveredCellKeys.size + remainder.coveredCount;
    const packagesSnapshot = acceptedPackages.map((p) => ({ ...p, cellTaskKeys: [...p.cellTaskKeys] }));
    const candidateSolution: BestSolution = {
      total,
      fullDayCount: packagesSnapshot.filter((p) => p.coverageMode === "FULL_DAY").length,
      packageCount: packagesSnapshot.length + remainder.assignments.filter((a) => a.kind === "generated").length,
      lessonLoadSum: lessonLoadSumFor(packagesSnapshot, remainder),
      balanceCost: balanceCostFor(packagesSnapshot, remainder),
      tieHash: solutionTieHash(packagesSnapshot, remainder),
      packages: packagesSnapshot,
      remainder,
    };
    if (isBetter(candidateSolution, best)) best = candidateSolution;
  }

  /**
   * Bütçe kontrolü SAYMADAN ÖNCE yapılır — bu yüzden `exploredNodeCount`
   * (döngü sonunda `nodeCount`) HİÇBİR ZAMAN `maxSearchNodes`'u AŞMAZ
   * (exploredNodeCount <= maxSearchNodes, off-by-one'sız açık davranış).
   * Bütçe tam burada tükenirse bu çağrı bir düğüm olarak SAYILMAZ — yalnız
   * o ana kadarki (bir ÖNCEKİ düğümün) durumunu terminal gibi kaydedip
   * geri döner.
   */
  function budgetExceeded(): boolean {
    return nodeCount >= maxNodes;
  }

  /**
   * Her düğümde üst sınır TAZE hesaplanır (computeUpperBound — admissible,
   * bkz. dosya başı not). Bir dal bu değeri (best.total'a göre)
   * İYİLEŞTİREMEYECEKSE ("<") BUDANIR — eşitlikte YİNE de gezilir (daha iyi
   * bir tie-break/kompozisyon bulunabilir), bu yüzden budama kesinlikle
   * YALNIZ "kesin daha kötü" durumda uygulanır (asla optimum bir dalı
   * KAÇIRMAZ). "Hiç paket seçme" (tüm adaylarda ATLA) dalı, hiçbir zaman
   * durum değiştirmediği için üst sınırı asla düşmez — bu yüzden HER ZAMAN
   * (best ne kadar iyi olursa olsun en azından eşitlik koşuluyla) gezilebilir
   * kalır, KAÇIRILMAZ. `best` DFS başlamadan ÖNCE cellOnlyBaseline ile
   * TOHUMLANIR (bkz. arama başlangıcı) — bu yüzden bütçe HER NE ZAMAN
   * tükenirse tükensin, `recordTerminal()`'ın `isBetter` kontrolü sayesinde
   * dönüş DEĞERİ asla bu başlangıç tabanının ALTINA düşemez.
   */
  function search(index: number): void {
    if (limitReached) return;
    if (budgetExceeded()) {
      limitReached = true;
      // Bütçe tükendiğinde bulunduğumuz noktayı da bir terminal gibi
      // değerlendir — en azından BU dalın kısmi sonucu kaybolmasın
      // (isBetter kontrolü zaten başlangıç tabanının altına düşmeyi engeller).
      recordTerminal();
      return;
    }
    nodeCount++;
    if (best !== null && computeUpperBound() < best.total) return; // kesin budama

    if (index >= candidates.length) {
      recordTerminal();
      return;
    }

    const candidate = candidates[index];
    const cellKeys = candidate.cells.map(taskKey);

    if (cellKeys.some((k) => coveredCellKeys.has(k))) {
      search(index + 1);
      return;
    }

    const eligible = candidate.teacherSourceIds.filter((t) => {
      if (lockedTeacherDays.has(teacherDayKey(t, candidate.dayOrder))) return false;
      const used = usedBudget.get(t) ?? 0;
      return used < baseRemainingBudget(t);
    });

    const ranked = eligible
      .map((t) => ({ t, score: scoreCandidateTeacher(t, candidate.dayOrder, candidate.coverageMode) }))
      .sort((a, b) => a.score - b.score || a.t.localeCompare(b.t));

    // SEÇ dalları — en umut verici (en iyi skorlu) önce, iyi bir incumbent'ı
    // erken bulup SONRAKİ dalların daha etkili budanmasını sağlamak için.
    for (const { t } of ranked) {
      if (limitReached) return;
      for (const k of cellKeys) coveredCellKeys.add(k);
      lockedTeacherDays.add(teacherDayKey(t, candidate.dayOrder));
      usedBudget.set(t, (usedBudget.get(t) ?? 0) + 1);
      acceptedPackages.push({ dayOrder: candidate.dayOrder, dutyLocationId: candidate.dutyLocationId, coverageMode: candidate.coverageMode, teacherSourceId: t, cellTaskKeys: cellKeys });

      if (best === null || computeUpperBound() >= best.total) {
        search(index + 1);
      }

      acceptedPackages.pop();
      usedBudget.set(t, (usedBudget.get(t) ?? 0) - 1);
      lockedTeacherDays.delete(teacherDayKey(t, candidate.dayOrder));
      for (const k of cellKeys) coveredCellKeys.delete(k);
    }

    // ATLA dalı — durum değişmedi (üst sınır bu düğümdekiyle AYNI kalır,
    // budama kontrolü bir SONRAKİ search() çağrısının başında zaten yapılır).
    search(index + 1);
  }

  // KRİTİK: DFS başlamadan ÖNCE cellOnlyBaseline'ı GERÇEK bir başlangıç
  // incumbent'ı olarak `best`'e koy (packages=[], remainder=cellOnlyBaseline).
  // BULGU: `best` başlangıçta null bırakılırsa VE arama bir SEÇ dalının
  // İÇİNDEYKEN bütçesi tükenirse, "hiç paket seçme" (skip-all) dalına HİÇ
  // ulaşılamayabilir — bu durumda tükenen aramanın kaydettiği (baseline'dan
  // KÖTÜ olabilecek) kısmi sonuç YANLIŞLIKLA nihai cevap olurdu. Best'i
  // baseline ile tohumlamak, `recordTerminal()`'ın HER ZAMAN çalıştırdığı
  // `isBetter` kontrolü sayesinde, döndürülen sonucun asla bu tabanın
  // ALTINA düşememesini KOŞULSUZ garanti eder (skip-all düğümü hiç
  // gezilmese BİLE).
  best = {
    total: cellOnlyBaseline.coveredCount,
    fullDayCount: 0,
    packageCount: cellOnlyBaseline.assignments.filter((a) => a.kind === "generated").length,
    lessonLoadSum: lessonLoadSumFor([], cellOnlyBaseline),
    balanceCost: balanceCostFor([], cellOnlyBaseline),
    tieHash: solutionTieHash([], cellOnlyBaseline),
    packages: [],
    remainder: cellOnlyBaseline,
  };

  search(0);

  if (best === null) {
    // Hiç aday paket yoktu (ör. hiçbir FULL_DAY/SHORT_BREAKS mümkün değil) —
    // saf hücre-bazlı çözüm zaten TEK terminal'di, ama yine de garanti için
    // burada da hesapla.
    recordTerminal();
  }
  if (best === null) {
    throw new Error("solveDutyPlanWithPackages: recordTerminal() sonrası best hâlâ null — beklenmeyen durum.");
  }

  const solved: BestSolution = best;
  const packages = solved.packages;
  const remainder = solved.remainder;

  const singleBlockPackages: PackageAssignment[] = remainder.assignments
    .filter((a) => a.kind === "generated" && a.teacherSourceId)
    .map((a) => ({
      dayOrder: a.dayOrder,
      dutyLocationId: a.dutyLocationId,
      coverageMode: "SINGLE_BLOCK" as const,
      teacherSourceId: a.teacherSourceId as string,
      cellTaskKeys: [taskKey(a)],
    }));

  const allPackages = [...packages, ...singleBlockPackages];

  const assignments: SolverAssignment[] = baseTasks.map((task) => {
    const key = taskKey(task);
    const pkg = allPackages.find((p) => p.cellTaskKeys.includes(key));
    if (pkg) return { ...task, teacherSourceId: pkg.teacherSourceId, kind: "generated" as const };
    return { ...task, teacherSourceId: null, kind: "unassigned" as const };
  });

  const coveredCount = assignments.filter((a) => a.kind === "generated").length;

  // Kanonik yük formülü: normalDutyCount = teacher_source_id başına PAKET
  // sayısı (satır/hücre sayısı DEĞİL).
  const packageCountFinal = new Map<string, number>();
  for (const p of allPackages) packageCountFinal.set(p.teacherSourceId, (packageCountFinal.get(p.teacherSourceId) ?? 0) + 1);

  const allTeacherIds = new Set<string>();
  for (const t of input.teachers ?? []) allTeacherIds.add(t.teacherSourceId);
  for (const f of input.teacherFixedLoads) allTeacherIds.add(f.teacherSourceId);
  for (const p of allPackages) allTeacherIds.add(p.teacherSourceId);

  const teacherLoads: SolverTeacherLoad[] = Array.from(allTeacherIds)
    .sort((a, b) => a.localeCompare(b))
    .map((teacherSourceId) => {
      const normalDutyCount = packageCountFinal.get(teacherSourceId) ?? 0;
      const fixedDutyDayCount = fixedDaysByTeacher.get(teacherSourceId) ?? 0;
      return { teacherSourceId, normalDutyCount, fixedDutyDayCount, totalDutyCount: normalDutyCount + fixedDutyDayCount };
    });

  // Bulgu 6 (asla eski hücre-bazlı modelin altına düşme): matematiksel garanti
  // — "hiç paket seçme" (tüm adaylarda ATLA) yolu HER ZAMAN cellOnlyBaseline'ı
  // üretebilir; bu yol üzerindeki üst sınır (computeUpperBound), ADMISSIBLE
  // olduğu için, o yoldan ulaşılabilir cellOnlyBaseline değerinin ASLA
  // altına düşmez — dolayısıyla bu yol yalnız ZATEN cellOnlyBaseline'a EŞİT
  // veya ONDAN DAHA İYİ bir `best` bulunduğunda budanabilir. Sonuç: nihai
  // `best.total` HER DURUMDA >= cellOnlyBaseline.coveredCount'tur.

  return {
    packages: allPackages,
    assignments,
    totalTaskCount: baseTasks.length,
    coveredCount,
    uncoveredCount: baseTasks.length - coveredCount,
    fullDayPackageCount: packages.filter((p) => p.coverageMode === "FULL_DAY").length,
    shortBreaksPackageCount: packages.filter((p) => p.coverageMode === "SHORT_BREAKS").length,
    singleBlockCellCount: singleBlockPackages.length,
    teacherLoads,
    warnings: remainder.warnings,
    optionsUsed: options,
    optimalityProven: !limitReached,
    searchLimitReached: limitReached,
    cellOnlyBaselineCoverage: cellOnlyBaseline.coveredCount,
    exploredNodeCount: nodeCount,
  };
}
