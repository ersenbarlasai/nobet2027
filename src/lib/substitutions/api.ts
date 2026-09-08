import{LOCAL_API_BASE_URL}from"../localApi";import type{CompensationType,PayrollOverview,SubCandidate,SubDayList,SubListItem,SubPreparation}from"./types";
const BASE=`${LOCAL_API_BASE_URL}/api/substitutions`;
async function read<T>(r:Response):Promise<T>{const b=await r.json().catch(()=>({})) as any;if(!r.ok)throw Object.assign(new Error(b.message??"İşlem tamamlanamadı."),{status:b.error,details:b});return b as T;}
async function request<T>(promise:Promise<Response>):Promise<T>{return read<T>(await promise)}
export const fetchSubPreparation=(q:URLSearchParams)=>request<SubPreparation>(fetch(`${BASE}/preparation?${q}`));
export const createAbsence=(body:unknown)=>request<Record<string,unknown>>(fetch(`${BASE}/absences`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}));
export const fetchSubLists=()=>request<{items:SubListItem[]}>(fetch(`${BASE}/lists`));
export const fetchSubList=(id:string)=>request<SubDayList>(fetch(`${BASE}/lists/${encodeURIComponent(id)}`));
export const fetchSubCandidates=(id:string)=>request<{found:boolean;items:SubCandidate[]}>(fetch(`${BASE}/tasks/${encodeURIComponent(id)}/candidates`));
export const updateSubTask=(id:string,body:unknown)=>request<{status:string;version:number}>(fetch(`${BASE}/tasks/${encodeURIComponent(id)}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}));
export const completeSubList=(id:string,expectedVersion:number)=>request<{status:string;version:number}>(fetch(`${BASE}/lists/${encodeURIComponent(id)}/complete`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({expectedVersion})}));
export const deleteSubList=(id:string,expectedVersion:number)=>request<{status:string}>(fetch(`${BASE}/lists/${encodeURIComponent(id)}`,{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({expectedVersion})}));
export const previewDeleteAbsence=(id:string)=>request<{found:boolean;absenceId:string;teacherName:string;isHistorical:boolean;affectedTasks:Array<{id:string;assignmentDate:string;periodName:string;classNames:string;subjectName:string;resolutionStatus:string;substituteTeacherName:string|null}>}>(fetch(`${BASE}/absences/${encodeURIComponent(id)}/delete-preview`));
export const deleteAbsence=(id:string,expectedTaskIds:string[])=>request<{status:string}>(fetch(`${BASE}/absences/${encodeURIComponent(id)}`,{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({expectedTaskIds})}));
export const fetchCompensation=()=>request<{items:CompensationType[]}>(fetch(`${BASE}/compensation-types`));
export const saveCompensation=(body:unknown)=>request<Record<string,unknown>>(fetch(`${BASE}/compensation-types`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}));
export const deleteCompensation=(id:string)=>request<{status:string;action:"deleted"|"deactivated"}>(fetch(`${BASE}/compensation-types/${encodeURIComponent(id)}`,{method:"DELETE"}));
export const addCompensationRate=(id:string,body:unknown)=>request<Record<string,unknown>>(fetch(`${BASE}/compensation-types/${encodeURIComponent(id)}/rates`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}));
export const addManualPayroll=(body:unknown)=>request<Record<string,unknown>>(fetch(`${BASE}/payroll/entries`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}));
export const updateManualPayroll=(id:string,body:unknown)=>request<Record<string,unknown>>(fetch(`${BASE}/payroll/entries/${encodeURIComponent(id)}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}));
export const deleteManualPayroll=(id:string)=>request<Record<string,unknown>>(fetch(`${BASE}/payroll/entries/${encodeURIComponent(id)}`,{method:"DELETE"}));
export const fetchPayroll=(anchorDate:string)=>request<PayrollOverview>(fetch(`${BASE}/payroll?anchorDate=${encodeURIComponent(anchorDate)}`));
export const closePayroll=(anchorDate:string,force=false)=>request<Record<string,unknown>>(fetch(`${BASE}/payroll/close`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({anchorDate,force})}));
