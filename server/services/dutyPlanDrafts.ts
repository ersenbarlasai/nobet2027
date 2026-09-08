import type { SupabaseClient } from "@supabase/supabase-js";

export class DutyPlanDraftQueryError extends Error {}

async function attachWeekContext<T extends { found: boolean; id?: string }>(
  _supabase: SupabaseClient,
  _campusName: string,
  _academicYearName: string,
  value: T,
): Promise<T> {
  if (!value.found || !value.id) return value;
  const generationOptions = (value as { generationOptions?: Record<string, unknown> }).generationOptions;
  if (!generationOptions) return value;
  const weekStartDate = typeof generationOptions.weekStartDate === "string" ? generationOptions.weekStartDate : undefined;
  const activeDayOrders = Array.isArray(generationOptions.activeDayOrders)
    ? generationOptions.activeDayOrders.filter((day): day is number => typeof day === "number")
    : undefined;
  const priorScoreSnapshot = generationOptions.priorScoreSnapshot && typeof generationOptions.priorScoreSnapshot === "object"
    ? generationOptions.priorScoreSnapshot as Record<string, number>
    : undefined;
  return { ...value, weekStartDate, activeDayOrders, priorScoreSnapshot };
}

export interface DutyPlanDraftAssignmentDto {
  id: string;
  dayOrder: number;
  dutyLocationId: string;
  dutyLocationName: string;
  dutyBlockId: string;
  dutyBlockName: string;
  teacherSourceId: string | null;
  teacherName: string | null;
  assignmentKind: "fixed" | "generated" | "manual" | "unassigned";
  fixedDutyAssignmentId: string | null;
  scoreDetails: Record<string, unknown>;
  /** unassigned ⇔ null; diğerlerinde ait olduğu duty_plan_assignment_packages satırı. */
  packageId: string | null;
}

export type DutyPlanPackageCoverageMode = "FULL_DAY" | "SHORT_BREAKS" | "SINGLE_BLOCK" | "FIXED_SHORT_BREAKS";

/** Bir öğretmen-günü — aynı gün/yer/öğretmen için TEK paket, birden çok hücreyi kapsayabilir. */
export interface DutyPlanDraftPackageDto {
  id: string;
  dayOrder: number;
  dutyLocationId: string;
  teacherSourceId: string;
  teacherName: string;
  coverageMode: DutyPlanPackageCoverageMode;
  assignmentKind: "fixed" | "generated" | "manual";
  coveredTaskIds: string[];
}

export type DutyPlanDraftDto =
  | { found: false }
  | {
      found: true;
      id: string;
      status: "draft" | "published" | "archived";
      timetableImportId: string;
      sourceFingerprint: string;
      /** get_duty_plan_draft RPC'sinin yetkili stale hesabı (bkz. migration 20260915090000 bölüm 6). */
      savedSourceFingerprint: string;
      currentSourceFingerprint: string | null;
      isStale: boolean;
      algorithmVersion: string;
      generationSeed: number | null;
      generationOptions: Record<string, unknown>;
      summary: Record<string, unknown>;
      version: number;
      createdAt: string;
      updatedAt: string;
      weekStartDate?: string;
      activeDayOrders?: number[];
      priorScoreSnapshot?: Record<string, number>;
      assignments: DutyPlanDraftAssignmentDto[];
      packages: DutyPlanDraftPackageDto[];
    };

export async function fetchCurrentDutyPlanDraft(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
): Promise<DutyPlanDraftDto> {
  const { data, error } = await supabase.rpc("get_current_duty_plan_draft", {
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
  });
  if (error || !data) {
    throw new DutyPlanDraftQueryError("Aktif nöbet planı taslağı alınamadı.");
  }
  return attachWeekContext(supabase, campusName, academicYearName, data as unknown as DutyPlanDraftDto);
}

export async function fetchDutyPlanDraft(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
  planId: string,
): Promise<DutyPlanDraftDto> {
  const { data, error } = await supabase.rpc("get_duty_plan_draft", {
    p_plan_id: planId,
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
  });
  if (error || !data) {
    throw new DutyPlanDraftQueryError("Nöbet planı taslağı alınamadı.");
  }
  return attachWeekContext(supabase, campusName, academicYearName, data as unknown as DutyPlanDraftDto);
}

