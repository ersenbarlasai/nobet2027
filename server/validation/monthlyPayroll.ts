import { z } from "zod";

const monthStart = z.string().regex(/^\d{4}-\d{2}-01$/, "Ay başlangıcı YYYY-MM-01 biçiminde olmalıdır.");
export const monthQuery = z.object({ monthStart }).strict();
export const teacherMonthQuery = z.object({ monthStart, teacherSourceId: z.string().trim().min(1) }).strict();
export const closeTeacherSchema = z.object({ monthStart, teacherSourceId: z.string().trim().min(1) }).strict();
export const closePeriodSchema = z.object({ monthStart }).strict();
export const correctionSchema = z.object({
  teacherSourceId: z.string().trim().min(1),
  monthStart,
  type: z.enum(["debt_adjust", "paid_count_adjust", "payment_amount_adjust"]),
  amount: z.number().finite().refine((v) => v !== 0),
  unitRateCents: z.number().int().nonnegative().nullable().optional(),
  reason: z.string().trim().min(3).max(500),
  createdBy: z.string().trim().max(200).nullable().optional(),
}).strict();
export const yearEndClearSchema = z.object({
  teacherSourceId: z.string().trim().min(1),
  debtAmount: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500),
  targetMonthStart: monthStart,
  createdBy: z.string().trim().max(200).nullable().optional(),
}).strict();
export const setSubstitutionTypeSchema = z.object({ typeId: z.string().uuid().nullable() }).strict();
