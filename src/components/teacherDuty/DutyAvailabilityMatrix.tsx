import { useEffect, useMemo, useState } from "react";
import { AlertCircle, RotateCcw, Info, MapPin, CheckCircle2, Loader2, LockKeyhole, BookX, Minus, Coffee, UserX } from "lucide-react";
import { navigate, ROUTES } from "../../lib/router";
import { fetchDutyMatrix, saveDutyMatrix, SaveDutyMatrixError } from "../../lib/teacherDutyAvailability/api";
import { BLOCK_SHORT_LABELS, CATEGORY_LABELS } from "../../lib/dutyLocations/types";
import type { DutyBlock } from "../../lib/dutyLocations/types";
import type {
  DutyCellStatus,
  DutyMatrixBlockCell,
  DutyMatrixCellPolicy,
  DutyMatrixDay,
  DutyMatrixLessonConflict,
  DutyMatrixLocation,
  FixedDutyInMatrix,
  FixedLocationAssignment,
  TeacherDutyMatrixResponse,
} from "../../lib/teacherDutyAvailability/types";
import "./DutyAvailabilityMatrix.css";

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * Hücre anahtarı: nöbet yeri × gün × blok. Kimliklerin ikisi de UUID
 * olduğundan ve gün sayı olduğundan ":" ayıracı belirsizlik yaratmaz.
 */
function cellKey(dutyLocationId: string, dayOrder: number, dutyBlockId: string): string {
  return `${dutyLocationId}:${dayOrder}:${dutyBlockId}`;
}

function parseCellKey(key: string): DutyMatrixBlockCell {
  const [dutyLocationId, dayOrderStr, dutyBlockId] = key.split(":");
  return { dutyLocationId, dayOrder: Number(dayOrderStr), dutyBlockId };
}

/** Ders çakışması anahtarı: gün × blok (nöbet yerinden bağımsızdır). */
/**
 * Bir yer×blok hücresinin AUTHORITATIVE atama politikası (bkz. migration
 * 20260920090000, get_teacher_duty_matrix → dutyLocations[].blockPolicies).
 *
 *   normal       → tercih olarak SEÇİLEBİLİR
 *   fixed_only   → yalnız Sabit Nöbetler ekranından karşılanır
 *   not_required → o yer/blok için nöbetçi GEREKMİYOR (eşleme YOK)
 *
 * Yer adı veya short_code HARD-CODE EDİLMEZ; karar yalnız bu veriden gelir.
 */
function cellPolicy(location: DutyMatrixLocation, dutyBlockId: string): DutyMatrixCellPolicy {
  const policy = location.blockPolicies.find((p) => p.dutyBlockId === dutyBlockId);
  return policy ? policy.assignmentMode : "not_required";
}

function conflictKey(dayOrder: number, dutyBlockId: string): string {
  return `${dayOrder}:${dutyBlockId}`;
}

/**
 * reasonCode'a göre dinamik açıklama (bkz. migration 20260913090000).
 * busyPeriodNames/periodName GERÇEK ders programı periyot adlarındandır —
 * "4. periyot" gibi sabit metin YAZILMAZ. Bilinmeyen/eksik reasonCode için
 * güvenli genel metne düşer (fallback).
 */
function describeLessonConflict(conflict: DutyMatrixLessonConflict | undefined): { tooltip: string; ariaSuffix: string } {
  const periodName = conflict?.periodName;
  const busyNames = conflict?.busyPeriodNames?.length ? conflict.busyPeriodNames.join(", ") : undefined;
  switch (conflict?.reasonCode) {
    case "target_period_busy":
      return {
        tooltip: periodName
          ? `Öğretmenin bu gün ${periodName} periyodunda dersi var.`
          : "Öğretmenin bu gün bu bloğa denk gelen dersi var.",
        ariaSuffix: periodName ? `${periodName} periyodunda dersi var` : "ders çakışması nedeniyle kullanılamaz",
      };
    case "no_adjacent_period_free":
      return {
        tooltip:
          periodName && busyNames
            ? `Öğretmenin ${periodName} periyodu boş, ancak komşu periyotların ikisi de (${busyNames}) dolu olduğundan bu blok uygun değil.`
            : "Öğretmenin komşu ders periyotlarının ikisi de dolu olduğundan bu blok uygun değil.",
        ariaSuffix: busyNames ? `komşu periyotlar (${busyNames}) dolu olduğundan kullanılamaz` : "komşu periyotlar dolu olduğundan kullanılamaz",
      };
    case "period_configuration_missing":
      return {
        tooltip: "Bu blok için gerekli ders periyodu tanımı ders programında bulunamadı, güvenlik nedeniyle uygun değil olarak işaretlendi.",
        ariaSuffix: "periyot tanımı eksik olduğundan uygun değil",
      };
    default:
      return {
        tooltip: "Öğretmenin bu gün bu bloğa denk gelen dersi var.",
        ariaSuffix: "ders çakışması nedeniyle kullanılamaz",
      };
  }
}

/** "Korunan tercih" (selected_lesson_conflict) için reasonCode'a göre metin — selected_lesson_conflict "şu an kullanılamıyor" ifadesini korur. */
function describeSelectedLessonConflict(conflict: DutyMatrixLessonConflict | undefined): { tooltip: string; ariaSuffix: string } {
  const periodName = conflict?.periodName;
  const busyNames = conflict?.busyPeriodNames?.length ? conflict.busyPeriodNames.join(", ") : undefined;
  switch (conflict?.reasonCode) {
    case "target_period_busy":
      return {
        tooltip: periodName
          ? `Bu tercih kayıtlıdır ancak öğretmenin ${periodName} periyodunda dersi olduğundan şu anda kullanılamaz. Çakışma kalkarsa tercih yeniden kullanılabilir olur.`
          : "Bu tercih kayıtlıdır ancak öğretmenin bu bloğa denk gelen dersi nedeniyle şu anda kullanılamaz. Ders çakışması kalkarsa tercih yeniden kullanılabilir olur.",
        ariaSuffix: periodName ? `${periodName} periyodunda dersi olduğundan şu an kullanılamıyor` : "ders çakışması nedeniyle şu an kullanılamıyor",
      };
    case "no_adjacent_period_free":
      return {
        tooltip:
          periodName && busyNames
            ? `Bu tercih kayıtlıdır ancak öğretmenin ${periodName} periyodu boş olmasına rağmen komşu periyotların ikisi de (${busyNames}) dolu olduğundan şu anda kullanılamaz. Çakışma kalkarsa tercih yeniden kullanılabilir olur.`
            : "Bu tercih kayıtlıdır ancak öğretmenin komşu ders periyotlarının ikisi de dolu olduğundan şu anda kullanılamaz. Çakışma kalkarsa tercih yeniden kullanılabilir olur.",
        ariaSuffix: busyNames ? `komşu periyotlar (${busyNames}) dolu olduğundan şu an kullanılamıyor` : "komşu periyotlar dolu olduğundan şu an kullanılamıyor",
      };
    case "period_configuration_missing":
      return {
        tooltip:
          "Bu tercih kayıtlıdır ancak bu blok için gerekli ders periyodu tanımı ders programında bulunamadığından şu anda kullanılamaz.",
        ariaSuffix: "periyot tanımı eksik olduğundan şu an kullanılamıyor",
      };
    default:
      return {
        tooltip:
          "Bu tercih kayıtlıdır ancak öğretmenin bu bloğa denk gelen dersi nedeniyle şu anda kullanılamaz. Ders çakışması kalkarsa tercih yeniden kullanılabilir olur.",
        ariaSuffix: "ders çakışması nedeniyle şu an kullanılamıyor",
      };
  }
}

