import { Router, type Request, type Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config";
import { completeExamInvigilationScopeSchema, createExamInvigilationPlanSchema, discardExamInvigilationScopeSchema, examPlanIdSchema, examSessionIdSchema, listExamInvigilationPlansQuerySchema, setExamInvigilationAssignmentSchema } from "../validation/examInvigilation";
import { completeExamInvigilationScope, createExamInvigilationPlan, deleteExamInvigilationPlan, discardExamInvigilationScope, getExamInvigilationCandidates, getExamInvigilationPlan, getExamInvigilationPreparation, listExamInvigilationPlans, setExamInvigilationAssignment } from "../services/examInvigilation";

function validation(res: Response, message?: string) { res.status(400).json({ error: "validation_error", message: message ?? "Geçersiz istek." }); }
function failed(res: Response, message: string) { res.status(500).json({ error: "query_failed", message }); }

export function createExamInvigilationRouter(supabase: SupabaseClient, config: AppConfig): Router {
  const router = Router();
  router.get("/preparation", async (_req, res) => {
    try { res.json(await getExamInvigilationPreparation(supabase, config.campusName, config.academicYearName)); }
    catch { console.error("[server] get_exam_invigilation_preparation başarısız."); failed(res, "Gözetmen hazırlık verisi alınamadı."); }
  });
  router.get("/plans", async (req, res) => {
    const query = listExamInvigilationPlansQuerySchema.safeParse(req.query ?? {});
    if (!query.success) return validation(res, query.error.issues[0]?.message);
    try {
      const result = await listExamInvigilationPlans(supabase, config.campusName, config.academicYearName, query.data);
      if (result.status === "validation_error") return validation(res, "Plan kaydı süzgeçleri geçersiz.");
      return res.json({ items: result.items });
    } catch { console.error("[server] list_exam_invigilation_plans_v2 başarısız."); return failed(res, "Gözetmen planları alınamadı."); }
  });
  router.post("/plans", async (req, res) => {
    const body = createExamInvigilationPlanSchema.safeParse(req.body ?? {});
    if (!body.success) return validation(res, body.error.issues[0]?.message);
    try {
      const result = await createExamInvigilationPlan(supabase, config.campusName, config.academicYearName, body.data);
      if (result.status === "ok") return res.status(201).json(result);
      const messages: Record<string,string> = { validation_error:"Sınav takvimindeki gün, saat veya sınıf seçimi geçersiz.", no_import:"Güncel ders programı bulunamadı.", published_duty_plan_not_found:"Seçilen hafta için yayımlanmış nöbet planı bulunamadı.", period_not_found:"Seçilen ders saatlerinden biri güncel programda bulunamadı.", class_not_found:"Seçilen sınıflardan biri güncel programda bulunamadı.", class_scope_mismatch:"Seçilen sınıfın XML'deki kademesi değişti. Sayfayı yenileyip tekrar seçin.", duplicate_session:"Aynı sınıf, gün ve ders saati birden fazla eklendi.", duplicate_plan:"Bu başlangıç tarihi ve adla bir sınav planı zaten var.", context_not_found:"Kampüs veya eğitim yılı bulunamadı." };
      return res.status(result.status==="validation_error"?400:409).json({ error: result.status, message: messages[result.status] ?? "Plan oluşturulamadı." });
    } catch { console.error("[server] create_exam_invigilation_plan başarısız."); return failed(res, "Gözetmen planı oluşturulamadı."); }
  });
  router.get("/plans/:planId", async (req: Request<{planId:string}>, res) => {
    const id=examPlanIdSchema.safeParse(req.params.planId); if(!id.success) return validation(res,id.error.issues[0]?.message);
    try { const result=await getExamInvigilationPlan(supabase,config.campusName,config.academicYearName,id.data); if(!result.found)return res.status(404).json({error:"not_found",message:"Gözetmen planı bulunamadı."}); return res.json(result); }
    catch { console.error("[server] get_exam_invigilation_plan başarısız."); return failed(res,"Gözetmen planı alınamadı."); }
  });
  router.delete("/plans/:planId", async (req: Request<{planId:string}>, res) => {
    const id=examPlanIdSchema.safeParse(req.params.planId); if(!id.success)return validation(res,id.error.issues[0]?.message);
    try { const result=await deleteExamInvigilationPlan(supabase,id.data); if(result.status==="ok")return res.json(result); if(result.status==="database_upgrade_required")return res.status(503).json({error:result.status,message:"Plan silme özelliği için bekleyen veritabanı güncellemesi henüz uygulanmamış."}); return res.status(result.status==="plan_not_found"?404:409).json({error:result.status,message:result.status==="plan_not_found"?"Gözetmen planı bulunamadı.":"Gözetmen planı silinemedi."}); }
    catch { console.error("[server] delete_exam_invigilation_plan başarısız."); return failed(res,"Gözetmen planı silinemedi."); }
  });
  router.get("/plans/:planId/sessions/:sessionId/candidates", async (req:Request<{planId:string;sessionId:string}>,res) => {
    const plan=examPlanIdSchema.safeParse(req.params.planId), session=examSessionIdSchema.safeParse(req.params.sessionId);
    if(!plan.success||!session.success)return validation(res,(plan.error??session.error)?.issues[0]?.message);
    try { const result=await getExamInvigilationCandidates(supabase,config.campusName,config.academicYearName,plan.data,session.data); if(!result.found||result.sessionFound===false)return res.status(404).json({error:"not_found",message:"Plan veya oturum bulunamadı."}); return res.json(result); }
    catch { console.error("[server] get_exam_invigilation_candidates başarısız."); return failed(res,"Uygun gözetmenler alınamadı."); }
  });
  router.put("/plans/:planId/sessions/:sessionId/assignment", async (req:Request<{planId:string;sessionId:string}>,res) => {
    const plan=examPlanIdSchema.safeParse(req.params.planId), session=examSessionIdSchema.safeParse(req.params.sessionId), body=setExamInvigilationAssignmentSchema.safeParse(req.body??{});
    if(!plan.success||!session.success||!body.success)return validation(res,(plan.error??session.error??body.error)?.issues[0]?.message);
    try {
      const result=await setExamInvigilationAssignment(supabase,plan.data,session.data,body.data); if(result.status==="ok")return res.json(result);
      const messages:Record<string,string>={plan_not_found:"Gözetmen planı bulunamadı.",session_not_found:"Oturum veya gözetmen slotu bulunamadı.",scope_completed:"Tamamlanmış liste değiştirilemez.",version_conflict:"Liste bu sırada değişti.",source_stale:"Ders programı veya nöbet planı değişti. Planı yeniden doğrulayın.",teacher_not_found:"Öğretmen güncel ders programında bulunamadı.",lesson_conflict:"Öğretmenin bu saatte dersi var.",teacher_already_assigned_other_scope:"Öğretmen diğer okul grubunun gözetmen listesinde görevli.",invigilation_conflict:"Öğretmen bu saatte başka bir sınav oturumunda görevli.",duty_coverage_acknowledgement_required:"Öğretmenin aynı gün nöbeti var. Geçici nöbet düzenlemesini onaylayın."};
      return res.status(409).json({error:result.status,message:messages[result.status]??"Atama yapılamadı.",...result});
    } catch { console.error("[server] set_exam_invigilation_assignment başarısız."); return failed(res,"Gözetmen ataması kaydedilemedi."); }
  });
  router.post("/plans/:planId/complete", async (req:Request<{planId:string}>,res) => {
    const plan=examPlanIdSchema.safeParse(req.params.planId), body=completeExamInvigilationScopeSchema.safeParse(req.body??{});
    if(!plan.success||!body.success)return validation(res,(plan.error??body.error)?.issues[0]?.message);
    try { const result=await completeExamInvigilationScope(supabase,plan.data,body.data); if(result.status==="ok"||result.status==="already_completed")return res.json(result); const messages:Record<string,string>={no_sessions:"Bu okul grubu için sınav oturumu planlanmadı.",open_slots:"Listede açık gözetmen görevleri var.",unacknowledged_duty_warnings:"Nöbet devri uyarıları onaylanmadı.",version_conflict:"Liste bu sırada değişti.",source_stale:"Ders programı veya nöbet planı değişti."}; return res.status(409).json({error:result.status,message:messages[result.status]??"Liste tamamlanamadı.",...result}); }
    catch { console.error("[server] complete_exam_invigilation_scope başarısız."); return failed(res,"Gözetmen listesi tamamlanamadı."); }
  });
  router.delete("/plans/:planId/scopes/:scopeCode",async(req:Request<{planId:string;scopeCode:string}>,res)=>{const plan=examPlanIdSchema.safeParse(req.params.planId),body=discardExamInvigilationScopeSchema.safeParse({scopeCode:req.params.scopeCode,...req.body});if(!plan.success||!body.success)return validation(res,(plan.error??body.error)?.issues[0]?.message);try{const result=await discardExamInvigilationScope(supabase,plan.data,body.data);if(result.status==="ok")return res.json(result);return res.status(409).json({error:result.status,message:result.status==="scope_completed"?"Tamamlanmış gözetmen listesi silinemez.":"Gözetmen taslağı silinemedi.",...result})}catch{return failed(res,"Gözetmen taslağı silinemedi.")}});
  return router;
}
