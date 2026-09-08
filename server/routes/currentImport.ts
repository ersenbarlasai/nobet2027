import { Router, type Request, type Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";
import { fetchCurrentImportSnapshot } from "../services/currentImport";

/**
 * GET /api/timetable-imports/current
 *
 * Salt okunur: veritabanında hâlihazırda kayıtlı, tek-kampüs yapılandırması
 * için en güncel başarılı (status=imported) XML importunun özetini döner.
 * Hiçbir veri değiştirmez, hiçbir secret/bağlantı bilgisi/stack trace döndürmez.
 */
export function createCurrentImportRouter(supabase: SupabaseClient, config: AppConfig): Router {
  const router = Router();

  router.get("/current", async (_req: Request, res: Response) => {
    try {
      const snapshot = await fetchCurrentImportSnapshot(supabase, config.campusName, config.academicYearName);
      res.status(200).json(snapshot);
    } catch {
      // Ayrıntı (Postgres hata mesajı) kasıtlı olarak cevaba dahil edilmiyor —
      // yalnız kod tarafı, hiçbir kişisel veri/secret/bağlantı bilgisi içermiyor.
      // eslint-disable-next-line no-console
      console.error("[server] get_current_timetable_import_snapshot RPC çağrısı başarısız oldu.");
      res.status(500).json({
        error: "query_failed",
        message: "Mevcut ders programı bilgisi alınamadı.",
      });
    }
  });

  return router;
}
