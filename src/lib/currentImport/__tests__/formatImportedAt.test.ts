import { describe, expect, it } from "vitest";
import { formatImportedAt } from "../formatImportedAt";

describe("formatImportedAt", () => {
  it("16) UTC zaman damgasını tr-TR/Europe-Istanbul biçiminde metne çevirir", () => {
    // 2026-08-31T20:15:00Z UTC → Europe/Istanbul'da (UTC+3, yaz saati sonrası
    // sabit) 23:15. Veritabanındaki UTC değeri bu fonksiyon tarafından
    // DEĞİŞTİRİLMEZ — yalnızca görüntüleme metni üretilir.
    expect(formatImportedAt("2026-08-31T20:15:00Z")).toBe("31 Ağustos 2026, 23:15");
  });

  it("farklı bir ay/gün için de doğru biçimlendirir", () => {
    expect(formatImportedAt("2026-01-05T10:00:00Z")).toBe("5 Ocak 2026, 13:00");
  });
});
