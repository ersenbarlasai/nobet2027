import { describe, expect, it } from "vitest";
import { computeMonthlyPayroll, tryToCents, type ActiveWeekInput, type MonthlyPayrollEngineInput, type QualifyingLessonInput } from "../services/monthlyPayrollEngine";

const RATE = tryToCents(500); // 500 TRY birim ücret

function weeks(loads: number[], monthStart = "2026-11"): ActiveWeekInput[] {
  return loads.map((load, index) => ({
    weekMonday: `${monthStart}-${String(index * 7 + 2).padStart(2, "0")}`,
    timetableImportId: "xml-1",
    normalWeeklyLoad: load,
  }));
}

function lessons(count: number, startDay = 1): QualifyingLessonInput[] {
  return Array.from({ length: count }, (_, i) => ({
    taskId: `t${i}`,
    assignmentDate: `2026-11-${String(startDay + i).padStart(2, "0")}`,
    periodOrder: 1,
    unitRateCents: RATE,
  }));
}

/** Eşiği tam karşılayan haftalar (gap=0) — ücret/düzeltme testlerini borç/eşik dışında izole eder. */
const noGapWeeks = () => weeks([28, 28, 28, 28]);

function baseInput(overrides: Partial<MonthlyPayrollEngineInput> = {}): MonthlyPayrollEngineInput {
  return {
    teacherSourceId: "T1",
    monthStart: "2026-11-01",
    activeWeeks: weeks([26, 26, 26, 26]),
    carryInDebt: 0,
    debtCreatedThisMonth: 0,
    qualifyingLessons: [],
    carryInFinancialOffsetCents: 0,
    corrections: [],
    ...overrides,
  };
}

describe("monthlyPayrollEngine — temel örnekler (spesifikasyon)", () => {
  it("örnek 1: 26 saat/hafta, 4 hafta, devreden 2 + bu ay 3 borç, 14 ek ders -> 1 ücretli ders, 0 devreden borç", () => {
    const result = computeMonthlyPayroll(
      baseInput({ carryInDebt: 2, debtCreatedThisMonth: 3, qualifyingLessons: lessons(14) }),
    );
    expect(result.normalMonthlyLoad).toBe(104);
    expect(result.monthlyThreshold).toBe(112);
    expect(result.monthlyCompletionGap).toBe(8);
    expect(result.debtOffsetCount).toBe(5);
    expect(result.thresholdFillCount).toBe(8);
    expect(result.paidLessonCount).toBe(1);
    expect(result.debtCarryOut).toBe(0);
    expect(result.grossAmountCents).toBe(RATE);
  });

  it("örnek 2: 30 saat/hafta, 5 borç, 2 ek ders -> 3 borç devreder, ödeme yok", () => {
    const result = computeMonthlyPayroll(
      baseInput({ activeWeeks: weeks([30, 30, 30, 30]), debtCreatedThisMonth: 5, qualifyingLessons: lessons(2) }),
    );
    expect(result.monthlyCompletionGap).toBe(0); // 30*4=120 >= 112 eşik
    expect(result.debtOffsetCount).toBe(2);
    expect(result.debtCarryOut).toBe(3);
    expect(result.paidLessonCount).toBe(0);
    expect(result.grossAmountCents).toBe(0);
  });
});

