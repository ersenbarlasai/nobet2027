/**
 * Nöbet2027 — otomatik nöbet planı üretim algoritması.
 *
 * Saf TypeScript, harici solver paketi YOK. Girdi (görevler, aday kenarlar,
 * mevcut sabit nöbet yükleri) veritabanından `get_duty_plan_generation_
 * snapshot` RPC'siyle gelir (bkz. supabase/migrations/
 * 20260915090000_create_automatic_duty_plan_drafts.sql) — bu modül hiçbir
 * iş kuralını (zaman uygunluğu, aday geçerliliği, sabit görev kilidi)
 * YENİDEN uygulamaz; yalnız GİRDİDEKİ aday kenarlarını kullanarak normal
 * görevleri öğretmenlere dağıtan bir min-cost max-flow algoritmasıdır.
 *
 * Ağ modeli:
 *   SOURCE → (basamaklı, maxWeeklyDuties adet birim kapasiteli kenar) →
 *   TEACHER → (o gün en az bir aday kenarı varsa, kapasite 1) → TEACHER_DAY →
 *   (yalnız snapshot'taki geçerli aday kenarları, kapasite 1) → TASK →
 *   (kapasite 1) → SINK.
 *
 * Önceliklendirme (lexicographic), tek bir successive-shortest-augmenting-
 * path min-cost-flow koşusuyla elde edilir:
 *   1) Kapsanan görev sayısını maksimum yap — ağın gerçek maksimum akışı
 *      (maliyetten bağımsız, yalnız kapasitelerle belirlenir) bunu garanti
 *      eder; algoritma akışı DAİMA mümkün olan en büyük değere kadar
 *      genişletir (artık genişletme yolu kalmayana dek).
 *   2) Haftalık üst sınırı aşma — SOURCE→TEACHER kenarlarının TOPLAM
 *      kapasitesi zaten `maxWeeklyDuties - sabitGünSayısı` ile sınırlıdır;
 *      bu bir sert kısıttır, maliyetle değil kapasiteyle uygulanır.
 *   3-4) Hedefe yakınlaşma + (balanceWorkload açıksa) varyans azaltma —
 *      basamaklı kenarların birim maliyeti dışbükey (convex) bir fonksiyon
 *      olarak kurulur: j'inci birimin maliyeti, o birimin yükü hedefe
 *      YAKINLAŞTIRIRKEN düşük, UZAKLAŞTIRIRKEN yüksektir. Min-cost-flow
 *      TÜM akış değerini SABİT TUTARAK (adım 1'den) toplam maliyeti
 *      minimize ettiği için, bu otomatik olarak yükü hedefe doğru VE
 *      öğretmenler arasında dengeli dağıtır.
 *   5) diversifyAreas — akış tamamlandıktan SONRA, kapsanan görev sayısını
 *      ASLA azaltmayan (yalnız aynı gün içinde iki öğretmenin görevini
 *      birbirleriyle değiştiren, ikisi için de geçerli aday kenarı olan)
 *      deterministik yerel iyileştirme (swap) geçişleriyle kategori
 *      çeşitliliği artırılır.
 *   6) Son eşitlikler — seed + kararlı (id bazlı) sıralama ile üretilen
 *      küçük, gerçek maliyet farklarını ASLA domine etmeyen bir tie-break
 *      terimiyle çözülür; aynı snapshot+options+seed HER ZAMAN aynı
 *      sonucu üretir.
 */

import { MinCostFlow } from "./minCostFlow";

export interface DutyTask {
  dayOrder: number;
  dutyLocationId: string;
  dutyBlockId: string;
  /** diversifyAreas için; verilmezse çeşitlilik iyileştirmesi atlanır. */
  category?: string | null;
}

export interface CandidateEdge {
  dayOrder: number;
  dutyLocationId: string;
  dutyBlockId: string;
  teacherSourceId: string;
}

