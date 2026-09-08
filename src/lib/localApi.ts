// Yalnızca yerel geliştirme backend'i (bkz. server/). Tarayıcı hiçbir zaman
// Supabase'e doğrudan bağlanmaz — yalnızca bu 127.0.0.1 adresine istek atar.
// Backend her zaman ayrı bir süreç olarak çalışır, secret yalnız orada kalır.
export const LOCAL_API_BASE_URL = "http://127.0.0.1:3001";
export const TIMETABLE_IMPORTS_URL = `${LOCAL_API_BASE_URL}/api/timetable-imports`;
export const CURRENT_TIMETABLE_IMPORT_URL = `${LOCAL_API_BASE_URL}/api/timetable-imports/current`;
export const CLASS_TIMETABLES_CLASSES_URL = `${LOCAL_API_BASE_URL}/api/class-timetables/classes`;
export function classTimetableUrl(classId: string): string {
  return `${CLASS_TIMETABLES_CLASSES_URL}/${encodeURIComponent(classId)}`;
}
export const TEACHER_TIMETABLES_TEACHERS_URL = `${LOCAL_API_BASE_URL}/api/teacher-timetables/teachers`;
export function teacherTimetableUrl(teacherId: string): string {
  return `${TEACHER_TIMETABLES_TEACHERS_URL}/${encodeURIComponent(teacherId)}`;
}
export const DUTY_LOCATIONS_URL = `${LOCAL_API_BASE_URL}/api/duty-locations`;
export const FIXED_DUTY_ASSIGNMENTS_URL = `${LOCAL_API_BASE_URL}/api/fixed-duty-assignments`;
/** Planlanabilirlik analizi — salt okunur. */
export const DUTY_PLAN_FEASIBILITY_URL = `${LOCAL_API_BASE_URL}/api/duty-plan/feasibility`;
/** Otomatik nöbet planı taslakları (bkz. server/routes/dutyPlanDrafts.ts). Yayımlama bu aşamada YOKTUR. */
export const DUTY_PLAN_DRAFTS_PREPARATION_URL = `${LOCAL_API_BASE_URL}/api/duty-plans/preparation`;
export const DUTY_PLAN_DRAFTS_GENERATE_URL = `${LOCAL_API_BASE_URL}/api/duty-plans/drafts/generate`;
export const DUTY_PLAN_DRAFTS_CURRENT_URL = `${LOCAL_API_BASE_URL}/api/duty-plans/drafts/current`;
export function dutyPlanDraftUrl(planId: string): string {
  return `${LOCAL_API_BASE_URL}/api/duty-plans/drafts/${encodeURIComponent(planId)}`;
}
export function dutyPlanTaskCandidatesUrl(planId: string, taskId: string): string {
  return `${LOCAL_API_BASE_URL}/api/duty-plans/drafts/${encodeURIComponent(planId)}/tasks/${encodeURIComponent(taskId)}/candidates`;
}
export function dutyPlanTaskUrl(planId: string, taskId: string): string {
  return `${LOCAL_API_BASE_URL}/api/duty-plans/drafts/${encodeURIComponent(planId)}/tasks/${encodeURIComponent(taskId)}`;
}
export function dutyPlanRegenerateUrl(planId: string): string {
  return `${LOCAL_API_BASE_URL}/api/duty-plans/drafts/${encodeURIComponent(planId)}/regenerate`;
}
export function dutyPlanPublishUrl(planId: string): string {
  return `${LOCAL_API_BASE_URL}/api/duty-plans/drafts/${encodeURIComponent(planId)}/publish`;
}
/** Çok hücreli manuel paket (FULL_DAY/SHORT_BREAKS/SINGLE_BLOCK) ön izlemesi — salt okunur. */
export function dutyPlanManualPackagePreviewUrl(planId: string): string {
  return `${LOCAL_API_BASE_URL}/api/duty-plans/drafts/${encodeURIComponent(planId)}/manual-package/preview`;
}
/** Çok hücreli manuel paket yazma — affectedTasks onayı gerektirebilir. */
export function dutyPlanManualPackageUrl(planId: string): string {
  return `${LOCAL_API_BASE_URL}/api/duty-plans/drafts/${encodeURIComponent(planId)}/manual-package`;
}
/** Yayımlanmış (published) nöbet planı — Haftalık Nöbet Planı ekranı için. */
export const DUTY_PLAN_PUBLISHED_CURRENT_URL = `${LOCAL_API_BASE_URL}/api/duty-plans/published/current`;
export const DUTY_PLAN_SCORE_SNAPSHOT_URL = `${LOCAL_API_BASE_URL}/api/duty-plans/score-snapshot`;
export const DUTY_PLAN_HISTORY_URL = `${LOCAL_API_BASE_URL}/api/duty-plans/history`;
export function dutyPlanHistoryDetailUrl(planId: string): string {
  return `${DUTY_PLAN_HISTORY_URL}/${encodeURIComponent(planId)}`;
}
export const EXAM_INVIGILATION_BASE_URL = `${LOCAL_API_BASE_URL}/api/exam-invigilation`;
export const EXAM_INVIGILATION_PREPARATION_URL = `${EXAM_INVIGILATION_BASE_URL}/preparation`;
export const EXAM_INVIGILATION_PLANS_URL = `${EXAM_INVIGILATION_BASE_URL}/plans`;
export function examInvigilationPlanUrl(planId: string): string { return `${EXAM_INVIGILATION_PLANS_URL}/${encodeURIComponent(planId)}`; }
export function examInvigilationCandidatesUrl(planId: string, sessionId: string): string { return `${examInvigilationPlanUrl(planId)}/sessions/${encodeURIComponent(sessionId)}/candidates`; }
export function examInvigilationAssignmentUrl(planId: string, sessionId: string): string { return `${examInvigilationPlanUrl(planId)}/sessions/${encodeURIComponent(sessionId)}/assignment`; }
export function examInvigilationCompleteUrl(planId: string): string { return `${examInvigilationPlanUrl(planId)}/complete`; }
export function dutyPlanHistoryReviseUrl(planId: string): string {
  return `${dutyPlanHistoryDetailUrl(planId)}/revise`;
}
export function dutyPlanHistoryArchiveUrl(planId: string): string {
  return `${dutyPlanHistoryDetailUrl(planId)}/archive`;
}
export function dutyLocationUrl(id: string): string {
  return `${DUTY_LOCATIONS_URL}/${encodeURIComponent(id)}`;
}
export function teacherDutyAvailabilityUrl(teacherId: string): string {
  return `${TEACHER_TIMETABLES_TEACHERS_URL}/${encodeURIComponent(teacherId)}/duty-availability`;
}
