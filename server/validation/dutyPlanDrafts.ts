import { z } from "zod";

export const generationOptionsSchema = z
  .object({
    minWeeklyDuties: z.number().int().min(0).max(5).optional(),
    targetWeeklyDuties: z.number().int().min(0).max(5).optional(),
    maxWeeklyDuties: z.number().int().min(0).max(3).optional(),
    balanceWorkload: z.boolean().optional(),
    diversifyAreas: z.boolean().optional(),
    allowPartial: z.boolean().optional(),
    seed: z.number().int().optional(),
  })
  .strict()
  .refine(
    (v) => {
      const min = v.minWeeklyDuties ?? 1;
      const target = v.targetWeeklyDuties ?? 2;
      const max = v.maxWeeklyDuties ?? 3;
      return min <= target && target <= max;
    },
    { message: "minWeeklyDuties <= targetWeeklyDuties <= maxWeeklyDuties olmalıdır." },
  );

export const generateDutyPlanDraftSchema = z
  .object({
    options: generationOptionsSchema.optional(),
    weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Hafta başlangıcı YYYY-AA-GG biçiminde olmalıdır.")
      .refine((value) => new Date(`${value}T00:00:00Z`).getUTCDay() === 1, "Hafta başlangıcı Pazartesi olmalıdır.").optional(),
    activeDayOrders: z.array(z.number().int().min(1).max(5)).min(1, "En az bir iş günü seçilmelidir.").max(5)
      .refine((days) => new Set(days).size === days.length, "İş günleri tekrarlanamaz.").optional(),
    /**
     * NULL/undefined ⇔ istemci aktif taslak olmadığını düşünüyor. Bir plan
     * kimliği ⇔ istemci O taslağı bilinçli olarak yeniliyor. Bkz.
     * server/services/dutyPlanGeneration.ts ve save_duty_plan_draft RPC'si.
     */
    expectedPlanId: z.string().uuid("Geçersiz plan kimliği.").nullable().optional(),
  })
  .strict();

export type GenerateDutyPlanDraftInput = z.infer<typeof generateDutyPlanDraftSchema>;

export const dutyPlanScoreSnapshotQuerySchema = z.object({
  weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => new Date(`${value}T00:00:00Z`).getUTCDay() === 1, "Hafta başlangıcı Pazartesi olmalıdır."),
}).strict();

export const dutyPlanIdSchema = z.string().uuid("Geçersiz plan kimliği.");
export const dutyPlanTaskIdSchema = z.string().uuid("Geçersiz görev kimliği.");

export const updateDutyPlanAssignmentSchema = z
  .object({
    /** null ⇔ atamayı kaldır (unassigned). */
    teacherSourceId: z.string().trim().min(1).nullable(),
    expectedPlanVersion: z.number().int().min(1),
  })
  .strict();

export type UpdateDutyPlanAssignmentInput = z.infer<typeof updateDutyPlanAssignmentSchema>;

export const regenerateDutyPlanDraftSchema = z
  .object({
    options: generationOptionsSchema.optional(),
    expectedPlanVersion: z.number().int().min(1),
    /**
     * Varsayılan (false/undefined): mevcut manuel atamalar KİLİTLİ KISIT
     * olarak korunur (bkz. server/services/dutyPlanGeneration.ts
     * regenerateDutyPlanDraft). true ⇔ kullanıcı AYRI ve AÇIK biçimde tüm
     * manuel atamaları silmeyi onaylamıştır — yeniden üretme sıfırdan yapılır.
     */
    wipeManualAssignments: z.boolean().optional(),
  })
  .strict();

export type RegenerateDutyPlanDraftInput = z.infer<typeof regenerateDutyPlanDraftSchema>;

export const publishDutyPlanDraftSchema = z
  .object({
    expectedPlanVersion: z.number().int().min(1),
  })
  .strict();

export type PublishDutyPlanDraftInput = z.infer<typeof publishDutyPlanDraftSchema>;

/** Geçmiş planı revizyona açma/arşivleme için iyimser eşzamanlılık gövdesi. */
export const dutyPlanHistoryMutationSchema = z
  .object({ expectedPlanVersion: z.number().int().min(1) })
  .strict();

export type DutyPlanHistoryMutationInput = z.infer<typeof dutyPlanHistoryMutationSchema>;

// ============================================================================
// Manuel paket (FULL_DAY/SHORT_BREAKS/SINGLE_BLOCK) — çok hücreli manuel atama
// ============================================================================

export const manualPackageCoverageModeSchema = z.enum(["FULL_DAY", "SHORT_BREAKS", "SINGLE_BLOCK"]);

const manualPackageBaseSchema = {
  dayOrder: z.number().int().min(1).max(5),
  dutyLocationId: z.string().uuid("Geçersiz nöbet yeri kimliği."),
  /** null ⇔ paketi kaldır (unassigned). */
  teacherSourceId: z.string().trim().min(1).nullable(),
  coverageMode: manualPackageCoverageModeSchema,
  /** Yalnız coverageMode=SINGLE_BLOCK iken zorunlu. */
  dutyBlockId: z.string().uuid("Geçersiz blok kimliği.").optional(),
};

export const previewDutyPlanManualPackageSchema = z
  .object(manualPackageBaseSchema)
  .strict()
  .refine((v) => v.coverageMode !== "SINGLE_BLOCK" || v.dutyBlockId !== undefined, {
    message: "SINGLE_BLOCK için dutyBlockId zorunludur.",
    path: ["dutyBlockId"],
  });

export type PreviewDutyPlanManualPackageInput = z.infer<typeof previewDutyPlanManualPackageSchema>;

export const setDutyPlanManualPackageSchema = z
  .object({
    ...manualPackageBaseSchema,
    expectedPlanVersion: z.number().int().min(1),
    /**
     * Bir ÖNCEKİ preview çağrısından gelen affectedTasks kümesinin id'leri —
     * verilmezse VE etkilenen küme boş değilse RPC requires_confirmation
     * döner (sessiz yazma YOK). Taze küme ile eşleşmezse stale_affected_set.
     */
    expectedAffectedTaskIds: z.array(z.string().uuid()).nullable().optional(),
  })
  .strict()
  .refine((v) => v.coverageMode !== "SINGLE_BLOCK" || v.dutyBlockId !== undefined, {
    message: "SINGLE_BLOCK için dutyBlockId zorunludur.",
    path: ["dutyBlockId"],
  });

export type SetDutyPlanManualPackageInput = z.infer<typeof setDutyPlanManualPackageSchema>;
