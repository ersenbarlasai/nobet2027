import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const saveAbsenceTypeSchema = z.object({
  id: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(2).max(100),
  createsDebt: z.boolean(),
  effectiveFrom: isoDate,
  isActive: z.boolean().default(true),
}).strict();
