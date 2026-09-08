import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tarih YYYY-AA-GG biçiminde olmalıdır.");
export const examPlanIdSchema = z.string().uuid("Geçersiz sınav planı kimliği.");
export const examSessionIdSchema = z.string().uuid("Geçersiz oturum kimliği.");
export const examScopeSchema = z.enum(["PRESCHOOL", "PRIMARY_SCHOOL", "MIDDLE_SCHOOL", "HIGH_SCHOOL", "OTHER"]);

export const createExamInvigilationPlanSchema = z.object({
  name: z.string().trim().min(2).max(160),
  weekStartDate: isoDate.refine((value) => new Date(`${value}T00:00:00Z`).getUTCDay() === 1, "Hafta başlangıcı Pazartesi olmalıdır."),
  sessions: z.array(z.object({
    scopeCode: examScopeSchema,
    examDate: isoDate,
    periodOrder: z.number().int().min(1).max(20),
    schoolClassIds: z.array(z.string().uuid()).min(1).max(100).refine((v) => new Set(v).size === v.length, "Sınıflar tekrarlanamaz."),
    // Bir seçili sınıf bir sınav oturumu ve bir gözetmen görevidir.
    // Gözetmen adedi istemciden serbestçe belirlenemez.
    requiredCount: z.literal(1).default(1),
  }).strict()).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  const monday = new Date(`${value.weekStartDate}T00:00:00Z`);
  const seen = new Set<string>();
  value.sessions.forEach((session, index) => {
    const exam = new Date(`${session.examDate}T00:00:00Z`);
    const days = (exam.getTime() - monday.getTime()) / 86_400_000;
    if (days < 0 || days > 4) ctx.addIssue({ code: "custom", message: "Sınav tarihi seçilen haftanın iş günlerinden biri olmalıdır.", path: ["sessions", index, "examDate"] });
    for (const classId of session.schoolClassIds) {
      const key = `${session.scopeCode}|${session.examDate}|${session.periodOrder}|${classId}`;
      if (seen.has(key)) ctx.addIssue({ code: "custom", message: "Aynı sınıf, gün ve ders saati birden fazla eklenemez.", path: ["sessions", index, "schoolClassIds"] });
      seen.add(key);
    }
  });
});

/**
 * Plan kayıtları listesi süzgeçleri. Boş string'ler "süzgeç yok" demektir —
 * arayüz temizlenen bir alanı `?search=` olarak gönderebilir.
 */
export const listExamInvigilationPlansQuerySchema = z.object({
  status: z.enum(["all", "draft", "completed", "stale"]).default("all"),
  scopeCode: examScopeSchema.nullish(),
  search: z.string().trim().max(160).nullish(),
  dateFrom: isoDate.nullish(),
  dateTo: isoDate.nullish(),
  sort: z.enum(["newest", "oldest"]).default("newest"),
}).strict().superRefine((value, ctx) => {
  if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) {
    ctx.addIssue({ code: "custom", message: "Başlangıç tarihi bitiş tarihinden sonra olamaz.", path: ["dateFrom"] });
  }
});

export const setExamInvigilationAssignmentSchema = z.object({
  slotNumber: z.number().int().min(1).max(20),
  teacherSourceId: z.string().trim().min(1).nullable(),
  expectedScopeVersion: z.number().int().min(1),
  dutyCoverageAcknowledged: z.boolean().optional(),
  dutyCoverageNote: z.string().trim().max(500).nullable().optional(),
}).strict();

export const completeExamInvigilationScopeSchema = z.object({
  scopeCode: examScopeSchema,
  expectedScopeVersion: z.number().int().min(1),
}).strict();
export const discardExamInvigilationScopeSchema = completeExamInvigilationScopeSchema;

export type ListExamInvigilationPlansQuery = z.infer<typeof listExamInvigilationPlansQuerySchema>;
export type CreateExamInvigilationPlanInput = z.infer<typeof createExamInvigilationPlanSchema>;
export type SetExamInvigilationAssignmentInput = z.infer<typeof setExamInvigilationAssignmentSchema>;
export type CompleteExamInvigilationScopeInput = z.infer<typeof completeExamInvigilationScopeSchema>;
