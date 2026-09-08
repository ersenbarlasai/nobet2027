import { Router, type Request, type Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";
import { fetchDutyPlanFeasibility } from "../services/dutyPlanFeasibility";

/**
 * "Planlanabilirlik Analizi" ekranı için SALT OKUNUR API. Bu router hiçbir
 * yazma uç noktası içermez ve bilinçli olarak içermeyecektir: nöbet planı
 * üretimi ayrı bir aşamadır.
 */
export function createDutyPlanRouter(supabase: SupabaseClient, config: AppConfig): Router {
  const router = Router();

  router.get("/feasibility", async (_req: Request, res: Response) => {
    try {
      const result = await fetchDutyPlanFeasibility(supabase, config.campusName, config.academicYearName);
      res.status(200).json(result);
    } catch {
      // eslint-disable-next-line no-console
      console.error("[server] günlük/haftalık planlanabilirlik önizlemesi alınamadı.");
      res.status(500).json({ error: "query_failed", message: "Planlanabilirlik analizi alınamadı." });
    }
  });

  return router;
}
