import {
  DUTY_PLAN_DRAFTS_CURRENT_URL,
  DUTY_PLAN_DRAFTS_GENERATE_URL,
  DUTY_PLAN_DRAFTS_PREPARATION_URL,
  DUTY_PLAN_PUBLISHED_CURRENT_URL,
  DUTY_PLAN_SCORE_SNAPSHOT_URL,
  DUTY_PLAN_HISTORY_URL,
  dutyPlanHistoryDetailUrl,
  dutyPlanHistoryReviseUrl,
  dutyPlanHistoryArchiveUrl,
  dutyPlanDraftUrl,
  dutyPlanManualPackagePreviewUrl,
  dutyPlanManualPackageUrl,
  dutyPlanPublishUrl,
  dutyPlanRegenerateUrl,
  dutyPlanTaskCandidatesUrl,
  dutyPlanTaskUrl,
} from "../localApi";
export { UpdateDutyPlanAssignmentApiError, PublishDutyPlanDraftApiError, SetDutyPlanManualPackageApiError, DutyPlanHistoryMutationApiError } from "./types";
import {
  UpdateDutyPlanAssignmentApiError,
  PublishDutyPlanDraftApiError,
  SetDutyPlanManualPackageApiError,
  type DutyPlanDraftDto,
  type DutyPlanGenerationSnapshot,
  type GenerateDutyPlanDraftInput,
  type GenerateDutyPlanDraftOk,
  type ManualPackageInput,
  type PreviewDutyPlanManualPackageResult,
  type PublishDutyPlanDraftErrorBody,
  type PublishDutyPlanDraftInput,
  type PublishDutyPlanDraftOk,
  type PublishedDutyPlanDto,
  type RegenerateDutyPlanDraftInput,
  type SetDutyPlanManualPackageErrorBody,
  type SetDutyPlanManualPackageInput,
  type SetDutyPlanManualPackageOk,
  type TaskCandidatesDto,
  type TeacherDutyScoreSnapshot,
  type UpdateDutyPlanAssignmentErrorBody,
  type UpdateDutyPlanAssignmentInput,
  type UpdateDutyPlanAssignmentOk,
  DutyPlanHistoryMutationApiError,
  type DutyPlanHistoryListDto,
  type DutyPlanHistoryDetailDto,
  type DutyPlanHistoryMutationInput,
  type DutyPlanHistoryMutationResult,
} from "./types";

/** HTTP/ağ hatası — sunucudan yapılandırılmış bir hata gövdesi gelmedi. AbortError bu tipe ait DEĞİLDİR. */
export class DutyPlanDraftsFetchError extends Error {}

/**
 * POST /drafts/generate'in döndürebileceği tüm reddedilme/çakışma durumları
 * (bkz. server/routes/dutyPlanDrafts.ts). `status` alanı sunucunun `error`
 * alanıyla BİREBİR aynıdır — ekran bu değere göre dallanır.
 */
export interface GenerateDutyPlanDraftErrorBody {
  status:
    | "no_import"
    | "partial_not_allowed"
    | "source_changed"
    | "invalid_assignment"
    | "invalid_summary"
    | "teacher_day_conflict"
    | "weekly_limit_exceeded"
    | "fixed_assignment_changed"
    | "version_conflict"
    | "validation_error"
    | "internal_error"
    | "query_failed";
  message: string;
  uncoveredCount?: number;
  totalTaskCount?: number;
  currentSourceFingerprint?: string | null;
  currentPlanId?: string | null;
  currentVersion?: number;
  reason?: string;
  authoritative?: unknown;
}

export class GenerateDutyPlanDraftApiError extends Error {
  body: GenerateDutyPlanDraftErrorBody;
  constructor(body: GenerateDutyPlanDraftErrorBody) {
    super(body.message);
    this.body = body;
  }
}

async function readErrorBody<T extends { status: string; message: string }>(response: Response): Promise<T | null> {
  try {
    const body = (await response.json()) as { error?: string; message?: string; [key: string]: unknown };
    if (!body.error) return null;
    return { status: body.error, message: body.message ?? body.error, ...body } as unknown as T;
  } catch {
    return null;
  }
}

