/**
 * Nöbet2027 — otomatik nöbet planı üretimi, SÜRÜM 3 (öğretmen bazlı yarım gün
 * kuralı + blok düzeyinde sabitlik).
 *
 * =============================================================================
 * MATEMATİKSEL MODEL
 * =============================================================================
 * v3'te her normal görev TEK HÜCRELİDİR (SINGLE_BLOCK). Bu yüzden v1/v2'nin
 * FULL_DAY/SHORT_BREAKS paket şablonlarını arayan branch-and-bound'u KULLANILMAZ;
 * problem doğrudan bir min-cost max-flow ağı olarak KESİN çözülür:
 *
 *   SOURCE
 *     → TEACHER              (basamaklı birim kenarlar; haftalık kapasite)
 *     → TEACHER_DAY          (kapasite = maxDailyNormalBlocks; sabit günde 0)
 *     → TEACHER_DAY_BLOCK    (kapasite 1 → aynı blokta tek nöbet yeri)
 *     → TASK                 (yalnız snapshot'taki candidateEdges)
 *     → SINK                 (kapasite 1 → her göreve en fazla bir öğretmen)
 *
 * Bütün kapasiteler ve maliyetler TAM SAYIDIR. Float karşılaştırma, rastgelelik
 * veya iterasyon limiti YOKTUR; `run()` genişletme yolu kalmayana dek çalışır,
 * bu yüzden sonuç ağın GERÇEK maksimum akışıdır (= azami kapsama) ve maliyet
 * yalnız azami kapsamalı çözümler ARASINDA sıralama yapar.
 *
 * =============================================================================
 * AMAÇ ÖNCELİĞİ (lexicographic — ölçek ayrımıyla)
 * =============================================================================
 *   1. Azami kapsama          — maliyetten BAĞIMSIZ; max-flow'un kendisi garanti eder.
 *   2. Zorunlu kurallar       — maliyetle DEĞİL, kapasiteyle uygulanır (sert kısıt).
 *   3. minWeeklyDuties'e çekme } marginalCostForLoad merdiveni,
 *   4. targetWeeklyDuties dengesi } ölçek: DİNAMİK weekly (bkz. dominanceScales)
 *   5. Az dersli günü tercih   — ölçek: DİNAMİK lesson; (3)/(4)'ü ASLA çeviremez
 *   6. diversifyAreas          — akıştan SONRA, kapsamayı ASLA azaltmayan swap'lar
 *   7. Seed tie-break          — ölçek 0..96; hiçbir gerçek maliyet farkını domine etmez
 *
 * Ölçekler kesin ayrıktır: bir alt öncelik, üst önceliğin EN KÜÇÜK farkını bile
 * çeviremez (bkz. testler). "Az dersli gün" tercihi kapsamayı ASLA düşürmez —
 * kapsama akış değeriyle sabitlenmiştir, maliyet yalnız aynı akış değerine sahip
 * çözümler arasında seçim yapar.
 *
 * =============================================================================
 * AUTHORITATIVE GİRDİ
 * =============================================================================
 * Bu modül HİÇBİR iş kuralını yeniden türetmez ve yer adı/short_code
 * HARD-CODE ETMEZ. Yalnız `get_duty_plan_generation_snapshot` alanlarını
 * kullanır: tasks (kind), candidateEdges, teachers[].halfDayRuleEnabled,
 * teachers[].maxDailyNormalBlocks, sabit yükler ve kilitli manuel atamalar.
 * `assignment_mode` süzgeci zaten snapshot'ta uygulanmıştır: fixed_only ve
 * eşlemesi olmayan hücreler normal görev evrenine GİRMEZ.
 */

import { MinCostFlow } from "./minCostFlow";
import {
  DutyPlanSolverOptionsError,
  marginalCostForLoad,
  normalizeGenerationOptions,
  taskKey,
  tieBreak,
  type CandidateEdge,
  type GenerationOptions,
  type SolverTeacherLoad,
  type SolverWarning,
} from "./solver";

export { DutyPlanSolverOptionsError };

/** v3 üretim sürümü — save_duty_plan_draft ve publish bu öneke göre v3 kurallarını uygular. */
export const DUTY_PLAN_SOLVER_V3_VERSION = "duty-plan-solver-v3-teacher-half-day-rules";

/**
 * Tie-break üst sınırı (tieBreak 0..96 döner). Ölçekler bu sabitten ve GERÇEK
 * veri büyüklüğünden TÜRETİLİR — "yeterince büyük" sabitlere GÜVENİLMEZ.
 */
const TIE_MAX = 97;

/**
 * Dinamik dominance ölçekleri. Her öncelik seviyesi, ALTINDAKİ bütün
 * seviyelerin TOPLAM en kötü maliyetinden KESİN olarak büyüktür; böylece
 * lexicographic sıra veri büyüklüğünden BAĞIMSIZ garanti edilir.
 *
 *   toplam tie      < taskCount * TIE_PER_PATH * TIE_MAX
 *   LESSON_SCALE    > toplam tie
 *   toplam ders     < taskCount * (maxLessons + 1) * LESSON_SCALE
 *   WEEKLY_SCALE    > toplam ders + toplam tie
 */
function dominanceScales(taskCount: number, maxLessonsPerDay: number): { lesson: number; weekly: number } {
  const TIE_PER_PATH = 2; // SOURCE→TEACHER (unit) ve DAY_BLOCK→TASK kenarları
  const n = Math.max(1, taskCount);
  const tieBound = n * TIE_PER_PATH * TIE_MAX;
  const lesson = tieBound + 1;
  const lessonBound = n * (Math.max(0, maxLessonsPerDay) + 1) * lesson;
  const weekly = lessonBound + tieBound + 1;
  return { lesson, weekly };
}

export interface V3Task {
  dayOrder: number;
  dutyLocationId: string;
  dutyBlockId: string;
  /** diversifyAreas için; yoksa çeşitlilik geçişi atlanır. */
  category?: string | null;
}

/** Snapshot'tan gelen öğretmen — günlük kapasite AUTHORITATIVE olarak buradan okunur. */
export interface V3Teacher {
  teacherSourceId: string;
  teacherName?: string;
  /** true ⇔ aynı gün yalnız BİR normal blok. */
  halfDayRuleEnabled?: boolean;
  /**
   * Günlük normal blok üst sınırı. Snapshot bunu döndürür (yarım gün açıkken 1,
   * kapalıyken blok sayısı). Verilmezse halfDayRuleEnabled'dan türetilir;
   * SOLVER İÇİNDE SABİT BİR SAYI (ör. 4) HARD-CODE EDİLMEZ.
   */
  maxDailyNormalBlocks?: number;
}

