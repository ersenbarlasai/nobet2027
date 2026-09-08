import { Router, type Request, type Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";
import { createFixedDutyAssignmentSchema, fixedDutyAssignmentIdSchema } from "../validation/fixedDutyAssignments";
import { createFixedDutyAssignment, deleteFixedDutyAssignment, fetchFixedDutyAssignments } from "../services/fixedDutyAssignments";

export function createFixedDutyAssignmentsRouter(supabase: SupabaseClient, config: AppConfig): Router {
  const router = Router();

  router.get("/", async (_req: Request, res: Response) => {
    try {
      res.status(200).json(await fetchFixedDutyAssignments(supabase, config.campusName, config.academicYearName));
    } catch {
      res.status(500).json({ error: "query_failed", message: "Sabit nöbetler alınamadı." });
    }
  });

  router.post("/", async (req: Request, res: Response) => {
    const parsed = createFixedDutyAssignmentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "validation_error", message: parsed.error.issues[0]?.message ?? "Geçersiz istek." });
      return;
    }
    try {
      const result = await createFixedDutyAssignment(supabase, config.campusName, config.academicYearName, parsed.data);
      if (result.status === "ok") {
        res.status(201).json(result);
        return;
      }
      if (result.status === "location_conflict") {
        res.status(409).json({ error: result.status, message: "Bu gün ve nöbet yerine başka bir öğretmen sabitlenmiş." });
        return;
      }
      if (result.status === "teacher_conflict") {
        res.status(409).json({ error: result.status, message: "Bu öğretmen aynı gün başka bir nöbet yerine sabitlenmiş." });
        return;
      }
      if (result.status === "location_not_fixed_eligible") {
        res.status(400).json({
          error: result.status,
          message: "Bu nöbet yerine sabit nöbet atanamaz. Sabit nöbet yalnız ilkokul koridorlarına verilebilir.",
        });
        return;
      }
      const status = result.status.endsWith("not_found") ? 404 : 400;
      res.status(status).json({ error: result.status, message: "Öğretmen, gün veya nöbet yeri bulunamadı." });
    } catch {
      res.status(500).json({ error: "query_failed", message: "Sabit nöbet kaydedilemedi." });
    }
  });

  router.delete("/:assignmentId", async (req: Request<{ assignmentId: string }>, res: Response) => {
    const parsed = fixedDutyAssignmentIdSchema.safeParse(req.params.assignmentId);
    if (!parsed.success) {
      res.status(400).json({ error: "validation_error", message: parsed.error.issues[0]?.message });
      return;
    }
    try {
      const result = await deleteFixedDutyAssignment(supabase, config.campusName, config.academicYearName, parsed.data);
      if (result === "not_found") {
        res.status(404).json({ error: "not_found", message: "Sabit nöbet bulunamadı." });
        return;
      }
      res.status(204).end();
    } catch {
      res.status(500).json({ error: "query_failed", message: "Sabit nöbet kaldırılamadı." });
    }
  });

  return router;
}