// ============================================================================
// Manuel atama — TEK görev hücresi
// ============================================================================

/**
 * get_duty_plan_task_candidates gerekçeleri — RPC ile BİREBİR aynı küme
 * (bkz. migration 20260920090000 ve v4 düzeltmesi 20260924090000). Yeni bir
 * gerekçe eklenirse burada da eklenmeli, aksi halde derleme "unknown" düşer.
 */
export type TaskCandidateIneligibilityReason =
  | "cell_not_open_for_normal"
  | "fixed_duty_day"
  | "already_assigned_same_block"
  | "daily_package_limit"
  | "half_day_daily_limit"
  | "no_preference_for_cell"
  | "time_rule_violation"
  | "weekly_limit_reached";

export interface TaskCandidateDto {
  teacherSourceId: string;
  teacherName: string;
  isCurrent: boolean;
  eligible: boolean;
  reasons: TaskCandidateIneligibilityReason[];
}

export type TaskCandidatesDto =
  | { found: false }
  | { found: true; taskFound: false; planStatus: string; planVersion: number }
  | {
      found: true;
      taskFound: true;
      planStatus: string;
      planVersion: number;
      isFixed: boolean;
      currentAssignment: { teacherSourceId: string | null; teacherName: string | null; assignmentKind: string };
      isStale: boolean;
      currentSourceFingerprint: string | null;
      candidates: TaskCandidateDto[];
    };

export async function fetchDutyPlanTaskCandidates(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
  planId: string,
  taskId: string,
): Promise<TaskCandidatesDto> {
  const { data, error } = await supabase.rpc("get_duty_plan_task_candidates", {
    p_plan_id: planId,
    p_task_id: taskId,
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
  });
  if (error || !data) {
    throw new DutyPlanDraftQueryError("Görev adayları alınamadı.");
  }
  return data as unknown as TaskCandidatesDto;
}

export type UpdateDutyPlanAssignmentResult =
  | {
      status: "ok";
      version: number;
      assignment: {
        taskId: string;
        dayOrder: number;
        dutyLocationId: string;
        dutyBlockId: string;
        teacherSourceId: string | null;
        teacherName: string | null;
        assignmentKind: string;
      };
      summary: Record<string, unknown>;
    }
  | { status: "plan_not_found" }
  | { status: "plan_not_draft" }
  | { status: "version_conflict"; currentVersion: number }
  | { status: "source_changed"; currentSourceFingerprint: string | null }
  | { status: "task_not_found" }
  | { status: "fixed_task_immutable" }
  | { status: "teacher_not_in_import" }
  | { status: "teacher_not_included" }
  | { status: "teacher_has_fixed_duty" }
  | {
      status: "teacher_day_conflict";
      /** v4'te günlük paket, tarihsel planlarda yarım gün kuralı sınırı aşıldı. */
      reason?: "half_day_rule" | "daily_package_limit";
      conflictingPackage: { id: string; coverageMode: DutyPlanPackageCoverageMode; dutyLocationId: string; assignmentKind: string };
    }
  /** Aynı gün AYNI BLOK'ta başka bir yerde görev var (yarım gün kapalı olsa bile yasak). */
  | { status: "teacher_block_conflict" }
  /** Hedef hücrenin bloğu assignment_mode='normal' değil. */
  | { status: "cell_not_open_for_normal" }
  | { status: "no_preference_for_cell" }
  | { status: "time_rule_violation" }
  | { status: "weekly_limit_exceeded" }
  | { status: "v4_package_action_required" }
  | {
      /** Hücre >1 hücreli bir FULL_DAY/SHORT_BREAKS paketinin parçası — bu uç
       * nokta tekil hücre içindir, çok hücreli işlem manual-package uç
       * noktasına yönlendirilmeli (sessiz bölme YOK). */
      status: "requires_package_action";
      package: {
        id: string;
        coverageMode: DutyPlanPackageCoverageMode;
        teacherSourceId: string;
        teacherName: string;
        dutyLocationId: string;
        coveredTaskIds: string[];
      };
    };

