export type ClosureType = "ara_tatil" | "yariyil_tatili" | "tam_kapali_hafta" | "resmi_tatil";
export interface EducationClosure { id: string; closureType: ClosureType; dateFrom: string; dateTo: string; description: string | null }
export interface EducationCalendar {
  term: { startDate: string; endDate: string; description: string | null } | null;
  closures: EducationClosure[];
}
