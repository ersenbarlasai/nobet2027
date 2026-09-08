import { Router, type Request, type Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";
import { createDutyLocationSchema, listQuerySchema, updateDutyLocationSchema, uuidSchema } from "../validation/dutyLocations";
import {
  createDutyLocation,
  DutyLocationError,
  getOrCreateCampusId,
  listDutyLocations,
  softDeleteDutyLocation,
  updateDutyLocation,
} from "../services/dutyLocations";

function sendZodError(res: Response, fieldMessage: string) {
  res.status(400).json({ error: { code: "VALIDATION_ERROR", message: fieldMessage } });
}

function sendServiceError(res: Response, err: unknown) {
  if (err instanceof DutyLocationError) {
    const status = err.code === "NOT_FOUND" ? 404 : err.code === "CONFLICT" ? 409 : err.code === "DATABASE_ERROR" ? 500 : 400;
    res.status(status).json({ error: { code: err.code, message: err.message, field: err.field } });
    return;
  }
  // eslint-disable-next-line no-console
  console.error("[server] duty-locations: beklenmeyen hata.");
  res.status(500).json({ error: { code: "DATABASE_ERROR", message: "Beklenmeyen bir sunucu hatası oluştu." } });
}

/**
 * "Nöbet Yerleri" ekranı için CRUD API. Frontend hiçbir zaman Supabase'e
 * doğrudan bağlanmaz; yalnızca bu yerel backend uç noktalarını çağırır.
 * Hata cevapları secret/bağlantı bilgisi/stack trace döndürmez.
 */
export function createDutyLocationsRouter(supabase: SupabaseClient, config: AppConfig): Router {
  const router = Router();

  router.get("/", async (req: Request, res: Response) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendZodError(res, "Geçersiz sorgu parametreleri.");
      return;
    }
    try {
      const campusId = await getOrCreateCampusId(supabase, config.campusName);
      const result = await listDutyLocations(supabase, campusId, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      sendServiceError(res, err);
    }
  });

  router.post("/", async (req: Request, res: Response) => {
    const parsed = createDutyLocationSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: issue?.message ?? "Geçersiz istek.", field: issue?.path.join(".") },
      });
      return;
    }
    try {
      const campusId = await getOrCreateCampusId(supabase, config.campusName);
      const created = await createDutyLocation(supabase, campusId, parsed.data);
      res.status(201).json(created);
    } catch (err) {
      sendServiceError(res, err);
    }
  });

  router.patch("/:id", async (req: Request<{ id: string }>, res: Response) => {
    const idResult = uuidSchema.safeParse(req.params.id);
    if (!idResult.success) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Geçersiz kimlik." } });
      return;
    }
    if (typeof req.body !== "object" || req.body === null || Object.keys(req.body as object).length === 0) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Güncellenecek en az bir alan gerekli." } });
      return;
    }
    const parsed = updateDutyLocationSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: issue?.message ?? "Geçersiz istek.", field: issue?.path.join(".") },
      });
      return;
    }
    try {
      const campusId = await getOrCreateCampusId(supabase, config.campusName);
      const updated = await updateDutyLocation(supabase, campusId, idResult.data, parsed.data);
      res.status(200).json(updated);
    } catch (err) {
      sendServiceError(res, err);
    }
  });

  router.delete("/:id", async (req: Request<{ id: string }>, res: Response) => {
    const idResult = uuidSchema.safeParse(req.params.id);
    if (!idResult.success) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Geçersiz kimlik." } });
      return;
    }
    try {
      const campusId = await getOrCreateCampusId(supabase, config.campusName);
      await softDeleteDutyLocation(supabase, campusId, idResult.data);
      res.status(204).end();
    } catch (err) {
      sendServiceError(res, err);
    }
  });

  return router;
}