export interface TeacherFixedLoad {
  teacherSourceId: string;
  /** İş kuralı 7: sabah+öğleden sonra çifti birlikte BİR gün sayılır. */
  fixedDutyDayCount: number;
}

/** Plana dahil (is_included=true) bilinen bir öğretmen — hiç aday kenarı olmasa bile. */
export interface TeacherRef {
  teacherSourceId: string;
  teacherName?: string;
}

export interface GenerationOptions {
  minWeeklyDuties: number;
  targetWeeklyDuties: number;
  maxWeeklyDuties: number;
  balanceWorkload: boolean;
  diversifyAreas: boolean;
  allowPartial: boolean;
  seed?: number;
}

export const DEFAULT_GENERATION_OPTIONS: GenerationOptions = {
  minWeeklyDuties: 1,
  targetWeeklyDuties: 2,
  maxWeeklyDuties: 3,
  balanceWorkload: true,
  diversifyAreas: true,
  allowPartial: true,
};

export class DutyPlanSolverOptionsError extends Error {}

export function normalizeGenerationOptions(options: Partial<GenerationOptions> | undefined): GenerationOptions {
  const merged: GenerationOptions = { ...DEFAULT_GENERATION_OPTIONS, ...(options ?? {}) };
  for (const key of ["minWeeklyDuties", "targetWeeklyDuties", "maxWeeklyDuties"] as const) {
    const value = merged[key];
    if (!Number.isInteger(value) || value < 0 || value > 5) {
      throw new DutyPlanSolverOptionsError(`${key} 0 ile 5 arasında bir tam sayı olmalıdır.`);
    }
  }
  if (!(merged.minWeeklyDuties <= merged.targetWeeklyDuties && merged.targetWeeklyDuties <= merged.maxWeeklyDuties)) {
    throw new DutyPlanSolverOptionsError("minWeeklyDuties <= targetWeeklyDuties <= maxWeeklyDuties olmalıdır.");
  }
  if (merged.seed !== undefined && !Number.isInteger(merged.seed)) {
    throw new DutyPlanSolverOptionsError("seed bir tam sayı olmalıdır.");
  }
  return merged;
}

export interface SolverInput {
  /** Yalnız NORMAL (sabit-olmayan) görevler — fixed görevler çağıran tarafça ayrıca işlenir. */
  tasks: DutyTask[];
  candidateEdges: CandidateEdge[];
  teacherFixedLoads: TeacherFixedLoad[];
  /**
   * Plana dahil TÜM öğretmenler — yalnız candidateEdges'ten TÜRETİLMEZ.
   * Hiç aday kenarı olmayan ya da yalnız sabit nöbeti bulunan bir öğretmen,
   * verilmişse, teacherLoads'ta 0 ile (ve ilgili uyarıyla) yine de görünür.
   * Verilmezse (geriye dönük uyumluluk) öğretmen evreni candidateEdges +
   * teacherFixedLoads birleşiminden türetilir.
   */
  teachers?: TeacherRef[];
  /**
   * Yeniden üretmede KİLİTLİ tutulan (bu koşuda çözülmeyecek) manuel
   * atamalar — teacher+day çifti solver'ın TEACHER_DAY düğümünden
   * TAMAMEN çıkarılır (o gün başka bir normal görev bu öğretmene
   * atanmaz). Kilitli atamaların kendisi bu modülün `tasks` girdisinde
   * YER ALMAZ — çağıran taraf onları çözülmüş sonuca ayrıca ekler; bu
   * yüzden solver'ın döndürdüğü teacherLoads.normalDutyCount kilitli
   * sayıyı İÇERMEZ (çağıran taraf bunu birleştirirken ekler).
   */
  excludedTeacherDays?: { teacherSourceId: string; dayOrder: number }[];
  /**
   * `${teacherSourceId}|${dayOrder}` -> o günün ders saati sayısı.
   * Verildiğinde, haftalık min/hedef dengesi bozulmadan daha az dersli gün
   * tercih edilir. Verilmezse bütün günler 0 kabul edilir.
   */
  lessonPeriodCountByTeacherDay?: Map<string, number>;
  /**
   * Aynı sayıda birim görev atanabildiğinde daha fazla gerçek hücre kapatan
   * atomik paketleri önceler. Değer en az 1 olmalıdır; yoksa 1 kabul edilir.
   */
  taskCoverageWeightByKey?: Map<string, number>;
  /**
   * Hedef haftadan ÖNCE yayımlanmış planlardan gelen değişmez puan toplamı.
   * Maksimum kapsama değişmez; eşit kapsamalı çözümlerde düşük geçmiş puanlı
   * öğretmen kesin olarak önce gelir.
   */
  historicalDutyPointsByTeacher?: Map<string, number>;
  options?: Partial<GenerationOptions>;
}

