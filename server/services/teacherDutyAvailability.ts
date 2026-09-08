import type { SupabaseClient } from "@supabase/supabase-js";
import type { DutyLocationCategory } from "../validation/dutyLocations";
import type { DutyBlockDto } from "./dutyBlocks";
import type { SaveDutyAvailabilityInput } from "../validation/teacherDutyAvailability";

/** RPC çağrısı başarısız olduğunda fırlatılır. Mesajı kullanıcıya güvenle gösterilebilir; bağlantı bilgisi/stack içermez. */
export class TeacherDutyAvailabilityQueryError extends Error {}

export interface DutyMatrixDay {
  order: number;
  name: string;
}

export interface DutyMatrixLocation {
  id: string;
  name: string;
  shortCode: string;
  category: DutyLocationCategory;
  capacity: number;
  sortOrder: number;
  /**
   * ESKİ alan — YER düzeyinde sabitlik. ARTIK KARAR İÇİN KULLANILMAZ, yalnız
   * geriye uyumluluk için taşınır. Authoritative kaynak `blockPolicies`.
   */
  allowsFixedAssignment: boolean;
  /** Bu yerin görev istediği bloklar, gün içi sırasında. Boşsa yerin hiçbir hücresi işaretlenemez. */
  blockIds: string[];
  /**
   * AUTHORITATIVE hücre politikası (bkz. migration 20260920090000). Listede
   * bulunmayan blok ⇒ o yer/blok için nöbetçi GEREKMİYOR.
   */
  blockPolicies: DutyMatrixBlockPolicy[];
}

/** Bir yer×blok hücresinin atama politikası. */
export interface DutyMatrixBlockPolicy {
  dutyBlockId: string;
  blockCode: string;
  /** normal ⇒ tercih/otomatik/manuel atamaya açık. fixed_only ⇒ yalnız sabit atama. */
  assignmentMode: "normal" | "fixed_only";
}

/** Blok bazlı seçim hücresi: (nöbet yeri × gün × blok). */
export interface DutyMatrixBlockCell {
  dutyLocationId: string;
  dayOrder: number;
  dutyBlockId: string;
}

/**
 * Eski, gün bazlı tablodan gelen salt-okunur denetim kaydı. Frontend bunu
 * matris çizmek için KULLANMAZ — yalnız "eski veri kaybolmadı" bilgisini
 * taşır (bkz. migration 20260910091000 başlığı).
 */
export interface DutyMatrixLegacyCell {
  dutyLocationId: string;
  dayOrder: number;
}

/**
 * Öğretmenin ders programı nedeniyle aday OLAMADIĞI (gün, blok) çifti:
 * 5-OO dersi → Uzun Nöbet 1, 5-IO dersi → Uzun Nöbet 2. Kullanıcı tercihiyle
 * geçersiz kılınamaz.
 */
/**
 * reasonCode: neden aday değil. target_period_busy → hedef periyot (5-OO/5-IO)
 * dolu. no_adjacent_period_free → hedef boş ama HER İKİ komşu periyot dolu.
 * period_configuration_missing → içe aktarımda hedef/komşu periyot tanımsız,
 * güvenli varsayılan: uygun değil. Bilinmeyen/eksik değer için frontend
 * güvenli fallback uygulamalı (bkz. migration 20260913090000).
 */
export type DutyMatrixLessonConflictReason =
  | "target_period_busy"
  | "no_adjacent_period_free"
  | "period_configuration_missing";

export interface DutyMatrixLessonConflict {
  dayOrder: number;
  dutyBlockId: string;
  periodName: string;
  reasonCode?: DutyMatrixLessonConflictReason;
  busyPeriodNames?: string[];
}

/** Bir öğretmenin sabit nöbet ataması (bkz. Sabit Nöbetler ekranı). Uygunluk TERCİHİ DEĞİLDİR — gerçek atamadır. */
export interface FixedAssignmentInMatrix {
  assignmentId: string;
  dayOrder: number;
  dutyLocationId: string;
  dutyLocationName: string;
  dutyLocationShortCode: string;
  /** false ise nöbet yeri sonradan pasif/soft-delete edilmiş — atama yine de gösterilir (bkz. migration yorumu). */
  dutyLocationIsActive: boolean;
}

