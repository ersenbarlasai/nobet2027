import { describe, expect, it } from "vitest";
import { createDutyLocationSchema, listQuerySchema, updateDutyLocationSchema, uuidSchema } from "../validation/dutyLocations";

function validCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Ön Bahçe",
    shortCode: "ON-BAH",
    category: "garden",
    capacity: 2,
    description: null,
    isActive: true,
    blockPolicies: [
      { dutyBlockId: "aaaaaaaa-0000-0000-0000-000000000001", assignmentMode: "normal" },
      { dutyBlockId: "aaaaaaaa-0000-0000-0000-000000000002", assignmentMode: "normal" },
      { dutyBlockId: "aaaaaaaa-0000-0000-0000-000000000003", assignmentMode: "normal" },
      { dutyBlockId: "aaaaaaaa-0000-0000-0000-000000000004", assignmentMode: "normal" },
    ],
    ...overrides,
  };
}

describe("createDutyLocationSchema", () => {
  it("geçerli gövdeyi kabul eder", () => {
    const result = createDutyLocationSchema.safeParse(validCreateBody());
    expect(result.success).toBe(true);
  });

  it("5) shortCode küçük harften büyük harfe normalize edilir", () => {
    const result = createDutyLocationSchema.safeParse(validCreateBody({ shortCode: "on-bah" }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.shortCode).toBe("ON-BAH");
  });

  it("shortCode baş/son tire ile reddedilir", () => {
    expect(createDutyLocationSchema.safeParse(validCreateBody({ shortCode: "-ONBAH" })).success).toBe(false);
    expect(createDutyLocationSchema.safeParse(validCreateBody({ shortCode: "ONBAH-" })).success).toBe(false);
  });

  it("shortCode ardışık çift tire ile reddedilir", () => {
    expect(createDutyLocationSchema.safeParse(validCreateBody({ shortCode: "ON--BAH" })).success).toBe(false);
  });

  it("shortCode Türkçe karakterle reddedilir (kayıplı dönüştürme yapılmaz)", () => {
    expect(createDutyLocationSchema.safeParse(validCreateBody({ shortCode: "ÖN-BAH" })).success).toBe(false);
  });

  it("shortCode 1 karakterken reddedilir, 16 karakterken kabul edilir", () => {
    expect(createDutyLocationSchema.safeParse(validCreateBody({ shortCode: "A" })).success).toBe(false);
    expect(createDutyLocationSchema.safeParse(validCreateBody({ shortCode: "A".repeat(16) })).success).toBe(true);
    expect(createDutyLocationSchema.safeParse(validCreateBody({ shortCode: "A".repeat(17) })).success).toBe(false);
  });

  it("9) capacity 0 ve 21 reddedilir; 1 ve 20 kabul edilir", () => {
    expect(createDutyLocationSchema.safeParse(validCreateBody({ capacity: 0 })).success).toBe(false);
    expect(createDutyLocationSchema.safeParse(validCreateBody({ capacity: 21 })).success).toBe(false);
    expect(createDutyLocationSchema.safeParse(validCreateBody({ capacity: 1 })).success).toBe(true);
    expect(createDutyLocationSchema.safeParse(validCreateBody({ capacity: 20 })).success).toBe(true);
  });

  it("capacity tam sayı olmayınca reddedilir", () => {
    expect(createDutyLocationSchema.safeParse(validCreateBody({ capacity: 2.5 })).success).toBe(false);
  });

  it("10) boş/whitespace açıklama null'a normalize edilir", () => {
    const result = createDutyLocationSchema.safeParse(validCreateBody({ description: "   " }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.description).toBeNull();
  });

  it("açıklama 300 karakteri aşınca reddedilir", () => {
    expect(createDutyLocationSchema.safeParse(validCreateBody({ description: "a".repeat(301) })).success).toBe(false);
    expect(createDutyLocationSchema.safeParse(validCreateBody({ description: "a".repeat(300) })).success).toBe(true);
  });

  it("geçersiz kategori reddedilir", () => {
    expect(createDutyLocationSchema.safeParse(validCreateBody({ category: "hangar" })).success).toBe(false);
  });

  it("name 2 karakterden kısa veya 80'den uzunsa reddedilir", () => {
    expect(createDutyLocationSchema.safeParse(validCreateBody({ name: "A" })).success).toBe(false);
    expect(createDutyLocationSchema.safeParse(validCreateBody({ name: "a".repeat(81) })).success).toBe(false);
    expect(createDutyLocationSchema.safeParse(validCreateBody({ name: "a".repeat(80) })).success).toBe(true);
  });

  it("name trim edilir", () => {
    const result = createDutyLocationSchema.safeParse(validCreateBody({ name: "  Ön Bahçe  " }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("Ön Bahçe");
  });

  it("isActive belirtilmezse varsayılan true olur", () => {
    const body = validCreateBody();
    delete (body as Record<string, unknown>).isActive;
    const result = createDutyLocationSchema.safeParse(body);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.isActive).toBe(true);
  });
});

describe("updateDutyLocationSchema", () => {
  it("tek bir alan gönderilmesine izin verir", () => {
    expect(updateDutyLocationSchema.safeParse({ capacity: 5 }).success).toBe(true);
  });

  it("boş gövde reddedilir", () => {
    expect(updateDutyLocationSchema.safeParse({}).success).toBe(false);
  });
});

describe("uuidSchema", () => {
  it("geçerli UUID kabul edilir, geçersiz reddedilir", () => {
    expect(uuidSchema.safeParse("22222222-2222-2222-2222-222222222222").success).toBe(true);
    expect(uuidSchema.safeParse("not-a-uuid").success).toBe(false);
  });
});

describe("listQuerySchema", () => {
  it("varsayılanları uygular", () => {
    const result = listQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ search: "", category: "", status: "all", sort: "order", page: 1, pageSize: 10 });
    }
  });

  it("page/pageSize string query değerlerini sayıya çevirir", () => {
    const result = listQuerySchema.safeParse({ page: "2", pageSize: "25" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(2);
      expect(result.data.pageSize).toBe(25);
    }
  });

  it("geçersiz status reddedilir", () => {
    expect(listQuerySchema.safeParse({ status: "unknown" }).success).toBe(false);
  });
});