describe("30 zorunlu test senaryosunun hesap-motoru ile kapsanan kısmı", () => {
  it("5. Devreden borç ek derslerden önce kapanır", () => {
    const result = computeMonthlyPayroll(baseInput({ carryInDebt: 3, qualifyingLessons: lessons(1) }));
    expect(result.taskAllocations[0].disposition).toBe("debt_offset");
    expect(result.debtCarryOut).toBe(2);
  });

  it("6. Ay sonu sonucu, ek derslerin işlenme sırasından etkilenmez (girdi sırası değil, tarih+ders saati sırası kullanılır)", () => {
    const inOrder = lessons(6);
    const shuffled = [inOrder[3], inOrder[0], inOrder[5], inOrder[1], inOrder[4], inOrder[2]];
    const a = computeMonthlyPayroll(baseInput({ debtCreatedThisMonth: 2, qualifyingLessons: inOrder }));
    const b = computeMonthlyPayroll(baseInput({ debtCreatedThisMonth: 2, qualifyingLessons: shuffled }));
    expect(a.debtCarryOut).toBe(b.debtCarryOut);
    expect(a.paidLessonCount).toBe(b.paidLessonCount);
    expect(a.grossAmountCents).toBe(b.grossAmountCents);
    expect(a.taskAllocations.map((t) => t.taskId)).toEqual(b.taskAllocations.map((t) => t.taskId));
  });

  it("7. Normal 26 saat, 4 aktif hafta, 14 ek ders, 5 borç -> 1 ücretli ders", () => {
    const result = computeMonthlyPayroll(baseInput({ debtCreatedThisMonth: 5, qualifyingLessons: lessons(14) }));
    expect(result.paidLessonCount).toBe(1);
  });

  it("8. Normal 30 saat, 5 borç, 2 ek ders -> 3 borç devreder, ödeme yok", () => {
    const result = computeMonthlyPayroll(
      baseInput({ activeWeeks: weeks([30, 30, 30, 30]), debtCreatedThisMonth: 5, qualifyingLessons: lessons(2) }),
    );
    expect(result.debtCarryOut).toBe(3);
    expect(result.grossAmountCents).toBe(0);
  });

  it("9. 28 saat eksiği sonraki aya taşınmaz (kalan gap atılır, borç değil)", () => {
    const result = computeMonthlyPayroll(baseInput({ qualifyingLessons: lessons(2) })); // gap=8, sadece 2 ek ders
    expect(result.monthlyCompletionGap).toBe(8);
    expect(result.thresholdFillCount).toBe(2);
    // Sonraki aya "gap carry" alanı motor çıktısında hiç yok — kasıtlı olarak yalnız debtCarryOut taşınır.
    expect(result.debtCarryOut).toBe(0);
  });

  it("10. Yokluk borcu sonraki aya taşınır", () => {
    const result = computeMonthlyPayroll(baseInput({ debtCreatedThisMonth: 4, qualifyingLessons: [] }));
    expect(result.debtCarryOut).toBe(4);
  });

  it("16. 5-ÖÖ / 5-İÖ gibi periyotlar da birer ders saatidir (motor periodOrder'a bakmaz, her kaydı 1 sayar)", () => {
    const result = computeMonthlyPayroll(baseInput({ debtCreatedThisMonth: 1, qualifyingLessons: [{ taskId: "x", assignmentDate: "2026-11-05", periodOrder: 5, unitRateCents: RATE }] }));
    expect(result.debtOffsetCount).toBe(1);
  });

  it("20/28. Aynı görev iki kez sayılmaz — girdi zaten tekil taskId varsayar, motor idempotenttir", () => {
    const a = computeMonthlyPayroll(baseInput({ qualifyingLessons: lessons(3) }));
    const b = computeMonthlyPayroll(baseInput({ qualifyingLessons: lessons(3) }));
    expect(a).toEqual(b);
  });

  it("24. Negatif mali mahsup negatif ödeme üretmez; kalan tutar sonraki aya mali mahsup olarak taşınır", () => {
    const result = computeMonthlyPayroll(
      baseInput({ activeWeeks: noGapWeeks(), qualifyingLessons: lessons(1), corrections: [{ id: "c1", type: "payment_amount_adjust", amount: -tryToCents(1000) }] }),
    );
    expect(result.netAmountCents).toBe(0);
    expect(result.financialOffsetCarryOut).toBe(tryToCents(1000) - RATE);
  });

  it("mali mahsup: devreden negatif bakiye sonraki pozitif ödemeden önce uygulanır", () => {
    const result = computeMonthlyPayroll(baseInput({ activeWeeks: noGapWeeks(), qualifyingLessons: lessons(2), carryInFinancialOffsetCents: RATE }));
    expect(result.financialOffsetApplied).toBe(RATE);
    expect(result.netAmountCents).toBe(RATE);
    expect(result.financialOffsetCarryOut).toBe(0);
  });

  it("25. Birim ücret değişikliği geçmiş görevin tutarını değiştirmez (motor her görevin kendi rate'ini kullanır)", () => {
    const mixed: QualifyingLessonInput[] = [
      { taskId: "a", assignmentDate: "2026-11-01", periodOrder: 1, unitRateCents: tryToCents(400) },
      { taskId: "b", assignmentDate: "2026-11-20", periodOrder: 1, unitRateCents: tryToCents(600) },
    ];
    const result = computeMonthlyPayroll(baseInput({ activeWeeks: noGapWeeks(), qualifyingLessons: mixed }));
    expect(result.grossAmountCents).toBe(tryToCents(400) + tryToCents(600));
  });

  it("13. Pazartesinin ait olduğu ay hafta sahipliğini belirler (girdi olarak zaten o ay için verilen haftalar toplanır)", () => {
    const result = computeMonthlyPayroll(baseInput({ activeWeeks: weeks([26, 26]) }));
    expect(result.activeWeekCount).toBe(2);
    expect(result.monthlyThreshold).toBe(56);
  });

  it("ücreti eksik görev varsa rate_missing olarak işaretlenir ve dönem kapanamaz", () => {
    const result = computeMonthlyPayroll(
      baseInput({ activeWeeks: noGapWeeks(), qualifyingLessons: [{ taskId: "x", assignmentDate: "2026-11-05", periodOrder: 1, unitRateCents: null }] }),
    );
    expect(result.hasMissingRate).toBe(true);
    expect(result.taskAllocations[0].disposition).toBe("rate_missing");
  });

  it("paid_count_adjust düzeltmesi düzeltme tarihindeki birim ücretle tutara çevrilir", () => {
    const result = computeMonthlyPayroll(
      baseInput({ activeWeeks: noGapWeeks(), corrections: [{ id: "c1", type: "paid_count_adjust", amount: 2, unitRateCentsAtCorrection: RATE }] }),
    );
    expect(result.paidLessonCount).toBe(2);
    expect(result.grossAmountCents).toBe(RATE * 2);
  });

  it("debt_adjust düzeltmesi borcu azaltabilir ama 0'ın altına düşürmez", () => {
    const result = computeMonthlyPayroll(baseInput({ debtCreatedThisMonth: 2, corrections: [{ id: "c1", type: "debt_adjust", amount: -10 }] }));
    expect(result.debtCarryOut).toBe(0);
  });
});