export interface V3FixedLoad {
  teacherSourceId: string;
  fixedDutyDayCount: number;
}

/** Sabit nöbet GÜNÜ — o gün ilgili öğretmenin normal kapasitesi 0'dır. */
export interface V3FixedDay {
  teacherSourceId: string;
  dayOrder: number;
}

/**
 * Snapshot'taki bir SABİT (fixed_only) görev HÜCRESİ. Gerekli sabit yük bu
 * evrenden türetilir — ATAMALARDAN DEĞİL: öğretmeni henüz atanmamış bir sabit
 * grup da gerçekte gereklidir ve yük hesabından DÜŞMEMELİDİR.
 */
export interface V3FixedTaskCell {
  dayOrder: number;
  dutyLocationId: string;
  dutyBlockId: string;
  /** null ⇒ bu hücre henüz bir sabit öğretmenle karşılanmamış. */
  fixedCoveredByTeacherSourceId?: string | null;
}

/** Regenerate sırasında KORUNAN manuel atama. */
export interface V3LockedAssignment {
  dayOrder: number;
  dutyLocationId: string;
  dutyBlockId: string;
  teacherSourceId: string;
}

export interface V3SolverInput {
  /** YALNIZ normal (kind='normal') görevler. Kilitli hücreler DAHİL edilmemelidir. */
  tasks: V3Task[];
  candidateEdges: CandidateEdge[];
  teachers: V3Teacher[];
  teacherFixedLoads: V3FixedLoad[];
  fixedDays?: V3FixedDay[];
  /**
   * Snapshot'taki SABİT görev hücrelerinin TAMAMI (kind='fixed'). Gerekli
   * sabit yük birimi buradan hesaplanır; verilmezse sabit yük 0 sayılır.
   */
  fixedTaskCells?: V3FixedTaskCell[];
  lockedAssignments?: V3LockedAssignment[];
  /** `${teacherSourceId}|${dayOrder}` → o günkü ders saati sayısı (öncelik 5). */
  lessonPeriodCountByTeacherDay?: Record<string, number>;
  options?: Partial<GenerationOptions>;
}

export interface V3Assignment {
  dayOrder: number;
  dutyLocationId: string;
  dutyBlockId: string;
  /** diversifyAreas geçişinde kullanılır; görev girdisinden taşınır. */
  category?: string | null;
  teacherSourceId: string | null;
  kind: "generated" | "unassigned";
}

/** Öğretmen bazında kullanılan/kalan kapasite teşhisi. */
export interface V3TeacherCapacity {
  teacherSourceId: string;
  fixedDutyDayCount: number;
  lockedNormalCount: number;
  generatedNormalCount: number;
  /** = fixed + locked + generated (haftalık yük sözleşmesiyle AYNI birim). */
  usedWeekly: number;
  weeklyCapacity: number;
  remainingWeekly: number;
  maxDailyNormalBlocks: number;
  /** dayOrder → o gün kullanılan normal blok sayısı. */
  usedByDay: Record<number, number>;
}

export type V3LockedViolationCode =
  | "no_candidate_edge"
  | "fixed_duty_day"
  | "duplicate_teacher_day_block"
  | "daily_capacity_exceeded"
  | "weekly_capacity_exceeded"
  | "task_not_in_universe"
  /** Eski v1/v2 çok hücreli (FULL_DAY/SHORT_BREAKS) manuel paket — v3'e sessizce taşınamaz. */
  | "legacy_multiblock_package";

export interface V3LockedViolation {
  code: V3LockedViolationCode;
  message: string;
  teacherSourceId: string;
  dayOrder: number;
  dutyLocationId: string;
  dutyBlockId: string;
}

export interface V3SolverResult {
  status: "ok";
  algorithmVersion: string;
  assignments: V3Assignment[];
  totalTaskCount: number;
  assignedTaskCount: number;
  unassignedTaskCount: number;
  fixedAssignmentCount: number;
  teacherLoads: SolverTeacherLoad[];
  teacherCapacities: V3TeacherCapacity[];
  warnings: SolverWarning[];
  optionsUsed: GenerationOptions;
  /**
   * NİHAİ sonucun optimumluğu.
   *
   *   diversifyAreas = false ⇒ true  (saf min-cost max-flow; kesin optimum)
   *   diversifyAreas = true  ⇒ false (çeşitlilik SEZGİSELDİR — global azami
   *                                   kategori çeşitliliği KANITLANMAZ)
   *
   * `false` olması "kurallar ihlal edildi" veya "kapsama düşük" demek DEĞİLDİR;
   * yalnız NİHAİ sıralamanın kanıtlanmadığını söyler (bkz. optimalityReason).
   */
  optimalityProven: boolean;
  /**
   * KAPSAMA her durumda kesin maksimumdur — akış değeriyle sabitlenir ve
   * çeşitlilik geçişi kapsamayı ASLA değiştirmez. Bu yüzden diversifyAreas
   * açıkken bile HER ZAMAN true.
   */
  coverageOptimalityProven: boolean;
  /** optimalityProven=false ise NEDENİ; aksi halde null. */
  optimalityReason: "diversification_heuristic" | null;
  /** Arama bütçesi/limit KAVRAMI YOKTUR — HER ZAMAN false. */
  searchLimitReached: boolean;
  /** Mevcut kurallar altında ULAŞILABİLİR azami kapsama (bu koşunun akış değeri). */
  maxTheoreticalCoverage: number;
  /**
   * DEPRECATED ADLANDIRMA — geriye uyumluluk için korunur. Bu alan basit
   * toplam kapasite açığı DEĞİLDİR; gerçek EŞLEŞTİRME sonucunda açık kalan
   * görev sayısıdır. Yeni kod `matchingConstrainedUncoveredTasks` kullanmalı.
   */
  weeklyCapacityShortfall: number;
  /**
   * Gerçek akış çözümünde tercih / zaman kuralı / gün / blok / haftalık
   * kısıtlar yüzünden AÇIK kalan normal görev sayısı. Ham hücre sayısı ile
   * kapasite toplamının farkı DEĞİLDİR.
   */
  matchingConstrainedUncoveredTasks: number;
  /** Yük BİRİMİ cinsinden kapasite tablosu (hücre sayısıyla KARIŞTIRILMAZ). */
  loadUnits: V3LoadUnits;
}

