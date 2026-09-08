import { Router, type Request, type Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";
import {
  generateDutyPlanDraftSchema,
  dutyPlanIdSchema,
  dutyPlanTaskIdSchema,
  updateDutyPlanAssignmentSchema,
  regenerateDutyPlanDraftSchema,
  publishDutyPlanDraftSchema,
  previewDutyPlanManualPackageSchema,
  setDutyPlanManualPackageSchema,
  dutyPlanScoreSnapshotQuerySchema,
  dutyPlanHistoryMutationSchema,
} from "../validation/dutyPlanDrafts";
import { fetchDutyPlanGenerationSnapshot, fetchTeacherDutyScoreSnapshot, generateDutyPlanDraft, regenerateDutyPlanDraft } from "../services/dutyPlanGeneration";
import {
  deleteDutyPlanDraft,
  fetchCurrentDutyPlanDraft,
  fetchDutyPlanDraft,
  fetchDutyPlanTaskCandidates,
  updateDutyPlanAssignment,
  publishDutyPlanDraft,
  fetchPublishedDutyPlan,
  previewDutyPlanManualPackage,
  setDutyPlanManualPackage,
  fetchDutyPlanHistory,
  fetchDutyPlanHistoryDetail,
  createDutyPlanRevision,
  archivePublishedDutyPlan,
} from "../services/dutyPlanDrafts";

/**
 * Otomatik nöbet planı TASLAĞI üretimi + okuma + silme + manuel düzenleme +
 * yeniden üretme + yayımlama. Görev/aday hesaplama kuralları burada TEKRAR
 * YAZILMAZ — server/lib/dutyPlanning/solver.ts ve ilgili RPC'ler (bkz.
 * 20260915090000_create_automatic_duty_plan_drafts.sql,
 * 20260917090000_add_manual_assignment_and_publish.sql) tek kaynaktır.
 */
export function createDutyPlanDraftsRouter(supabase: SupabaseClient, config: AppConfig): Router {
  const router = Router();

  router.get("/preparation", async (_req: Request, res: Response) => {
    try {
      const snapshot = await fetchDutyPlanGenerationSnapshot(supabase, config.campusName, config.academicYearName);
      res.status(200).json(snapshot);
    } catch {
      // eslint-disable-next-line no-console
      console.error("[server] get_duty_plan_generation_snapshot RPC çağrısı başarısız oldu.");
      res.status(500).json({ error: "query_failed", message: "Üretim hazırlık verisi alınamadı." });
    }
  });

  router.get("/score-snapshot", async (req: Request, res: Response) => {
    const parsed = dutyPlanScoreSnapshotQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "validation_error", message: parsed.error.issues[0]?.message ?? "Geçersiz hafta." });
      return;
    }
    try {
      res.status(200).json(await fetchTeacherDutyScoreSnapshot(
        supabase,
        config.campusName,
        config.academicYearName,
        parsed.data.weekStartDate,
      ));
    } catch {
      console.error("[server] get_teacher_duty_score_snapshot RPC çağrısı başarısız oldu.");
      res.status(500).json({ error: "query_failed", message: "Öğretmen nöbet puanları alınamadı." });
    }
  });

  router.post("/drafts/generate", async (req: Request, res: Response) => {
    const parsed = generateDutyPlanDraftSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "validation_error", message: parsed.error.issues[0]?.message ?? "Geçersiz istek." });
      return;
    }
    try {
      const result = await generateDutyPlanDraft(
        supabase,
        config.campusName,
        config.academicYearName,
        parsed.data.options,
        parsed.data.expectedPlanId,
        parsed.data.weekStartDate,
        parsed.data.activeDayOrders,
      );
      switch (result.status) {
        case "ok":
          res.status(201).json(result);
          return;
        case "no_import":
          res.status(409).json({ error: result.status, message: "Şu anda içe aktarılmış bir ders programı yok." });
          return;
        case "partial_not_allowed":
          res.status(409).json({
            error: result.status,
            message: "Açık (atanamayan) görevler var; allowPartial=false ile taslak oluşturulamaz.",
            uncoveredCount: result.uncoveredCount,
            totalTaskCount: result.totalTaskCount,
          });
          return;
        case "source_changed":
          res.status(409).json({
            error: result.status,
            message: "Kaynak veri (import, öğretmen tercihleri, sabit nöbetler) üretim sırasında değişti. Lütfen tekrar deneyin.",
            currentSourceFingerprint: result.currentSourceFingerprint,
          });
          return;
        case "invalid_assignment":
          res.status(400).json({ error: result.status, message: "Üretilen atamalar geçersiz.", reason: result.reason });
          return;
        case "invalid_summary":
          // Kısmi/çelişkili bir özet ASLA kaydedilmez — bu, sunucunun kendi
          // hesabıyla veritabanının yeniden hesabı arasında bir tutarsızlığa
          // işaret eder (istemci hatası değil, savunma amaçlı). authoritative
          // alanı hata ayıklama için döner, secret/stack İÇERMEZ.
          res.status(500).json({
            error: result.status,
            message: "Üretim özeti veritabanının yeniden hesapladığı değerlerle uyuşmuyor.",
            authoritative: result.authoritative,
          });
          return;
        case "teacher_day_conflict":
          res.status(409).json({
            error: result.status,
            message:
              result.reason === "daily_package_limit"
                ? "Yeni nöbet modelinde bir öğretmene aynı gün yalnız bir normal görev paketi verilebilir."
                : result.reason === "half_day_rule"
                ? "Yarım gün kuralı açık bir öğretmene aynı gün birden fazla normal görev verildi."
                : "Bir öğretmen aynı gün birden fazla göreve atandı.",
            reason: result.reason,
          });
          return;
        case "teacher_block_conflict":
          res.status(409).json({ error: result.status, message: "Bir öğretmen aynı gün aynı nöbet bloğunda iki farklı yere atandı." });
          return;
        case "invalid_locked_assignment":
          // Kural 9: korunması istenen manuel atama güncel kurallarla çelişiyor.
          // SESSİZ silme/düzeltme YOK — hangi atamaların neden geçersiz olduğu
          // yapılandırılmış biçimde döner (SQL/stack İÇERMEZ).
          res.status(409).json({
            error: result.status,
            message: "Korunması istenen manuel atamalar güncel kurallarla çelişiyor. Yeniden üretmeden önce bu atamaları düzeltin veya manuel atamaları temizlemeyi onaylayın.",
            violations: result.violations,
          });
          return;
        case "teacher_has_fixed_duty":
          res.status(409).json({ error: result.status, message: "Sabit nöbeti olan bir öğretmene aynı gün normal görev verildi." });
          return;
        case "weekly_limit_exceeded":
          res.status(409).json({ error: result.status, message: "Haftalık üst sınır aşıldı." });
          return;
        case "fixed_assignment_changed":
          res.status(409).json({ error: result.status, message: "Sabit nöbet ataması üretim sırasında değişti." });
          return;
        case "version_conflict":
          res.status(409).json({ error: result.status, message: "Eşzamanlı bir üretim isteği taslağı değiştirdi.", currentPlanId: result.currentPlanId, currentVersion: result.currentVersion });
          return;
        default:
          res.status(500).json({ error: "internal_error", message: "Beklenmeyen bir durum oluştu." });
      }
    } catch {
      // eslint-disable-next-line no-console
      console.error("[server] nöbet planı taslağı üretimi başarısız oldu.");
      res.status(500).json({ error: "query_failed", message: "Nöbet planı taslağı üretilemedi." });
    }
  });

  router.get("/drafts/current", async (_req: Request, res: Response) => {
    try {
      const result = await fetchCurrentDutyPlanDraft(supabase, config.campusName, config.academicYearName);
      res.status(200).json(result);
    } catch {
      // eslint-disable-next-line no-console
      console.error("[server] get_current_duty_plan_draft RPC çağrısı başarısız oldu.");
      res.status(500).json({ error: "query_failed", message: "Aktif nöbet planı taslağı alınamadı." });
    }
  });

  router.get("/drafts/:planId", async (req: Request<{ planId: string }>, res: Response) => {
    const parsed = dutyPlanIdSchema.safeParse(req.params.planId);
    if (!parsed.success) {
      res.status(400).json({ error: "validation_error", message: parsed.error.issues[0]?.message });
      return;
    }
    try {
      const result = await fetchDutyPlanDraft(supabase, config.campusName, config.academicYearName, parsed.data);
      if (!result.found) {
        res.status(404).json({ error: "not_found", message: "Nöbet planı bulunamadı." });
        return;
      }
      res.status(200).json(result);
    } catch {
      // eslint-disable-next-line no-console
      console.error("[server] get_duty_plan_draft RPC çağrısı başarısız oldu.");
      res.status(500).json({ error: "query_failed", message: "Nöbet planı alınamadı." });
    }
  });

  router.get("/published/current", async (_req: Request, res: Response) => {
    try {
      const result = await fetchPublishedDutyPlan(supabase, config.campusName, config.academicYearName);
      res.status(200).json(result);
    } catch {
      // eslint-disable-next-line no-console
      console.error("[server] get_published_duty_plan RPC çağrısı başarısız oldu.");
      res.status(500).json({ error: "query_failed", message: "Yayımlanmış nöbet planı alınamadı." });
    }
  });

  router.get("/history", async (_req: Request, res: Response) => {
    try {
      res.status(200).json(await fetchDutyPlanHistory(supabase, config.campusName, config.academicYearName));
    } catch {
      console.error("[server] list_duty_plan_history RPC çağrısı başarısız oldu.");
      res.status(500).json({ error: "query_failed", message: "Nöbet planı geçmişi alınamadı." });
    }
  });

  router.get("/history/:planId", async (req: Request<{ planId: string }>, res: Response) => {
    const parsed = dutyPlanIdSchema.safeParse(req.params.planId);
    if (!parsed.success) {
      res.status(400).json({ error: "validation_error", message: parsed.error.issues[0]?.message });
      return;
    }
    try {
      const result = await fetchDutyPlanHistoryDetail(supabase, config.campusName, config.academicYearName, parsed.data);
      if (!result.found) {
        res.status(404).json({ error: "not_found", message: "Nöbet planı bulunamadı." });
        return;
      }
      res.status(200).json(result);
    } catch {
      console.error("[server] get_duty_plan_history_detail RPC çağrısı başarısız oldu.");
      res.status(500).json({ error: "query_failed", message: "Nöbet planı ayrıntısı alınamadı." });
    }
  });

  router.post("/history/:planId/revise", async (req: Request<{ planId: string }>, res: Response) => {
    const planId = dutyPlanIdSchema.safeParse(req.params.planId);
    const body = dutyPlanHistoryMutationSchema.safeParse(req.body ?? {});
    if (!planId.success || !body.success) {
      res.status(400).json({ error: "validation_error", message: (planId.error ?? body.error)?.issues[0]?.message ?? "Geçersiz istek." });
      return;
    }
    try {
      const result = await createDutyPlanRevision(supabase, config.campusName, config.academicYearName, planId.data, body.data.expectedPlanVersion);
      switch (result.status) {
        case "ok": res.status(201).json(result); return;
        case "already_draft": res.status(200).json(result); return;
        case "plan_not_found": res.status(404).json({ error: result.status, message: "Nöbet planı bulunamadı." }); return;
        case "version_conflict": res.status(409).json({ error: result.status, message: "Plan bu sırada değişti.", currentVersion: result.currentVersion }); return;
        case "active_draft_exists": res.status(409).json({ error: result.status, message: "Önce mevcut taslağı tamamlayın veya silin.", planId: result.planId }); return;
        case "source_stale": res.status(409).json({ error: result.status, message: "Kaynak veriler değiştiği için bu plan doğrudan revizyona açılamaz. Yeni bir taslak üretin.", currentSourceFingerprint: result.currentSourceFingerprint }); return;
      }
    } catch {
      console.error("[server] create_duty_plan_revision RPC çağrısı başarısız oldu.");
      res.status(500).json({ error: "query_failed", message: "Plan revizyonu oluşturulamadı." });
    }
  });

  router.post("/history/:planId/archive", async (req: Request<{ planId: string }>, res: Response) => {
    const planId = dutyPlanIdSchema.safeParse(req.params.planId);
    const body = dutyPlanHistoryMutationSchema.safeParse(req.body ?? {});
    if (!planId.success || !body.success) {
      res.status(400).json({ error: "validation_error", message: (planId.error ?? body.error)?.issues[0]?.message ?? "Geçersiz istek." });
      return;
    }
    try {
      const result = await archivePublishedDutyPlan(supabase, config.campusName, config.academicYearName, planId.data, body.data.expectedPlanVersion);
      switch (result.status) {
        case "ok": case "already_archived": res.status(200).json(result); return;
        case "plan_not_found": res.status(404).json({ error: result.status, message: "Nöbet planı bulunamadı." }); return;
        case "version_conflict": res.status(409).json({ error: result.status, message: "Plan bu sırada değişti.", currentVersion: result.currentVersion }); return;
        case "plan_not_published": res.status(409).json({ error: result.status, message: "Yalnız yayımlanmış planlar arşivlenebilir." }); return;
      }
    } catch {
      console.error("[server] archive_published_duty_plan RPC çağrısı başarısız oldu.");
      res.status(500).json({ error: "query_failed", message: "Plan arşivlenemedi." });
    }
  });

  router.get("/drafts/:planId/tasks/:taskId/candidates", async (req: Request<{ planId: string; taskId: string }>, res: Response) => {
    const planIdParsed = dutyPlanIdSchema.safeParse(req.params.planId);
    const taskIdParsed = dutyPlanTaskIdSchema.safeParse(req.params.taskId);
    if (!planIdParsed.success || !taskIdParsed.success) {
      res.status(400).json({ error: "validation_error", message: (planIdParsed.error ?? taskIdParsed.error)?.issues[0]?.message });
      return;
    }
    try {
      const result = await fetchDutyPlanTaskCandidates(supabase, config.campusName, config.academicYearName, planIdParsed.data, taskIdParsed.data);
      if (!result.found || !result.taskFound) {
        res.status(404).json({ error: "not_found", message: "Plan veya görev bulunamadı." });
        return;
      }
      res.status(200).json(result);
    } catch {
      // eslint-disable-next-line no-console
      console.error("[server] get_duty_plan_task_candidates RPC çağrısı başarısız oldu.");
      res.status(500).json({ error: "query_failed", message: "Görev adayları alınamadı." });
    }
  });

  router.put("/drafts/:planId/tasks/:taskId", async (req: Request<{ planId: string; taskId: string }>, res: Response) => {
    const planIdParsed = dutyPlanIdSchema.safeParse(req.params.planId);
    const taskIdParsed = dutyPlanTaskIdSchema.safeParse(req.params.taskId);
    if (!planIdParsed.success || !taskIdParsed.success) {
      res.status(400).json({ error: "validation_error", message: (planIdParsed.error ?? taskIdParsed.error)?.issues[0]?.message });
      return;
    }
    const bodyParsed = updateDutyPlanAssignmentSchema.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({ error: "validation_error", message: bodyParsed.error.issues[0]?.message ?? "Geçersiz istek." });
      return;
    }
    try {
      const result = await updateDutyPlanAssignment(supabase, config.campusName, config.academicYearName, planIdParsed.data, taskIdParsed.data, bodyParsed.data);
      switch (result.status) {
        case "ok":
          res.status(200).json(result);
          return;
        case "plan_not_found":
          res.status(404).json({ error: result.status, message: "Nöbet planı bulunamadı." });
          return;
        case "plan_not_draft":
          res.status(409).json({ error: result.status, message: "Yalnız taslak (draft) durumundaki planlar düzenlenebilir." });
          return;
        case "version_conflict":
          res.status(409).json({ error: result.status, message: "Plan bu sırada başka bir işlemle değişti.", currentVersion: result.currentVersion });
          return;
        case "source_changed":
          res.status(409).json({
            error: result.status,
            message: "Kaynak veri (import, öğretmen tercihleri, sabit nöbetler) değişti. Taslağı yeniden üretin.",
            currentSourceFingerprint: result.currentSourceFingerprint,
          });
          return;
        case "task_not_found":
          res.status(404).json({ error: result.status, message: "Görev bulunamadı." });
          return;
        case "fixed_task_immutable":
          res.status(409).json({ error: result.status, message: "Sabit görev hücreleri düzenlenemez." });
          return;
        case "teacher_not_in_import":
          res.status(409).json({ error: result.status, message: "Öğretmen güncel ders programı içe aktarımında bulunamadı." });
          return;
        case "teacher_not_included":
          res.status(409).json({ error: result.status, message: "Öğretmen nöbet planlamasına dahil değil." });
          return;
        case "teacher_has_fixed_duty":
          res.status(409).json({ error: result.status, message: "Öğretmenin o gün zaten sabit nöbeti var." });
          return;
        case "teacher_day_conflict":
          res.status(409).json({
            error: result.status,
            // reason='half_day_rule' ⇒ yarım gün kuralı açık olduğu için o gün
            // ikinci normal görev verilemiyor.
            message:
              result.reason === "daily_package_limit"
                ? "Yeni nöbet modelinde öğretmenin o gün zaten başka bir normal görev paketi var."
                : result.reason === "half_day_rule"
                ? "Öğretmenin yarım gün kuralı açık: aynı gün yalnız bir normal nöbet bloğu alabilir."
                : "Öğretmenin o gün zaten başka bir görevi var.",
            reason: result.reason,
            conflictingPackage: result.conflictingPackage,
          });
          return;
        case "teacher_block_conflict":
          res.status(409).json({ error: result.status, message: "Öğretmenin o gün aynı nöbet bloğunda başka bir yerde görevi var." });
          return;
        case "cell_not_open_for_normal":
          res.status(409).json({ error: result.status, message: "Bu hücreye normal atama yapılamaz; yalnız Sabit Nöbetler ekranından karşılanır." });
          return;
        case "no_preference_for_cell":
          res.status(409).json({ error: result.status, message: "Öğretmen bu hücreyi tercih etmemiş." });
          return;
        case "time_rule_violation":
          res.status(409).json({ error: result.status, message: "Öğretmen bu blok için zaman kuralına (ders/komşu periyot) uygun değil." });
          return;
        case "weekly_limit_exceeded":
          res.status(409).json({ error: result.status, message: "Haftalık üst sınır aşılır." });
          return;
        case "requires_package_action":
          // Hücre >1 hücreli bir FULL_DAY/SHORT_BREAKS paketinin parçası —
          // bu uç nokta TEKİL hücre içindir, sessiz bölme YOK. İstemci
          // manual-package uç noktasına yönlendirilmeli.
          res.status(409).json({
            error: result.status,
            message: "Bu hücre çok hücreli bir paketin parçası; tekil hücre olarak düzenlenemez. Paket işlemini kullanın.",
            package: result.package,
          });
          return;
        case "v4_package_action_required":
          res.status(409).json({
            error: result.status,
            message: "Yeni plan modelinde Sabah ve Öğleden Sonra tek Teneffüs paketi olarak birlikte düzenlenmelidir.",
          });
          return;
        default:
          res.status(500).json({ error: "internal_error", message: "Beklenmeyen bir durum oluştu." });
      }
    } catch {
      // eslint-disable-next-line no-console
      console.error("[server] update_duty_plan_assignment RPC çağrısı başarısız oldu.");
      res.status(500).json({ error: "query_failed", message: "Manuel atama kaydedilemedi." });
    }
  });

  router.post("/drafts/:planId/manual-package/preview", async (req: Request<{ planId: string }>, res: Response) => {
    const planIdParsed = dutyPlanIdSchema.safeParse(req.params.planId);
    if (!planIdParsed.success) {
      res.status(400).json({ error: "validation_error", message: planIdParsed.error.issues[0]?.message });
      return;
    }
    const bodyParsed = previewDutyPlanManualPackageSchema.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({ error: "validation_error", message: bodyParsed.error.issues[0]?.message ?? "Geçersiz istek." });
      return;
    }
    try {
      const result = await previewDutyPlanManualPackage(supabase, config.campusName, config.academicYearName, planIdParsed.data, bodyParsed.data);
      if (!result.found) {
        res.status(404).json({ error: "not_found", message: "Nöbet planı bulunamadı." });
        return;
      }
      res.status(200).json(result);
    } catch {
      // eslint-disable-next-line no-console
      console.error("[server] preview_duty_plan_manual_package RPC çağrısı başarısız oldu.");
      res.status(500).json({ error: "query_failed", message: "Manuel paket ön izlemesi alınamadı." });
    }
  });

  router.put("/drafts/:planId/manual-package", async (req: Request<{ planId: string }>, res: Response) => {
    const planIdParsed = dutyPlanIdSchema.safeParse(req.params.planId);
    if (!planIdParsed.success) {
      res.status(400).json({ error: "validation_error", message: planIdParsed.error.issues[0]?.message });
      return;
    }
    const bodyParsed = setDutyPlanManualPackageSchema.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({ error: "validation_error", message: bodyParsed.error.issues[0]?.message ?? "Geçersiz istek." });
      return;
    }
    try {
      const result = await setDutyPlanManualPackage(supabase, config.campusName, config.academicYearName, planIdParsed.data, bodyParsed.data);
      switch (result.status) {
        case "ok":
          res.status(200).json(result);
          return;
        case "plan_not_found":
          res.status(404).json({ error: result.status, message: "Nöbet planı bulunamadı." });
          return;
        case "plan_not_draft":
          res.status(409).json({ error: result.status, message: "Yalnız taslak (draft) durumundaki planlar düzenlenebilir." });
          return;
        case "version_conflict":
          res.status(409).json({ error: result.status, message: "Plan bu sırada başka bir işlemle değişti.", currentVersion: result.currentVersion });
          return;
        case "source_changed":
          res.status(409).json({
            error: result.status,
            message: "Kaynak veri değişti. Taslağı yeniden üretin.",
            currentSourceFingerprint: result.currentSourceFingerprint,
          });
          return;
        case "invalid_package_combination":
          res.status(400).json({ error: result.status, message: "Bu yer/gün kombinasyonu istenen paket türünü desteklemiyor." });
          return;
        case "task_not_found":
          res.status(404).json({ error: result.status, message: "Hedef görev hücreleri bulunamadı." });
          return;
        case "fixed_task_immutable":
          res.status(409).json({ error: result.status, message: "Sabit görev hücreleri/paketleri düzenlenemez." });
          return;
        case "requires_confirmation":
          // Hedef kümenin DIŞINDA kalan (bölünecek) YABANCI paket hücreleri
          // var — istemci bunları göstermeli ve AÇIK onay almalı, sonra AYNI
          // isteği expectedAffectedTaskIds ile tekrar göndermeli.
          res.status(409).json({
            error: result.status,
            message: "Bu işlem başka paketleri bölecek. Etkilenen hücreleri onaylayıp tekrar deneyin.",
            affectedTasks: result.affectedTasks,
          });
          return;
        case "stale_affected_set":
          res.status(409).json({
            error: result.status,
            message: "Etkilenen hücre kümesi bu sırada değişti. Güncel kümeyi onaylayıp tekrar deneyin.",
            affectedTasks: result.affectedTasks,
          });
          return;
        case "teacher_not_in_import":
          res.status(409).json({ error: result.status, message: "Öğretmen güncel ders programı içe aktarımında bulunamadı." });
          return;
        case "teacher_not_included":
          res.status(409).json({ error: result.status, message: "Öğretmen nöbet planlamasına dahil değil." });
          return;
        case "teacher_has_fixed_duty":
          res.status(409).json({ error: result.status, message: "Öğretmenin o gün zaten sabit nöbeti var." });
          return;
        case "teacher_day_conflict":
          res.status(409).json({
            error: result.status,
            message:
              result.reason === "daily_package_limit"
                ? "Yeni nöbet modelinde öğretmenin o gün zaten başka bir normal görev paketi var."
                : result.reason === "half_day_rule"
                ? "Öğretmenin yarım gün kuralı açık: aynı gün yalnız bir normal nöbet bloğu alabilir."
                : "Öğretmenin o gün zaten başka bir paketi var.",
            reason: result.reason,
            conflictingPackage: result.conflictingPackage,
          });
          return;
        case "teacher_block_conflict":
          res.status(409).json({ error: result.status, message: "Öğretmenin o gün aynı nöbet bloğunda başka bir yerde görevi var." });
          return;
        case "cell_not_open_for_normal":
          res.status(409).json({ error: result.status, message: "Bu hücreye normal atama yapılamaz; yalnız Sabit Nöbetler ekranından karşılanır." });
          return;
        case "normal_package_must_be_single_block":
          res.status(409).json({
            error: result.status,
            message: "Yeni nöbet modelinde normal görevler yalnız tek blok olarak atanır. Tüm gün veya Sabah+Öğleden Sonra paketi kullanılamaz.",
          });
          return;
        case "no_preference_for_cell":
          res.status(409).json({ error: result.status, message: "Öğretmen hedef hücrelerin tamamını tercih etmemiş." });
          return;
        case "time_rule_violation":
          res.status(409).json({ error: result.status, message: "Öğretmen bu bloklardan biri için zaman kuralına uygun değil." });
          return;
        case "weekly_limit_exceeded":
          res.status(409).json({ error: result.status, message: "Haftalık üst sınır aşılır." });
          return;
        default:
          res.status(500).json({ error: "internal_error", message: "Beklenmeyen bir durum oluştu." });
      }
    } catch {
      // eslint-disable-next-line no-console
      console.error("[server] set_duty_plan_manual_package RPC çağrısı başarısız oldu.");
      res.status(500).json({ error: "query_failed", message: "Manuel paket kaydedilemedi." });
    }
  });

  router.post("/drafts/:planId/regenerate", async (req: Request<{ planId: string }>, res: Response) => {
    const planIdParsed = dutyPlanIdSchema.safeParse(req.params.planId);
    if (!planIdParsed.success) {
      res.status(400).json({ error: "validation_error", message: planIdParsed.error.issues[0]?.message });
      return;
    }
    const bodyParsed = regenerateDutyPlanDraftSchema.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({ error: "validation_error", message: bodyParsed.error.issues[0]?.message ?? "Geçersiz istek." });
      return;
    }
    try {
      const result = await regenerateDutyPlanDraft(
        supabase,
        config.campusName,
        config.academicYearName,
        planIdParsed.data,
        bodyParsed.data.options,
        bodyParsed.data.wipeManualAssignments,
      );
      switch (result.status) {
        case "ok":
          res.status(200).json(result);
          return;
        case "plan_not_found":
          res.status(404).json({ error: result.status, message: "Nöbet planı bulunamadı." });
          return;
        case "plan_not_draft":
          res.status(409).json({ error: result.status, message: "Yalnız taslak (draft) durumundaki planlar yeniden üretilebilir." });
          return;
        case "no_import":
          res.status(409).json({ error: result.status, message: "Şu anda içe aktarılmış bir ders programı yok." });
          return;
        case "partial_not_allowed":
          res.status(409).json({
            error: result.status,
            message: "Açık (atanamayan) görevler var; allowPartial=false ile taslak oluşturulamaz.",
            uncoveredCount: result.uncoveredCount,
            totalTaskCount: result.totalTaskCount,
          });
          return;
        case "source_changed":
          res.status(409).json({
            error: result.status,
            message: "Kaynak veri üretim sırasında değişti. Lütfen tekrar deneyin.",
            currentSourceFingerprint: result.currentSourceFingerprint,
          });
          return;
        case "invalid_assignment":
          res.status(400).json({ error: result.status, message: "Üretilen atamalar geçersiz.", reason: result.reason });
          return;
        case "invalid_summary":
          res.status(500).json({
            error: result.status,
            message: "Üretim özeti veritabanının yeniden hesapladığı değerlerle uyuşmuyor.",
            authoritative: result.authoritative,
          });
          return;
        case "teacher_day_conflict":
          res.status(409).json({
            error: result.status,
            message:
              result.reason === "daily_package_limit"
                ? "Yeni nöbet modelinde bir öğretmene aynı gün yalnız bir normal görev paketi verilebilir."
                : result.reason === "half_day_rule"
                ? "Yarım gün kuralı açık bir öğretmene aynı gün birden fazla normal görev verildi."
                : "Bir öğretmen aynı gün birden fazla göreve atandı.",
            reason: result.reason,
          });
          return;
        case "teacher_block_conflict":
          res.status(409).json({ error: result.status, message: "Bir öğretmen aynı gün aynı nöbet bloğunda iki farklı yere atandı." });
          return;
        case "invalid_locked_assignment":
          // Kural 9: korunması istenen manuel atama güncel kurallarla çelişiyor.
          // SESSİZ silme/düzeltme YOK — hangi atamaların neden geçersiz olduğu
          // yapılandırılmış biçimde döner (SQL/stack İÇERMEZ).
          res.status(409).json({
            error: result.status,
            message: "Korunması istenen manuel atamalar güncel kurallarla çelişiyor. Yeniden üretmeden önce bu atamaları düzeltin veya manuel atamaları temizlemeyi onaylayın.",
            violations: result.violations,
          });
          return;
        case "teacher_has_fixed_duty":
          res.status(409).json({ error: result.status, message: "Sabit nöbeti olan bir öğretmene aynı gün normal görev verildi." });
          return;
        case "weekly_limit_exceeded":
          res.status(409).json({ error: result.status, message: "Haftalık üst sınır aşıldı." });
          return;
        case "fixed_assignment_changed":
          res.status(409).json({ error: result.status, message: "Sabit nöbet ataması üretim sırasında değişti." });
          return;
        case "version_conflict":
          res.status(409).json({ error: result.status, message: "Eşzamanlı bir üretim isteği taslağı değiştirdi.", currentPlanId: result.currentPlanId, currentVersion: result.currentVersion });
          return;
        default:
          res.status(500).json({ error: "internal_error", message: "Beklenmeyen bir durum oluştu." });
      }
    } catch {
      // eslint-disable-next-line no-console
      console.error("[server] nöbet planı taslağı yeniden üretimi başarısız oldu.");
      res.status(500).json({ error: "query_failed", message: "Nöbet planı taslağı yeniden üretilemedi." });
    }
  });

  router.post("/drafts/:planId/publish", async (req: Request<{ planId: string }>, res: Response) => {
    const planIdParsed = dutyPlanIdSchema.safeParse(req.params.planId);
    if (!planIdParsed.success) {
      res.status(400).json({ error: "validation_error", message: planIdParsed.error.issues[0]?.message });
      return;
    }
    const bodyParsed = publishDutyPlanDraftSchema.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({ error: "validation_error", message: bodyParsed.error.issues[0]?.message ?? "Geçersiz istek." });
      return;
    }
    try {
      const result = await publishDutyPlanDraft(supabase, config.campusName, config.academicYearName, planIdParsed.data, bodyParsed.data.expectedPlanVersion);
      switch (result.status) {
        case "ok":
          res.status(200).json(result);
          return;
        case "plan_not_found":
          res.status(404).json({ error: result.status, message: "Nöbet planı bulunamadı." });
          return;
        case "plan_not_draft":
          res.status(409).json({ error: result.status, message: "Yalnız taslak (draft) durumundaki planlar yayımlanabilir." });
          return;
        case "version_conflict":
          res.status(409).json({ error: result.status, message: "Plan bu sırada başka bir işlemle değişti.", currentVersion: result.currentVersion });
          return;
        case "source_stale":
          res.status(409).json({
            error: result.status,
            message: "Kaynak veri değişti. Yayımlamadan önce taslağı yeniden üretin.",
            currentSourceFingerprint: result.currentSourceFingerprint,
          });
          return;
        case "open_tasks_remaining":
          res.status(409).json({ error: result.status, message: "Açık (atanamayan) görevler var; kısmi bir plan yayımlanamaz.", uncoveredCount: result.uncoveredCount });
          return;
        case "rule_violation":
          res.status(409).json({
            error: result.status,
            message:
              result.reason === "daily_package_limit_violation"
                ? "Bir öğretmene aynı gün birden fazla normal görev paketi verildiği için plan yayımlanamaz."
                : "Zorunlu bir kural ihlal ediliyor; yayımlanamaz.",
            reason: result.reason,
          });
          return;
        default:
          res.status(500).json({ error: "internal_error", message: "Beklenmeyen bir durum oluştu." });
      }
    } catch {
      // eslint-disable-next-line no-console
      console.error("[server] publish_duty_plan_draft RPC çağrısı başarısız oldu.");
      res.status(500).json({ error: "query_failed", message: "Nöbet planı yayımlanamadı." });
    }
  });

  router.delete("/drafts/:planId", async (req: Request<{ planId: string }>, res: Response) => {
    const parsed = dutyPlanIdSchema.safeParse(req.params.planId);
    if (!parsed.success) {
      res.status(400).json({ error: "validation_error", message: parsed.error.issues[0]?.message });
      return;
    }
    try {
      const result = await deleteDutyPlanDraft(supabase, config.campusName, config.academicYearName, parsed.data);
      if (result === "not_found") {
        res.status(404).json({ error: "not_found", message: "Nöbet planı bulunamadı." });
        return;
      }
      if (result === "not_draft") {
        res.status(409).json({ error: "not_draft", message: "Yalnız taslak (draft) durumundaki planlar silinebilir." });
        return;
      }
      res.status(204).end();
    } catch {
      // eslint-disable-next-line no-console
      console.error("[server] delete_duty_plan_draft RPC çağrısı başarısız oldu.");
      res.status(500).json({ error: "query_failed", message: "Nöbet planı silinemedi." });
    }
  });

  return router;
}
