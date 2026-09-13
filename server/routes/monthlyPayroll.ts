import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";
import {
  addPayrollCorrection, clearTeacherAbsenceDebt, closeMonthlyPayrollForTeacher, closeMonthlyPayrollPeriod,
  getMonthlyPayrollSnapshot, listAbsenceDebtYearEndClearances, listMonthlyPayrollPeriods,
  listMonthlyPayrollRelevantTeachers, listPayrollCorrections, previewMonthlyPayroll, setSubstitutionPayrollCompensationType,
} from "../services/monthlyPayroll";
import { closePeriodSchema, closeTeacherSchema, correctionSchema, monthQuery, setSubstitutionTypeSchema, teacherMonthQuery, yearEndClearSchema } from "../validation/monthlyPayroll";

const bad = (r: any, m = "Geçersiz istek.") => r.status(400).json({ error: "validation_error", message: m });
const fail = (r: any) => r.status(500).json({ error: "query_failed", message: "İşlem tamamlanamadı." });

const CLOSE_MESSAGES: Record<string, string> = {
  pending_education_calendar: "Kapanış bekliyor — eğitim takvimi eksik.",
  pending_compensation_type: "Kapanış bekliyor — ders yerine görevlendirme için ücret türü seçilmedi.",
  pending_unit_rate: "Kapanış bekliyor — bazı görevlerin tarihinde geçerli birim ücret eksik.",
};

export function createMonthlyPayrollRouter(db: SupabaseClient, cfg: AppConfig) {
  const r = Router();

  r.get("/periods", async (_q, s) => {
    try { return s.json({ items: await listMonthlyPayrollPeriods(db, cfg.campusName, cfg.academicYearName) }); } catch { return fail(s); }
  });

  r.get("/relevant-teachers", async (q, s) => {
    const v = monthQuery.safeParse(q.query);
    if (!v.success) return bad(s, v.error.issues[0]?.message);
    try { return s.json(await listMonthlyPayrollRelevantTeachers(db, cfg.campusName, cfg.academicYearName, v.data.monthStart)); } catch { return fail(s); }
  });

  r.get("/overview", async (q, s) => {
    const v = teacherMonthQuery.safeParse(q.query);
    if (!v.success) return bad(s, v.error.issues[0]?.message);
    try {
      const snapshot = await getMonthlyPayrollSnapshot(db, cfg.campusName, cfg.academicYearName, v.data.monthStart, v.data.teacherSourceId);
      if ((snapshot as { found?: boolean }).found !== false) return s.json({ source: "closed", ...snapshot });
      const preview = await previewMonthlyPayroll(db, cfg.campusName, cfg.academicYearName, v.data.teacherSourceId, v.data.monthStart);
      return s.json({ source: "preview", ...preview });
    } catch { return fail(s); }
  });

  r.post("/close-teacher", async (q, s) => {
    const v = closeTeacherSchema.safeParse(q.body);
    if (!v.success) return bad(s, v.error.issues[0]?.message);
    try {
      const x = await closeMonthlyPayrollForTeacher(db, cfg.campusName, cfg.academicYearName, v.data.teacherSourceId, v.data.monthStart);
      if (x.status === "ok" || x.status === "already_closed") return s.json(x);
      return s.status(409).json({ error: x.status, message: CLOSE_MESSAGES[x.status] ?? "Öğretmen için puantaj kapatılamadı." });
    } catch { return fail(s); }
  });

  r.post("/close-period", async (q, s) => {
    const v = closePeriodSchema.safeParse(q.body);
    if (!v.success) return bad(s, v.error.issues[0]?.message);
    try { return s.json(await closeMonthlyPayrollPeriod(db, cfg.campusName, cfg.academicYearName, v.data.monthStart)); } catch { return fail(s); }
  });

  r.get("/corrections", async (q, s) => {
    const v = teacherMonthQuery.safeParse(q.query);
    if (!v.success) return bad(s, v.error.issues[0]?.message);
    try { return s.json({ items: await listPayrollCorrections(db, cfg.campusName, cfg.academicYearName, v.data.monthStart, v.data.teacherSourceId) }); } catch { return fail(s); }
  });

  r.post("/corrections", async (q, s) => {
    const v = correctionSchema.safeParse(q.body);
    if (!v.success) return bad(s, v.error.issues[0]?.message);
    try {
      const x = await addPayrollCorrection(db, cfg.campusName, cfg.academicYearName, { ...v.data, createdBy: v.data.createdBy ?? "" });
      if (x.status === "ok") return s.json(x);
      const messages: Record<string, string> = { period_closed: "Kapanmış aya doğrudan düzeltme eklenemez; sonraki açık aya yazın.", validation_error: "Girilen bilgiler geçersiz." };
      return s.status(409).json({ error: x.status, message: messages[String(x.status)] ?? "Düzeltme eklenemedi." });
    } catch { return fail(s); }
  });

  r.post("/year-end-clear", async (q, s) => {
    const v = yearEndClearSchema.safeParse(q.body);
    if (!v.success) return bad(s, v.error.issues[0]?.message);
    try {
      const x = await clearTeacherAbsenceDebt(db, cfg.campusName, cfg.academicYearName, { ...v.data, createdBy: v.data.createdBy ?? "" });
      return x.status === "ok" ? s.json(x) : bad(s, "Yokluk borcu kapatılamadı.");
    } catch { return fail(s); }
  });

  r.get("/year-end-clearances", async (_q, s) => {
    try { return s.json({ items: await listAbsenceDebtYearEndClearances(db, cfg.campusName, cfg.academicYearName) }); } catch { return fail(s); }
  });

  r.post("/compensation-type", async (q, s) => {
    const v = setSubstitutionTypeSchema.safeParse(q.body);
    if (!v.success) return bad(s, v.error.issues[0]?.message);
    try {
      const x = await setSubstitutionPayrollCompensationType(db, cfg.campusName, v.data.typeId);
      return x.status === "ok" ? s.json(x) : bad(s, "Ücret türü kaydedilemedi.");
    } catch { return fail(s); }
  });

  return r;
}