/**
 * Eğitim yılı+kampüsteki TÜM sabit yer işgalleri (her öğretmen) — bkz.
 * migration 20260911090000. `FixedAssignmentInMatrix`'ten farkı: yalnız
 * SEÇİLEN öğretmenle sınırlı değildir, başka öğretmenlerin ILKOKUL1/ILKOKUL2
 * gibi allows_fixed_assignment=true yerlerdeki atamalarını da içerir —
 * matrisin bu yerleri her öğretmen için doğru (kilitli + öğretmen adıyla)
 * göstermesini sağlar.
 */
export interface FixedLocationAssignment {
  assignmentId: string;
  dayOrder: number;
  dutyLocationId: string;
  dutyLocationName: string;
  dutyLocationShortCode: string;
  teacherSourceId: string;
  /** Güncel imported snapshot'taki teachers.name; orada bulunamazsa teacher_name_snapshot fallback'i (bkz. RPC yorumu). Asla null değildir. */
  teacherName: string;
  dutyLocationIsActive: boolean;
}

export type TeacherDutyMatrix =
  | { hasImport: false; teacherFound: false }
  | { hasImport: true; teacherFound: false; importedAt: string }
  | {
      hasImport: true;
      teacherFound: true;
      teacher: { id: string; sourceId: string; name: string };
      isIncluded: boolean;
      /**
       * Öğretmen bazlı yarım gün kuralı. AÇIK ⇒ plan atamasında aynı gün
       * yalnız bir normal nöbet bloğu. TERCİH GİRİŞİNİ KISITLAMAZ.
       */
      halfDayRuleEnabled: boolean;
      days: DutyMatrixDay[];
      blocks: DutyBlockDto[];
      dutyLocations: DutyMatrixLocation[];
      selectedBlockCells: DutyMatrixBlockCell[];
      legacySelectedCells: DutyMatrixLegacyCell[];
      lessonConflicts: DutyMatrixLessonConflict[];
      fixedAssignments: FixedAssignmentInMatrix[];
      fixedLocationAssignments: FixedLocationAssignment[];
      updatedAt: string | null;
    };

interface RawMatrixRpcResult {
  hasImport: boolean;
  teacherFound: boolean;
  importedAt?: string;
  teacher?: { id: string; sourceId: string; name: string };
  isIncluded?: boolean;
  halfDayRuleEnabled?: boolean;
  days?: DutyMatrixDay[];
  blocks?: DutyBlockDto[];
  dutyLocations?: DutyMatrixLocation[];
  selectedBlockCells?: DutyMatrixBlockCell[];
  legacySelectedCells?: DutyMatrixLegacyCell[];
  lessonConflicts?: DutyMatrixLessonConflict[];
  fixedAssignments?: FixedAssignmentInMatrix[];
  fixedLocationAssignments?: FixedLocationAssignment[];
  updatedAt?: string | null;
}

export async function fetchTeacherDutyMatrix(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
  teacherId: string,
): Promise<TeacherDutyMatrix> {
  const { data, error } = await supabase.rpc("get_teacher_duty_matrix", {
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
    p_teacher_id: teacherId,
  });
  if (error) {
    throw new TeacherDutyAvailabilityQueryError(error.message);
  }
  const result = data as RawMatrixRpcResult;

  if (!result.hasImport) return { hasImport: false, teacherFound: false };
  if (!result.teacherFound) return { hasImport: true, teacherFound: false, importedAt: result.importedAt ?? "" };

  return {
    hasImport: true,
    teacherFound: true,
    teacher: result.teacher!,
    isIncluded: result.isIncluded ?? true,
    halfDayRuleEnabled: result.halfDayRuleEnabled ?? true,
    days: result.days ?? [],
    blocks: result.blocks ?? [],
    dutyLocations: result.dutyLocations ?? [],
    selectedBlockCells: result.selectedBlockCells ?? [],
    legacySelectedCells: result.legacySelectedCells ?? [],
    lessonConflicts: result.lessonConflicts ?? [],
    fixedAssignments: result.fixedAssignments ?? [],
    fixedLocationAssignments: result.fixedLocationAssignments ?? [],
    updatedAt: result.updatedAt ?? null,
  };
}