export async function updateDutyPlanAssignment(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
  planId: string,
  taskId: string,
  input: { teacherSourceId: string | null; expectedPlanVersion: number },
): Promise<UpdateDutyPlanAssignmentResult> {
  const { data, error } = await supabase.rpc("update_duty_plan_assignment", {
    p_plan_id: planId,
    p_task_id: taskId,
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
    p_teacher_source_id: input.teacherSourceId,
    p_expected_plan_version: input.expectedPlanVersion,
  });
  if (error?.message?.includes("v4_invalid_package_cells") || error?.message?.includes("v4_teacher_daily_package_limit")) {
    return { status: "v4_package_action_required" };
  }
  if (error || !data) {
    throw new DutyPlanDraftQueryError("Manuel atama kaydedilemedi.");
  }
  return data as unknown as UpdateDutyPlanAssignmentResult;
}

// ============================================================================
// Yayımlama
// ============================================================================

export type PublishDutyPlanDraftResult =
  | { status: "ok"; planId: string; version: number; publishedAt: string; archivedPreviousPlanId: string | null }
  | { status: "plan_not_found" }
  | { status: "plan_not_draft" }
  | { status: "version_conflict"; currentVersion: number }
  | { status: "source_stale"; currentSourceFingerprint: string | null }
  | { status: "open_tasks_remaining"; uncoveredCount: number }
  | { status: "rule_violation"; reason: string };

export async function publishDutyPlanDraft(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
  planId: string,
  expectedPlanVersion: number,
): Promise<PublishDutyPlanDraftResult> {
  const { data, error } = await supabase.rpc("publish_duty_plan_draft", {
    p_plan_id: planId,
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
    p_expected_plan_version: expectedPlanVersion,
  });
  if (error || !data) {
    throw new DutyPlanDraftQueryError("Nöbet planı yayımlanamadı.");
  }
  return data as unknown as PublishDutyPlanDraftResult;
}

export interface PublishedDutyPlanAssignmentDto {
  id: string;
  dayOrder: number;
  dutyLocationId: string;
  dutyLocationName: string;
  dutyBlockId: string;
  dutyBlockName: string;
  teacherSourceId: string | null;
  teacherName: string | null;
  assignmentKind: "fixed" | "generated" | "manual" | "unassigned";
  packageId: string | null;
}

/** Yayımlanmış plan paketi — tarihsel snapshot alanlarıyla (sonraki XML importundan ETKİLENMEZ). */
export interface PublishedDutyPlanPackageDto {
  id: string;
  dayOrder: number;
  dutyLocationId: string;
  dutyLocationName: string;
  teacherSourceId: string;
  teacherName: string;
  coverageMode: DutyPlanPackageCoverageMode;
  assignmentKind: "fixed" | "generated" | "manual";
  coveredBlockCodes: string[];
}

export type PublishedDutyPlanDto =
  | { found: false }
  | {
      found: true;
      id: string;
      status: "published";
      algorithmVersion: string;
      generationOptions: Record<string, unknown>;
      summary: Record<string, unknown>;
      version: number;
      createdAt: string;
      updatedAt: string;
      weekStartDate?: string;
      activeDayOrders?: number[];
      assignments: PublishedDutyPlanAssignmentDto[];
      packages: PublishedDutyPlanPackageDto[];
    };

export async function fetchPublishedDutyPlan(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
): Promise<PublishedDutyPlanDto> {
  const { data, error } = await supabase.rpc("get_published_duty_plan", {
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
  });
  if (error || !data) {
    throw new DutyPlanDraftQueryError("Yayımlanmış nöbet planı alınamadı.");
  }
  return attachWeekContext(supabase, campusName, academicYearName, data as unknown as PublishedDutyPlanDto);
}

export type DutyPlanHistoryStatus = "draft" | "published" | "archived";

export interface DutyPlanHistoryListItemDto {
  id: string;
  weekStartDate: string;
  activeDayOrders: number[];
  status: DutyPlanHistoryStatus;
  version: number;
  algorithmVersion: string;
  createdAt: string;
  updatedAt: string;
  packageCount: number;
  assignedTeacherCount: number;
  priorPointTotal: number;
  weekPointTotal: number;
  projectedWeekPointTotal: number;
  cumulativePointTotal: number;
  normalCoveredCount: number;
  uncoveredCount: number;
}

export interface DutyPlanTeacherPointsDto {
  teacherSourceId: string;
  teacherName: string;
  priorPoints: number;
  weekPoints: number;
  totalPoints: number;
  isProjected: boolean;
}