/**
 * YÜK BİRİMİ tablosu. Hücre sayısı ile yük birimi AYNI ŞEY DEĞİLDİR:
 *   - Her normal hücre 1 SINGLE_BLOCK paket ⇒ 1 yük birimi.
 *   - Sabit hücreler ikişerli FIXED_SHORT_BREAKS paketlerinde toplanır
 *     (Sabah + Öğleden Sonra), yani 2 hücre ⇒ 1 yük birimi.
 * Bu yüzden ham hücre sayısı ile öğretmen kapasitesi DOĞRUDAN karşılaştırılmaz.
 */
export interface V3LoadUnits {
  /** Normal SINGLE_BLOCK görev birimi sayısı (= normal hücre sayısı). */
  normalRequiredUnits: number;
  /**
   * GEREKLİ sabit görev birimi: aynı (gün, yer) grubundaki fixed_only hücreler
   * TEK bir FIXED_SHORT_BREAKS birimidir. Öğretmen ATANMAMIŞ olsa bile bu
   * birim gereklidir — grup anahtarına öğretmen kimliği GİRMEZ.
   */
  fixedRequiredUnits: number;
  /** Öğretmeni EKSİKSİZ bulunan sabit birim sayısı. */
  fixedCoveredUnits: number;
  /** fixedRequiredUnits − fixedCoveredUnits. */
  fixedUncoveredUnits: number;
  /** normalRequiredUnits + fixedRequiredUnits. */
  totalRequiredLoadUnits: number;
  /** Σ maxWeeklyDuties (plana dahil öğretmen evreni üzerinden). */
  aggregateTeacherCapacity: number;
  /** aggregateTeacherCapacity − totalRequiredLoadUnits (negatif ⇒ yapısal açık). */
  aggregateCapacitySlack: number;
  /**
   * Ham hücre sayısı: GERÇEK normal hücreler + GERÇEK fixed_only hücreler.
   * Varsayımla (ör. "sabit gün × 2") türetilmez. YALNIZ bilgi amaçlıdır;
   * kapasiteyle DOĞRUDAN karşılaştırılmaz.
   */
  rawTaskCells: number;
  /**
   * Sabit grup yapısı beklenmedik olan (gün, yer) grupları — bir grubun
   * hücreleri FARKLI öğretmenlere atanmışsa veya yalnız bir kısmı atanmışsa.
   * Sessizce "karşılanmış" sayılmaz.
   */
  malformedFixedGroups: V3MalformedFixedGroup[];
}

/** Tutarsız sabit görev grubu teşhisi. */
export interface V3MalformedFixedGroup {
  dayOrder: number;
  dutyLocationId: string;
  cellCount: number;
  coveredCellCount: number;
  distinctTeacherCount: number;
  reason: "partially_covered" | "multiple_teachers";
}

export interface V3InvalidLockedResult {
  status: "invalid_locked_assignment";
  violations: V3LockedViolation[];
}

export type V3Result = V3SolverResult | V3InvalidLockedResult;

const dayKey = (teacherSourceId: string, dayOrder: number) => `${teacherSourceId}|${dayOrder}`;
const dayBlockKey = (teacherSourceId: string, dayOrder: number, dutyBlockId: string) => `${teacherSourceId}|${dayOrder}|${dutyBlockId}`;

/** Günlük kapasite: snapshot değeri AUTHORITATIVE; yoksa yarım gün bayrağından türetilir. */
function dailyCapacityOf(teacher: V3Teacher, fallbackBlockCount: number): number {
  if (typeof teacher.maxDailyNormalBlocks === "number" && Number.isInteger(teacher.maxDailyNormalBlocks) && teacher.maxDailyNormalBlocks >= 0) {
    return teacher.maxDailyNormalBlocks;
  }
  // Snapshot alanı yoksa: yarım gün AÇIK ⇒ 1; KAPALI ⇒ evrendeki DİSTİNCT blok
  // sayısı (sabit bir sayı hard-code EDİLMEZ).
  return teacher.halfDayRuleEnabled === false ? fallbackBlockCount : 1;
}

// ============================================================================
// Kilitli manuel atama doğrulaması (kural 9)
// ============================================================================
function validateLocked(
  locked: V3LockedAssignment[],
  ctx: {
    candidateSet: Set<string>;
    fixedDaySet: Set<string>;
    dailyCapacity: Map<string, number>;
    weeklyCapacity: Map<string, number>;
    fixedLoad: Map<string, number>;
  },
): V3LockedViolation[] {
  const violations: V3LockedViolation[] = [];
  const seenDayBlock = new Set<string>();
  const perDay = new Map<string, number>();
  const perWeek = new Map<string, number>();

  const ordered = [...locked].sort((a, b) => (a.teacherSourceId + taskKey(a)).localeCompare(b.teacherSourceId + taskKey(b)));

  for (const l of ordered) {
    const base = { teacherSourceId: l.teacherSourceId, dayOrder: l.dayOrder, dutyLocationId: l.dutyLocationId, dutyBlockId: l.dutyBlockId };

    if (!ctx.candidateSet.has(`${taskKey(l)}>${l.teacherSourceId}`)) {
      violations.push({ ...base, code: "no_candidate_edge", message: "Kilitli manuel atama için geçerli bir aday kenarı yok (tercih/zaman kuralı artık sağlanmıyor)." });
    }
    if (ctx.fixedDaySet.has(dayKey(l.teacherSourceId, l.dayOrder))) {
      violations.push({ ...base, code: "fixed_duty_day", message: "Öğretmenin o gün sabit nöbeti var; normal görev tutamaz." });
    }
    const dbKey = dayBlockKey(l.teacherSourceId, l.dayOrder, l.dutyBlockId);
    if (seenDayBlock.has(dbKey)) {
      violations.push({ ...base, code: "duplicate_teacher_day_block", message: "Aynı öğretmen aynı gün aynı blokta birden fazla kilitli atamaya sahip." });
    }
    seenDayBlock.add(dbKey);

    const dKey = dayKey(l.teacherSourceId, l.dayOrder);
    const dayUsed = (perDay.get(dKey) ?? 0) + 1;
    perDay.set(dKey, dayUsed);
    const dayCap = ctx.dailyCapacity.get(l.teacherSourceId) ?? 1;
    if (dayUsed > dayCap) {
      violations.push({ ...base, code: "daily_capacity_exceeded", message: `Kilitli atamalar öğretmenin günlük kapasitesini (${dayCap}) aşıyor.` });
    }

    const weekUsed = (perWeek.get(l.teacherSourceId) ?? 0) + 1;
    perWeek.set(l.teacherSourceId, weekUsed);
    const weekCap = ctx.weeklyCapacity.get(l.teacherSourceId) ?? 0;
    if (weekUsed + (ctx.fixedLoad.get(l.teacherSourceId) ?? 0) > weekCap) {
      violations.push({ ...base, code: "weekly_capacity_exceeded", message: `Kilitli atamalar öğretmenin haftalık üst sınırını (${weekCap}) aşıyor.` });
    }
  }
  return violations;
}

