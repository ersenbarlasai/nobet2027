import { Router, type Request, type Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";
import { fetchCurrentImportTeachers, fetchTeacherTimetableSnapshot } from "../services/teacherTimetables";
import {
  fetchTeacherDutyMatrix,
  saveTeacherDutyMatrix,
  TeacherDutyAvailabilityQueryError,
  type SaveDutyCellsReason,
} from "../services/teacherDutyAvailability";
import { saveDutyAvailabilitySchema } from "../validation/teacherDutyAvailability";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Kontrollü red gerekçelerinin kullanıcıya gösterilecek Türkçe karşılıkları.
 * Record<SaveDutyCellsReason, string> olduğu için RPC'ye yeni bir gerekçe
 * eklendiğinde derleme burada da güncelleme yapılmasını ZORUNLU kılar.
 */
const INVALID_CELLS_MESSAGES: Record<SaveDutyCellsReason, string> = {
  day_order_out_of_range: "Gün değeri 1-5 aralığında olmalı.",
  duty_location_not_available: "Seçilen nöbet yeri artık aktif değil. Güncel veriyi yükleyin.",
  duty_block_not_available: "Seçilen nöbet bloğu geçersiz. Güncel veriyi yükleyin.",
  block_not_allowed_for_location: "Bu nöbet yeri seçilen blokta görev istemiyor.",
  lesson_conflict: "Öğretmenin o gün çakışan dersi olduğu için bu blokta nöbet tutamaz.",
  fixed_assignment_only_location: "Bu nöbet yerine yalnız Sabit Nöbetler ekranından öğretmen atanabilir.",
  fixed_assignment_only_cell: "Bu blokta nöbetçi yalnız Sabit Nöbetler ekranından atanır; tercih olarak seçilemez.",
};

/**
 * "Öğretmen Ders Programı" ekranı için salt-okunur API. Frontend hiçbir zaman
 * Supabase'e doğrudan bağlanmaz; yalnızca bu yerel backend uç noktalarını
 * çağırır. Hiçbir uç nokta veri değiştirmez, secret/bağlantı bilgisi/stack
 * trace döndürmez.
 */
export function createTeacherTimetablesRouter(supabase: SupabaseClient, config: AppConfig): Router {
  const router = Router();

  router.get("/teachers", async (_req: Request, res: Response) => {
    try {
      const result = await fetchCurrentImportTeachers(supabase, config.campusName, config.academicYearName);
      res.status(200).json(result);
    } catch {
      // eslint-disable-next-line no-console
      console.error("[server] get_current_import_teachers RPC çağrısı başarısız oldu.");
      res.status(500).json({
        error: "query_failed",
        message: "Öğretmen listesi alınamadı.",
      });
    }
  });

  router.get("/teachers/:teacherId", async (req: Request<{ teacherId: string }>, res: Response) => {
    const { teacherId } = req.params;
    if (!UUID_PATTERN.test(teacherId)) {
      res.status(400).json({ error: "invalid_teacher_id", message: "Geçersiz öğretmen kimliği." });
      return;
    }
    try {
      const snapshot = await fetchTeacherTimetableSnapshot(supabase, config.campusName, config.academicYearName, teacherId);
      if (!snapshot.teacherFound) {
        res.status(404).json(snapshot);
        return;
      }
      res.status(200).json(snapshot);
    } catch {
      // eslint-disable-next-line no-console
      console.error("[server] get_teacher_timetable_snapshot RPC çağrısı başarısız oldu.");
      res.status(500).json({
        error: "query_failed",
        message: "Öğretmen ders programı alınamadı.",
      });
    }
  });

  router.get("/teachers/:teacherId/duty-availability", async (req: Request<{ teacherId: string }>, res: Response) => {
    const { teacherId } = req.params;
    if (!UUID_PATTERN.test(teacherId)) {
      res.status(400).json({ error: "invalid_teacher_id", message: "Geçersiz öğretmen kimliği." });
      return;
    }
    try {
      const matrix = await fetchTeacherDutyMatrix(supabase, config.campusName, config.academicYearName, teacherId);
      if (!matrix.teacherFound) {
        res.status(404).json(matrix);
        return;
      }
      res.status(200).json(matrix);
    } catch {
      // eslint-disable-next-line no-console
      console.error("[server] get_teacher_duty_matrix RPC çağrısı başarısız oldu.");
      res.status(500).json({
        error: "query_failed",
        message: "Nöbet uygunlukları alınamadı.",
      });
    }
  });

  router.put("/teachers/:teacherId/duty-availability", async (req: Request<{ teacherId: string }>, res: Response) => {
    const { teacherId } = req.params;
    if (!UUID_PATTERN.test(teacherId)) {
      res.status(400).json({ error: "invalid_teacher_id", message: "Geçersiz öğretmen kimliği." });
      return;
    }
    const parsed = saveDutyAvailabilitySchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      res.status(400).json({
        error: "validation_error",
        message: issue?.message ?? "Geçersiz istek.",
        field: issue?.path.join("."),
      });
      return;
    }
    try {
      const result = await saveTeacherDutyMatrix(supabase, config.campusName, config.academicYearName, teacherId, parsed.data);
      switch (result.status) {
        case "ok":
          res.status(200).json({ savedAt: result.updatedAt, updatedAt: result.updatedAt, halfDayRuleEnabled: result.halfDayRuleEnabled });
          return;
        case "not_found":
          res.status(404).json({ error: "not_found", message: "Öğretmen mevcut içe aktarmada bulunamadı." });
          return;
        case "conflict":
          res.status(409).json({
            error: "conflict",
            message: "Bu kayıt başka bir işlem tarafından güncellendi. Güncel veriyi yeniden yükleyin.",
            currentUpdatedAt: result.currentUpdatedAt,
          });
          return;
        case "invalid_cells":
          res.status(400).json({
            error: "invalid_cells",
            message: INVALID_CELLS_MESSAGES[result.reason],
            reason: result.reason,
          });
          return;
        case "fixed_day_locked":
          res.status(409).json({
            error: "fixed_day_locked",
            message: "Sabit nöbet bulunan günlerde hiçbir blokta uygunluk değiştirilemez.",
            lockedDayOrders: result.lockedDayOrders,
          });
          return;
      }
    } catch (err) {
      if (err instanceof TeacherDutyAvailabilityQueryError) {
        // eslint-disable-next-line no-console
        console.error("[server] save_teacher_duty_matrix RPC çağrısı başarısız oldu.");
      }
      res.status(500).json({
        error: "query_failed",
        message: "Nöbet uygunlukları kaydedilemedi.",
      });
    }
  });

  return router;
}