export interface DutyPlanHistoryListDto { plans: DutyPlanHistoryListItemDto[] }

export type DutyPlanHistoryDetailDto =
  | { found: false }
  | (Omit<Extract<PublishedDutyPlanDto, { found: true }>, "status"> & {
      status: DutyPlanHistoryStatus;
      priorScoreSnapshot: Record<string, number>;
      isStale: boolean;
      teacherPoints: DutyPlanTeacherPointsDto[];
    });

export async function fetchDutyPlanHistory(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
): Promise<DutyPlanHistoryListDto> {
  const { data, error } = await supabase.rpc("list_duty_plan_history", {
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
  });
  if (error || !data) throw new DutyPlanDraftQueryError("Nöbet planı geçmişi alınamadı.");
  return data as unknown as DutyPlanHistoryListDto;
}

export async function fetchDutyPlanHistoryDetail(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
  planId: string,
): Promise<DutyPlanHistoryDetailDto> {
  const { data, error } = await supabase.rpc("get_duty_plan_history_detail", {
    p_plan_id: planId,
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
  });
  if (error || !data) throw new DutyPlanDraftQueryError("Nöbet planı ayrıntısı alınamadı.");
  return data as unknown as DutyPlanHistoryDetailDto;
}

export type CreateDutyPlanRevisionResult =
  | { status: "ok"; planId: string; version: number }
  | { status: "already_draft"; planId: string; version: number }
  | { status: "plan_not_found" }
  | { status: "version_conflict"; currentVersion: number }
  | { status: "active_draft_exists"; planId: string }
  | { status: "source_stale"; currentSourceFingerprint: string | null };

export async function createDutyPlanRevision(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
  planId: string,
  expectedPlanVersion: number,
): Promise<CreateDutyPlanRevisionResult> {
  const { data, error } = await supabase.rpc("create_duty_plan_revision", {
    p_plan_id: planId,
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
    p_expected_plan_version: expectedPlanVersion,
  });
  if (error || !data) throw new DutyPlanDraftQueryError("Plan revizyonu oluşturulamadı.");
  return data as unknown as CreateDutyPlanRevisionResult;
}

export type ArchivePublishedDutyPlanResult =
  | { status: "ok"; planId: string; version: number }
  | { status: "already_archived"; planId: string; version: number }
  | { status: "plan_not_found" }
  | { status: "version_conflict"; currentVersion: number }
  | { status: "plan_not_published" };

export async function archivePublishedDutyPlan(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
  planId: string,
  expectedPlanVersion: number,
): Promise<ArchivePublishedDutyPlanResult> {
  const { data, error } = await supabase.rpc("archive_published_duty_plan", {
    p_plan_id: planId,
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
    p_expected_plan_version: expectedPlanVersion,
  });
  if (error || !data) throw new DutyPlanDraftQueryError("Plan arşivlenemedi.");
  return data as unknown as ArchivePublishedDutyPlanResult;
}

export type DeleteDutyPlanDraftResult = "ok" | "not_found" | "not_draft";

export async function deleteDutyPlanDraft(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
  planId: string,
): Promise<DeleteDutyPlanDraftResult> {
  const { data, error } = await supabase.rpc("delete_duty_plan_draft", {
    p_plan_id: planId,
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
  });
  if (error || !data) {
    throw new DutyPlanDraftQueryError("Nöbet planı taslağı silinemedi.");
  }
  return (data as { status: DeleteDutyPlanDraftResult }).status;
}

// ============================================================================
// Manuel PAKET (FULL_DAY/SHORT_BREAKS/SINGLE_BLOCK) — çok hücreli manuel
// atama. preview_duty_plan_manual_package/set_duty_plan_manual_package
// RPC'leri TEK karar mantığını (compute_duty_plan_manual_package_change)
// paylaşır — bkz. 20260918090000_create_duty_plan_packages.sql.
// ============================================================================

export interface ManualPackageTargetTaskDto {
  id: string;
  dutyBlockId: string;
  dutyBlockName: string;
  currentTeacherSourceId: string | null;
  currentTeacherName: string | null;
  currentAssignmentKind: string;
  currentPackageId: string | null;
}

export interface ManualPackageAffectedTaskDto {
  id: string;
  dutyBlockId: string;
  dutyBlockName: string;
  currentTeacherSourceId: string | null;
  currentTeacherName: string | null;
  packageId: string | null;
}