/**
 * save_teacher_duty_matrix'in kontrollü red gerekçeleri. RPC ile BİREBİR
 * aynı kümedir (bkz. migration 20260910091000, bölüm 3); yeni bir gerekçe
 * eklenirse burada da eklenmelidir, aksi halde derleme "unknown" düşer.
 */
export type SaveDutyCellsReason =
  | "day_order_out_of_range"
  | "duty_location_not_available"
  | "duty_block_not_available"
  | "block_not_allowed_for_location"
  | "lesson_conflict"
  /**
   * ESKİ (yer düzeyi) gerekçe — 20260920090000 sonrası RPC bunu ARTIK
   * ÜRETMEZ, eski sürümlerle uyum için tipte bırakıldı.
   */
  | "fixed_assignment_only_location"
  /** Hücrenin bloğu assignment_mode='normal' değil (fixed_only veya eşlemesiz). */
  | "fixed_assignment_only_cell";

export type SaveDutyMatrixResult =
  | { status: "ok"; updatedAt: string; halfDayRuleEnabled: boolean }
  | { status: "not_found" }
  | { status: "conflict"; currentUpdatedAt: string | null }
  | { status: "invalid_cells"; reason: SaveDutyCellsReason }
  | { status: "fixed_day_locked"; lockedDayOrders: number[] };

interface RawSaveRpcResult {
  status: "ok" | "not_found" | "conflict" | "invalid_cells" | "fixed_day_locked";
  updatedAt?: string;
  halfDayRuleEnabled?: boolean;
  currentUpdatedAt?: string | null;
  reason?: SaveDutyCellsReason;
  lockedDayOrders?: number[];
}

export async function saveTeacherDutyMatrix(
  supabase: SupabaseClient,
  campusName: string,
  academicYearName: string,
  teacherId: string,
  input: SaveDutyAvailabilityInput,
): Promise<SaveDutyMatrixResult> {
  // v2: half_day_rule_enabled matris tercihleriyle AYNI optimistic-concurrency
  // işleminde yazılır. Eski 6 parametreli imza bir sarmalayıcı olarak durur ama
  // bu katman artık DOĞRUDAN v2'yi çağırır (overload belirsizliği yoktur).
  const { data, error } = await supabase.rpc("save_teacher_duty_matrix_v2", {
    p_campus_name: campusName,
    p_academic_year_name: academicYearName,
    p_teacher_id: teacherId,
    p_is_included: input.isIncluded,
    p_half_day_rule_enabled: input.halfDayRuleEnabled ?? null,
    p_cells: input.cells.map((c) => ({
      duty_location_id: c.dutyLocationId,
      day_order: c.dayOrder,
      duty_block_id: c.dutyBlockId,
    })),
    p_expected_updated_at: input.expectedUpdatedAt,
  });
  if (error) {
    throw new TeacherDutyAvailabilityQueryError(error.message);
  }
  const result = data as RawSaveRpcResult;

  switch (result.status) {
    case "ok":
      return { status: "ok", updatedAt: result.updatedAt!, halfDayRuleEnabled: result.halfDayRuleEnabled ?? true };
    case "not_found":
      return { status: "not_found" };
    case "conflict":
      return { status: "conflict", currentUpdatedAt: result.currentUpdatedAt ?? null };
    case "invalid_cells":
      return { status: "invalid_cells", reason: result.reason ?? "duty_location_not_available" };
    case "fixed_day_locked":
      return { status: "fixed_day_locked", lockedDayOrders: result.lockedDayOrders ?? [] };
  }
}
