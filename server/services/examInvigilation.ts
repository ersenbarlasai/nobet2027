import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompleteExamInvigilationScopeInput, CreateExamInvigilationPlanInput, ListExamInvigilationPlansQuery, SetExamInvigilationAssignmentInput } from "../validation/examInvigilation";

export class ExamInvigilationQueryError extends Error {}

async function rpc<T>(supabase: SupabaseClient, name: string, args: Record<string, unknown>, message: string): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error || !data) throw new ExamInvigilationQueryError(message);
  return data as unknown as T;
}

/**
 * Plan kayıtları listesi. Durum, görev sayıları ve uyarı sayısı RPC içinde
 * hesaplanır — burada ikinci bir kural motoru YOKTUR.
 */
export function listExamInvigilationPlans(supabase: SupabaseClient, campusName: string, academicYearName: string, query: ListExamInvigilationPlansQuery) {
  return rpc<{ status: string; items: unknown[] }>(supabase, "list_exam_invigilation_plans_v2", {
    p_campus_name: campusName, p_academic_year_name: academicYearName,
    p_status: query.status, p_scope_code: query.scopeCode ?? null,
    p_search: query.search ?? null, p_date_from: query.dateFrom ?? null,
    p_date_to: query.dateTo ?? null, p_sort: query.sort,
  }, "Gözetmen planları alınamadı.");
}

export function getExamInvigilationPreparation(supabase: SupabaseClient, campusName: string, academicYearName: string) {
  return rpc<Record<string, unknown>>(supabase, "get_exam_invigilation_preparation", { p_campus_name: campusName, p_academic_year_name: academicYearName }, "Gözetmen hazırlık verisi alınamadı.");
}

export function getExamInvigilationPlan(supabase: SupabaseClient, campusName: string, academicYearName: string, planId: string) {
  return rpc<{ found: boolean } & Record<string, unknown>>(supabase, "get_exam_invigilation_plan", { p_plan_id: planId, p_campus_name: campusName, p_academic_year_name: academicYearName }, "Gözetmen planı alınamadı.");
}

export function createExamInvigilationPlan(supabase: SupabaseClient, campusName: string, academicYearName: string, input: CreateExamInvigilationPlanInput) {
  return rpc<{ status: string; planId?: string }>(supabase, "create_exam_invigilation_plan_v2", {
    p_campus_name: campusName, p_academic_year_name: academicYearName, p_name: input.name,
    p_week_start_date: input.weekStartDate, p_session_specs: input.sessions,
  }, "Gözetmen planı oluşturulamadı.");
}

export function getExamInvigilationCandidates(supabase: SupabaseClient, campusName: string, academicYearName: string, planId: string, sessionId: string) {
  return rpc<{ found: boolean; sessionFound?: boolean } & Record<string, unknown>>(supabase, "get_exam_invigilation_candidates", {
    p_plan_id: planId, p_session_id: sessionId, p_campus_name: campusName, p_academic_year_name: academicYearName,
  }, "Uygun gözetmenler alınamadı.");
}

export function setExamInvigilationAssignment(supabase: SupabaseClient, planId: string, sessionId: string, input: SetExamInvigilationAssignmentInput) {
  return rpc<{ status: string } & Record<string, unknown>>(supabase, "set_exam_invigilation_assignment", {
    p_plan_id: planId, p_session_id: sessionId, p_slot_number: input.slotNumber,
    p_teacher_source_id: input.teacherSourceId, p_expected_scope_version: input.expectedScopeVersion,
    p_duty_coverage_acknowledged: input.dutyCoverageAcknowledged ?? false,
    p_duty_coverage_note: input.dutyCoverageNote ?? null,
  }, "Gözetmen ataması kaydedilemedi.");
}

export function completeExamInvigilationScope(supabase: SupabaseClient, planId: string, input: CompleteExamInvigilationScopeInput) {
  return rpc<{ status: string } & Record<string, unknown>>(supabase, "complete_exam_invigilation_scope", {
    p_plan_id: planId, p_scope_code: input.scopeCode, p_expected_scope_version: input.expectedScopeVersion,
  }, "Gözetmen listesi tamamlanamadı.");
}
export function discardExamInvigilationScope(supabase:SupabaseClient,planId:string,input:CompleteExamInvigilationScopeInput){return rpc<{status:string}&Record<string,unknown>>(supabase,"discard_exam_invigilation_scope",{p_plan_id:planId,p_scope_code:input.scopeCode,p_expected_version:input.expectedScopeVersion},"Gözetmen taslağı silinemedi.");}
export async function deleteExamInvigilationPlan(supabase:SupabaseClient,planId:string){
  const {data,error}=await supabase.rpc("delete_exam_invigilation_plan",{p_plan_id:planId});
  if(error){
    const missingRpc=error.code==="PGRST202"||error.code==="42883"||/delete_exam_invigilation_plan/i.test(error.message??"");
    if(missingRpc)return{status:"database_upgrade_required"};
    throw new ExamInvigilationQueryError("Gözetmen planı silinemedi.");
  }
  if(!data)throw new ExamInvigilationQueryError("Gözetmen planı silinemedi.");
  return data as unknown as {status:string;deleted?:number};
}