/** Sabit YER işgali anahtarı: gün × nöbet yeri (öğretmenden bağımsız — o gün+yerin GLOBAL durumu). */
function fixedLocationKey(dayOrder: number, dutyLocationId: string): string {
  return `${dayOrder}:${dutyLocationId}`;
}

interface MatrixSnapshot {
  teacherName: string;
  isIncluded: boolean;
  /** Öğretmen bazlı yarım gün kuralı (varsayılan AÇIK). */
  halfDayRuleEnabled: boolean;
  days: DutyMatrixDay[];
  blocks: DutyBlock[];
  dutyLocations: DutyMatrixLocation[];
  cellKeys: Set<string>;
  conflictKeys: Set<string>;
  /** conflictKey(dayOrder, dutyBlockId) → tam gerekçe (reasonCode/busyPeriodNames dahil), tooltip/aria-label icin. */
  conflictDetails: Map<string, DutyMatrixLessonConflict>;
  fixedAssignments: FixedDutyInMatrix[];
  fixedLocationAssignments: FixedLocationAssignment[];
  updatedAt: string | null;
}

type Outcome =
  | { status: "loading" }
  | { status: "error" }
  | { status: "schema-mismatch" }
  | { status: "not-found" }
  | { status: "ready"; snapshot: MatrixSnapshot };

/**
 * Runtime contract guard. TypeScript only checks compile-time shapes; an older
 * remote RPC can still return the pre-block-policy payload. Rendering that
 * payload would otherwise crash at `location.blockPolicies.find(...)` and
 * blank the entire teacher timetable page.
 *
 * We deliberately do not infer the new block policy from legacy `blockIds` or
 * `allowsFixedAssignment`: that would revive the old, incorrect location-level
 * semantics. Until the database migration is present, the matrix fails closed
 * while the lesson timetable remains usable.
 */
function hasCurrentMatrixContract(data: Extract<TeacherDutyMatrixResponse, { hasImport: true; teacherFound: true }>): boolean {
  return (
    typeof data.halfDayRuleEnabled === "boolean" &&
    Array.isArray(data.days) &&
    Array.isArray(data.blocks) &&
    Array.isArray(data.dutyLocations) &&
    data.dutyLocations.every((location) => Array.isArray(location.blockPolicies)) &&
    Array.isArray(data.selectedBlockCells) &&
    Array.isArray(data.lessonConflicts) &&
    Array.isArray(data.fixedAssignments) &&
    Array.isArray(data.fixedLocationAssignments)
  );
}

interface Props {
  teacherId: string;
  onDirtyChange: (dirty: boolean) => void;
}