export type SolverAssignmentKind = "generated" | "unassigned";

export interface SolverAssignment {
  dayOrder: number;
  dutyLocationId: string;
  dutyBlockId: string;
  teacherSourceId: string | null;
  kind: SolverAssignmentKind;
}

export interface SolverWarning {
  code: "fixed_load_at_or_above_max" | "no_candidate" | "teacher_no_candidate_cells" | "teacher_below_min";
  message: string;
  teacherSourceId?: string;
  dayOrder?: number;
  dutyLocationId?: string;
  dutyBlockId?: string;
}

/** Bulgu 5: tek belirsiz sayı yerine yapılandırılmış yük — normal+sabit AYRI, toplam AÇIK. */
export interface SolverTeacherLoad {
  teacherSourceId: string;
  normalDutyCount: number;
  fixedDutyDayCount: number;
  totalDutyCount: number;
}

export interface SolverResult {
  assignments: SolverAssignment[];
  totalTaskCount: number;
  coveredCount: number;
  uncoveredCount: number;
  /** teacherSourceId'ye göre artan sırayla — DB'nin yetkili yeniden hesaplamasıyla aynı sırayı üretir. */
  teacherLoads: SolverTeacherLoad[];
  warnings: SolverWarning[];
  optionsUsed: GenerationOptions;
}

export function taskKey(t: { dayOrder: number; dutyLocationId: string; dutyBlockId: string }): string {
  return `${t.dayOrder}|${t.dutyLocationId}|${t.dutyBlockId}`;
}

/** FNV-1a — deterministik, dış bağımlılık yok, aynı girdi HER ZAMAN aynı sayı. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function tieBreak(seed: number, ...parts: string[]): number {
  return fnv1a(`${seed}::${parts.join("::")}`) % 97;
}

/**
 * Bulgu 4 — minWeeklyDuties GERÇEKTEN İŞLEVSEL: üç bölgeli, tamsayı, HER
 * ZAMAN monoton artan (dışbükey) bir merdiven. `load` = fixedDays+j (bkz.
 * çağıran yer) — başlangıç yüküne sabit nöbet günleri zaten dahildir.
 *
 *   load <= min        : ACİL çekim — min'e yaklaştıkça (load artışıyla)
 *                         ucuzlaşan (artan) büyük NEGATİF değerler.
 *   min < load <= target: ILIMLI çekim — target'a doğru artan küçük pozitif.
 *   load > target       : CAYDIRMA — target'ı aşmayı ek olarak pahalılaştırır.
 *
 * Üç bölgenin sınırlarındaki değerler HER ZAMAN bir öncekinden büyüktür
 * (bkz. testler) — bu, "j'inci birimin marjinal maliyeti" tekniğinin
 * geçerliliği için ZORUNLUDUR (aksi halde parallel-unit-edge indirgemesi
 * yanlış sonuç verebilir). Minimum bölgesi HER ZAMAN aktiftir (balanceWorkload
 * bayrağından BAĞIMSIZ) — minWeeklyDuties'in işlevsel olması koşulsuzdur;
 * balanceWorkload yalnız target/max bölgelerinin AĞIRLIĞINI (dolayısıyla
 * öğretmenler arası dengeleme gücünü) artırır.
 */
