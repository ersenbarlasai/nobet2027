import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";
import { validateImportRequest } from "../validation/importPayload";
import { toRpcPayload } from "../services/toRpcPayload";
import { importTimetableSnapshot, ImportRpcError } from "../services/importTimetable";
import { getImportBlockers } from "../services/substitutions";

/**
 * POST /api/timetable-imports
 *
 * Frontend'in doğrulanmış+normalize XML sonucunu kabul eder, sunucu
 * tarafında YENİDEN doğrular, RPC'ye devreder. Hata cevapları hiçbir
 * zaman secret, bağlantı bilgisi veya stack trace içermez.
 */
export function createTimetableImportsRouter(supabase: SupabaseClient, config: AppConfig): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response) => {
    const validation = validateImportRequest(req.body);
    if (!validation.ok) {
      res.status(400).json({ error: "invalid_payload", details: validation.errors });
      return;
    }

    const rpcPayload = toRpcPayload(validation.data, config.campusName, config.academicYearName);

    try {
      const blockers=await getImportBlockers(supabase,config.campusName,config.academicYearName) as {blocked?:boolean;items?:unknown[];currentSourceSha256?:string|null};
      const isExactCurrentFile=Boolean(validation.data.sourceSha256&&validation.data.sourceSha256===blockers.currentSourceSha256);
      if(blockers.blocked&&!isExactCurrentFile){res.status(409).json({error:"open_work_blocks_import",message:"XML'e bağlı açık çalışmalar tamamlanmadan veya silinmeden yeni XML yüklenemez.",items:blockers.items??[]});return;}
      const outcome = await importTimetableSnapshot(supabase, rpcPayload);
      res.status(200).json(outcome);
    } catch (err) {
      const referenceId = randomUUID();
      const message = err instanceof ImportRpcError ? err.message : "Beklenmeyen bir hata oluştu.";
      // Veritabanı ayrıntısı ve payload loglanmaz; yalnız takip kodu ve güvenli hata kodu tutulur.
      console.error(`[timetable-import] reference=${referenceId} code=${err instanceof ImportRpcError ? (err.code ?? "rpc_error") : "unexpected_error"}`);
      res.status(502).json({
        error: "import_failed",
        message: "Veriler kaydedilemedi. Veritabanında değişiklik yapılmadı.",
        detail: message,
        referenceId,
      });
    }
  });

  return router;
}