/** Üretim hazırlık görüntüsü — salt okunur (bkz. get_duty_plan_generation_snapshot RPC). */
export async function fetchDutyPlanPreparation(signal?: AbortSignal): Promise<DutyPlanGenerationSnapshot> {
  const response = await fetch(DUTY_PLAN_DRAFTS_PREPARATION_URL, { signal });
  if (!response.ok) {
    throw new DutyPlanDraftsFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as DutyPlanGenerationSnapshot;
}

export async function fetchTeacherDutyScoreSnapshot(weekStartDate: string, signal?: AbortSignal): Promise<TeacherDutyScoreSnapshot> {
  const url = new URL(DUTY_PLAN_SCORE_SNAPSHOT_URL);
  url.searchParams.set("weekStartDate", weekStartDate);
  const response = await fetch(url.toString(), { signal });
  if (!response.ok) throw new DutyPlanDraftsFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  return (await response.json()) as TeacherDutyScoreSnapshot;
}

/** Yeni bir nöbet planı taslağı üretir ve atomik biçimde kaydeder. */
export async function generateDutyPlanDraft(input: GenerateDutyPlanDraftInput, signal?: AbortSignal): Promise<GenerateDutyPlanDraftOk> {
  const response = await fetch(DUTY_PLAN_DRAFTS_GENERATE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) {
    const errorBody = await readErrorBody<GenerateDutyPlanDraftErrorBody>(response);
    if (errorBody) throw new GenerateDutyPlanDraftApiError(errorBody);
    throw new DutyPlanDraftsFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as GenerateDutyPlanDraftOk;
}

/** Kampüs/eğitim yılının AKTİF (status=draft) planı, varsa. */
export async function fetchCurrentDutyPlanDraft(signal?: AbortSignal): Promise<DutyPlanDraftDto> {
  const response = await fetch(DUTY_PLAN_DRAFTS_CURRENT_URL, { signal });
  if (!response.ok) {
    throw new DutyPlanDraftsFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as DutyPlanDraftDto;
}

/** Yalnız status=draft bir planı siler (cascade ile atamaları da). */
export async function deleteDutyPlanDraft(planId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(dutyPlanDraftUrl(planId), { method: "DELETE", signal });
  if (!response.ok && response.status !== 404) {
    throw new DutyPlanDraftsFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
}

/** TEK bir görev hücresi için aday öğretmen listesi (bilgilendirici). */
export async function fetchDutyPlanTaskCandidates(planId: string, taskId: string, signal?: AbortSignal): Promise<TaskCandidatesDto> {
  const response = await fetch(dutyPlanTaskCandidatesUrl(planId, taskId), { signal });
  if (!response.ok) {
    if (response.status === 404) return { found: false };
    throw new DutyPlanDraftsFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as TaskCandidatesDto;
}

/** TEK bir görev hücresini manuel olarak değiştirir (teacherSourceId null ⇔ atamayı kaldır). */
export async function updateDutyPlanAssignment(
  planId: string,
  taskId: string,
  input: UpdateDutyPlanAssignmentInput,
  signal?: AbortSignal,
): Promise<UpdateDutyPlanAssignmentOk> {
  const response = await fetch(dutyPlanTaskUrl(planId, taskId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) {
    const errorBody = await readErrorBody<UpdateDutyPlanAssignmentErrorBody>(response);
    if (errorBody) throw new UpdateDutyPlanAssignmentApiError(errorBody);
    throw new DutyPlanDraftsFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as UpdateDutyPlanAssignmentOk;
}

/**
 * Taslağı yeniden üretir. Varsayılan: mevcut manuel atamalar KİLİTLİ KISIT
 * olarak korunur. wipeManualAssignments:true ⇔ kullanıcının AYRI, AÇIK
 * onayı — tüm manuel atamalar silinir.
 */
export async function regenerateDutyPlanDraft(planId: string, input: RegenerateDutyPlanDraftInput, signal?: AbortSignal): Promise<GenerateDutyPlanDraftOk> {
  const response = await fetch(dutyPlanRegenerateUrl(planId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) {
    const errorBody = await readErrorBody<GenerateDutyPlanDraftErrorBody>(response);
    if (errorBody) throw new GenerateDutyPlanDraftApiError(errorBody);
    throw new DutyPlanDraftsFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as GenerateDutyPlanDraftOk;
}

/** Draft'ı yayımlar (açık görev=0, kural ihlali=0, kaynak+versiyon güncel olmalı). */
export async function publishDutyPlanDraft(planId: string, input: PublishDutyPlanDraftInput, signal?: AbortSignal): Promise<PublishDutyPlanDraftOk> {
  const response = await fetch(dutyPlanPublishUrl(planId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) {
    const errorBody = await readErrorBody<PublishDutyPlanDraftErrorBody>(response);
    if (errorBody) throw new PublishDutyPlanDraftApiError(errorBody);
    throw new DutyPlanDraftsFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as PublishDutyPlanDraftOk;
}

/** Kampüs/eğitim yılının yayımlanmış (AKTİF) nöbet planı — Haftalık Nöbet Planı ekranı için. */
export async function fetchPublishedDutyPlan(signal?: AbortSignal): Promise<PublishedDutyPlanDto> {
  const response = await fetch(DUTY_PLAN_PUBLISHED_CURRENT_URL, { signal });
  if (!response.ok) {
    throw new DutyPlanDraftsFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as PublishedDutyPlanDto;
}

export async function fetchDutyPlanHistory(signal?: AbortSignal): Promise<DutyPlanHistoryListDto> {
  const response = await fetch(DUTY_PLAN_HISTORY_URL, { signal });
  if (!response.ok) throw new DutyPlanDraftsFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  return (await response.json()) as DutyPlanHistoryListDto;
}

export async function fetchDutyPlanHistoryDetail(planId: string, signal?: AbortSignal): Promise<DutyPlanHistoryDetailDto> {
  const response = await fetch(dutyPlanHistoryDetailUrl(planId), { signal });
  if (response.status === 404) return { found: false };
  if (!response.ok) throw new DutyPlanDraftsFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  return (await response.json()) as DutyPlanHistoryDetailDto;
}

async function mutateDutyPlanHistory(
  url: string,
  input: DutyPlanHistoryMutationInput,
  signal?: AbortSignal,
): Promise<DutyPlanHistoryMutationResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) {
    const body = await readErrorBody<import("./types").DutyPlanHistoryMutationErrorBody>(response);
    if (body) throw new DutyPlanHistoryMutationApiError(body);
    throw new DutyPlanDraftsFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as DutyPlanHistoryMutationResult;
}

export function createDutyPlanRevision(planId: string, input: DutyPlanHistoryMutationInput, signal?: AbortSignal) {
  return mutateDutyPlanHistory(dutyPlanHistoryReviseUrl(planId), input, signal);
}

export function archivePublishedDutyPlan(planId: string, input: DutyPlanHistoryMutationInput, signal?: AbortSignal) {
  return mutateDutyPlanHistory(dutyPlanHistoryArchiveUrl(planId), input, signal);
}

/**
 * Çok hücreli manuel paket (FULL_DAY/SHORT_BREAKS/SINGLE_BLOCK) ön izlemesi
 * — salt okunur, hiçbir şey YAZMAZ. Hedef+etkilenen hücre kümesini, uygunluğu
 * ve varsa çakışan paketi döner; gerçek yazımdan (setDutyPlanManualPackage)
 * ÖNCE, kullanıcıya "hangi seçenekler gerçekten uygun" göstermek için
 * çağrılır.
 */
export async function previewDutyPlanManualPackage(planId: string, input: ManualPackageInput, signal?: AbortSignal): Promise<PreviewDutyPlanManualPackageResult> {
  const response = await fetch(dutyPlanManualPackagePreviewUrl(planId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) {
    if (response.status === 404) return { found: false };
    throw new DutyPlanDraftsFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as PreviewDutyPlanManualPackageResult;
}

/**
 * Çok hücreli manuel paketi yazar. Hedef kümenin DIŞINDA kalan (bölünecek)
 * yabancı paket hücreleri varsa VE `expectedAffectedTaskIds` verilmemişse
 * (veya taze küme ile eşleşmiyorsa) sessizce YAZMAZ — requires_confirmation/
 * stale_affected_set fırlatır, çağıran taraf güncel affectedTasks'ı
 * kullanıcıya gösterip AÇIK onayla AYNI isteği tekrar göndermelidir.
 */
export async function setDutyPlanManualPackage(planId: string, input: SetDutyPlanManualPackageInput, signal?: AbortSignal): Promise<SetDutyPlanManualPackageOk> {
  const response = await fetch(dutyPlanManualPackageUrl(planId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) {
    const errorBody = await readErrorBody<SetDutyPlanManualPackageErrorBody>(response);
    if (errorBody) throw new SetDutyPlanManualPackageApiError(errorBody);
    throw new DutyPlanDraftsFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as SetDutyPlanManualPackageOk;
}