export function marginalCostForLoad(load: number, min: number, target: number, balanceWorkload: boolean): number {
  const MIN_ZONE_WEIGHT = 1000;
  const TARGET_ZONE_WEIGHT = balanceWorkload ? 40 : 4;
  const OVER_TARGET_WEIGHT = balanceWorkload ? 60 : 6;

  if (load <= min) {
    return -MIN_ZONE_WEIGHT * (min - load + 1);
  }
  if (load <= target) {
    return TARGET_ZONE_WEIGHT * (load - min);
  }
  return TARGET_ZONE_WEIGHT * (target - min) + OVER_TARGET_WEIGHT * (load - target);
}

// ============================================================================
// Min-cost max-flow — ORTAK motor (bkz. ./minCostFlow.ts). v1/v2 ve v3 AYNI
// uygulamayı kullanır; burada ikinci bir kopya tutulmaz.
// ============================================================================

export function solveDutyPlan(input: SolverInput): SolverResult {
  const options = normalizeGenerationOptions(input.options);
  const seed = options.seed ?? 0;
  const warnings: SolverWarning[] = [];

  const tasks = [...input.tasks].sort((a, b) => taskKey(a).localeCompare(taskKey(b)));
  const taskIndexByKey = new Map<string, number>();
  tasks.forEach((t, i) => taskIndexByKey.set(taskKey(t), i));

  const edgesByTask = new Map<string, CandidateEdge[]>();
  for (const edge of input.candidateEdges) {
    const key = taskKey(edge);
    if (!taskIndexByKey.has(key)) continue; // snapshot'ta olmayan görev — yok say (savunma)
    const list = edgesByTask.get(key);
    if (list) list.push(edge);
    else edgesByTask.set(key, [edge]);
  }

  const fixedLoadByTeacher = new Map<string, number>();
  for (const row of input.teacherFixedLoads) {
    fixedLoadByTeacher.set(row.teacherSourceId, row.fixedDutyDayCount);
  }
  const historicalPointsByTeacher = input.historicalDutyPointsByTeacher ?? new Map<string, number>();

  const candidateTeacherIds = new Set(input.candidateEdges.map((e) => e.teacherSourceId));
  // Öğretmen evreni yalnız candidateEdges'ten TÜRETİLMEZ (bulgu 5): explicit
  // `teachers` girdisi + teacherFixedLoads + candidateEdges birleşimi.
  const universe = new Set<string>(candidateTeacherIds);
  for (const t of input.teachers ?? []) universe.add(t.teacherSourceId);
  for (const f of input.teacherFixedLoads) universe.add(f.teacherSourceId);
  const allTeacherIds = Array.from(universe).sort((a, b) => a.localeCompare(b));

  // Ağ grafiği yalnız GERÇEK aday kenarı olan öğretmenler için kurulur —
  // adayı olmayanın çözülecek bir şeyi yoktur, ama yük özetinde 0 ile görünür.
  const teacherIds = allTeacherIds.filter((id) => candidateTeacherIds.has(id));

  for (const teacherSourceId of allTeacherIds) {
    const fixedDays = fixedLoadByTeacher.get(teacherSourceId) ?? 0;
    if (fixedDays >= options.maxWeeklyDuties) {
      warnings.push({
        code: "fixed_load_at_or_above_max",
        message: `Öğretmenin sabit nöbet gün sayısı (${fixedDays}) haftalık üst sınıra (${options.maxWeeklyDuties}) ulaşmış veya aşmış; normal görev verilmeyecek.`,
        teacherSourceId,
      });
    } else if (!candidateTeacherIds.has(teacherSourceId)) {
      warnings.push({
        code: "teacher_no_candidate_cells",
        message: "Öğretmenin hiç geçerli aday hücresi (uygunluk beyanı) yok; normal görev verilemeyecek.",
        teacherSourceId,
      });
    }
  }

  for (const task of tasks) {
    if ((edgesByTask.get(taskKey(task)) ?? []).length === 0) {
      warnings.push({
        code: "no_candidate",
        message: "Bu görev için hiç aday öğretmen yok.",
        dayOrder: task.dayOrder,
        dutyLocationId: task.dutyLocationId,
        dutyBlockId: task.dutyBlockId,
      });
    }
  }

  function buildTeacherLoads(normalCountByTeacher: Map<string, number>): SolverTeacherLoad[] {
    return allTeacherIds.map((teacherSourceId) => {
      const normalDutyCount = normalCountByTeacher.get(teacherSourceId) ?? 0;
      const fixedDutyDayCount = fixedLoadByTeacher.get(teacherSourceId) ?? 0;
      return { teacherSourceId, normalDutyCount, fixedDutyDayCount, totalDutyCount: normalDutyCount + fixedDutyDayCount };
    });
  }

  function addBelowMinWarnings(loads: SolverTeacherLoad[]): void {
    for (const load of loads) {
      if (!candidateTeacherIds.has(load.teacherSourceId)) continue; // zaten teacher_no_candidate_cells ile raporlandı
      if (load.totalDutyCount < options.minWeeklyDuties) {
        warnings.push({
          code: "teacher_below_min",
          message: `Öğretmenin toplam haftalık yükü (${load.totalDutyCount}) minimumun (${options.minWeeklyDuties}) altında kaldı.`,
          teacherSourceId: load.teacherSourceId,
        });
      }
    }
  }

  if (tasks.length === 0 || teacherIds.length === 0) {
    const teacherLoads = buildTeacherLoads(new Map());
    addBelowMinWarnings(teacherLoads);
    return {
      assignments: tasks.map((t) => ({ ...t, teacherSourceId: null, kind: "unassigned" as const })),
      totalTaskCount: tasks.length,
      coveredCount: 0,
      uncoveredCount: tasks.length,
      teacherLoads,
      warnings,
      optionsUsed: options,
    };
  }

  // === Düğüm dizini ===
  // 0 = SOURCE, 1 = SINK
  const SOURCE = 0;
  const SINK = 1;
  let nextId = 2;

  const teacherNode = new Map<string, number>();
  for (const id of teacherIds) teacherNode.set(id, nextId++);

  // TEACHER_DAY düğümleri: yalnız o öğretmenin o gün için EN AZ BİR aday
  // kenarı varsa oluşturulur (kararlı sırayla: öğretmen, sonra gün).
  const excludedDaysByTeacher = new Map<string, Set<number>>();
  for (const ex of input.excludedTeacherDays ?? []) {
    const set = excludedDaysByTeacher.get(ex.teacherSourceId) ?? new Set<number>();
    set.add(ex.dayOrder);
    excludedDaysByTeacher.set(ex.teacherSourceId, set);
  }

  const teacherDayNode = new Map<string, number>();
  const teacherDayKey = (teacherSourceId: string, dayOrder: number) => `${teacherSourceId}|${dayOrder}`;
  for (const teacherSourceId of teacherIds) {
    const excludedDays = excludedDaysByTeacher.get(teacherSourceId);
    const days = Array.from(
      new Set(input.candidateEdges.filter((e) => e.teacherSourceId === teacherSourceId).map((e) => e.dayOrder)),
    )
      .filter((d) => !excludedDays?.has(d))
      .sort((a, b) => a - b);
    for (const dayOrder of days) {
      teacherDayNode.set(teacherDayKey(teacherSourceId, dayOrder), nextId++);
    }
  }

  const taskNode = new Map<string, number>();
  for (const task of tasks) taskNode.set(taskKey(task), nextId++);

  const mcmf = new MinCostFlow(nextId);

  // Maliyet katmanları gerçek veri boyutundan türetilir. Bir alt katmanın
  // bütün toplamı, üst katmandaki tek bir puan farkını geçemez:
  // haftalık denge > az dersli gün > deterministik tie-break.
  const TIE_MAX = 97;
  const tieBound = Math.max(1, tasks.length) * TIE_MAX;
  const lessonScale = tieBound + 1;
  let maxLessonsPerDay = 0;
  for (const value of input.lessonPeriodCountByTeacherDay?.values() ?? []) {
    if (Number.isFinite(value)) maxLessonsPerDay = Math.max(maxLessonsPerDay, Math.max(0, Math.trunc(value)));
  }
  const weeklyScale = Math.max(1, tasks.length) * (maxLessonsPerDay + 1) * lessonScale + tieBound + 1;
  const maxMarginalAbs = 6000; // min/target/max 0..5 için kanıtlanmış kaba üst sınır
  const weeklyPathBound = maxMarginalAbs * weeklyScale + (maxLessonsPerDay + 1) * lessonScale + TIE_MAX;
  const historyScale = Math.max(1, tasks.length) * weeklyPathBound + 1;
  let maxHistoricalPoints = 0;
  for (const value of historicalPointsByTeacher.values()) {
    if (Number.isFinite(value)) maxHistoricalPoints = Math.max(maxHistoricalPoints, Math.max(0, Math.trunc(value)));
  }
  const maxHistoricalMarginal = 2 * (maxHistoricalPoints + options.maxWeeklyDuties + 1) - 1;
  const lowerCostBoundPerPath = maxHistoricalMarginal * historyScale + weeklyPathBound;
  const coverageScale = Math.max(1, tasks.length) * lowerCostBoundPerPath + 1;
  const optimizeWeightedCoverage = input.taskCoverageWeightByKey !== undefined;

  // SOURCE → TEACHER: basamaklı, dışbükey (monoton artan) birim maliyetli
  // kenarlar — bkz. dosya başı yorum ve marginalCostForLoad(). j'inci birimin
  // maliyeti YALNIZ o birimin sonucundaki TOPLAM yüke (sabit gün DAHİL) bağlı
  // bir GLOBAL merdiven fonksiyonudur; bu yüzden min-cost-flow, aynı toplam
  // akışı sabit tutarak, minimumun ALTINDAKİ öğretmenleri hedefe/maksimuma
  // ulaşmış öğretmenlere göre HER ZAMAN önceliklendirir (bulgu 4).
  const teacherSourceEdgeIndex = new Map<string, number[]>();
  for (const teacherSourceId of teacherIds) {
    const fixedDays = fixedLoadByTeacher.get(teacherSourceId) ?? 0;
    const lockedCount = excludedDaysByTeacher.get(teacherSourceId)?.size ?? 0;
    const cap = Math.max(0, options.maxWeeklyDuties - fixedDays - lockedCount);
    const indices: number[] = [];
    for (let j = 1; j <= cap; j++) {
      const loadAfter = fixedDays + lockedCount + j;
      const marginalCost = marginalCostForLoad(loadAfter, options.minWeeklyDuties, options.targetWeeklyDuties, options.balanceWorkload);
      const historicalPoints = Math.max(0, Math.trunc(historicalPointsByTeacher.get(teacherSourceId) ?? 0));
      // (x+1)^2-x^2 = 2x+1. Buradaki x, önceki yayımlanmış
      // haftaların puanı + bu haftada paketten önce oluşan yüktür.
      const cumulativeAfter = historicalPoints + loadAfter;
      const historicalMarginal = 2 * cumulativeAfter - 1;
      const tie = tieBreak(seed, "unit", teacherSourceId, String(j));
      const edgeStart = mcmf.nextEdgeIndex();
      mcmf.addEdge(
        SOURCE,
        teacherNode.get(teacherSourceId) as number,
        1,
        historicalMarginal * historyScale + marginalCost * weeklyScale + tie,
      );
      indices.push(edgeStart);
    }
    teacherSourceEdgeIndex.set(teacherSourceId, indices);
  }

  // TEACHER → TEACHER_DAY: kapasite 1 (günde en fazla bir normal görev).
  for (const [key, node] of teacherDayNode) {
    const [teacherSourceId] = key.split("|");
    mcmf.addEdge(teacherNode.get(teacherSourceId) as number, node, 1, 0);
  }

  // TEACHER_DAY → TASK: yalnız snapshot'taki geçerli aday kenarları.
  // Aynı kapsama ve haftalık yük dağılımında az dersli gün önce gelir.
  const taskEdgeIndex = new Map<string, { edgeIndex: number; teacherSourceId: string }[]>();
  for (const task of tasks) {
    const key = taskKey(task);
    const candidates = (edgesByTask.get(key) ?? []).slice().sort((a, b) => a.teacherSourceId.localeCompare(b.teacherSourceId));
    const list: { edgeIndex: number; teacherSourceId: string }[] = [];
    for (const edge of candidates) {
      const dayNode = teacherDayNode.get(teacherDayKey(edge.teacherSourceId, task.dayOrder));
      if (dayNode === undefined) continue;
      const tie = tieBreak(seed, "task", key, edge.teacherSourceId);
      const lessonCount = Math.max(
        0,
        Math.trunc(input.lessonPeriodCountByTeacherDay?.get(teacherDayKey(edge.teacherSourceId, task.dayOrder)) ?? 0),
      );
      const coverageWeight = Math.max(1, Math.trunc(input.taskCoverageWeightByKey?.get(key) ?? 1));
      const edgeStart = mcmf.nextEdgeIndex();
      mcmf.addEdge(
        dayNode,
        taskNode.get(key) as number,
        1,
        (optimizeWeightedCoverage ? 0 : -(coverageWeight - 1) * coverageScale) + lessonCount * lessonScale + tie,
      );
      list.push({ edgeIndex: edgeStart, teacherSourceId: edge.teacherSourceId });
    }
    taskEdgeIndex.set(key, list);
  }

  // TASK → SINK
  for (const task of tasks) {
    const key = taskKey(task);
    mcmf.addEdge(taskNode.get(key) as number, SINK, 1, 0);
    if (optimizeWeightedCoverage) {
      // Sabit toplam akış: her atomik paket ya bir öğretmenden gelir ya da
      // SOURCE→TASK ceza kenarıyla "açık" bırakılır. Ceza gerçek hücre
      // ağırlığıyla çarpılır ve bütün alt maliyetlerden baskındır; böylece
      // önce kapsanan GERÇEK hücre sayısı kesin maksimum yapılır. Sırf paket
      // adedini artırmak, iki hücreli TENEFFÜS paketini feda edemez.
      const coverageWeight = Math.max(1, Math.trunc(input.taskCoverageWeightByKey?.get(key) ?? 1));
      mcmf.addEdge(SOURCE, taskNode.get(key) as number, 1, coverageWeight * coverageScale);
    }
  }

  mcmf.run(SOURCE, SINK);

  const assignments: SolverAssignment[] = tasks.map((task) => {
    const key = taskKey(task);
    for (const { edgeIndex, teacherSourceId } of taskEdgeIndex.get(key) ?? []) {
      if (mcmf.flowOn(edgeIndex) > 0) {
        return { ...task, teacherSourceId, kind: "generated" as const };
      }
    }
    return { ...task, teacherSourceId: null, kind: "unassigned" as const };
  });

  applyDiversification(assignments, edgesByTask, options, seed);

  const normalCountByTeacher = new Map<string, number>();
  for (const a of assignments) {
    if (a.teacherSourceId) normalCountByTeacher.set(a.teacherSourceId, (normalCountByTeacher.get(a.teacherSourceId) ?? 0) + 1);
  }
  const teacherLoads = buildTeacherLoads(normalCountByTeacher);
  addBelowMinWarnings(teacherLoads);

  const coveredCount = assignments.filter((a) => a.kind === "generated").length;

  return {
    assignments,
    totalTaskCount: tasks.length,
    coveredCount,
    uncoveredCount: tasks.length - coveredCount,
    teacherLoads,
    warnings,
    optionsUsed: options,
  };
}