// ============================================================================
// Çekirdek: akış ağını kur ve çöz
// ============================================================================
interface FlowOutcome {
  assignedByTask: Map<string, string>;
  coverage: number;
}

function runFlow(params: {
  tasks: V3Task[];
  edgesByTask: Map<string, CandidateEdge[]>;
  teacherIds: string[];
  weeklyUnitCost: (teacherSourceId: string, unitIndex: number) => number | null;
  dayCapacity: (teacherSourceId: string, dayOrder: number) => number;
  dayCost: (teacherSourceId: string, dayOrder: number) => number;
  seed: number;
  /** true ⇔ yalnız KAPSAMA ölçülür (kapasite senaryoları); maliyetler sıfırlanır. */
  coverageOnly: boolean;
}): FlowOutcome {
  const { tasks, edgesByTask, teacherIds, seed } = params;

  const SOURCE = 0;
  const SINK = 1;
  let nextId = 2;

  const teacherNode = new Map<string, number>();
  for (const id of teacherIds) teacherNode.set(id, nextId++);

  // Öğretmenin aday kenarı bulunan (gün, blok) çiftleri.
  const dayBlocksByTeacher = new Map<string, Map<number, Set<string>>>();
  for (const edges of edgesByTask.values()) {
    for (const e of edges) {
      if (!teacherNode.has(e.teacherSourceId)) continue;
      const byDay = dayBlocksByTeacher.get(e.teacherSourceId) ?? new Map<number, Set<string>>();
      const blocks = byDay.get(e.dayOrder) ?? new Set<string>();
      blocks.add(e.dutyBlockId);
      byDay.set(e.dayOrder, blocks);
      dayBlocksByTeacher.set(e.teacherSourceId, byDay);
    }
  }

  const teacherDayNode = new Map<string, number>();
  const teacherDayBlockNode = new Map<string, number>();
  for (const teacherSourceId of teacherIds) {
    const byDay = dayBlocksByTeacher.get(teacherSourceId);
    if (!byDay) continue;
    for (const dayOrder of Array.from(byDay.keys()).sort((a, b) => a - b)) {
      if (params.dayCapacity(teacherSourceId, dayOrder) <= 0) continue;
      teacherDayNode.set(dayKey(teacherSourceId, dayOrder), nextId++);
      for (const dutyBlockId of Array.from(byDay.get(dayOrder) as Set<string>).sort()) {
        teacherDayBlockNode.set(dayBlockKey(teacherSourceId, dayOrder, dutyBlockId), nextId++);
      }
    }
  }

  const taskNode = new Map<string, number>();
  for (const task of tasks) taskNode.set(taskKey(task), nextId++);

  const mcmf = new MinCostFlow(nextId);

  // SOURCE → TEACHER: basamaklı (dışbükey) birim kapasiteli kenarlar.
  for (const teacherSourceId of teacherIds) {
    for (let j = 1; ; j++) {
      const cost = params.weeklyUnitCost(teacherSourceId, j);
      if (cost === null) break;
      const tie = tieBreak(seed, "unit", teacherSourceId, String(j));
      mcmf.addEdge(SOURCE, teacherNode.get(teacherSourceId) as number, 1, params.coverageOnly ? tie : cost + tie);
    }
  }

  // TEACHER → TEACHER_DAY: kapasite = günlük normal blok sınırı.
  // Maliyet = o günkü ders sayısı (öncelik 5) — az dersli gün TERCİH edilir.
  for (const [key, node] of teacherDayNode) {
    const [teacherSourceId, dayText] = key.split("|");
    const dayOrder = Number(dayText);
    const cap = params.dayCapacity(teacherSourceId, dayOrder);
    const cost = params.coverageOnly ? 0 : params.dayCost(teacherSourceId, dayOrder);
    for (let unit = 0; unit < cap; unit++) {
      mcmf.addEdge(teacherNode.get(teacherSourceId) as number, node, 1, cost);
    }
  }

  // TEACHER_DAY → TEACHER_DAY_BLOCK: kapasite 1 ⇒ aynı blokta TEK nöbet yeri.
  for (const [key, node] of teacherDayBlockNode) {
    const [teacherSourceId, dayText] = key.split("|");
    const parent = teacherDayNode.get(dayKey(teacherSourceId, Number(dayText)));
    if (parent === undefined) continue;
    mcmf.addEdge(parent, node, 1, 0);
  }

  // TEACHER_DAY_BLOCK → TASK: yalnız snapshot'taki aday kenarları.
  const taskEdgeIndex = new Map<string, { edgeIndex: number; teacherSourceId: string }[]>();
  for (const task of tasks) {
    const key = taskKey(task);
    const candidates = (edgesByTask.get(key) ?? []).slice().sort((a, b) => a.teacherSourceId.localeCompare(b.teacherSourceId));
    const list: { edgeIndex: number; teacherSourceId: string }[] = [];
    for (const edge of candidates) {
      const node = teacherDayBlockNode.get(dayBlockKey(edge.teacherSourceId, task.dayOrder, task.dutyBlockId));
      if (node === undefined) continue;
      const tie = tieBreak(seed, "task", key, edge.teacherSourceId);
      const edgeStart = mcmf.nextEdgeIndex();
      mcmf.addEdge(node, taskNode.get(key) as number, 1, tie);
      list.push({ edgeIndex: edgeStart, teacherSourceId: edge.teacherSourceId });
    }
    taskEdgeIndex.set(key, list);
  }

  for (const task of tasks) mcmf.addEdge(taskNode.get(taskKey(task)) as number, SINK, 1, 0);

  mcmf.run(SOURCE, SINK);

  const assignedByTask = new Map<string, string>();
  for (const task of tasks) {
    const key = taskKey(task);
    for (const { edgeIndex, teacherSourceId } of taskEdgeIndex.get(key) ?? []) {
      if (mcmf.flowOn(edgeIndex) > 0) {
        assignedByTask.set(key, teacherSourceId);
        break;
      }
    }
  }
  return { assignedByTask, coverage: assignedByTask.size };
}


