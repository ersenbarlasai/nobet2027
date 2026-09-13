export interface AbsenceTypeVersion { effectiveFrom: string; name: string; createsDebt: boolean }
export interface AbsenceType {
  id: string;
  isActive: boolean;
  currentName: string;
  currentCreatesDebt: boolean;
  inUse: boolean;
  versions: AbsenceTypeVersion[];
}
