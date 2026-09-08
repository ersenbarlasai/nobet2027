import { z } from "zod";

export const createFixedDutyAssignmentSchema = z.object({
  teacherId: z.string().uuid("Geçersiz öğretmen kimliği."),
  dayOrder: z.number().int().min(1).max(5),
  dutyLocationId: z.string().uuid("Geçersiz nöbet yeri kimliği."),
}).strict();

export const fixedDutyAssignmentIdSchema = z.string().uuid("Geçersiz sabit nöbet kimliği.");

export type CreateFixedDutyAssignmentInput = z.infer<typeof createFixedDutyAssignmentSchema>;
