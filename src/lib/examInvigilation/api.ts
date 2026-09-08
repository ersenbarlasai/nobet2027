import { EXAM_INVIGILATION_PLANS_URL, EXAM_INVIGILATION_PREPARATION_URL, examInvigilationAssignmentUrl, examInvigilationCandidatesUrl, examInvigilationCompleteUrl, examInvigilationPlanUrl } from "../localApi";
import { ExamInvigilationApiError, type CreateExamPlanInput, type ExamCandidates, type ExamPlanDetail, type ExamPlanList, type ExamPlanListFilters, type ExamPreparation, type ExamScopeCode, type SetExamAssignmentInput } from "./types";

async function read<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new ExamInvigilationApiError(String(body.error ?? "request_failed"), String(body.message ?? "İşlem tamamlanamadı."), body);
  return body as T;
}
export async function fetchExamPreparation(signal?:AbortSignal){ return read<ExamPreparation>(await fetch(EXAM_INVIGILATION_PREPARATION_URL,{signal})); }
/** Süzgeçler sunucuya taşınır; plan durumu istemcide TÜRETİLMEZ. */
export function examPlansQueryString(filters:ExamPlanListFilters={}):string{
  const params=new URLSearchParams();
  if(filters.status&&filters.status!=="all")params.set("status",filters.status);
  if(filters.scopeCode)params.set("scopeCode",filters.scopeCode);
  const search=filters.search?.trim();
  if(search)params.set("search",search);
  if(filters.dateFrom)params.set("dateFrom",filters.dateFrom);
  if(filters.dateTo)params.set("dateTo",filters.dateTo);
  if(filters.sort&&filters.sort!=="newest")params.set("sort",filters.sort);
  const query=params.toString();
  return query?`?${query}`:"";
}
export async function fetchExamPlans(filters:ExamPlanListFilters={},signal?:AbortSignal){ return read<ExamPlanList>(await fetch(`${EXAM_INVIGILATION_PLANS_URL}${examPlansQueryString(filters)}`,{signal})); }
export async function fetchExamPlan(planId:string,signal?:AbortSignal){ return read<ExamPlanDetail>(await fetch(examInvigilationPlanUrl(planId),{signal})); }
export async function createExamPlan(input:CreateExamPlanInput){ return read<{status:"ok";planId:string}>(await fetch(EXAM_INVIGILATION_PLANS_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)})); }
export async function deleteExamPlan(planId:string){ return read<{status:"ok"}>(await fetch(examInvigilationPlanUrl(planId),{method:"DELETE"})); }
export async function fetchExamCandidates(planId:string,sessionId:string,signal?:AbortSignal){ return read<ExamCandidates>(await fetch(examInvigilationCandidatesUrl(planId,sessionId),{signal})); }
export async function setExamAssignment(planId:string,sessionId:string,input:SetExamAssignmentInput){ return read<{status:"ok";scopeVersion:number;assignmentId:string|null}>(await fetch(examInvigilationAssignmentUrl(planId,sessionId),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)})); }
export async function completeExamScope(planId:string,scopeCode:ExamScopeCode,expectedScopeVersion:number){ return read<{status:string;version:number}>(await fetch(examInvigilationCompleteUrl(planId),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({scopeCode,expectedScopeVersion})})); }
export async function discardExamScope(planId:string,scopeCode:ExamScopeCode,expectedScopeVersion:number){return read<{status:string;version:number}>(await fetch(`${examInvigilationPlanUrl(planId)}/scopes/${scopeCode}`,{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({expectedScopeVersion})}));}
