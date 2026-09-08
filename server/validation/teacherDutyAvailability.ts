import { z } from "zod";

// "Nöbet Uygunluk Matrisi" PUT gövdesi için şema. "Gelen veriye güvenme"
// ilkesiyle yazıldı: DB, RPC içinde AYRICA doğrular (savunma derinliği) —
// bkz. supabase/migrations/20260910091000_create_teacher_duty_block_availability.sql
// save_teacher_duty_matrix. Yer×blok gereksinimi ve ders çakışması gibi iş
// kuralları BURADA TEKRARLANMAZ (bu katman öğretmenin ders programını
// bilmez); onlar yalnız RPC'de, tek bir yerde uygulanır.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const uuidSchema = z.string().regex(UUID_PATTERN, "Geçersiz kimlik.");

const cellSchema = z.object({
  dutyLocationId: uuidSchema,
  dayOrder: z.number().int().min(1, "Gün 1-5 aralığında olmalı.").max(5, "Gün 1-5 aralığında olmalı."),
  dutyBlockId: uuidSchema,
});

// Dört bloklu modelde bir hücre = (nöbet yeri × gün × blok). Gerçekçi üst
// sınır: sayfalama olmayan matriste makul en fazla nöbet yeri sayısı (~15)
// × 5 gün × 4 blok = 300. 2000, bu aralığın çok üzerinde bir güvenlik
// marjıdır ve aşırı büyük gövdeyi yine de reddeder.
const MAX_CELLS = 2000;

export const saveDutyAvailabilitySchema = z.object({
  isIncluded: z.boolean(),
  /**
   * Öğretmen bazlı yarım gün kuralı. Gönderilmezse (undefined) RPC mevcut
   * değeri KORUR — eski istemciler ayarı yanlışlıkla sıfırlayamaz. Kural
   * yalnız plan atamasını sınırlar, tercih girişini DEĞİL.
   */
  halfDayRuleEnabled: z.boolean().optional(),
  cells: z.array(cellSchema).max(MAX_CELLS, "Çok fazla hücre gönderildi."),
  expectedUpdatedAt: z
    .union([z.string().datetime({ offset: true }), z.null()])
    .optional()
    .transform((v) => v ?? null),
});

export type SaveDutyAvailabilityInput = z.infer<typeof saveDutyAvailabilitySchema>;
