export interface FixedDutyTeacher { id: string; sourceId: string; name: string }
export interface FixedDutyDay { order: number; name: string }
/**
 * Sabit nöbete UYGUN nöbet yeri. Sunucu bu listeyi zaten
 * allows_fixed_assignment=true olanlarla sınırlar; bayrak yine de taşınır ki
 * arayüz "neden sadece bunlar var" sorusunu yanıtlayabilsin.
 */
export interface FixedDutyLocation { id: string; name: string; shortCode: string; allowsFixedAssignment: boolean }
export interface FixedDutyAssignment {
  id: string;
  teacherSourceId: string;
  teacherName: string;
  dayOrder: number;
  dutyLocationId: string;
  dutyLocationName: string;
}
export interface FixedDutySnapshot {
  hasImport: boolean;
  teachers?: FixedDutyTeacher[];
  days?: FixedDutyDay[];
  dutyLocations?: FixedDutyLocation[];
  assignments?: FixedDutyAssignment[];
}
