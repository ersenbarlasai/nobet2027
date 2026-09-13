import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const saveTermSchema = z.object({
  startDate: isoDate,
  endDate: isoDate,
  description: z.string().trim().max(500).nullable().optional(),
}).strict().refine((v) => v.endDate >= v.startDate, { message: "Bitiş tarihi başlangıçtan önce olamaz." });

export const addClosureSchema = z.object({
  closureType: z.enum(["ara_tatil", "yariyil_tatili", "tam_kapali_hafta", "resmi_tatil"]),
  dateFrom: isoDate,
  dateTo: isoDate,
  description: z.string().trim().max(500).nullable().optional(),
}).strict().refine((v) => v.dateTo >= v.dateFrom, { message: "Bitiş tarihi başlangıçtan önce olamaz." });