// ============================================================================
// ORTAK KISIT BAĞLAMI — solveDutyPlanV3 ve analyzeV3Capacity AYNI hazırlıktan
// beslenir. Kurallar İKİNCİ KEZ, farklı biçimde yazılmaz.
// ============================================================================
interface V3Context {
  tasks: V3Task[];
  /** Kilitli blokları ELENMİŞ aday kenarları (görev bazında). */
  usableEdgesByTask: Map<string, CandidateEdge[]>;
  /** Ağda düğümü olan (aday kenarı bulunan) öğretmenler. */
  teacherIds: string[];
  allTeacherIds: string[];
  candidateTeacherIds: Set<string>;
  candidateSet: Set<string>;
  fixedLoad: Map<string, number>;
  fixedDaySet: Set<string>;
  dailyCapacity: Map<string, number>;
  lockedCountByTeacher: Map<string, number>;
  lockedByTeacherDay: Map<string, number>;
  lockedDayBlocks: Set<string>;
  distinctBlockCount: number;
  /** Haftalık KALAN kapasite: max − sabit gün − kilitli normal paket. */
  weeklyRemaining: (teacherSourceId: string) => number;
  /** Günlük kalan kapasite; sabit günde 0, kilitliler düşülmüş. */
  dayCapacity: (teacherSourceId: string, dayOrder: number, halfDayDisabledOverride?: boolean) => number;
}

function prepareV3Context(input: V3SolverInput, options: GenerationOptions): V3Context {
  const tasks = [...input.tasks].sort((a, b) => taskKey(a).localeCompare(taskKey(b)));
  const taskKeySet = new Set(tasks.map(taskKey));

  const edgesByTask = new Map<string, CandidateEdge[]>();
  const candidateSet = new Set<string>();
  for (const edge of input.candidateEdges) {
    candidateSet.add(`${taskKey(edge)}>${edge.teacherSourceId}`);
    if (!taskKeySet.has(taskKey(edge))) continue;
    const list = edgesByTask.get(taskKey(edge));
    if (list) list.push(edge);
    else edgesByTask.set(taskKey(edge), [edge]);
  }

  const fixedLoad = new Map<string, number>();
  for (const f of input.teacherFixedLoads) fixedLoad.set(f.teacherSourceId, f.fixedDutyDayCount);
  const fixedDaySet = new Set<string>();
  for (const d of input.fixedDays ?? []) fixedDaySet.add(dayKey(d.teacherSourceId, d.dayOrder));

  const teacherById = new Map<string, V3Teacher>();
  for (const t of input.teachers) teacherById.set(t.teacherSourceId, t);
  const universe = new Set<string>(teacherById.keys());
  for (const f of input.teacherFixedLoads) universe.add(f.teacherSourceId);
  for (const e of input.candidateEdges) universe.add(e.teacherSourceId);
  const allTeacherIds = Array.from(universe).sort((a, b) => a.localeCompare(b));

  const distinctBlockCount = new Set(input.candidateEdges.map((e) => e.dutyBlockId)).size || 1;
  const dailyCapacity = new Map<string, number>();
  for (const id of allTeacherIds) dailyCapacity.set(id, dailyCapacityOf(teacherById.get(id) ?? { teacherSourceId: id }, distinctBlockCount));

  // Kilitli manuel paketler: haftalık VE günlük kapasiteyi tüketir, ilgili
  // teacher-day-block hücresini KAPATIR.
  const locked = input.lockedAssignments ?? [];
  const lockedCountByTeacher = new Map<string, number>();
  const lockedByTeacherDay = new Map<string, number>();
  const lockedDayBlocks = new Set<string>();
  for (const l of locked) {
    lockedCountByTeacher.set(l.teacherSourceId, (lockedCountByTeacher.get(l.teacherSourceId) ?? 0) + 1);
    const dk = dayKey(l.teacherSourceId, l.dayOrder);
    lockedByTeacherDay.set(dk, (lockedByTeacherDay.get(dk) ?? 0) + 1);
    lockedDayBlocks.add(dayBlockKey(l.teacherSourceId, l.dayOrder, l.dutyBlockId));
  }

  // Kilitli blokların aday kenarları DÜŞÜLÜR (aynı gün+blok ikinci yer yasak).
  const usableEdgesByTask = new Map<string, CandidateEdge[]>();
  for (const [key, edges] of edgesByTask) {
    const filtered = edges.filter((e) => !lockedDayBlocks.has(dayBlockKey(e.teacherSourceId, e.dayOrder, e.dutyBlockId)));
    if (filtered.length > 0) usableEdgesByTask.set(key, filtered);
  }

  const candidateTeacherIds = new Set(input.candidateEdges.map((e) => e.teacherSourceId));
  const teacherIds = allTeacherIds.filter((id) => candidateTeacherIds.has(id));

  const weeklyRemaining = (id: string) =>
    Math.max(0, options.maxWeeklyDuties - (fixedLoad.get(id) ?? 0) - (lockedCountByTeacher.get(id) ?? 0));

  const dayCapacityFn = (id: string, day: number, halfDayDisabledOverride = false) => {
    if (fixedDaySet.has(dayKey(id, day))) return 0; // sabit gün ⇒ SIFIR
    const t = teacherById.get(id);
    const base = halfDayDisabledOverride
      ? // Senaryo YALNIZ yarım gün tavanını değiştirir; diğer her kural aynıdır.
        t && t.halfDayRuleEnabled === false && typeof t.maxDailyNormalBlocks === "number"
        ? t.maxDailyNormalBlocks
        : distinctBlockCount
      : (dailyCapacity.get(id) ?? 1);
    return Math.max(0, base - (lockedByTeacherDay.get(dayKey(id, day)) ?? 0));
  };

  return {
    tasks,
    usableEdgesByTask,
    teacherIds,
    allTeacherIds,
    candidateTeacherIds,
    candidateSet,
    fixedLoad,
    fixedDaySet,
    dailyCapacity,
    lockedCountByTeacher,
    lockedByTeacherDay,
    lockedDayBlocks,
    distinctBlockCount,
    weeklyRemaining,
    dayCapacity: dayCapacityFn,
  };
}

