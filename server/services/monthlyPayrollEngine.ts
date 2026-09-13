/**
 * Aylık yokluk borcu + 28 saat eşiği + ücretli ders hesaplama motoru.
 *
 * Saf fonksiyon: veritabanına, saate veya global duruma dokunmaz. Aynı girdi
 * her zaman aynı çıktıyı üretir; kayıt sırasından etkilenmez (kendi
 * kronolojik sıralamasını yapar). Ay sonu kapanışı ve açık dönem önizlemesi
 * bu modülü ÇAĞIRARAK aynı sonucu üretmelidir — hesap mantığı burada iki kez
 * yazılmaz.
 *
 * Para birimi taşması olmasın diye tüm tutarlar kuruş (integer) ile
 * hesaplanır; TRY <-> kuruş dönüşümü yalnız girdi/çıktı sınırında yapılır.
 */

export interface ActiveWeekInput {
  /** Haftanın pazartesi tarihi (ISO, YYYY-MM-DD). Hafta bu tarihin ait olduğu aya yazılır. */
  weekMonday: string;
  /** Bu haftanın pazartesi tarihinde geçerli XML sürümü kimliği (dondurma/izlenebilirlik için). */
  timetableImportId: string | null;
  /** Bu haftada öğretmenin Kulüp hariç normal ders saati toplamı. */
  normalWeeklyLoad: number;
}

export interface QualifyingLessonInput {
  /** substitution_tasks.id — kaynak görev kimliği. */
  taskId: string;
  assignmentDate: string;
  periodOrder: number;
  /** Görev tarihinde geçerli birim ücret (kuruş). Bilinmiyorsa null — dönem kapanamaz. */
  unitRateCents: number | null;
}

export interface CorrectionInput {
  id: string;
  type: "debt_adjust" | "paid_count_adjust" | "payment_amount_adjust";
  /** debt_adjust: ders adedi (+/-). paid_count_adjust: ders adedi (+/-). payment_amount_adjust: kuruş (+/-). */
  amount: number;
  /** paid_count_adjust için görev tarihinde geçerli birim ücret (kuruş); amount'u TRY'ye çevirmek için. */
  unitRateCentsAtCorrection?: number | null;
}

export interface MonthlyPayrollEngineInput {
  teacherSourceId: string;
  monthStart: string;
  activeWeeks: ActiveWeekInput[];
  /** Önceki aydan devreden yokluk borcu (ders adedi, negatif olamaz). */
  carryInDebt: number;
  /** Bu ay yokluktan doğan yeni borç (ders adedi). */
  debtCreatedThisMonth: number;
  /** Bu teacher'ın substitute olarak üstlendiği, puantaja giren (ders birleştirme HARİÇ) nitelikli ek dersler. */
  qualifyingLessons: QualifyingLessonInput[];
  /** Önceki aydan devreden mali mahsup bakiyesi (kuruş, pozitif = öğretmene borçlu tutar mahsup edilecek). */
  carryInFinancialOffsetCents: number;
  /** Bu aya ait yönetici düzeltmeleri (tarih sırasıyla uygulanır). */
  corrections: CorrectionInput[];
}

export type TaskDisposition = "debt_offset" | "threshold_fill" | "paid" | "rate_missing";

export interface TaskAllocationResult {
  taskId: string;
  assignmentDate: string;
  periodOrder: number;
  disposition: TaskDisposition;
  amountCents: number | null;
}

export interface MonthlyPayrollEngineResult {
  teacherSourceId: string;
  monthStart: string;
  activeWeekCount: number;
  normalMonthlyLoad: number;
  monthlyThreshold: number;
  monthlyCompletionGap: number;
  debtCarryIn: number;
  debtCreatedThisMonth: number;
  totalDebtBeforeAllocation: number;
  taskAllocations: TaskAllocationResult[];
  debtOffsetCount: number;
  thresholdFillCount: number;
  paidLessonCount: number;
  debtCarryOut: number;
  grossAmountCents: number;
  correctionDebtDelta: number;
  correctionPaidCountDelta: number;
  correctionPaidCountAmountCents: number;
  correctionPaymentAmountDeltaCents: number;
  financialOffsetCarryIn: number;
  financialOffsetApplied: number;
  financialOffsetCarryOut: number;
  netAmountCents: number;
  /** Ücreti eksik olan (rate_missing) görev var mı — dönem bu öğretmen için kapanamaz. */
  hasMissingRate: boolean;
}

function sortLessons(lessons: QualifyingLessonInput[]): QualifyingLessonInput[] {
  return [...lessons].sort((a, b) => {
    if (a.assignmentDate !== b.assignmentDate) return a.assignmentDate < b.assignmentDate ? -1 : 1;
    if (a.periodOrder !== b.periodOrder) return a.periodOrder - b.periodOrder;
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  });
}

