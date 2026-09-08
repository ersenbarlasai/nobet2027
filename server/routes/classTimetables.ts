import { Router, type Request, type Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";
import { fetchCurrentImportClasses, fetchClassTimetableSnapshot } from "../services/classTimetables";

/**
 * "Sınıf Ders Programı" ekranı için salt-okunur API. Frontend hiçbir zaman
 * Supabase'e doğrudan bağlanmaz; yalnızca bu yerel backend uç noktalarını
 * çağırır. Hiçbir uç nokta veri değiştirmez, secret/bağlantı bilgisi/stack
 * trace döndürmez.
 */
export function createClassTimetablesRouter(supabase: SupabaseClient, config: AppConfig): Router {
  const router = Router();

  router.get("/classes", async (_req: Request, res: Response) => {
    try {
      const result = await fetchCurrentImportClasses(supabase, config.campusName, config.academicYearName);
      res.status(200).json(result);
    } catch {
      // eslint-disable-next-line no-console
      console.error("[server] get_current_import_classes RPC çağrısı başarısız oldu.");
      res.status(500).json({
        error: "query_failed",
        message: "Sınıf listesi alınamadı.",
      });
    }
  });

  router.get("/classes/:classId", async (req: Request<{ classId: string }>, res: Response) => {
    const { classId } = req.params;
    try {
      const snapshot = await fetchClassTimetableSnapshot(supabase, config.campusName, config.academicYearName, classId);
      if (!snapshot.classFound) {
        res.status(404).json(snapshot);
        return;
      }
      res.status(200).json(snapshot);
    } catch {
      // eslint-disable-next-line no-console
      console.error("[server] get_class_timetable_snapshot RPC çağrısı başarısız oldu.");
      res.status(500).json({
        error: "query_failed",
        message: "Sınıf ders programı alınamadı.",
      });
    }
  });

  return router;
}
