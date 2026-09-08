import { describe, expect, it } from "vitest";
import { classifyTeacherForCell, isEligibleStatus, validateGenerationOptions } from "../types";

describe("classifyTeacherForCell", () => {
  const base = {
    teacherSourceId: "T1",
    isCurrentAssignee: false,
    hasFixedDutyThatDay: false,
    hasOtherNormalDutyThatDay: false,
    totalWeeklyLoad: 0,
    maxWeeklyDuties: 3,
    hasCandidateEdge: true,
  };

  it("mevcut atanan öğretmen HER ZAMAN 'current' — yükü max olsa bile", () => {
    const status = classifyTeacherForCell({ ...base, isCurrentAssignee: true, totalWeeklyLoad: 3, maxWeeklyDuties: 3 });
    expect(status).toBe("current");
    expect(isEligibleStatus(status)).toBe(true);
  });

  it("aday kenarı var ama o gün başka normal görevi var → already_assigned_that_day", () => {
    const status = classifyTeacherForCell({ ...base, hasOtherNormalDutyThatDay: true });
    expect(status).toBe("already_assigned_that_day");
    expect(isEligibleStatus(status)).toBe(false);
  });

  it("aday kenarı var ama haftalık limite ulaşmış → weekly_limit_reached", () => {
    const status = classifyTeacherForCell({ ...base, totalWeeklyLoad: 3, maxWeeklyDuties: 3 });
    expect(status).toBe("weekly_limit_reached");
  });

  it("o gün sabit nöbeti var → fixed_duty_day (haftalık limitten ÖNCELİKLİ)", () => {
    const status = classifyTeacherForCell({ ...base, hasFixedDutyThatDay: true, totalWeeklyLoad: 3, maxWeeklyDuties: 3 });
    expect(status).toBe("fixed_duty_day");
  });

  it("aday kenarı var, hiçbir engel yok → eligible", () => {
    const status = classifyTeacherForCell({ ...base, totalWeeklyLoad: 1 });
    expect(status).toBe("eligible");
    expect(isEligibleStatus(status)).toBe(true);
  });

  it("temel aday kenarı YOK → birleşik dürüst gerekçe availability_or_time_conflict", () => {
    const status = classifyTeacherForCell({ ...base, hasCandidateEdge: false });
    expect(status).toBe("availability_or_time_conflict");
    expect(isEligibleStatus(status)).toBe(false);
  });
});

describe("validateGenerationOptions", () => {
  function valid(overrides: Partial<{ minWeeklyDuties: number; targetWeeklyDuties: number; maxWeeklyDuties: number; seed?: number }> = {}) {
    return { minWeeklyDuties: 1, targetWeeklyDuties: 2, maxWeeklyDuties: 3, ...overrides };
  }

  it("geçerli değerleri kabul eder", () => {
    expect(validateGenerationOptions(valid()).valid).toBe(true);
  });

  it("boş seed kabul edilir", () => {
    expect(validateGenerationOptions(valid({ seed: undefined })).valid).toBe(true);
  });

  it("geçerli tam sayı seed kabul edilir", () => {
    expect(validateGenerationOptions(valid({ seed: 42 })).valid).toBe(true);
  });

  it("ondalık seed reddedilir", () => {
    const result = validateGenerationOptions(valid({ seed: 4.5 }));
    expect(result.valid).toBe(false);
    expect(result.fieldErrors.seed).toBeDefined();
  });

  it("ondalık min/target/max reddedilir", () => {
    const result = validateGenerationOptions(valid({ minWeeklyDuties: 1.5 }));
    expect(result.valid).toBe(false);
    expect(result.fieldErrors.minWeeklyDuties).toBeDefined();
  });

  it("negatif değer reddedilir", () => {
    expect(validateGenerationOptions(valid({ minWeeklyDuties: -1 })).valid).toBe(false);
  });

  it("5 üstü değer reddedilir", () => {
    expect(validateGenerationOptions(valid({ maxWeeklyDuties: 6 })).valid).toBe(false);
  });

  it("geçersiz sıralama (min > target) reddedilir", () => {
    const result = validateGenerationOptions(valid({ minWeeklyDuties: 3, targetWeeklyDuties: 2 }));
    expect(result.valid).toBe(false);
  });

  it("geçersiz sıralama (target > max) reddedilir", () => {
    const result = validateGenerationOptions(valid({ targetWeeklyDuties: 4, maxWeeklyDuties: 3 }));
    expect(result.valid).toBe(false);
  });

  it("NaN/Infinity reddedilir (Number.isFinite kontrolü)", () => {
    expect(validateGenerationOptions(valid({ minWeeklyDuties: Number.NaN })).valid).toBe(false);
    expect(validateGenerationOptions(valid({ maxWeeklyDuties: Number.POSITIVE_INFINITY })).valid).toBe(false);
  });
});