// ============================================================================
// Ana giriş
// ============================================================================
export function solveDutyPlanV3(input: V3SolverInput): V3Result {
  const options = normalizeGenerationOptions(input.options);
  const seed = options.seed ?? 0;
  const warnings: SolverWarning[] = [];

  // ORTAK kısıt bağlamı — kapasite analizi AYNI hazırlığı kullanır.
  const ctx = prepareV3Context(input, options);
  const { tasks, allTeacherIds, candidateTeacherIds, candidateSet, fixedLoad, fixedDaySet, dailyCapacity } = ctx;

  const locked = input.lockedAssignments ?? [];
  const lockedByTeacher = new Map<string, V3LockedAssignment[]>();
  for (const l of locked) {
    const list = lockedByTeacher.get(l.teacherSourceId) ?? [];
    list.push(l);
    lockedByTeacher.set(l.teacherSourceId, list);
  }

  const weeklyCapacity = new Map<string, number>();
  for (const id of allTeacherIds) weeklyCapacity.set(id, options.maxWeeklyDuties);

  // --- Kural 9: kilitli atamalar doğrulanır; ihlal varsa SESSİZ düzeltme YOK.
  const violations = validateLocked(locked, { candidateSet, fixedDaySet, dailyCapacity, weeklyCapacity, fixedLoad });
  if (violations.length > 0) {
    return { status: "invalid_locked_assignment", violations };
  }

  const { lockedCountByTeacher } = ctx;

  for (const id of allTeacherIds) {
    const fixed = fixedLoad.get(id) ?? 0;
    if (fixed >= options.maxWeeklyDuties) {
      warnings.push({
        code: "fixed_load_at_or_above_max",
        message: `Öğretmenin sabit nöbet gün sayısı (${fixed}) haftalık üst sınıra (${options.maxWeeklyDuties}) ulaşmış veya aşmış; normal görev verilmeyecek.`,
        teacherSourceId: id,
      });
    }
  }
  for (const id of allTeacherIds) {
    if (!candidateTeacherIds.has(id) && (fixedLoad.get(id) ?? 0) < options.maxWeeklyDuties) {
      warnings.push({ code: "teacher_no_candidate_cells", message: "Öğretmenin hiç geçerli aday hücresi (uygunluk beyanı) yok; normal görev verilemeyecek.", teacherSourceId: id });
    }
  }
  for (const task of tasks) {
    if ((ctx.usableEdgesByTask.get(taskKey(task)) ?? []).length === 0) {
      warnings.push({ code: "no_candidate", message: "Bu görev için hiç aday öğretmen yok.", dayOrder: task.dayOrder, dutyLocationId: task.dutyLocationId, dutyBlockId: task.dutyBlockId });
    }
  }

  const teacherIds = ctx.teacherIds;
  const lessonCounts = input.lessonPeriodCountByTeacherDay ?? {};
  // Ölçekler GERÇEK veri büyüklüğünden türetilir (bkz. dominanceScales).
  const maxLessons = Object.values(lessonCounts).reduce((m, v) => (v > m ? v : m), 0);
  const scales = dominanceScales(tasks.length, maxLessons);

  /** Haftalık basamak: j'inci ek normal görevin marjinal maliyeti (null ⇒ kapasite bitti). */
  function weeklyUnitCost(teacherSourceId: string, unitIndex: number): number | null {
    const fixed = fixedLoad.get(teacherSourceId) ?? 0;
    const lockedCount = lockedCountByTeacher.get(teacherSourceId) ?? 0;
    if (unitIndex > ctx.weeklyRemaining(teacherSourceId)) return null;
    const loadAfter = fixed + lockedCount + unitIndex;
    return marginalCostForLoad(loadAfter, options.minWeeklyDuties, options.targetWeeklyDuties, options.balanceWorkload) * scales.weekly;
  }

  const dayCapacity = (teacherSourceId: string, dayOrder: number): number => ctx.dayCapacity(teacherSourceId, dayOrder);

  function dayCost(teacherSourceId: string, dayOrder: number): number {
    const lessons = lessonCounts[dayKey(teacherSourceId, dayOrder)] ?? 0;
    return lessons * scales.lesson;
  }

  const usableEdgesByTask = ctx.usableEdgesByTask;

  const outcome =
    tasks.length === 0 || teacherIds.length === 0
      ? { assignedByTask: new Map<string, string>(), coverage: 0 }
      : runFlow({ tasks, edgesByTask: usableEdgesByTask, teacherIds, weeklyUnitCost, dayCapacity, dayCost, seed, coverageOnly: false });

  const assignments: V3Assignment[] = tasks.map((task) => {
    const teacher = outcome.assignedByTask.get(taskKey(task));
    return teacher ? { ...task, teacherSourceId: teacher, kind: "generated" as const } : { ...task, teacherSourceId: null, kind: "unassigned" as const };
  });

  applyDiversificationV3(assignments, usableEdgesByTask, options);

  const generatedByTeacher = new Map<string, number>();
  const usedByTeacherDay = new Map<string, Map<number, number>>();
  for (const a of assignments) {
    if (!a.teacherSourceId) continue;
    generatedByTeacher.set(a.teacherSourceId, (generatedByTeacher.get(a.teacherSourceId) ?? 0) + 1);
    const byDay = usedByTeacherDay.get(a.teacherSourceId) ?? new Map<number, number>();
    byDay.set(a.dayOrder, (byDay.get(a.dayOrder) ?? 0) + 1);
    usedByTeacherDay.set(a.teacherSourceId, byDay);
  }

  // Haftalık yük sözleşmesi (kural 8): distinct sabit gün + kilitli normal
  // paket + üretilen normal paket — HEPSİ AYNI birimde.
  const teacherLoads: SolverTeacherLoad[] = allTeacherIds.map((teacherSourceId) => {
    const normalDutyCount = (generatedByTeacher.get(teacherSourceId) ?? 0) + (lockedCountByTeacher.get(teacherSourceId) ?? 0);
    const fixedDutyDayCount = fixedLoad.get(teacherSourceId) ?? 0;
    return { teacherSourceId, normalDutyCount, fixedDutyDayCount, totalDutyCount: normalDutyCount + fixedDutyDayCount };
  });

  for (const load of teacherLoads) {
    if (!candidateTeacherIds.has(load.teacherSourceId)) continue;
    if (load.totalDutyCount < options.minWeeklyDuties) {
      warnings.push({ code: "teacher_below_min", message: `Öğretmenin toplam haftalık yükü (${load.totalDutyCount}) minimumun (${options.minWeeklyDuties}) altında kaldı.`, teacherSourceId: load.teacherSourceId });
    }
  }

  const teacherCapacities: V3TeacherCapacity[] = allTeacherIds.map((teacherSourceId) => {
    const fixed = fixedLoad.get(teacherSourceId) ?? 0;
    const lockedCount = lockedCountByTeacher.get(teacherSourceId) ?? 0;
    const generated = generatedByTeacher.get(teacherSourceId) ?? 0;
    const used = fixed + lockedCount + generated;
    const byDay: Record<number, number> = {};
    for (const [day, n] of usedByTeacherDay.get(teacherSourceId) ?? new Map<number, number>()) byDay[day] = n;
    for (const l of lockedByTeacher.get(teacherSourceId) ?? []) byDay[l.dayOrder] = (byDay[l.dayOrder] ?? 0) + 1;
    return {
      teacherSourceId,
      fixedDutyDayCount: fixed,
      lockedNormalCount: lockedCount,
      generatedNormalCount: generated,
      usedWeekly: used,
      weeklyCapacity: options.maxWeeklyDuties,
      remainingWeekly: Math.max(0, options.maxWeeklyDuties - used),
      maxDailyNormalBlocks: dailyCapacity.get(teacherSourceId) ?? 1,
      usedByDay: byDay,
    };
  });

  const assignedTaskCount = assignments.filter((a) => a.kind === "generated").length;

  // ==========================================================================
  // YÜK BİRİMİ hesabı — hücre sayısı DEĞİL, PAKET birimi.
  //
  // GEREKLİ sabit yük ATAMALARDAN türetilmez: bir (gün, yer) sabit grubu henüz
  // öğretmene atanmamış olsa bile o görev GERÇEKTE GEREKLİDİR. Bu yüzden grup
  // anahtarı (gün, yer)'dir; öğretmen kimliği GİRMEZ. `fixedDaySet` yalnız
  // "sabit öğretmen o gün normal görev alamaz" ve mevcut sabit yükün
  // hesaplanması için kullanılır — görev İHTİYACININ kaynağı DEĞİLDİR.
  // ==========================================================================
  const fixedCells = input.fixedTaskCells ?? [];
  const fixedGroups = new Map<string, { dayOrder: number; dutyLocationId: string; cells: number; covered: number; teachers: Set<string> }>();
  for (const c of fixedCells) {
    const key = `${c.dayOrder}|${c.dutyLocationId}`;
    const g = fixedGroups.get(key) ?? { dayOrder: c.dayOrder, dutyLocationId: c.dutyLocationId, cells: 0, covered: 0, teachers: new Set<string>() };
    g.cells += 1;
    if (c.fixedCoveredByTeacherSourceId) {
      g.covered += 1;
      g.teachers.add(c.fixedCoveredByTeacherSourceId);
    }
    fixedGroups.set(key, g);
  }

  const malformedFixedGroups: V3MalformedFixedGroup[] = [];
  let fixedCoveredUnits = 0;
  for (const key of Array.from(fixedGroups.keys()).sort()) {
    const g = fixedGroups.get(key) as NonNullable<ReturnType<typeof fixedGroups.get>>;
    const base = { dayOrder: g.dayOrder, dutyLocationId: g.dutyLocationId, cellCount: g.cells, coveredCellCount: g.covered, distinctTeacherCount: g.teachers.size };
    if (g.teachers.size > 1) {
      // Bir sabit grup TEK öğretmene aittir; birden fazlası tutarsızlıktır.
      malformedFixedGroups.push({ ...base, reason: "multiple_teachers" });
      continue;
    }
    if (g.covered === 0) continue; // hiç atanmamış — gerekli ama karşılanmamış
    if (g.covered < g.cells) {
      // Kısmen atanmış grup SESSİZCE karşılanmış sayılmaz.
      malformedFixedGroups.push({ ...base, reason: "partially_covered" });
      continue;
    }
    fixedCoveredUnits += 1;
  }

  const fixedRequiredUnits = fixedGroups.size;
  const normalRequiredUnits = tasks.length + locked.length;
  const totalRequiredLoadUnits = normalRequiredUnits + fixedRequiredUnits;
  const aggregateTeacherCapacity = allTeacherIds.length * options.maxWeeklyDuties;
  const loadUnits: V3LoadUnits = {
    normalRequiredUnits,
    fixedRequiredUnits,
    fixedCoveredUnits,
    fixedUncoveredUnits: fixedRequiredUnits - fixedCoveredUnits,
    totalRequiredLoadUnits,
    aggregateTeacherCapacity,
    aggregateCapacitySlack: aggregateTeacherCapacity - totalRequiredLoadUnits,
    // GERÇEK hücre sayısı — "sabit gün × 2" gibi bir varsayım YOK.
    rawTaskCells: tasks.length + locked.length + fixedCells.length,
    malformedFixedGroups,
  };

  return {
    status: "ok",
    algorithmVersion: DUTY_PLAN_SOLVER_V3_VERSION,
    assignments,
    totalTaskCount: tasks.length,
    assignedTaskCount,
    unassignedTaskCount: tasks.length - assignedTaskCount,
    // Öğretmeni EKSİKSİZ bulunan sabit görev birimi sayısı (hücre değil).
    // Gerekli sabit birim için loadUnits.fixedRequiredUnits kullanılır.
    fixedAssignmentCount: fixedCoveredUnits,
    teacherLoads,
    teacherCapacities,
    warnings,
    optionsUsed: options,
    // Kesin min-cost max-flow: heuristic ve iterasyon limiti YOK.
    // Çeşitlilik geçişi SEZGİSELDİR; açıkken nihai optimumluk KANITLANMAZ.
    optimalityProven: !options.diversifyAreas,
    coverageOptimalityProven: true,
    optimalityReason: options.diversifyAreas ? "diversification_heuristic" : null,
    searchLimitReached: false,
    maxTheoreticalCoverage: assignedTaskCount,
    weeklyCapacityShortfall: tasks.length - assignedTaskCount,
    matchingConstrainedUncoveredTasks: tasks.length - assignedTaskCount,
    loadUnits,
  };
}

