import { z } from "zod";

export const CLEAR_TRIAL_RECORDS_CONFIRMATION = "KAYITLARI TEMİZLE";

// Modal zaten kullanıcıya bu ifadeyi yazdırıyor; sunucu tarafı bu alanı
// AYRICA doğrular (savunma derinliği — yalnız arayüz doğrulamasına güvenilmez).
export const clearTrialRecordsSchema = z.object({
  confirmationText: z.literal(CLEAR_TRIAL_RECORDS_CONFIRMATION),
});
