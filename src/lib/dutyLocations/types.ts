export const DUTY_LOCATION_CATEGORIES = [
  "garden",
  "entrance",
  "floor",
  "corridor",
  "cafeteria",
  "sports_area",
  "other",
] as const;

export type DutyLocationCategory = (typeof DUTY_LOCATION_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<DutyLocationCategory, string> = {
  garden: "Bahçe",
  entrance: "Giriş",
  floor: "Kat",
  corridor: "Koridor",
  cafeteria: "Yemekhane",
  sports_area: "Spor Alanı",
  other: "Diğer",
};

/**
 * Okulun dört günlük nöbet bloğu. Kodlar ve Türkçe adları veritabanındaki
 * `duty_blocks` referans tablosundan gelir (bkz. migration 20260910090000);
 * frontend bunları YALNIZ gösterir, kullanıcı düzenleyemez.
 */
export const DUTY_BLOCK_CODES = ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"] as const;

export type DutyBlockCode = (typeof DUTY_BLOCK_CODES)[number];

/** Dar sütun başlıkları için kısa etiketler (tam ad `DutyBlock.name` alanındadır). */
export const BLOCK_SHORT_LABELS: Record<DutyBlockCode, string> = {
  MORNING_BREAKS: "Sabah",
  LONG_BREAK_1: "Uzun 1",
  LONG_BREAK_2: "Uzun 2",
  AFTERNOON_BREAKS: "Öğleden Sonra",
};

export interface DutyBlock {
  id: string;
  code: DutyBlockCode;
  name: string;
  blockOrder: number;
  /** Bu blokta nöbet tutmayı engelleyen ders saati adı ("5-OO"/"5-IO"); yoksa null. */
  conflictPeriodName: string | null;
}

export type DutyLocationBlockAssignmentMode = "normal" | "fixed_only" | "off";

export interface DutyLocationBlockPolicy {
  dutyBlockId: string;
  assignmentMode: Exclude<DutyLocationBlockAssignmentMode, "off">;
}

export interface DutyLocationBlockPolicyInput {
  dutyBlockId: string;
  assignmentMode: DutyLocationBlockAssignmentMode;
}

export interface DutyLocation {
  id: string;
  name: string;
  shortCode: string;
  category: DutyLocationCategory;
  capacity: number;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  /** Sabit nöbet bu yere verilebilir mi. Salt-okunur — arayüzden değiştirilemez. */
  allowsFixedAssignment: boolean;
  /** Bu yerin görev istediği bloklar (gün içi sırasında). Salt-okunur. */
  blockIds: string[];
  /** Yetkili yer×blok politikaları. Eşlemesi olmayan blok `off` kabul edilir. */
  blockPolicies: DutyLocationBlockPolicy[];
  createdAt: string;
  updatedAt: string;
}

export interface DutyLocationListResponse {
  items: DutyLocation[];
  blocks: DutyBlock[];
  summary: { total: number; active: number; inactive: number };
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
}

export type DutyLocationStatusFilter = "all" | "active" | "inactive";
export type DutyLocationSort = "order" | "name" | "category" | "active";

export interface DutyLocationListParams {
  search: string;
  category: DutyLocationCategory | "";
  status: DutyLocationStatusFilter;
  sort: DutyLocationSort;
  page: number;
  pageSize: number;
}

export interface DutyLocationCreateInput {
  name: string;
  shortCode: string;
  category: DutyLocationCategory;
  capacity: number;
  description: string | null;
  isActive: boolean;
  blockPolicies: DutyLocationBlockPolicyInput[];
}

// shortCode PATCH ile gönderilemez — kararlı/değiştirilemez tanımlayıcıdır
// (bkz. server/validation/dutyLocations.ts updateDutyLocationSchema, DB
// tetikleyicisi trg_duty_locations_short_code_immutable).
export type DutyLocationUpdateInput = Partial<Omit<DutyLocationCreateInput, "shortCode">> & { expectedUpdatedAt?: string };

export type DutyLocationErrorCode = "VALIDATION_ERROR" | "DUPLICATE_NAME" | "DUPLICATE_SHORT_CODE" | "NOT_FOUND" | "CONFLICT" | "DATABASE_ERROR";

export interface DutyLocationApiError {
  code: DutyLocationErrorCode;
  message: string;
  field?: string;
}
