import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateFixedDutyAssignmentInput } from "../validation/fixedDutyAssignments";

export interface FixedDutySnapshot {
  hasImport: boolean;
  teachers?: Array<{ id: string; sourceId: string; name: string }>;
  days?: Array<{ order: number; name: string }>;
  /**
   * YALNIZ sabit nöbete uygun (allows_fixed_assignment=true) aktif yerler.
   * Filtre RPC'de uygulanır; bu bir kolaylıktır, asıl zorlama
   * create_fixed_duty_assignment içindedir.
   */
  dutyLocations?: Array<{ id: string; name: string; shortCode: string; allowsFixedAssignment: boolean }>;
  assignments?: Array<{
    id: string;
    teacherSourceId: string;
    teacherName: string;
    dayOrder: number;
    dutyLocationId: string;
    dutyLocationName: string;
  }>;
}

export type CreateFixedDutyResult =
  | { status: "ok"; id: string }
  | {
      status:
        | "not_found"
        | "teacher_not_found"
        | "location_not_found"
        // Sabit nöbete uygun OLMAYAN bir yere atama denendi. Frontend seçim
        // listesi bunu zaten engeller; bu durum yalnız filtre aşıldığında
        // (eski sekme, doğrudan HTTP/RPC çağrısı) döner.
        | "location_not_fixed_eligible"
        | "invalid_day"
        | "location_conflict"
        | "teacher_conflict";
    };

export async function fetchFixedDutyAssignments(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
): Promise<FixedDutySnapshot> {
  const { data, error } = await supabase.rpc("get_fixed_duty_assignments", {
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
  });
  if (error || !data) throw new Error("fixed_duty_query_failed");
  return data as unknown as FixedDutySnapshot;
}

export async function createFixedDutyAssignment(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
  input: CreateFixedDutyAssignmentInput,
): Promise<CreateFixedDutyResult> {
  const { data, error } = await supabase.rpc("create_fixed_duty_assignment", {
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
    p_teacher_id: input.teacherId,
    p_day_order: input.dayOrder,
    p_duty_location_id: input.dutyLocationId,
  });
  if (error || !data) throw new Error("fixed_duty_create_failed");
  return data as unknown as CreateFixedDutyResult;
}

export async function deleteFixedDutyAssignment(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
  assignmentId: string,
): Promise<"ok" | "not_found"> {
  const { data, error } = await supabase.rpc("delete_fixed_duty_assignment", {
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
    p_assignment_id: assignmentId,
  });
  if (error || !data) throw new Error("fixed_duty_delete_failed");
  return (data as unknown as { status: "ok" | "not_found" }).status;
}
