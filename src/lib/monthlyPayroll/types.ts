export type TaskDisposition = "debt_offset" | "threshold_fill" | "paid" | "rate_missing";
export interface TaskAllocation { source_task_id?: string; taskId?: string; assignment_date?: string; assignmentDate?: string; period_order?: number; periodOrder?: number; disposition: TaskDisposition; amount_cents?: number | null; amountCents?: number | null }
export interface MonthlyPayrollOverview {
  source: "closed" | "preview";
  teacherSourceId?: string;
  teacherNameSnapshot?: string;
  monthStart?: string;
  activeWeekCount?: number;
  active_week_count?: number;
  normalMonthlyLoad?: number;
  normal_monthly_load?: number;
  monthlyThreshold?: number;
  monthly_threshold?: number;
  monthlyCompletionGap?: number;
  monthly_completion_gap?: number;
  debtCarryIn?: number;
  debt_carry_in?: number;
  debtCreatedThisMonth?: number;
  debt_created_this_month?: number;
  debtOffsetCount?: number;
  debt_offset_count?: number;
  thresholdFillCount?: number;
  threshold_fill_count?: number;
  paidLessonCount?: number;
  paid_lesson_count?: number;
  debtCarryOut?: number;
  debt_carry_out?: number;
  grossAmountCents?: number;
  gross_amount_cents?: number;
  financialOffsetCarryIn?: number;
  financial_offset_carry_in_cents?: number;
  financialOffsetApplied?: number;
  financial_offset_applied_cents?: number;
  financialOffsetCarryOut?: number;
  financial_offset_carry_out_cents?: number;
  netAmountCents?: number;
  net_amount_cents?: number;
  hasMissingRate?: boolean;
  hasEducationCalendar?: boolean;
  hasCompensationType?: boolean;
  allocations?: TaskAllocation[];
  taskAllocations?: TaskAllocation[];
}
export interface RelevantTeacher { sourceId: string; name: string }
export interface PayrollPeriod { id: string; monthStart: string; status: "open" | "closed"; closedAt: string | null }
export interface PayrollCorrection { id: string; type: string; amount: number; reason: string; createdAt: string; createdBy: string | null }
