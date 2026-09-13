import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";
import { addEducationCalendarClosure, deleteEducationCalendarClosure, listEducationCalendar, saveEducationTerm } from "../services/educationCalendar";
import { addClosureSchema, saveTermSchema } from "../validation/educationCalendar";

const bad = (r: any, m = "Geçersiz istek.") => r.status(400).json({ error: "validation_error", message: m });
const fail = (r: any) => r.status(500).json({ error: "query_failed", message: "İşlem tamamlanamadı." });

export function createEducationCalendarRouter(db: SupabaseClient, cfg: AppConfig) {
  const r = Router();
  r.get("/", async (_q, s) => {
    try { return s.json(await listEducationCalendar(db, cfg.campusName, cfg.academicYearName)); } catch { return fail(s); }
  });
  r.post("/term", async (q, s) => {
    const v = saveTermSchema.safeParse(q.body);
    if (!v.success) return bad(s, v.error.issues[0]?.message);
    try {
      const x = await saveEducationTerm(db, cfg.campusName, cfg.academicYearName, v.data);
      return x.status === "ok" ? s.json(x) : bad(s, "Eğitim dönemi kaydedilemedi.");
    } catch { return fail(s); }
  });
  r.post("/closures", async (q, s) => {
    const v = addClosureSchema.safeParse(q.body);
    if (!v.success) return bad(s, v.error.issues[0]?.message);
    try {
      const x = await addEducationCalendarClosure(db, cfg.campusName, cfg.academicYearName, v.data);
      return x.status === "ok" ? s.json(x) : bad(s, "Tatil aralığı eklenemedi.");
    } catch { return fail(s); }
  });
  r.delete("/closures/:id", async (q, s) => {
    try {
      const x = await deleteEducationCalendarClosure(db, cfg.campusName, q.params.id);
      return x.status === "ok" ? s.json(x) : s.status(404).json({ error: "not_found", message: "Tatil aralığı bulunamadı." });
    } catch { return fail(s); }
  });
  return r;
}
