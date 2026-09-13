import type { SupabaseClient } from "@supabase/supabase-js";

// "Sistem ve Veri" ekranı — deneme sürecinde oluşan planlama/puantaj
// kayıtlarını temizler. Ders programı, öğretmen/sınıf/ders, nöbet yerleri/
// blokları, öğretmen nöbet uygunlukları, sabit nöbet tanımları, ücret
// türleri/birim ücretler ve kampüs/eğitim yılı bu serviste HİÇ ele alınmaz.

export type SystemDataErrorCode = "DATABASE_ERROR";

export class SystemDataError extends Error {
  code: SystemDataErrorCode;
  constructor(code: SystemDataErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface TrialDataCounts {
  dutyPlanCount: number;
  examInvigilationPlanCount: number;
  assignmentListCount: number;
  payrollRecordCount: number;
  closedPeriodCount: number;
}

interface CountsRpcResult {
  status: "ok";
  dutyPlanCount: number;
  examInvigilationPlanCount: number;
  assignmentListCount: number;
  payrollRecordCount: number;
  closedPeriodCount: number;
}

export async function getTrialDataCounts(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
): Promise<TrialDataCounts> {
  const { data, error } = await supabase.rpc("get_trial_data_counts", {
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
  });
  if (error || !data) {
    throw new SystemDataError("DATABASE_ERROR", "Kayıt sayıları alınamadı.");
  }
  const result = data as CountsRpcResult;
  return {
    dutyPlanCount: result.dutyPlanCount,
    examInvigilationPlanCount: result.examInvigilationPlanCount,
    assignmentListCount: result.assignmentListCount,
    payrollRecordCount: result.payrollRecordCount,
    closedPeriodCount: result.closedPeriodCount,
  };
}

interface ClearRpcResult {
  status: "ok" | "not_found";
  deleted?: {
    dutyPlanCount: number;
    examInvigilationPlanCount: number;
    assignmentListCount: number;
    payrollRecordCount: number;
    closedPeriodCount: number;
  };
}

export async function clearTrialRecords(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
): Promise<TrialDataCounts> {
  const { data, error } = await supabase.rpc("clear_trial_records", {
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
  });
  if (error || !data) {
    // RPC gövdesi tek bir plpgsql fonksiyonudur; bir adım başarısız olursa
    // TÜM etkiler geri alınır (Postgres fonksiyon-seviyesi atomiklik) —
    // burada hiçbir kayıt silinmemiş olur.
    throw new SystemDataError("DATABASE_ERROR", "Kayıtlar temizlenemedi. Veritabanında değişiklik yapılmadı. Lütfen tekrar deneyin.");
  }
  const result = data as ClearRpcResult;
  if (result.status !== "ok" || !result.deleted) {
    throw new SystemDataError("DATABASE_ERROR", "Kayıtlar temizlenemedi. Veritabanında değişiklik yapılmadı. Lütfen tekrar deneyin.");
  }
  return result.deleted;
}