export interface ManualPackageConflictDto {
  id: string;
  coverageMode: DutyPlanPackageCoverageMode;
  dutyLocationId: string;
  assignmentKind: string;
}

export type PreviewDutyPlanManualPackageResult =
  | { found: false }
  | { found: true; eligible: false; reasons: string[]; targetTaskIds?: undefined }
  | {
      found: true;
      planStatus: string;
      planVersion: number;
      targetTaskIds: string[];
      targetTasks: ManualPackageTargetTaskDto[];
      affectedTasks: ManualPackageAffectedTaskDto[];
      eligible: boolean;
      reasons: string[];
      conflictingPackage: ManualPackageConflictDto | null;
    };

export interface ManualPackageInput {
  dayOrder: number;
  dutyLocationId: string;
  teacherSourceId: string | null;
  coverageMode: "FULL_DAY" | "SHORT_BREAKS" | "SINGLE_BLOCK";
  dutyBlockId?: string;
}

export async function previewDutyPlanManualPackage(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
  planId: string,
  input: ManualPackageInput,
): Promise<PreviewDutyPlanManualPackageResult> {
  const { data, error } = await supabase.rpc("preview_duty_plan_manual_package", {
    p_plan_id: planId,
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
    p_day_order: input.dayOrder,
    p_duty_location_id: input.dutyLocationId,
    p_teacher_source_id: input.teacherSourceId,
    p_coverage_mode: input.coverageMode,
    p_duty_block_id: input.dutyBlockId ?? null,
  });
  if (error || !data) {
    throw new DutyPlanDraftQueryError("Manuel paket ön izlemesi alınamadı.");
  }
  return data as unknown as PreviewDutyPlanManualPackageResult;
}

export type SetDutyPlanManualPackageResult =
  | { status: "ok"; version: number; packageId: string | null; summary: Record<string, unknown> }
  | { status: "plan_not_found" }
  | { status: "plan_not_draft" }
  | { status: "version_conflict"; currentVersion: number }
  | { status: "source_changed"; currentSourceFingerprint: string | null }
  | { status: "invalid_package_combination" }
  | { status: "task_not_found" }
  | { status: "fixed_task_immutable" }
  | { status: "requires_confirmation"; affectedTasks: ManualPackageAffectedTaskDto[] }
  | { status: "stale_affected_set"; affectedTasks: ManualPackageAffectedTaskDto[] }
  | { status: "teacher_not_in_import" }
  | { status: "teacher_not_included" }
  | { status: "teacher_has_fixed_duty" }
  | { status: "teacher_day_conflict"; reason?: "half_day_rule" | "daily_package_limit"; conflictingPackage: ManualPackageConflictDto }
  | { status: "teacher_block_conflict" }
  | { status: "cell_not_open_for_normal" }
  /** solver-v3 planlarda normal paket yalnız SINGLE_BLOCK olabilir. */
  | { status: "normal_package_must_be_single_block" }
  | { status: "no_preference_for_cell" }
  | { status: "time_rule_violation" }
  | { status: "weekly_limit_exceeded" };

export async function setDutyPlanManualPackage(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
  planId: string,
  input: ManualPackageInput & { expectedPlanVersion: number; expectedAffectedTaskIds?: string[] | null },
): Promise<SetDutyPlanManualPackageResult> {
  const { data, error } = await supabase.rpc("set_duty_plan_manual_package", {
    p_plan_id: planId,
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
    p_day_order: input.dayOrder,
    p_duty_location_id: input.dutyLocationId,
    p_teacher_source_id: input.teacherSourceId,
    p_coverage_mode: input.coverageMode,
    p_expected_plan_version: input.expectedPlanVersion,
    p_expected_affected_task_ids: input.expectedAffectedTaskIds ?? null,
    p_duty_block_id: input.dutyBlockId ?? null,
  });
  if (error?.message?.includes("v4_unsupported_package_mode") || error?.message?.includes("v4_invalid_package_cells")) {
    return { status: "invalid_package_combination" };
  }
  if (error || !data) {
    throw new DutyPlanDraftQueryError("Manuel paket kaydedilemedi.");
  }
  return data as unknown as SetDutyPlanManualPackageResult;
}
