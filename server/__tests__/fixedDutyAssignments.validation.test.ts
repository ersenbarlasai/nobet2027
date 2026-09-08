import { describe, expect, it } from "vitest";
import { createFixedDutyAssignmentSchema, fixedDutyAssignmentIdSchema } from "../validation/fixedDutyAssignments";

const valid = {
  teacherId: "10000000-0000-4000-8000-000000000001",
  dayOrder: 1,
  dutyLocationId: "20000000-0000-4000-8000-000000000002",
};

describe("fixed duty assignment validation", () => {
  it("geçerli atamayı kabul eder", () => {
    expect(createFixedDutyAssignmentSchema.safeParse(valid).success).toBe(true);
  });

  it.each([0, 6, 1.5])("geçersiz gün sırasını reddeder: %s", (dayOrder) => {
    expect(createFixedDutyAssignmentSchema.safeParse({ ...valid, dayOrder }).success).toBe(false);
  });

  it("bilinmeyen alanları ve geçersiz UUID'leri reddeder", () => {
    expect(createFixedDutyAssignmentSchema.safeParse({ ...valid, teacherId: "x", extra: true }).success).toBe(false);
    expect(fixedDutyAssignmentIdSchema.safeParse("x").success).toBe(false);
  });
});
