import type { DutyBlock, DutyLocationCategory } from "../dutyLocations/types";

export type { DutyBlock, DutyLocationCategory };

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
   * ESKİ alan — YER düzeyinde sabitlik. ARTIK KARAR İÇİN KULLANILMAZ
   * (bkz. `blockPolicies`); yalnız geriye uyumluluk için taşınır.
   */
  allowsFixedAssignment: boolean;
  /**
   * ESKİ alan — GERİYE UYUMLULUK İÇİN korunur, UI KARARINDA KULLANILMAZ.
   * Yalnız "bu yer bu blokta görev istiyor mu" bilgisini taşır; hücrenin
   * normal mi yoksa yalnız sabit atamayla mı karşılandığını AYIRT EDEMEZ.
   * Arayüz hücre kararını YALNIZ `blockPolicies` üzerinden vermelidir.
   */
  blockIds: string[];
  /**
   * AUTHORITATIVE hücre politikası. Arayüz hücre durumunu (seçilebilir /
   * sabit atama bekliyor / nöbetçi gerekmiyor) YALNIZ buradan türetmeli —
   * yer adı veya short_code HARD-CODE ETMEMELİ.
   *
   * Listede olmayan blok ⇒ o yer/blok için nöbetçi GEREKMİYOR (not_required).
   */
  blockPolicies: DutyMatrixBlockPolicy[];
}

/** Bir yer×blok hücresinin atama politikası (bkz. duty_location_blocks.assignment_mode). */
export interface DutyMatrixBlockPolicy {
  dutyBlockId: string;
  blockCode: string;
  /** normal ⇒ tercih/otomatik/manuel atamaya açık. fixed_only ⇒ yalnız sabit atama. */
  assignmentMode: DutyCellAssignmentMode;
}

export type DutyCellAssignmentMode = "normal" | "fixed_only";

/**
 * Matris hücresinin türetilmiş durumu. `not_required` ⇒ blockPolicies'te
 * eşleme YOK. Bu tür, arayüzün tek karar tablosudur.
 */
export type DutyMatrixCellPolicy = DutyCellAssignmentMode | "not_required";

/** Blok bazlı seçim hücresi: (nöbet yeri × gün × blok). */
export interface DutyMatrixBlockCell {
  dutyLocationId: string;
  dayOrder: number;
  dutyBlockId: string;
}

/**
 * Eski, gün bazlı tablodan gelen salt-okunur denetim kaydı. Matris çizmek
 * için KULLANILMAZ; yalnız eski verinin korunduğunu gösterir.
 */
export interface DutyMatrixLegacyCell {
  dutyLocationId: string;
  dayOrder: number;
}

/**
 * Öğretmenin ders programı nedeniyle aday olamadığı (gün, blok) çifti:
 * "5-OO" dersi → Uzun Nöbet 1, "5-IO" dersi → Uzun Nöbet 2. Kullanıcı
 * tercihiyle geçersiz kılınamaz; matriste kilitli gösterilir.
 */
/**
 * target_period_busy → hedef periyot dolu. no_adjacent_period_free → hedef
 * boş ama komşu periyotların İKİSİ de dolu. period_configuration_missing →
 * içe aktarımda periyot tanımsız (güvenli varsayılan: uygun değil).
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

/**
 * Bir öğretmenin sabit nöbet ataması (Sabit Nöbetler ekranından). Uygunluk
 * TERCİHİ DEĞİLDİR — gerçek atamadır (bkz. DutyCellStatus "fixed").
 */
export interface FixedDutyInMatrix {
  assignmentId: string;
  dayOrder: number;
  dutyLocationId: string;
  dutyLocationName: string;
  dutyLocationShortCode: string;
  /** false ise nöbet yeri sonradan pasif/soft-delete edilmiş — atama yine de gösterilir. */
  dutyLocationIsActive: boolean;
}

/**
 * Eğitim yılındaki TÜM sabit yer işgalleri (her öğretmen) — bkz. migration
 * 20260911090000. `FixedDutyInMatrix`'ten farkı: yalnız görüntülenen
 * öğretmenle sınırlı değildir. Matrisin allows_fixed_assignment=true
 * yerlerini (ILKOKUL1/ILKOKUL2) HER öğretmen için doğru — kilitli + hangi
 * öğretmenin sabit olduğu bilgisiyle — göstermesini sağlar.
 */
export interface FixedLocationAssignment {
  assignmentId: string;
  dayOrder: number;
  dutyLocationId: string;
  dutyLocationName: string;
  dutyLocationShortCode: string;
  teacherSourceId: string;
  teacherName: string;
  dutyLocationIsActive: boolean;
}