export default function DutyAvailabilityMatrix({ teacherId, onDirtyChange }: Props) {
  const [outcome, setOutcome] = useState<Outcome>({ status: "loading" });
  const [retryNonce, setRetryNonce] = useState(0);
  const [draftIncluded, setDraftIncluded] = useState(true);
  /**
   * Yarım gün kuralı taslağı. Varsayılan AÇIK. Tercih GİRİŞİNİ KISITLAMAZ —
   * yalnız plan ATAMASINDA aynı gün kaç tercihin kullanılabileceğini belirler.
   */
  const [draftHalfDay, setDraftHalfDay] = useState(true);
  const [draftCells, setDraftCells] = useState<Set<string>>(new Set());
  const [activeDay, setActiveDay] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [lockedDayOrders, setLockedDayOrders] = useState<number[] | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let ignore = false;

    fetchDutyMatrix(teacherId, controller.signal)
      .then((data) => {
        if (ignore) return;
        if (!data.hasImport || !data.teacherFound) {
          setOutcome({ status: "not-found" });
          return;
        }
        if (!hasCurrentMatrixContract(data)) {
          setOutcome({ status: "schema-mismatch" });
          return;
        }
        const cellKeys = new Set(data.selectedBlockCells.map((c) => cellKey(c.dutyLocationId, c.dayOrder, c.dutyBlockId)));
        const snapshot: MatrixSnapshot = {
          teacherName: data.teacher.name,
          isIncluded: data.isIncluded,
          halfDayRuleEnabled: data.halfDayRuleEnabled,
          days: data.days,
          blocks: data.blocks,
          dutyLocations: data.dutyLocations,
          cellKeys,
          conflictKeys: new Set(data.lessonConflicts.map((c) => conflictKey(c.dayOrder, c.dutyBlockId))),
          conflictDetails: new Map(data.lessonConflicts.map((c) => [conflictKey(c.dayOrder, c.dutyBlockId), c])),
          fixedAssignments: data.fixedAssignments,
          fixedLocationAssignments: data.fixedLocationAssignments,
          updatedAt: data.updatedAt,
        };
        // Sabit atamalar draft state'in PARÇASI DEĞİLDİR — yüklenmeleri
        // dirty state üretmez (draft yalnız isIncluded + normal hücrelerden türer).
        setDraftIncluded(data.isIncluded);
        setDraftHalfDay(data.halfDayRuleEnabled);
        setDraftCells(new Set(cellKeys));
        setActiveDay((current) => (current !== null && data.days.some((d) => d.order === current) ? current : (data.days[0]?.order ?? null)));
        setOutcome({ status: "ready", snapshot });
      })
      .catch((err) => {
        if (ignore || isAbortError(err)) return;
        setOutcome({ status: "error" });
      });

    return () => {
      ignore = true;
      controller.abort();
    };
  }, [teacherId, retryNonce]);

  const snapshot = outcome.status === "ready" ? outcome.snapshot : null;

  const fixedByDay = useMemo(() => {
    const map = new Map<number, FixedDutyInMatrix>();
    if (snapshot) for (const fa of snapshot.fixedAssignments) map.set(fa.dayOrder, fa);
    return map;
  }, [snapshot]);

  const dirty = useMemo(() => {
    if (!snapshot) return false;
    if (draftIncluded !== snapshot.isIncluded) return true;
    if (draftHalfDay !== snapshot.halfDayRuleEnabled) return true;
    if (draftCells.size !== snapshot.cellKeys.size) return true;
    for (const key of draftCells) if (!snapshot.cellKeys.has(key)) return true;
    return false;
  }, [snapshot, draftIncluded, draftHalfDay, draftCells]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!dirty) return;
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  function handleRetry() {
    setOutcome({ status: "loading" });
    setSaveError(null);
    setConflict(false);
    setLockedDayOrders(null);
    setSaveSuccess(false);
    setRetryNonce((n) => n + 1);
  }

  /**
   * Bir hücrenin gerçekten işaretlenebilir olup olmadığı — tek karar noktası.
   * Hem tıklama hem toplu seçim aynı fonksiyonu kullanır, böylece "Tümünü
   * Seç" ile tek tek tıklamanın kuralları ayrışamaz.
   */
  function isSelectable(location: DutyMatrixLocation, dayOrder: number, dutyBlockId: string): boolean {
    if (!draftIncluded) return false;
    if (!snapshot) return false;
    // AUTHORITATIVE: hücre politikası YER düzeyinde değil BLOK düzeyindedir
    // (bkz. migration 20260920090000, blockPolicies). Yalnız 'normal' hücreler
    // tercih olarak seçilebilir; 'fixed_only' ve eşlemesi olmayan hücreler
    // seçilemez. Yer adı/short_code HARD-CODE EDİLMEZ.
    if (cellPolicy(location, dutyBlockId) !== "normal") return false;
    if (fixedByDay.has(dayOrder)) return false;
    if (snapshot.conflictKeys.has(conflictKey(dayOrder, dutyBlockId))) return false;
    return true;
  }

  /**
   * Ders çakışması nedeniyle korunmuş bir SEÇİLİ tercih mi? (gün×blok,
   * yerden bağımsız — bkz. conflictKey). Toplu temizleme fonksiyonlarının
   * (clearDay/clearBlock/clearAll) TEK karar noktası: bu true ise hücre
   * draftCells'ten ASLA çıkarılmaz — tıklanamadığı gibi toplu işlemle de
   * kaldırılamaz (kesin kural, bkz. görev tanımı).
   */
  function isConflictProtected(dayOrder: number, dutyBlockId: string): boolean {
    return snapshot ? snapshot.conflictKeys.has(conflictKey(dayOrder, dutyBlockId)) : false;
  }

  function toggleCell(location: DutyMatrixLocation, dayOrder: number, dutyBlockId: string) {
    if (!isSelectable(location, dayOrder, dutyBlockId)) return;
    setSaveSuccess(false);
    setDraftCells((prev) => {
      const next = new Set(prev);
      const key = cellKey(location.id, dayOrder, dutyBlockId);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** Seçili günün tüm işaretlenebilir hücrelerini seçer. */
  function selectDay(dayOrder: number) {
    if (!snapshot) return;
    setSaveSuccess(false);
    setDraftCells((prev) => {
      const next = new Set(prev);
      for (const loc of snapshot.dutyLocations)
        for (const block of snapshot.blocks)
          if (isSelectable(loc, dayOrder, block.id)) next.add(cellKey(loc.id, dayOrder, block.id));
      return next;
    });
  }

  /**
   * Seçili günün seçimlerini temizler (diğer günlere dokunmaz). Ders
   * çakışması nedeniyle korunmuş seçili hücreler ATLANIR — bunlar
   * draftCells'te kalmaya devam eder (kesin kural: toplu temizleme onları
   * çıkaramaz).
   */
  function clearDay(dayOrder: number) {
    if (!draftIncluded || fixedByDay.has(dayOrder)) return;
    setSaveSuccess(false);
    setDraftCells((prev) => {
      const next = new Set(prev);
      for (const key of prev) {
        const cell = parseCellKey(key);
        if (cell.dayOrder !== dayOrder) continue;
        if (isConflictProtected(cell.dayOrder, cell.dutyBlockId)) continue;
        next.delete(key);
      }
      return next;
    });
  }

  /** Seçili gün içinde tek bir bloğun tüm nöbet yerlerini seçer. */
  function selectBlock(dayOrder: number, dutyBlockId: string) {
    if (!snapshot) return;
    setSaveSuccess(false);
    setDraftCells((prev) => {
      const next = new Set(prev);
      for (const loc of snapshot.dutyLocations)
        if (isSelectable(loc, dayOrder, dutyBlockId)) next.add(cellKey(loc.id, dayOrder, dutyBlockId));
      return next;
    });
  }

  /** Ders çakışması nedeniyle korunmuş seçili hücreyi ATLAR (bkz. clearDay). */
  function clearBlock(dayOrder: number, dutyBlockId: string) {
    if (!draftIncluded || fixedByDay.has(dayOrder)) return;
    setSaveSuccess(false);
    setDraftCells((prev) => {
      const next = new Set(prev);
      for (const key of prev) {
        const cell = parseCellKey(key);
        if (cell.dayOrder !== dayOrder || cell.dutyBlockId !== dutyBlockId) continue;
        if (isConflictProtected(cell.dayOrder, cell.dutyBlockId)) continue;
        next.delete(key);
      }
      return next;
    });
  }

  /** Bütün günlerin işaretlenebilir hücrelerini seçer. */
  function selectAll() {
    if (!snapshot) return;
    setSaveSuccess(false);
    setDraftCells((prev) => {
      const next = new Set(prev);
      for (const day of snapshot.days)
        for (const loc of snapshot.dutyLocations)
          for (const block of snapshot.blocks)
            if (isSelectable(loc, day.order, block.id)) next.add(cellKey(loc.id, day.order, block.id));
      return next;
    });
  }

  /**
   * Tüm günlerin seçimlerini temizler. Sabit günlerde saklanan tercihlere
   * dokunulmaz — draftCells zaten onları hiç içermez (sunucu da göndermez),
   * ama savunma derinliği için açıkça korunur. Ders çakışması nedeniyle
   * korunmuş seçili hücreler de AYNI ŞEKİLDE atlanır (kesin kural).
   */
  function clearAll() {
    if (!draftIncluded) return;
    setSaveSuccess(false);
    setDraftCells((prev) => {
      const next = new Set<string>();
      for (const key of prev) {
        const cell = parseCellKey(key);
        if (fixedByDay.has(cell.dayOrder) || isConflictProtected(cell.dayOrder, cell.dutyBlockId)) next.add(key);
      }
      return next;
    });
  }

  function handleUndo() {
    if (!snapshot) return;
    setDraftIncluded(snapshot.isIncluded);
    setDraftHalfDay(snapshot.halfDayRuleEnabled);
    setDraftCells(new Set(snapshot.cellKeys));
    setSaveError(null);
    setConflict(false);
    setLockedDayOrders(null);
    setSaveSuccess(false);
  }

  async function handleSave() {
    if (!snapshot || saving) return;
    setSaving(true);
    setSaveError(null);
    setConflict(false);
    setLockedDayOrders(null);
    setSaveSuccess(false);

    // Savunma derinliği: UI kurallara aykırı hücre üretmez, ama gönderim
    // öncesi yine de aynı `isSelectable` kuralından geçirilir. Asıl zorlama
    // save_teacher_duty_matrix RPC'sindedir.
    const locationById = new Map(snapshot.dutyLocations.map((l) => [l.id, l]));
    const cells: DutyMatrixBlockCell[] = [...draftCells]
      .map(parseCellKey)
      .filter((c) => {
        const loc = locationById.get(c.dutyLocationId);
        return loc !== undefined && isSelectable(loc, c.dayOrder, c.dutyBlockId);
      });

    try {
      const result = await saveDutyMatrix(teacherId, {
        isIncluded: draftIncluded,
        halfDayRuleEnabled: draftHalfDay,
        cells,
        expectedUpdatedAt: snapshot.updatedAt,
      });
      const savedKeys = new Set(cells.map((c) => cellKey(c.dutyLocationId, c.dayOrder, c.dutyBlockId)));
      setDraftCells(savedKeys);
      setOutcome({
        status: "ready",
        snapshot: { ...snapshot, isIncluded: draftIncluded, halfDayRuleEnabled: result.halfDayRuleEnabled, cellKeys: savedKeys, updatedAt: result.updatedAt },
      });
      setSaveSuccess(true);
    } catch (err) {
      if (err instanceof SaveDutyMatrixError) {
        if (err.apiError.error === "conflict") {
          setConflict(true);
        } else if (err.apiError.error === "fixed_day_locked") {
          setLockedDayOrders(err.apiError.lockedDayOrders ?? []);
        } else {
          setSaveError(err.apiError.message);
        }
      } else {
        setSaveError("Nöbet uygunlukları kaydedilemedi. Yerel API bağlantısını kontrol edip tekrar deneyin.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="dam-card" aria-label="Nöbet Uygunluk Matrisi">
      <div className="dam-header">
        <div>
          <h2 className="dam-title">Nöbet Uygunluk Matrisi</h2>
          <p className="dam-desc">Öğretmenin nöbet tutabileceği gün, nöbet yeri ve nöbet bloklarını işaretleyin.</p>
        </div>
        <div className="dam-header-right">
          {dirty && <span className="dam-dirty-badge">Kaydedilmemiş değişiklikler var</span>}
          <label className="dam-toggle">
            <input
              type="checkbox"
              checked={draftIncluded}
              onChange={(e) => {
                setSaveSuccess(false);
                setDraftIncluded(e.target.checked);
              }}
              disabled={outcome.status !== "ready"}
              aria-label="Nöbet planına dahil"
            />
            <span>Nöbet planına dahil</span>
          </label>
          {/*
            Yarım gün kuralı — TERCİH GİRİŞİNİ KISITLAMAZ. Öğretmen aynı gün
            dört normal hücreyi de tercih olarak işaretleyebilir; bu ayar
            yalnız PLAN ATAMASINDA aynı gün kaç tercihin kullanılabileceğini
            belirler (bkz. migration 20260919090000).
          */}
          <label className="dam-toggle">
            <input
              type="checkbox"
              checked={draftHalfDay}
              onChange={(e) => {
                setSaveSuccess(false);
                setDraftHalfDay(e.target.checked);
              }}
              disabled={outcome.status !== "ready"}
              aria-label="Yarım gün kuralı"
              aria-describedby="dam-half-day-desc"
            />
            <span>Yarım gün kuralı</span>
          </label>
          <span id="dam-half-day-desc" className="dam-half-day-desc">
            Açıkken bu öğretmene aynı gün yalnız bir normal nöbet bloğu atanabilir.
          </span>
          <span
            className="dam-info-icon"
            tabIndex={0}
            role="note"
            aria-label="Gün başına dört nöbet bloğu vardır. Öğle arası bloklarında uygunluk, hedef ders saatinin (Uzun Nöbet 1 için 5-OO, Uzun Nöbet 2 için 5-IO) boş olmasına VE komşu ders saatlerinden en az birinin uygun olmasına göre değerlendirilir. Sabit nöbet günü tüm bloklarıyla kilitlidir. Her nöbet yerinin hangi bloklarda görev istediği ve hangilerinin yalnız sabit atamayla karşılandığı yere göre değişir."
          >
            <Info size={16} strokeWidth={2} aria-hidden="true" />
            <span className="dam-tooltip" role="tooltip">
              Gün başına dört nöbet bloğu vardır. Sabah ve öğleden sonra blokları kısa teneffüsleri topluca temsil eder.
              <br />
              Öğle arası bloklarında uygunluk yalnız hedef ders saatine bakılarak belirlenmez: Uzun Nöbet 1 için <strong>5-OO</strong>,
              Uzun Nöbet 2 için <strong>5-IO</strong> boş olmalı, <em>ayrıca</em> komşu ders saatlerinden en az biri uygun olmalıdır.
              Hücrenin kendi ipucu, o hücre için geçerli tam gerekçeyi gösterir.
              <br />
              Sabit nöbeti olan gün, dört bloğuyla birlikte kilitlidir.
              <br />
              Her nöbet yerinin hangi bloklarda görev istediği yere göre değişir; bazı bloklarındaki görev yalnız Sabit Nöbetler ekranından atanır.
            </span>
          </span>
        </div>
      </div>

      {outcome.status === "loading" && (
        <div className="dam-skeleton-wrap" aria-busy="true">
          <span className="visually-hidden">Nöbet uygunlukları yükleniyor…</span>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="dam-skeleton-row" />
          ))}
        </div>
      )}

      {outcome.status === "error" && (
        <div className="dam-error-card" role="alert">
          <AlertCircle size={20} strokeWidth={2} aria-hidden="true" />
          <div>
            <p className="dam-error-title">Nöbet uygunlukları alınamadı.</p>
            <p className="dam-error-desc">Yerel API bağlantısını kontrol edip tekrar deneyin.</p>
            <button type="button" className="btn btn-secondary" onClick={handleRetry}>
              <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
              Tekrar Dene
            </button>
          </div>
        </div>
      )}

      {outcome.status === "schema-mismatch" && (
        <div className="dam-error-card" role="alert">
          <AlertCircle size={20} strokeWidth={2} aria-hidden="true" />
          <div>
            <p className="dam-error-title">Nöbet uygunluk matrisi henüz kullanılamıyor.</p>
            <p className="dam-error-desc">
              Veritabanındaki nöbet blok yapısı bu arayüz sürümüyle uyumlu değil. Bekleyen veritabanı güncellemeleri uygulandıktan sonra tekrar deneyin.
            </p>
          </div>
        </div>
      )}

      {outcome.status === "not-found" && (
        <div className="dam-error-card" role="alert">
          <AlertCircle size={20} strokeWidth={2} aria-hidden="true" />
          <div>
            <p className="dam-error-title">Nöbet uygunlukları alınamadı.</p>
            <p className="dam-error-desc">Öğretmen mevcut içe aktarmada bulunamadı.</p>
            <button type="button" className="btn btn-secondary" onClick={handleRetry}>
              <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
              Tekrar Dene
            </button>
          </div>
        </div>
      )}

      {outcome.status === "ready" && snapshot && snapshot.dutyLocations.length === 0 && snapshot.fixedAssignments.length === 0 && (
        <div className="dam-empty-state">
          <MapPin size={32} strokeWidth={1.5} aria-hidden="true" />
          <p className="dam-empty-title">Henüz aktif nöbet yeri tanımlanmadı.</p>
          <button type="button" className="btn btn-primary" onClick={() => navigate(ROUTES.dutyLocations)}>
            Nöbet Yerlerine Git
          </button>
        </div>
      )}

      {outcome.status === "ready" && snapshot && (snapshot.dutyLocations.length > 0 || snapshot.fixedAssignments.length > 0) && (
        <MatrixBody
          snapshot={snapshot}
          fixedByDay={fixedByDay}
          activeDay={activeDay}
          onActiveDayChange={setActiveDay}
          draftIncluded={draftIncluded}
          draftCells={draftCells}
          dirty={dirty}
          saving={saving}
          saveError={saveError}
          conflict={conflict}
          lockedDayOrders={lockedDayOrders}
          saveSuccess={saveSuccess}
          isSelectable={isSelectable}
          onToggleCell={toggleCell}
          onSelectAll={selectAll}
          onClearAll={clearAll}
          onSelectDay={selectDay}
          onClearDay={clearDay}
          onSelectBlock={selectBlock}
          onClearBlock={clearBlock}
          onUndo={handleUndo}
          onSave={handleSave}
          onReload={handleRetry}
        />
      )}
    </section>
  );
}

function MatrixBody({
  snapshot,
  fixedByDay,
  activeDay,
  onActiveDayChange,
  draftIncluded,
  draftCells,
  dirty,
  saving,
  saveError,
  conflict,
  lockedDayOrders,
  saveSuccess,
  isSelectable,
  onToggleCell,
  onSelectAll,
  onClearAll,
  onSelectDay,
  onClearDay,
  onSelectBlock,
  onClearBlock,
  onUndo,
  onSave,
  onReload,
}: {
  snapshot: MatrixSnapshot;
  fixedByDay: Map<number, FixedDutyInMatrix>;
  activeDay: number | null;
  onActiveDayChange: (dayOrder: number) => void;
  draftIncluded: boolean;
  draftCells: Set<string>;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  conflict: boolean;
  lockedDayOrders: number[] | null;
  saveSuccess: boolean;
  isSelectable: (location: DutyMatrixLocation, dayOrder: number, dutyBlockId: string) => boolean;
  onToggleCell: (location: DutyMatrixLocation, dayOrder: number, dutyBlockId: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  onSelectDay: (dayOrder: number) => void;
  onClearDay: (dayOrder: number) => void;
  onSelectBlock: (dayOrder: number, dutyBlockId: string) => void;
  onClearBlock: (dayOrder: number, dutyBlockId: string) => void;
  onUndo: () => void;
  onSave: () => void;
  onReload: () => void;
}) {
  const { days, blocks, dutyLocations, fixedAssignments, fixedLocationAssignments, conflictKeys, conflictDetails } = snapshot;
  const day = days.find((d) => d.order === activeDay) ?? days[0];
  const fixedToday = day ? fixedByDay.get(day.order) : undefined;

  // Bu eğitim yılı+kampüsteki TÜM sabit yer işgalleri, gün×yer anahtarıyla —
  // görüntülenen öğretmenden BAĞIMSIZ, o gün+yerin global durumu (bkz.
  // migration 20260911090000).
  const fixedLocationMap = useMemo(() => {
    const map = new Map<string, FixedLocationAssignment>();
    for (const fa of fixedLocationAssignments) map.set(fixedLocationKey(fa.dayOrder, fa.dutyLocationId), fa);
    return map;
  }, [fixedLocationAssignments]);

  // Pasif/soft-delete edilmiş bir yerdeki sabit nöbet, normal dutyLocations
  // listesinde yer almaz (o liste yalnız aktif yerleri içerir) — bu yüzden
  // matriste görünür kalması için salt-okunur ek satırlar üretilir.
  const activeLocationIds = useMemo(() => new Set(dutyLocations.map((l) => l.id)), [dutyLocations]);
  const inactiveFixedLocations = useMemo(() => {
    const seen = new Map<string, FixedDutyInMatrix>();
    for (const fa of fixedAssignments) {
      if (!activeLocationIds.has(fa.dutyLocationId) && !seen.has(fa.dutyLocationId)) seen.set(fa.dutyLocationId, fa);
    }
    return [...seen.values()];
  }, [fixedAssignments, activeLocationIds]);

  /**
   * SAYAÇ MODELİ — tek merkezi türetim (bkz. görev tanımı):
   *  - usable: seçili VE şu an gerçekten planlanabilir (conflictKeys'te YOK)
   *  - conflictPreserved: seçili AMA aynı gün+blokta ders çakışması var —
   *    veritabanında korunmuş eski tercih, normal adaya sayılmaz
   *  - total = usable + conflictPreserved
   * Bir hücrenin conflictPreserved sayılması için HEM draftCells'te (seçili)
   * OLMASI HEM DE conflictKeys ile eşleşmesi gerekir — yalnız çakışma olması
   * yetmez (spec: "gün+blokta ders çakışması bulunması ... otomatik olarak
   * korunmuş tercih saymamalıdır").
   */
  function classifyDraftKey(key: string): "usable" | "conflictPreserved" {
    const cell = parseCellKey(key);
    return conflictKeys.has(conflictKey(cell.dayOrder, cell.dutyBlockId)) ? "conflictPreserved" : "usable";
  }

  const overallCounts = useMemo(() => {
    let usable = 0;
    let conflictPreserved = 0;
    for (const key of draftCells) {
      if (classifyDraftKey(key) === "conflictPreserved") conflictPreserved++;
      else usable++;
    }
    return { usable, conflictPreserved, total: usable + conflictPreserved };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftCells, conflictKeys]);

  const dayCounts = useMemo(() => {
    const counts = new Map<number, { usable: number; conflictPreserved: number }>();
    for (const key of draftCells) {
      const dayOrder = parseCellKey(key).dayOrder;
      const entry = counts.get(dayOrder) ?? { usable: 0, conflictPreserved: 0 };
      if (classifyDraftKey(key) === "conflictPreserved") entry.conflictPreserved++;
      else entry.usable++;
      counts.set(dayOrder, entry);
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftCells, conflictKeys]);

  const blockCountsToday = useMemo(() => {
    const counts = new Map<string, { usable: number; conflictPreserved: number }>();
    if (!day) return counts;
    for (const key of draftCells) {
      const cell = parseCellKey(key);
      if (cell.dayOrder !== day.order) continue;
      const entry = counts.get(cell.dutyBlockId) ?? { usable: 0, conflictPreserved: 0 };
      if (classifyDraftKey(key) === "conflictPreserved") entry.conflictPreserved++;
      else entry.usable++;
      counts.set(cell.dutyBlockId, entry);
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftCells, day, conflictKeys]);

  /**
   * Hücre durumu — karar TAMAMEN blockPolicies tabanlıdır. Blok KODUNA
   * (LONG_BREAK_1/2) bakarak anlam üretilmez; yer düzeyindeki eski
   * allowsFixedAssignment ve blockIds alanları UI kararında KULLANILMAZ.
   *
   * Öncelik:
   *   1. policy = not_required          → block_not_required
   *   2. policy = fixed_only
   *        a. görüntülenen öğretmenin AYNI yer+gündeki kendi sabit görevi
   *                                     → fixed
   *        b. başka öğretmene atanmış   → fixed_by_other (adıyla)
   *        c. atama yok                 → fixed_assignment_required
   *   3. policy = normal
   *        a. öğretmenin o gün HERHANGİ bir sabit nöbeti varsa
   *                                     → locked_by_fixed_duty
   *        b. ders/zaman çakışması      → selected_lesson_conflict | lesson_conflict
   *        c. aksi halde                → available | unavailable
   *
   * Böylece İLKOKUL-1'de sabit olan öğretmen için Öğle Arası-1 hücresi
   * "Dinlenme" DEĞİL, doğru biçimde locked_by_fixed_duty olur; aynı hücre
   * BAŞKA bir öğretmen için normal tercih hücresidir.
   */
  function cellStatus(location: DutyMatrixLocation, dayOrder: number, block: DutyBlock): DutyCellStatus {
    const policy = cellPolicy(location, block.id);
    if (policy === "not_required") return "block_not_required";

    if (policy === "fixed_only") {
      const ownFixed = fixedByDay.get(dayOrder);
      if (ownFixed && ownFixed.dutyLocationId === location.id) return "fixed";
      return fixedLocationMap.has(fixedLocationKey(dayOrder, location.id)) ? "fixed_by_other" : "fixed_assignment_required";
    }

    // policy === "normal"
    if (fixedByDay.has(dayOrder)) return "locked_by_fixed_duty";
    const isSelected = draftCells.has(cellKey(location.id, dayOrder, block.id));
    if (conflictKeys.has(conflictKey(dayOrder, block.id))) return isSelected ? "selected_lesson_conflict" : "lesson_conflict";
    return isSelected ? "available" : "unavailable";
  }

  if (!day) {
    return (
      <div className="dam-empty-state">
        <MapPin size={32} strokeWidth={1.5} aria-hidden="true" />
        <p className="dam-empty-title">Ders programında gün bilgisi bulunamadı.</p>
      </div>
    );
  }

  return (
    <div className={draftIncluded ? "dam-body" : "dam-body dam-body--disabled"}>
      <div className="dam-controls">
        <button type="button" className="btn btn-secondary" onClick={onSelectAll} disabled={!draftIncluded}>
          Tüm Günleri Seç
        </button>
        <button type="button" className="btn btn-secondary" onClick={onClearAll} disabled={!draftIncluded}>
          Tümünü Temizle
        </button>
        <div className="dam-controls-spacer" />
        <button type="button" className="btn btn-secondary" onClick={onUndo} disabled={!dirty || saving}>
          Değişiklikleri Geri Al
        </button>
        <button type="button" className="btn btn-primary" onClick={onSave} disabled={!dirty || saving}>
          {saving ? (
            <>
              <Loader2 size={16} className="spin" aria-hidden="true" />
              Kaydediliyor…
            </>
          ) : (
            "Kaydet"
          )}
        </button>
      </div>

      <p className="dam-summary">
        {overallCounts.conflictPreserved > 0 ? (
          <>
            {overallCounts.usable} kullanılabilir tercih · {overallCounts.conflictPreserved} ders çakışması nedeniyle kilitli ·{" "}
            {overallCounts.total} toplam seçili tercih
          </>
        ) : (
          <>Toplam {overallCounts.usable} uygun seçenek</>
        )}{" "}
        · {dayCounts.size} günde seçim var · {fixedAssignments.length} sabit nöbet
      </p>

      {saveError && (
        <div className="alert alert-error" role="alert">
          <span>{saveError}</span>
        </div>
      )}
      {conflict && (
        <div className="alert alert-error" role="alert">
          <span>Bu kayıt başka bir işlem tarafından güncellendi. Güncel veriyi yeniden yükleyin.</span>
          <button type="button" className="btn btn-secondary" onClick={onReload}>
            <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
            Yenile
          </button>
        </div>
      )}
      {lockedDayOrders !== null && (
        <div className="alert alert-error" role="alert">
          <span>Sabit nöbet bulunan günlerde hiçbir blokta uygunluk değiştirilemez.</span>
          <button type="button" className="btn btn-secondary" onClick={onReload}>
            <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
            Güncel Veriyi Yükle
          </button>
        </div>
      )}
      {saveSuccess && !dirty && (
        <div className="alert alert-success" role="status">
          <CheckCircle2 size={16} strokeWidth={2} aria-hidden="true" />
          <span>Nöbet uygunlukları kaydedildi.</span>
        </div>
      )}

      {/* Gün sekmeleri — matris 20 sütuna büyümesin diye gün ekseni sekmeye alındı. */}
      <div className="dam-day-tabs" role="tablist" aria-label="Günler">
        {days.map((d) => {
          const isActive = d.order === day.order;
          const dayCount = dayCounts.get(d.order) ?? { usable: 0, conflictPreserved: 0 };
          const hasFixed = fixedByDay.has(d.order);
          const hasConflictPreserved = dayCount.conflictPreserved > 0;
          const dayAriaLabel = hasFixed
            ? undefined
            : hasConflictPreserved
              ? `${d.name}: ${dayCount.usable} kullanılabilir tercih, ${dayCount.conflictPreserved} ders çakışması nedeniyle kilitli tercih`
              : undefined;
          return (
            <button
              key={d.order}
              type="button"
              role="tab"
              id={`dam-tab-${d.order}`}
              aria-selected={isActive}
              aria-controls={`dam-panel-${d.order}`}
              aria-label={dayAriaLabel}
              className={isActive ? "dam-day-tab dam-day-tab--active" : "dam-day-tab"}
              onClick={() => onActiveDayChange(d.order)}
            >
              {hasFixed && <LockKeyhole size={12} strokeWidth={2.5} aria-hidden="true" />}
              <span>{d.name}</span>
              {hasFixed ? (
                <span className="dam-tab-count dam-tab-count--fixed">sabit</span>
              ) : hasConflictPreserved ? (
                <>
                  <span className="dam-tab-count">{dayCount.usable} uygun</span>
                  <span className="dam-tab-count dam-tab-count--conflict">{dayCount.conflictPreserved} kilitli</span>
                </>
              ) : (
                <span className="dam-tab-count">{dayCount.usable}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="dam-day-panel" role="tabpanel" id={`dam-panel-${day.order}`} aria-labelledby={`dam-tab-${day.order}`}>
        {fixedToday ? (
          <div className="dam-fixed-day-note" role="note">
            <LockKeyhole size={16} strokeWidth={2} aria-hidden="true" />
            <span>
              {day.name} günü <strong>{fixedToday.dutyLocationName}</strong> alanında sabit nöbeti var. Sabit öğretmen o gün başka
              hiçbir nöbet görevine aday olamaz; dört blok da kilitlidir.
            </span>
          </div>
        ) : (
          <div className="dam-day-actions-bar">
            <span className="dam-day-actions-label">{day.name}</span>
            <button type="button" onClick={() => onSelectDay(day.order)} disabled={!draftIncluded}>
              Günü Seç
            </button>
            <button type="button" onClick={() => onClearDay(day.order)} disabled={!draftIncluded}>
              Günü Temizle
            </button>
          </div>
        )}

        <div className="dam-table-scroll">
          <table className="dam-table">
            <thead>
              <tr>
                <th scope="col" className="dam-col-location">
                  Nöbet Yeri
                </th>
                {blocks.map((block) => (
                  <th scope="col" key={block.id} className="dam-col-block">
                    <div className="dam-block-head">
                      <span className="dam-block-name" title={block.name}>
                        {BLOCK_SHORT_LABELS[block.code]}
                      </span>
                      {block.conflictPeriodName && (
                        <span className="dam-block-period" title={`${block.conflictPeriodName} dersi olan öğretmen bu blokta nöbet tutamaz.`}>
                          {block.conflictPeriodName}
                        </span>
                      )}
                      {fixedToday ? (
                        <span className="dam-block-count dam-block-count--fixed">kilitli</span>
                      ) : (
                        <>
                          <span className="dam-block-actions">
                            <button type="button" onClick={() => onSelectBlock(day.order, block.id)} disabled={!draftIncluded}>
                              Seç
                            </button>
                            {" / "}
                            <button type="button" onClick={() => onClearBlock(day.order, block.id)} disabled={!draftIncluded}>
                              Temizle
                            </button>
                          </span>
                          {(() => {
                            const blockCount = blockCountsToday.get(block.id) ?? { usable: 0, conflictPreserved: 0 };
                            return blockCount.conflictPreserved > 0 ? (
                              <span className="dam-block-count">
                                {blockCount.usable} uygun · <span className="dam-block-count--conflict">{blockCount.conflictPreserved} kilitli</span>
                              </span>
                            ) : (
                              <span className="dam-block-count">{blockCount.usable} uygun</span>
                            );
                          })()}
                        </>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dutyLocations.map((loc) => (
                <tr key={loc.id}>
                  <th scope="row" className="dam-col-location">
                    <div className="dam-location-name">{loc.name}</div>
                    <div className="dam-location-meta">
                      <span className="dam-badge">{loc.shortCode}</span>
                      <span className="dam-category">{CATEGORY_LABELS[loc.category]}</span>
                      {(() => {
                        // Rozet YER düzeyindeki allowsFixedAssignment'tan DEĞİL,
                        // blok politikalarından türetilir: bir yerin YALNIZ BAZI
                        // blokları sabit olabilir (İLKOKUL-1/2 gibi).
                        const fixedOnlyBlocks = loc.blockPolicies.filter((p) => p.assignmentMode === "fixed_only");
                        if (fixedOnlyBlocks.length === 0) return null;
                        const names = fixedOnlyBlocks
                          .map((p) => blocks.find((b) => b.id === p.dutyBlockId)?.name)
                          .filter((n): n is string => Boolean(n));
                        const suffix = names.length > 0 ? ` Sabit bloklar: ${names.join(", ")}.` : "";
                        return (
                          <span
                            className="dam-fixed-eligible"
                            title={`Bu yerin sabit blokları Sabit Nöbetler ekranından yönetilir; normal blokları uygunluk matrisinden seçilebilir.${suffix}`}
                          >
                            Bazı bloklar sabit
                          </span>
                        );
                      })()}
                    </div>
                  </th>
                  {blocks.map((block) => {
                    const status = cellStatus(loc, day.order, block);
                    const otherAssignment = status === "fixed_by_other" ? fixedLocationMap.get(fixedLocationKey(day.order, loc.id)) : undefined;
                    const conflictDetail =
                      status === "lesson_conflict" || status === "selected_lesson_conflict"
                        ? conflictDetails.get(conflictKey(day.order, block.id))
                        : undefined;
                    return (
                      <DutyCell
                        key={block.id}
                        dayName={day.name}
                        blockName={block.name}
                        location={loc}
                        status={status}
                        otherTeacherName={otherAssignment?.teacherName}
                        conflictDetail={conflictDetail}
                        disabled={!isSelectable(loc, day.order, block.id)}
                        onToggle={() => onToggleCell(loc, day.order, block.id)}
                      />
                    );
                  })}
                </tr>
              ))}
              {inactiveFixedLocations.map((fa) => (
                <tr key={fa.dutyLocationId} className="dam-row--inactive-fixed">
                  <th scope="row" className="dam-col-location">
                    <div className="dam-location-name">{fa.dutyLocationName}</div>
                    <div className="dam-location-meta">
                      <span className="dam-badge">{fa.dutyLocationShortCode}</span>
                      <span className="dam-inactive-note">Pasif sabit nöbet yeri</span>
                    </div>
                  </th>
                  {/*
                    PASİF yer için blockPolicies YOKTUR (aktif yer listesinde
                    bulunmaz). Bu yüzden hangi blokların sabit atamayla
                    karşılandığı BİLİNMEZ: blok başına hücre üretmek, sabit
                    atamanın dört bloğu da kapsadığı yönünde YANLIŞ bilgi verir.
                    Blok sütunlarının tamamı, kapsam iddiası taşımayan TEK bir
                    salt-okunur hücreyle temsil edilir.
                  */}
                  {(() => {
                    const isFixedHere = fixedToday?.dutyLocationId === fa.dutyLocationId;
                    const title = "Nöbet yeri pasif olduğu için güncel blok politikası gösterilemiyor.";
                    return (
                      <td colSpan={blocks.length} className="dam-cell dam-cell--inactive-fixed" title={title}>
                        {isFixedHere ? (
                          <div
                            className="dam-inactive-fixed-chip"
                            role="img"
                            aria-label={`${day.name}, ${fa.dutyLocationName}: geçmiş sabit atama, nöbet yeri pasif. ${title}`}
                          >
                            <LockKeyhole size={13} strokeWidth={2} aria-hidden="true" />
                            <span>Geçmiş sabit atama · Nöbet yeri pasif</span>
                          </div>
                        ) : (
                          <div
                            className="dam-inactive-fixed-empty"
                            role="img"
                            aria-label={`${day.name}, ${fa.dutyLocationName}: bu gün sabit atama yok, nöbet yeri pasif. ${title}`}
                          >
                            —
                          </div>
                        )}
                      </td>
                    );
                  })()}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <ul className="dam-legend" aria-label="Hücre açıklamaları">
          <li>
            <span className="dam-legend-swatch dam-legend-swatch--selected" aria-hidden="true" />
            Uygun
          </li>
          <li>
            <LockKeyhole size={13} strokeWidth={2} aria-hidden="true" />
            Sabit nöbet / sabit gün kilidi
          </li>
          <li>
            <BookX size={13} strokeWidth={2} aria-hidden="true" />
            Ders çakışması (5-OO / 5-IO)
          </li>
          <li>
            <BookX size={13} strokeWidth={2} aria-hidden="true" className="dam-legend-conflict-preserved" />
            Korunan tercih (seçili ama şu an ders çakışmasıyla kilitli)
          </li>
          <li>
            <Minus size={13} strokeWidth={2} aria-hidden="true" />
            Bu blok için nöbetçi gerekmiyor
          </li>
          <li>
            <LockKeyhole size={13} strokeWidth={2} aria-hidden="true" />
            Başka öğretmen sabit (isim hücrede görünür)
          </li>
          <li>
            <UserX size={13} strokeWidth={2} aria-hidden="true" />
            Sabit atama bekleniyor
          </li>
        </ul>
      </div>
    </div>
  );
}

function DutyCell({
  dayName,
  blockName,
  location,
  status,
  otherTeacherName,
  conflictDetail,
  disabled,
  onToggle,
}: {
  dayName: string;
  blockName: string;
  location: Pick<DutyMatrixLocation, "id" | "name">;
  status: DutyCellStatus;
  /** Yalnız status==="fixed_by_other" iken anlamlıdır: o gün+yerde sabit olan BAŞKA öğretmenin adı. */
  otherTeacherName?: string;
  /** Yalnız status==="lesson_conflict"/"selected_lesson_conflict" iken anlamlıdır: reasonCode/busyPeriodNames dahil tam gerekçe. */
  conflictDetail?: DutyMatrixLessonConflict;
  disabled: boolean;
  onToggle: () => void;
}) {
  if (status === "fixed_by_other") {
    const name = otherTeacherName ?? "";
    return (
      <td className="dam-cell dam-cell--fixed-other" title={`Bu yer ve blok ${name} için sabit ayrılmıştır.`}>
        <div className="dam-fixed-other-chip" role="img" aria-label={`${dayName}, ${blockName}, ${location.name}: ${name} sabit nöbetçi`}>
          <LockKeyhole size={12} strokeWidth={2} aria-hidden="true" />
          <span className="dam-fixed-other-name">{name}</span>
        </div>
      </td>
    );
  }

  if (status === "fixed_assignment_required") {
    return (
      <td className="dam-cell dam-cell--assignment-required" title="Bu yere henüz sabit öğretmen atanmadı.">
        <div className="dam-assignment-required-chip" role="img" aria-label={`${dayName}, ${blockName}, ${location.name}: sabit atama bekleniyor`}>
          <UserX size={13} strokeWidth={2} aria-hidden="true" />
          <span className="dam-assignment-required-label">Sabit atama bekleniyor</span>
        </div>
      </td>
    );
  }

  if (status === "fixed") {
    return (
      <td className="dam-cell dam-cell--fixed" title="Bu nöbet Sabit Nöbetler ekranından atanmıştır.">
        <div className="dam-fixed-chip" role="img" aria-label={`${dayName}, ${blockName}, ${location.name}: sabit nöbet`}>
          <LockKeyhole size={14} strokeWidth={2.5} aria-hidden="true" />
          <span className="dam-fixed-badge">Sabit</span>
        </div>
      </td>
    );
  }

  // fixed_resting ARTIK ÜRETİLMEZ (bkz. DutyCellStatus yorumu). Görsel dal,
  // eski veriyle render edilen bir ekranın bozulmaması için KORUNUYOR.
  if (status === "fixed_resting") {
    return (
      <td
        className="dam-cell dam-cell--resting"
        title="Sabit öğretmen bu blokta dinlenir ve aynı gün başka göreve atanamaz."
      >
        <div
          className="dam-resting-chip"
          role="img"
          aria-label="Sabit öğretmen bu blokta dinlenir ve aynı gün başka göreve atanamaz."
        >
          <Coffee size={13} strokeWidth={2} aria-hidden="true" />
          <span className="dam-resting-badge">Dinlenme</span>
        </div>
      </td>
    );
  }

  if (status === "locked_by_fixed_duty") {
    return (
      <td className="dam-cell dam-cell--locked" title="Öğretmenin bu gün başka bir alanda sabit nöbeti var.">
        <div
          className="dam-locked-chip"
          role="img"
          aria-label={`${dayName}, ${blockName}, ${location.name}: sabit nöbet nedeniyle kullanılamaz`}
        >
          <LockKeyhole size={12} strokeWidth={2} aria-hidden="true" />
        </div>
      </td>
    );
  }

  if (status === "lesson_conflict") {
    const { tooltip, ariaSuffix } = describeLessonConflict(conflictDetail);
    return (
      <td className="dam-cell dam-cell--conflict" title={tooltip}>
        <div className="dam-conflict-chip" role="img" aria-label={`${dayName}, ${blockName}, ${location.name}: ${ariaSuffix}`}>
          <BookX size={13} strokeWidth={2} aria-hidden="true" />
        </div>
      </td>
    );
  }

  if (status === "selected_lesson_conflict") {
    const { tooltip, ariaSuffix } = describeSelectedLessonConflict(conflictDetail);
    return (
      <td className="dam-cell dam-cell--selected-conflict" title={tooltip}>
        <div
          className="dam-selected-conflict-chip"
          role="img"
          aria-label={`${dayName}, ${blockName}, ${location.name}: korunan tercih, ${ariaSuffix}`}
        >
          <BookX size={13} strokeWidth={2} aria-hidden="true" />
          <span className="dam-selected-conflict-label">Korunan tercih</span>
        </div>
      </td>
    );
  }

  if (status === "block_not_required") {
    return (
      <td className="dam-cell dam-cell--not-required" title="Bu nöbet yerinde bu blok için nöbetçi gerekmiyor.">
        <span className="visually-hidden">{`${dayName}, ${blockName}, ${location.name}: bu blokta nöbetçi gerekmiyor`}</span>
        <Minus size={13} strokeWidth={2} aria-hidden="true" className="dam-cell-icon" />
      </td>
    );
  }

  const checked = status === "available";
  return (
    <td className={checked ? "dam-cell dam-cell--selected" : "dam-cell"}>
      <label className="dam-cell-label">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
          aria-label={`${dayName}, ${blockName}, ${location.name}: ${checked ? "uygun" : "uygun değil"}`}
        />
        {checked && <CheckCircle2 size={16} strokeWidth={2} aria-hidden="true" className="dam-cell-icon" />}
      </label>
    </td>
  );
}