/**
 * Öncelik 5 — kapsama sayısını ASLA azaltmadan, aynı gün içinde iki farklı
 * öğretmenin görevlerini (ikisi de karşı tarafın göreviyle uygunsa) yer
 * değiştirerek kategori çeşitliliğini artırır. Deterministik, sınırlı sayıda
 * geçiş (round) yapar; hiçbir round iyileştirme bulamazsa durur.
 */
function applyDiversification(
  assignments: SolverAssignment[],
  edgesByTask: Map<string, CandidateEdge[]>,
  options: GenerationOptions,
  seed: number,
): void {
  if (!options.diversifyAreas) return;

  // Adaylık kontrolü için hızlı arama seti.
  const eligibleSet = new Set<string>();
  for (const [key, edges] of edgesByTask) {
    for (const e of edges) eligibleSet.add(`${key}>${e.teacherSourceId}`);
  }
  const isEligible = (task: SolverAssignment, teacherSourceId: string) =>
    eligibleSet.has(`${taskKey(task)}>${teacherSourceId}`);

  const teacherCategories = (assignedList: SolverAssignment[]): Map<string, Set<string>> => {
    const map = new Map<string, Set<string>>();
    for (const a of assignedList) {
      if (!a.teacherSourceId) continue;
      const category = (a as unknown as { category?: string | null }).category;
      if (!category) continue;
      const set = map.get(a.teacherSourceId) ?? new Set<string>();
      set.add(category);
      map.set(a.teacherSourceId, set);
    }
    return map;
  };

  const MAX_ROUNDS = 3;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let improved = false;
    const byDay = new Map<number, SolverAssignment[]>();
    for (const a of assignments) {
      if (a.kind !== "generated") continue;
      const list = byDay.get(a.dayOrder) ?? [];
      list.push(a);
      byDay.set(a.dayOrder, list);
    }

    const days = Array.from(byDay.keys()).sort((x, y) => x - y);
    for (const day of days) {
      const list = (byDay.get(day) ?? []).sort((a, b) => taskKey(a).localeCompare(taskKey(b)));
      const catMap = teacherCategories(assignments);

      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (!a.teacherSourceId || !b.teacherSourceId || a.teacherSourceId === b.teacherSourceId) continue;
          if (!isEligible(a, b.teacherSourceId) || !isEligible(b, a.teacherSourceId)) continue;

          const catA = (a as unknown as { category?: string | null }).category;
          const catB = (b as unknown as { category?: string | null }).category;
          if (!catA || !catB || catA === catB) continue;

          const setA = catMap.get(a.teacherSourceId) ?? new Set<string>();
          const setB = catMap.get(b.teacherSourceId) ?? new Set<string>();
          const before = (setA.has(catA) ? 1 : 0) + (setB.has(catB) ? 1 : 0);
          const afterSetA = new Set(setA);
          afterSetA.delete(catA);
          afterSetA.add(catB);
          const afterSetB = new Set(setB);
          afterSetB.delete(catB);
          afterSetB.add(catA);
          const after = (afterSetA.has(catB) ? 1 : 0) + (afterSetB.has(catA) ? 1 : 0);

          const gain = afterSetA.size + afterSetB.size - (setA.size + setB.size);
          const tie = tieBreak(seed, "swap", taskKey(a), taskKey(b));
          if (gain > 0 || (gain === 0 && tie % 2 === 0 && before > after)) {
            const swapTeacher = a.teacherSourceId;
            a.teacherSourceId = b.teacherSourceId;
            b.teacherSourceId = swapTeacher;
            improved = true;
          }
        }
      }
    }
    if (!improved) break;
  }
}