/**
 * Bir matris hücresinin görünüm durumu — tek kararlı tanım:
 * - available: kullanıcının uygunluk olarak seçtiği hücre
 * - unavailable: normal, seçilmemiş, tıklanabilir hücre
 * - fixed: bu hücrenin TAM OLARAK kendisi, GÖRÜNTÜLENEN öğretmenin sabit
 *   nöbet ataması (Sabah/Öğleden Sonra — fiilen bu bloklarda görevlidir)
 * - fixed_resting: ARTIK ÜRETİLMEZ (yalnız geriye uyumluluk için tipte
 *   duruyor). Eski modelde "kendi sabit yerinde Uzun Nöbet 1 = dinlenme"
 *   anlamına geliyordu; bu, blok koduna bakarak anlam üreten bir varsayımdı.
 *   Yeni modelde karar blockPolicies'ten gelir: İLKOKUL-1/2 × Öğle Arası-1
 *   'normal' bir hücredir, sabit öğretmen için locked_by_fixed_duty,
 *   BAŞKA öğretmenler için seçilebilir tercih hücresidir
 *   (bkz. migration 20260919090000/20260920090000).
 * - fixed_by_other: assignmentMode='fixed_only' bir hücre, o gün+yerde BAŞKA
 *   bir öğretmen tarafından sabit tutuluyor — görüntülenen öğretmenden
 *   bağımsız, GLOBAL bir gerçektir (bkz. fixedLocationAssignments)
 * - fixed_assignment_required: assignmentMode='fixed_only' hücre, bu gün için
 *   henüz kimse sabit atanmamış — yine de normal tercihe KAPALIDIR
 * - locked_by_fixed_duty: öğretmenin o GÜN BAŞKA bir yerde (allows_fixed_
 *   assignment=false) sabit nöbeti olduğu için kilitli hücre
 * - lesson_conflict: hücre SEÇİLİ DEĞİLDİR ve öğretmenin o gün o bloğa denk
 *   gelen dersi var — normal kilitli hücre.
 * - selected_lesson_conflict: hücre SEÇİLİDİR (blok backfill'inden veya daha
 *   önceki bir kayıttan gelen tercih veritabanında korunuyor) VE aynı anda
 *   ders çakışması var. Tercih FİZİKSEL OLARAK SİLİNMEDİ, yalnız şu an
 *   kullanılamıyor — normal aday sayısına katılmaz, tıklanamaz/temizlenemez,
 *   ama çakışma kalkarsa otomatik olarak yeniden "available" olur (bkz.
 *   get_teacher_duty_matrix'in tercih koruma davranışı).
 * - block_not_required: nöbet yeri bu blokta görev istemiyor (hücre yok).
 *   Görüntülenen öğretmenin KENDİ sabit yerinde Uzun Nöbet 2 için de
 *   kullanılır (bkz. migration 20260910091000 başlığı: "LONG_BREAK_2 →
 *   nöbet gerekmiyor").
 */
export type DutyCellStatus =
  | "available"
  | "unavailable"
  | "fixed"
  | "fixed_resting"
  | "fixed_by_other"
  | "fixed_assignment_required"
  | "locked_by_fixed_duty"
  | "lesson_conflict"
  | "selected_lesson_conflict"
  | "block_not_required";

export type TeacherDutyMatrixResponse =
  | { hasImport: false; teacherFound: false }
  | { hasImport: true; teacherFound: false; importedAt: string }
  | {
      hasImport: true;
      teacherFound: true;
      teacher: { id: string; sourceId: string; name: string };
      isIncluded: boolean;
      /**
       * Öğretmen bazlı yarım gün kuralı (varsayılan AÇIK). Yalnız plan
       * ATAMASINI sınırlar; matriste tercih girişini KISITLAMAZ.
       */
      halfDayRuleEnabled: boolean;
      days: DutyMatrixDay[];
      blocks: DutyBlock[];
      dutyLocations: DutyMatrixLocation[];
      selectedBlockCells: DutyMatrixBlockCell[];
      legacySelectedCells: DutyMatrixLegacyCell[];
      lessonConflicts: DutyMatrixLessonConflict[];
      fixedAssignments: FixedDutyInMatrix[];
      fixedLocationAssignments: FixedLocationAssignment[];
      updatedAt: string | null;
    };

export interface SaveDutyMatrixPayload {
  isIncluded: boolean;
  /**
   * Yarım gün kuralı. Gönderilmezse sunucu mevcut değeri KORUR. Kural yalnız
   * plan ATAMASINI sınırlar; öğretmen tüm normal hücreleri tercih edebilir.
   */
  halfDayRuleEnabled?: boolean;
  cells: DutyMatrixBlockCell[];
  expectedUpdatedAt: string | null;
}

export interface SaveDutyMatrixSuccess {
  savedAt: string;
  updatedAt: string;
  halfDayRuleEnabled: boolean;
}

export type SaveDutyMatrixErrorCode =
  | "validation_error"
  | "invalid_cells"
  | "not_found"
  | "conflict"
  | "fixed_day_locked"
  | "query_failed";

export interface SaveDutyMatrixApiError {
  error: SaveDutyMatrixErrorCode;
  message: string;
  currentUpdatedAt?: string | null;
  reason?: string;
  lockedDayOrders?: number[];
}