export function computeMonthlyPayroll(input: MonthlyPayrollEngineInput): MonthlyPayrollEngineResult {
  const activeWeekCount = input.activeWeeks.length;
  const normalMonthlyLoad = input.activeWeeks.reduce((sum, w) => sum + w.normalWeeklyLoad, 0);
  const monthlyThreshold = 28 * activeWeekCount;
  const monthlyCompletionGap = Math.max(0, monthlyThreshold - normalMonthlyLoad);

  const debtCarryIn = Math.max(0, input.carryInDebt);
  const debtCreatedThisMonth = Math.max(0, input.debtCreatedThisMonth);
  const totalDebtBeforeAllocation = debtCarryIn + debtCreatedThisMonth;

  const orderedLessons = sortLessons(input.qualifyingLessons);

  let remainingDebt = totalDebtBeforeAllocation;
  let remainingGap = monthlyCompletionGap;
  let hasMissingRate = false;
  let debtOffsetCount = 0;
  let thresholdFillCount = 0;
  let paidLessonCount = 0;
  let grossAmountCents = 0;

  const taskAllocations: TaskAllocationResult[] = orderedLessons.map((lesson) => {
    if (remainingDebt > 0) {
      remainingDebt -= 1;
      debtOffsetCount += 1;
      return { taskId: lesson.taskId, assignmentDate: lesson.assignmentDate, periodOrder: lesson.periodOrder, disposition: "debt_offset", amountCents: null };
    }
    if (remainingGap > 0) {
      remainingGap -= 1;
      thresholdFillCount += 1;
      return { taskId: lesson.taskId, assignmentDate: lesson.assignmentDate, periodOrder: lesson.periodOrder, disposition: "threshold_fill", amountCents: null };
    }
    if (lesson.unitRateCents === null) {
      hasMissingRate = true;
      return { taskId: lesson.taskId, assignmentDate: lesson.assignmentDate, periodOrder: lesson.periodOrder, disposition: "rate_missing", amountCents: null };
    }
    paidLessonCount += 1;
    grossAmountCents += lesson.unitRateCents;
    return { taskId: lesson.taskId, assignmentDate: lesson.assignmentDate, periodOrder: lesson.periodOrder, disposition: "paid", amountCents: lesson.unitRateCents };
  });

  const debtCarryOutBeforeCorrections = remainingDebt; // 28 saat eksiği asla devretmez; kalan gap atılır.

  let correctionDebtDelta = 0;
  let correctionPaidCountDelta = 0;
  let correctionPaidCountAmountCents = 0;
  let correctionPaymentAmountDeltaCents = 0;
  for (const correction of input.corrections) {
    if (correction.type === "debt_adjust") {
      correctionDebtDelta += correction.amount;
    } else if (correction.type === "paid_count_adjust") {
      correctionPaidCountDelta += correction.amount;
      const rate = correction.unitRateCentsAtCorrection ?? 0;
      correctionPaidCountAmountCents += correction.amount * rate;
    } else {
      correctionPaymentAmountDeltaCents += correction.amount;
    }
  }

  const debtCarryOut = Math.max(0, debtCarryOutBeforeCorrections + correctionDebtDelta);
  const adjustedPaidLessonCount = Math.max(0, paidLessonCount + correctionPaidCountDelta);
  const grossAmountWithCorrections = grossAmountCents + correctionPaidCountAmountCents;

  // Mali mahsup: önce devreden negatif bakiye varsa pozitif ödemeden düşülür.
  const financialOffsetCarryIn = Math.max(0, input.carryInFinancialOffsetCents);
  const preOffsetAmount = grossAmountWithCorrections + correctionPaymentAmountDeltaCents;
  const financialOffsetApplied = Math.min(financialOffsetCarryIn, Math.max(0, preOffsetAmount));
  const afterOffsetAmount = preOffsetAmount - financialOffsetApplied;

  let netAmountCents: number;
  let financialOffsetCarryOut: number;
  if (afterOffsetAmount < 0) {
    // Negatif düzeltme mevcut ödemeden büyük: negatif ödeme çıkarılmaz, kalan
    // tutar ayrı mali mahsup bakiyesi olarak sonraki aya taşınır.
    netAmountCents = 0;
    financialOffsetCarryOut = financialOffsetCarryIn - financialOffsetApplied + Math.abs(afterOffsetAmount);
  } else {
    netAmountCents = afterOffsetAmount;
    financialOffsetCarryOut = financialOffsetCarryIn - financialOffsetApplied;
  }

  return {
    teacherSourceId: input.teacherSourceId,
    monthStart: input.monthStart,
    activeWeekCount,
    normalMonthlyLoad,
    monthlyThreshold,
    monthlyCompletionGap,
    debtCarryIn,
    debtCreatedThisMonth,
    totalDebtBeforeAllocation,
    taskAllocations,
    debtOffsetCount,
    thresholdFillCount,
    paidLessonCount: adjustedPaidLessonCount,
    debtCarryOut,
    grossAmountCents: grossAmountWithCorrections,
    correctionDebtDelta,
    correctionPaidCountDelta,
    correctionPaidCountAmountCents,
    correctionPaymentAmountDeltaCents,
    financialOffsetCarryIn,
    financialOffsetApplied,
    financialOffsetCarryOut,
    netAmountCents,
    hasMissingRate,
  };
}

export function tryToCents(amountTry: number): number {
  return Math.round(amountTry * 100);
}

export function centsToTry(cents: number): number {
  return Math.round(cents) / 100;
}