/**
 * Öncelik 6 — kapsamayı ASLA azaltmadan (yalnız aynı gün içinde, ikisi de
 * karşı görev için aday olan iki öğretmenin görevlerini takas ederek)
 * kategori çeşitliliğini artırır. Takas AYNI BLOK kısıtını da korur: yalnız
 * aynı bloktaki iki görev takas edilir, böylece teacher+day+block tekilliği
 * ve günlük kapasite DEĞİŞMEZ.
 */
function applyDiversificationV3(assignments: V3Assignment[], edgesByTask: Map<string, CandidateEdge[]>, options: GenerationOptions): void {
  if (!options.diversifyAreas) return;

  const eligible = new Set<string>();
  for (const [key, edges] of edgesByTask) for (const e of edges) eligible.add(`${key}>${e.teacherSourceId}`);
  const isEligible = (a: V3Assignment, teacherSourceId: string) => eligible.has(`${taskKey(a)}>${teacherSourceId}`);

  /**
   * GERÇEK çeşitlilik skoru: Σ (öğretmenin DISTINCT kategori sayısı).
   * Set üzerinden "sil + ekle" yaparak tahmin YAPILMAZ — bir öğretmenin aynı
   * kategoride BİRDEN FAZLA görevi olabilir, tek bir görevi takas etmek o
   * kategoriyi kümeden düşürmeyebilir. Bu yüzden skor, her değerlendirmede
   * güncel atamalardan SAYARAK hesaplanır.
   */
  const diversityScore = (): number => {
    const perTeacher = new Map<string, Set<string>>();
    for (const a of assignments) {
      if (a.kind !== "generated" || !a.teacherSourceId || !a.category) continue;
      const set = perTeacher.get(a.teacherSourceId) ?? new Set<string>();
      set.add(a.category);
      perTeacher.set(a.teacherSourceId, set);
    }
    let total = 0;
    for (const set of perTeacher.values()) total += set.size;
    return total;
  };

  const MAX_ROUNDS = 3;
  let current = diversityScore();

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let improved = false;

    // Takas YALNIZ aynı gün + aynı blok grubunda yapılır: böylece
    // teacher-day-block tekilliği, günlük kapasite, haftalık yük ve ders
    // maliyeti DEĞİŞMEZ; yalnız iki görevin öğretmeni yer değiştirir.
    const groups = new Map<string, V3Assignment[]>();
    for (const a of assignments) {
      if (a.kind !== "generated") continue;
      const gk = `${a.dayOrder}|${a.dutyBlockId}`;
      const list = groups.get(gk) ?? [];
      list.push(a);
      groups.set(gk, list);
    }

    for (const gk of Array.from(groups.keys()).sort()) {
      const list = (groups.get(gk) as V3Assignment[]).slice().sort((a, b) => taskKey(a).localeCompare(taskKey(b)));
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (!a.teacherSourceId || !b.teacherSourceId || a.teacherSourceId === b.teacherSourceId) continue;
          // Takas SONRASI da her iki atama GEÇERLİ bir aday kenarı olmalı.
          if (!isEligible(a, b.teacherSourceId) || !isEligible(b, a.teacherSourceId)) continue;

          // Deneysel takas → GERÇEK skoru yeniden hesapla.
          const keep = a.teacherSourceId;
          a.teacherSourceId = b.teacherSourceId;
          b.teacherSourceId = keep;
          const next = diversityScore();
          if (next > current) {
            // Kabul: skor GERÇEKTEN arttı.
            current = next;
            improved = true;
          } else {
            // Reddet: geri al. Skor ASLA azalmaz.
            b.teacherSourceId = a.teacherSourceId;
            a.teacherSourceId = keep;
          }
        }
      }
    }
    if (!improved) break;
  }
}

