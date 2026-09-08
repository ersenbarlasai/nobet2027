import { z } from "zod";

const isoDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const uuid=z.string().uuid();
export const preparationQuery=z.object({teacherSourceId:z.string().trim().min(1).optional(),dateFrom:isoDate.optional(),dateTo:isoDate.optional()}).strict().superRefine((v,c)=>{if((v.dateFrom&&!v.dateTo)||(!v.dateFrom&&v.dateTo)||v.dateFrom&&v.dateTo&&v.dateFrom>v.dateTo)c.addIssue({code:"custom",message:"Geçerli bir tarih aralığı seçin."});});
export const createAbsenceSchema=z.object({teacherSourceId:z.string().trim().min(1),dateFrom:isoDate,dateTo:isoDate,absenceScope:z.enum(["all_day","selected_lessons"]),reasonCode:z.enum(["medical_report","leave","official_duty","other"]),note:z.string().trim().max(500).nullable().optional(),lessons:z.array(z.object({assignmentDate:isoDate,timetableCardId:uuid}).strict()).min(1).max(500)}).strict().refine(v=>v.dateTo>=v.dateFrom,{message:"Bitiş tarihi başlangıçtan önce olamaz."});
export const setTaskSchema=z.object({teacherSourceId:z.string().trim().min(1).nullable(),unfilledNote:z.string().trim().max(500).nullable().optional(),expectedVersion:z.number().int().positive(),overrideAcknowledged:z.boolean().optional(),overrideNote:z.string().trim().max(500).nullable().optional()}).strict();
export const completeListSchema=z.object({expectedVersion:z.number().int().positive()}).strict();
export const deleteAbsenceSchema=z.object({expectedTaskIds:z.array(uuid).max(500)}).strict();
export const payrollEntrySchema=z.object({teacherSourceId:z.string().trim().min(1),replacedTeacherSourceId:z.string().trim().min(1).nullable().optional(),dutyDate:isoDate,compensationTypeId:uuid,quantity:z.number().finite().refine(v=>v!==0),note:z.string().trim().max(500).nullable().optional()}).strict().refine(v=>v.quantity>0||Boolean(v.note?.trim()),{message:"Eksi düzeltme kaydı için açıklama zorunludur.",path:["note"]});
export const compensationTypeSchema=z.object({id:uuid.nullable().optional(),name:z.string().trim().min(2).max(100),isActive:z.boolean().default(true)}).strict();
export const compensationRateSchema=z.object({effectiveFrom:isoDate,unitRate:z.number().min(0).max(1_000_000)}).strict();
export const payrollQuery=z.object({anchorDate:isoDate}).strict();
export const closePayrollSchema=z.object({anchorDate:isoDate,force:z.boolean().optional()}).strict();
