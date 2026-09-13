import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";
import { deleteAbsenceType, listAbsenceTypes, saveAbsenceType } from "../services/absenceTypes";
import { saveAbsenceTypeSchema } from "../validation/absenceTypes";

const bad = (r: any, m = "Geçersiz istek.") => r.status(400).json({ error: "validation_error", message: m });
const fail = (r: any) => r.status(500).json({ error: "query_failed", message: "İşlem tamamlanamadı." });

export function createAbsenceTypesRouter(db: SupabaseClient, cfg: AppConfig) {
  const r = Router();
  r.get("/", async (_q, s) => {
    try { return s.json(await listAbsenceTypes(db, cfg.campusName)); } catch { return fail(s); }
  });
  r.post("/", async (q, s) => {
    const v = saveAbsenceTypeSchema.safeParse(q.body);
    if (!v.success) return bad(s, v.error.issues[0]?.message);
    try {
      const x = await saveAbsenceType(db, cfg.campusName, v.data);
      if (x.status === "ok") return s.json(x);
      const messages: Record<string, string> = { not_found: "Yokluk türü bulunamadı.", validation_error: "Girilen bilgiler geçersiz." };
      return s.status(x.status === "not_found" ? 404 : 409).json({ error: x.status, message: messages[String(x.status)] ?? "Yokluk türü kaydedilemedi." });
    } catch { return fail(s); }
  });
  r.delete("/:id", async (q, s) => {
    const id = q.params.id;
    try {
      const x = await deleteAbsenceType(db, cfg.campusName, id);
      return x.status === "ok" ? s.json(x) : s.status(404).json({ error: "not_found", message: "Yokluk türü bulunamadı." });
    } catch { return fail(s); }
  });
  return r;
}
