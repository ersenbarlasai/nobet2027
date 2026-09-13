import { Router, type Request, type Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";
import { clearTrialRecordsSchema } from "../validation/systemData";
import { clearTrialRecords, getTrialDataCounts, SystemDataError } from "../services/systemData";

function sendServiceError(res: Response, err: unknown, fallbackMessage: string) {
  if (err instanceof SystemDataError) {
    res.status(500).json({ error: { code: err.code, message: err.message } });
    return;
  }
  // eslint-disable-next-line no-console
  console.error("[server] system-data: beklenmeyen hata.");
  res.status(500).json({ error: { code: "DATABASE_ERROR", message: fallbackMessage } });
}

/**
 * "Sistem ve Veri" ekranı için API. Salt-okunur özet sayılar (GET) ve tek
 * transactionlık deneme kaydı temizleme (POST). Frontend hiçbir zaman
 * Supabase'e doğrudan bağlanmaz; service-role anahtarı yalnızca burada
 * (server/supabase.ts üzerinden) kullanılır.
 */
export function createSystemDataRouter(supabase: SupabaseClient, config: AppConfig): Router {
  const router = Router();

  router.get("/trial-data/counts", async (_req: Request, res: Response) => {
    try {
      const counts = await getTrialDataCounts(supabase, config.campusName, config.academicYearName);
      res.status(200).json(counts);
    } catch (err) {
      sendServiceError(res, err, "Kayıt sayıları alınamadı.");
    }
  });

  router.post("/trial-data/clear", async (req: Request, res: Response) => {
    const parsed = clearTrialRecordsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Onay ifadesi eksik veya hatalı." },
      });
      return;
    }
    try {
      const deleted = await clearTrialRecords(supabase, config.campusName, config.academicYearName);
      res.status(200).json({ deleted });
    } catch (err) {
      sendServiceError(res, err, "Kayıtlar temizlenemedi. Veritabanında değişiklik yapılmadı. Lütfen tekrar deneyin.");
    }
  });

  return router;
}