// ============================================================================
// KAPASİTE ANALİZİ — solver ile AYNI motor, ikinci bir iş kuralı kopyası YOK
// ============================================================================
export interface V3CapacityScenario {
  scenario: "currentRules" | "allHalfDayRulesDisabled";
  /** Bu senaryoda ULAŞILABİLİR azami normal görev (gerçek eşleştirme sonucu). */
  maxCoverableTasks: number;
  totalNormalTasks: number;
  uncoveredTasks: number;
  /** = uncoveredTasks (kapasite/aday darboğazı nedeniyle karşılanamayan). */
  weeklyCapacityShortfall: number;
  /** dayOrder → o gün açık kalan görev sayısı. */
  shortfallByDay: Record<number, number>;
  /** dutyBlockId → o blokta açık kalan görev sayısı. */
  shortfallByBlock: Record<string, number>;
}

export interface V3CapacityAnalysis {
  currentRules: V3CapacityScenario;
  allHalfDayRulesDisabled: V3CapacityScenario;
  /** İki senaryo arasındaki kapsama farkı (yarım gün kuralının maliyeti). */
  coverageGainIfHalfDayDisabled: number;
}

/**
 * Kapasite senaryolarını SOLVER'IN KENDİ motoruyla hesaplar — basit kapasite
 * toplamıyla TAHMİN ETMEZ; aday kenarlarını ve öğretmenlerin ortak kapasite
 * çakışmalarını gerçek eşleştirmeyle dikkate alır.
 *
 * allHalfDayRulesDisabled senaryosunda YALNIZ günlük kapasite yükseltilir;
 * tercihler, zaman uygunluğu, sabit günler, aynı-blok tekilliği ve haftalık
 * üst sınır AYNEN korunur.
 */
export function analyzeV3Capacity(input: V3SolverInput): V3CapacityAnalysis {
  const options = normalizeGenerationOptions(input.options);
  // SOLVER İLE AYNI hazırlanmış kısıt durumu — kurallar İKİNCİ KEZ, farklı
  // biçimde yazılmaz (bkz. prepareV3Context).
  const ctx = prepareV3Context(input, options);

  function scenario(name: V3CapacityScenario["scenario"]): V3CapacityScenario {
    const outcome =
      ctx.tasks.length === 0 || ctx.teacherIds.length === 0
        ? { assignedByTask: new Map<string, string>(), coverage: 0 }
        : runFlow({
            tasks: ctx.tasks,
            edgesByTask: ctx.usableEdgesByTask,
            teacherIds: ctx.teacherIds,
            // Haftalık kapasite: sabit gün VE kilitli manuel paketler DÜŞÜLÜR.
            weeklyUnitCost: (id, unit) => (unit > ctx.weeklyRemaining(id) ? null : 0),
            // Günlük kapasite: sabit gün 0, kilitli paketler düşülür; senaryo
            // YALNIZ yarım gün tavanını değiştirir.
            dayCapacity: (id, day) => ctx.dayCapacity(id, day, name === "allHalfDayRulesDisabled"),
            dayCost: () => 0,
            seed: options.seed ?? 0,
            coverageOnly: true,
          });

    const shortfallByDay: Record<number, number> = {};
    const shortfallByBlock: Record<string, number> = {};
    for (const t of ctx.tasks) {
      if (outcome.assignedByTask.has(taskKey(t))) continue;
      shortfallByDay[t.dayOrder] = (shortfallByDay[t.dayOrder] ?? 0) + 1;
      shortfallByBlock[t.dutyBlockId] = (shortfallByBlock[t.dutyBlockId] ?? 0) + 1;
    }
    return {
      scenario: name,
      maxCoverableTasks: outcome.coverage,
      totalNormalTasks: ctx.tasks.length,
      uncoveredTasks: ctx.tasks.length - outcome.coverage,
      weeklyCapacityShortfall: ctx.tasks.length - outcome.coverage,
      shortfallByDay,
      shortfallByBlock,
    };
  }

  const currentRules = scenario("currentRules");
  const allHalfDayRulesDisabled = scenario("allHalfDayRulesDisabled");
  return {
    currentRules,
    allHalfDayRulesDisabled,
    coverageGainIfHalfDayDisabled: allHalfDayRulesDisabled.maxCoverableTasks - currentRules.maxCoverableTasks,
  };
}
