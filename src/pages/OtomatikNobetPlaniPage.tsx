import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  CircleSlash,
  Loader2,
  LockKeyhole,
  RotateCcw,
  Shuffle,
  TriangleAlert,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import {
  deleteDutyPlanDraft,
  fetchCurrentDutyPlanDraft,
  fetchDutyPlanPreparation,
  fetchDutyPlanTaskCandidates,
  generateDutyPlanDraft,
  GenerateDutyPlanDraftApiError,
  previewDutyPlanManualPackage,
  publishDutyPlanDraft,
  PublishDutyPlanDraftApiError,
  regenerateDutyPlanDraft,
  setDutyPlanManualPackage,
  SetDutyPlanManualPackageApiError,
  updateDutyPlanAssignment,
  UpdateDutyPlanAssignmentApiError,
} from "../lib/dutyPlanDrafts/api";
import {
  DEFAULT_GENERATION_OPTIONS,
  MANUAL_PACKAGE_COVERAGE_MODE_LABELS,
  PACKAGE_COVERAGE_MODE_LABELS,
  TASK_CANDIDATE_REASON_LABELS,
  validateGenerationOptions,
  WEEKDAY_NAMES,
  type DutyPlanDraftAssignmentDto,
  type DutyPlanDraftDto,
  type DutyPlanDraftPackageDto,
  type DutyPlanGenerationSnapshot,
  type GenerationOptions,
  type ManualPackageAffectedTaskDto,
  type ManualPackageCoverageMode,
  type TaskCandidatesDto,
} from "../lib/dutyPlanDrafts/types";
import { BLOCK_SHORT_LABELS, type DutyBlock, type DutyBlockCode } from "../lib/dutyLocations/types";
import "./OtomatikNobetPlaniPage.css";

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function currentMondayIso(): string {
  const now = new Date();
  const day = now.getDay() || 7;
  now.setDate(now.getDate() - day + 1);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

type ImportedSnapshot = Extract<DutyPlanGenerationSnapshot, { hasImport: true }>;
type FoundDraft = Extract<DutyPlanDraftDto, { found: true }>;

type Phase =
  | { status: "loading" }
  | { status: "error" }
  | { status: "no-import" }
  | { status: "stageA"; snapshot: ImportedSnapshot }
  | { status: "stageB"; draft: FoundDraft; snapshot: ImportedSnapshot | null };

/**
 * "Otomatik Nöbet Planı" — iki aşamalı ekran.
 *
 * Aşama A (hazırlık): mevcut yapılandırmayla üretimin ne kadar karşılanabilir
 * olduğunu gösterir, dağıtım tercihlerini alır, taslağı üretir.
 * Aşama B (inceleme): üretilmiş/mevcut taslağı gün×yer×blok tablosunda,
 * kapsama şeridiyle ve öğretmen yük dağılımıyla gösterir. Manuel atama ve
 * manuel atama, yeniden üretme, iptal ve yayımlama işlemlerini yönetir.
 */
export default function OtomatikNobetPlaniPage({
  embedded = false,
  onPublished,
}: {
  embedded?: boolean;
  onPublished?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ status: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let ignore = false;

    async function load() {
      try {
        const [draftResult, prepResult] = await Promise.allSettled([
          fetchCurrentDutyPlanDraft(controller.signal),
          fetchDutyPlanPreparation(controller.signal),
        ]);
        if (ignore) return;

        const draftAborted = draftResult.status === "rejected" && isAbortError(draftResult.reason);
        const prepAborted = prepResult.status === "rejected" && isAbortError(prepResult.reason);
        if (draftAborted || prepAborted) return;

        if (draftResult.status === "rejected") {
          setPhase({ status: "error" });
          return;
        }

        const draft = draftResult.value;
        const prep = prepResult.status === "fulfilled" ? prepResult.value : null;

        if (draft.found && draft.status === "draft") {
          setPhase({ status: "stageB", draft, snapshot: prep && prep.hasImport ? prep : null });
          return;
        }

        if (!prep) {
          setPhase({ status: "error" });
          return;
        }
        if (!prep.hasImport) {
          setPhase({ status: "no-import" });
          return;
        }
        setPhase({ status: "stageA", snapshot: prep });
      } catch (err) {
        if (!ignore && !isAbortError(err)) setPhase({ status: "error" });
      }
    }

    void load();
    return () => {
      ignore = true;
      controller.abort();
    };
  }, [reloadNonce]);

  function reload() {
    setPhase({ status: "loading" });
    setReloadNonce((n) => n + 1);
  }

  return (
    <section className={embedded ? "anp-page anp-page--embedded" : "anp-page"}>
      {!embedded && <header className="anp-header">
        <div>
          <h1>Otomatik Nöbet Planı</h1>
          <p>Öğretmen uygunlukları, ders programları ve sabit nöbetlere göre haftalık nöbet taslağı oluşturun.</p>
        </div>
      </header>}

      {phase.status === "loading" && (
        <div className="anp-card" aria-busy="true">
          <span className="visually-hidden">Yükleniyor…</span>
          <div className="anp-skeleton" />
          <div className="anp-skeleton" />
          <div className="anp-skeleton" />
        </div>
      )}

      {phase.status === "error" && (
        <div className="anp-card anp-error" role="alert">
          <AlertCircle size={20} strokeWidth={2} aria-hidden="true" />
          <div>
            <p className="anp-error-title">Veriler alınamadı.</p>
            <p className="anp-error-desc">Yerel API bağlantısını kontrol edip tekrar deneyin.</p>
            <button type="button" className="btn btn-secondary" onClick={reload}>
              <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
              Tekrar Dene
            </button>
          </div>
        </div>
      )}

      {phase.status === "no-import" && (
        <div className="anp-card">İçe aktarılmış bir ders programı yok. Otomatik nöbet planı üretmeden önce Veri ve XML ekranından bir program yükleyin.</div>
      )}

      {phase.status === "stageA" && (
        <PreparationStage
          snapshot={phase.snapshot}
          onGenerated={(draft) => setPhase({ status: "stageB", draft, snapshot: phase.snapshot })}
        />
      )}

      {phase.status === "stageB" && (
        <ReviewStage
          draft={phase.draft}
          snapshot={phase.snapshot}
          onCancelled={reload}
          onRegenerated={(draft) => setPhase({ status: "stageB", draft, snapshot: phase.snapshot })}
          embedded={embedded}
          onPublished={onPublished}
        />
      )}
    </section>
  );
}

// ============================================================================
// Kapsama şeridi — Pazartesi–Cuma karşılanan/gereken görev sayısı, tek bakışta.
// ============================================================================
function CoverageStrip({ items }: { items: { order: number; name: string; covered: number; required: number }[] }) {
  return (
    <div className="anp-strip" role="list" aria-label="Haftalık kapsama şeridi">
      {items.map((d) => {
        const ratio = d.required === 0 ? 1 : d.covered / d.required;
        const short = d.covered < d.required;
        return (
          <div key={d.order} role="listitem" className={short ? "anp-strip-day anp-strip-day--short" : "anp-strip-day"}>
            <span className="anp-strip-day-name">{d.name}</span>
            <div className="anp-strip-bar" aria-hidden="true">
              <div className="anp-strip-bar-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
            </div>
            <span className="anp-strip-day-count">
              {d.covered}/{d.required}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// Aşama A — Plan Hazırlığı
// ============================================================================
function PreparationStage({ snapshot, onGenerated }: { snapshot: ImportedSnapshot; onGenerated: (draft: DutyPlanDraftDto & { found: true }) => void }) {
  const [options, setOptions] = useState<GenerationOptions>(DEFAULT_GENERATION_OPTIONS);
  const [weekStartDate, setWeekStartDate] = useState(currentMondayIso);
  const [activeDayOrders, setActiveDayOrders] = useState<number[]>(() => snapshot.days.map((day) => day.order));
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const dirty = useMemo(
    () => JSON.stringify(options) !== JSON.stringify(DEFAULT_GENERATION_OPTIONS) || weekStartDate !== currentMondayIso() || activeDayOrders.length !== snapshot.days.length,
    [options, weekStartDate, activeDayOrders.length, snapshot.days.length],
  );

  useEffect(() => {
    if (!dirty) return;
    function handler(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const activeDays = useMemo(() => new Set(activeDayOrders), [activeDayOrders]);
  const feasibility = snapshot.feasibility;
  const selectedFeasibilityDays = (feasibility.days ?? []).filter((day) => activeDays.has(day.order));
  const totalUncovered = activeDayOrders.length === snapshot.days.length
    ? (feasibility.summary?.totalUncoveredTasks ?? 0)
    : selectedFeasibilityDays.reduce((sum, day) => sum + day.totals.uncoveredTasks, 0);
  const feasible = totalUncovered === 0;
  const selectedConfigErrors = snapshot.configurationErrors.filter((row) => activeDays.has(row.dayOrder));
  const hasConfigError = selectedConfigErrors.length > 0;

  const fixedDutyDayTotal = new Set(snapshot.tasks.filter((t) => activeDays.has(t.dayOrder) && t.kind === "fixed" && t.fixedCoveredByTeacherSourceId).map((t) => `${t.fixedCoveredByTeacherSourceId}|${t.dayOrder}`)).size;
  const fixedTaskCellCount = snapshot.tasks.filter((t) => activeDays.has(t.dayOrder) && t.kind === "fixed").length;
  const firstActiveDay = activeDayOrders[0];
  const day1TaskCount = snapshot.tasks.filter((t) => t.dayOrder === firstActiveDay).length;

  const packageCapacity = useMemo(() => {
    const normalByDayLocation = new Map<string, Set<DutyBlockCode>>();
    const fixedGroups = new Set<string>();
    for (const task of snapshot.tasks) {
      if (!activeDays.has(task.dayOrder)) continue;
      const key = `${task.dayOrder}|${task.dutyLocationId}`;
      if (task.kind === "fixed") {
        fixedGroups.add(key);
        continue;
      }
      const codes = normalByDayLocation.get(key) ?? new Set<DutyBlockCode>();
      codes.add(task.blockCode);
      normalByDayLocation.set(key, codes);
    }
    let normalPackageCount = 0;
    let orphanBreakConfigurationCount = 0;
    const normalByDay = new Map<number, number>();
    for (const [key, codes] of normalByDayLocation) {
      const [dayText] = key.split("|");
      const day = Number(dayText);
      const morning = codes.has("MORNING_BREAKS");
      const afternoon = codes.has("AFTERNOON_BREAKS");
      if (morning !== afternoon) orphanBreakConfigurationCount += 1;
      const units = (morning && afternoon ? 1 : 0) + Number(codes.has("LONG_BREAK_1")) + Number(codes.has("LONG_BREAK_2"));
      normalPackageCount += units;
      normalByDay.set(day, (normalByDay.get(day) ?? 0) + units);
    }
    const totalRequiredPackages = normalPackageCount + fixedGroups.size;
    const totalCapacity = snapshot.teachers.length * options.maxWeeklyDuties;
    const weeklyShortfall = Math.max(0, totalRequiredPackages - totalCapacity);
    return { normalPackageCount, totalRequiredPackages, totalCapacity, weeklyShortfall, orphanBreakConfigurationCount, normalByDay };
  }, [snapshot, options.maxWeeklyDuties, activeDays]);

  const hasPackageConfigError = packageCapacity.orphanBreakConfigurationCount > 0;

  const stripItems = selectedFeasibilityDays.map((d) => ({
    order: d.order,
    name: d.name,
    covered: d.totals.coveredTasks,
    required: d.totals.requiredTasks,
  }));

  const validation = validateGenerationOptions(options);

  async function handleGenerate() {
    if (generating || !validation.valid || hasConfigError) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const result = await generateDutyPlanDraft({ options, expectedPlanId: null, weekStartDate, activeDayOrders });
      const fresh = await fetchCurrentDutyPlanDraft();
      if (fresh.found) {
        onGenerated(fresh);
      } else {
        // RPC 'ok' dedi ama okuma tekrar bulamadı — beklenmedik durum, genel hata göster.
        setGenerateError(`Taslak oluşturuldu (${result.planId}) ancak okunamadı. Sayfayı yenileyin.`);
      }
    } catch (err) {
      if (err instanceof GenerateDutyPlanDraftApiError) {
        setGenerateError(err.body.message);
      } else {
        setGenerateError("Taslak üretilemedi. Yerel API bağlantısını kontrol edip tekrar deneyin.");
      }
    } finally {
      setGenerating(false);
    }
  }

  return (
    <>
      <section className="anp-card anp-week-setup" aria-labelledby="anp-week-title">
        <div>
          <h2 id="anp-week-title" className="anp-card-title">Planlanacak Hafta</h2>
          <p className="anp-week-help">Tatil olan günleri kapatın. Plan yalnız seçili günler için üretilir; önceki yayımlanmış haftaların nöbet puanları adil dağıtımda otomatik dikkate alınır.</p>
        </div>
        <label className="anp-week-date">
          Haftanın pazartesi günü
          <input type="date" value={weekStartDate} onChange={(event) => setWeekStartDate(event.target.value)} />
        </label>
        <div className="anp-weekday-picks" aria-label="Planlanacak günler">
          {snapshot.days.map((day) => {
            const selected = activeDays.has(day.order);
            return (
              <button
                key={day.order}
                type="button"
                className={selected ? "anp-weekday-pick anp-weekday-pick--active" : "anp-weekday-pick"}
                aria-pressed={selected}
                onClick={() => setActiveDayOrders((current) => selected ? current.filter((order) => order !== day.order) : [...current, day.order].sort((a, b) => a - b))}
              >
                <span>{day.name}</span>
                <small>{selected ? "Planlanacak" : "Tatil / kapsam dışı"}</small>
              </button>
            );
          })}
        </div>
        {activeDayOrders.length === 0 && <p className="anp-field-error" role="alert">En az bir gün seçin.</p>}
      </section>

      <div className="anp-card">
        <h2 className="anp-card-title">Haftalık Kapsama</h2>
        <CoverageStrip items={stripItems} />
      </div>

      <div className="anp-facts">
        <Fact label="Aktif gün" value={activeDayOrders.length} />
        <Fact label="Blok / gün" value={snapshot.blocks.length} />
        <Fact label="Günlük görev" value={day1TaskCount} />
        <Fact label="Haftalık görev" value={snapshot.tasks.filter((task) => activeDays.has(task.dayOrder)).length} />
        <Fact label="Haftalık görev paketi" value={packageCapacity.totalRequiredPackages} />
        <Fact label="Sabit nöbet günü" value={fixedDutyDayTotal} />
        <Fact label="Sabit görev hücresi" value={fixedTaskCellCount} />
        <Fact label="Plana dahil öğretmen" value={snapshot.teachers.length} />
        <Fact label="Karşılanabilir görev" value={selectedFeasibilityDays.reduce((sum, day) => sum + day.totals.coveredTasks, 0)} />
        <Fact label="Açık görev" value={totalUncovered} emphasize={totalUncovered > 0} />
      </div>

      {hasConfigError && (
        <div className="alert alert-error" role="alert">
          <AlertCircle size={16} strokeWidth={2} aria-hidden="true" />
          <span>
            Seçili günlerde bazı bloklar için periyot konfigürasyonu eksik ({selectedConfigErrors.length} blok). Taslak üretimi bu
            sorun giderilene kadar devre dışı.
          </span>
        </div>
      )}

      {hasPackageConfigError && (
        <div className="alert alert-error" role="alert">
          <AlertCircle size={16} strokeWidth={2} aria-hidden="true" />
          <span>
            {packageCapacity.orphanBreakConfigurationCount} yer×gün kaydında Sabah ve Öğleden Sonra birlikte açık değil. Teneffüs paketi iki bloğu birlikte gerektirir; Nöbet Yerleri ekranından düzeltin.
          </span>
        </div>
      )}

      {!hasPackageConfigError && packageCapacity.weeklyShortfall > 0 && (
        <div className="alert alert-warning" role="alert">
          <TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />
          <span>
            Haftalık {packageCapacity.totalRequiredPackages} görev paketine karşı öğretmenlerin seçili üst sınırla toplam kapasitesi {packageCapacity.totalCapacity}. En az {packageCapacity.weeklyShortfall} paket açık kalacaktır. Bir yer×blok gereksinimini kapatın, öğretmen ekleyin veya açık görevle taslak üretin; hiçbir öğretmene dördüncü nöbet verilmeyecek.
          </span>
        </div>
      )}

      {!hasConfigError && !feasible && (
        <div className="alert alert-warning" role="alert">
          <TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />
          <span>
            Mevcut uygunluklara göre teorik kapsamada {totalUncovered} görev karşılanamıyor. Açık görevlerle taslak oluşturursanız bu görevler{" "}
            <strong>atanmamış</strong> kalır ve yayımlamayı engeller. Gerçek taslak sonucu haftalık yük sınırlarına göre değişebilir.
          </span>
        </div>
      )}

      {!hasConfigError && feasible && (
        <div className="alert alert-success" role="status">
          <CheckCircle2 size={16} strokeWidth={2} aria-hidden="true" />
          <span>Mevcut uygunluklara göre teorik kapsama tamdır. Gerçek taslak sonucu haftalık yük sınırlarına göre değişebilir — kesin kapsama taslak üretildikten sonra görülür.</span>
        </div>
      )}

      <div className="anp-two-col">
        <section className="anp-card">
          <h2 className="anp-card-title">Zorunlu Kurallar</h2>
          <ul className="anp-rules">
            <li>Bir öğretmen aynı gün en fazla bir normal nöbet alır.</li>
            <li>Sabit nöbetler değiştirilemez.</li>
            <li>Sabit öğretmen aynı gün normal göreve atanamaz.</li>
            <li>Ders/zaman çakışmalarında atama yapılamaz.</li>
            <li>Yalnız öğretmenin işaretlediği uygunluklar kullanılır.</li>
            <li>5-OO ve 5-IO komşu periyot kuralları uygulanır.</li>
          </ul>
        </section>

        <section className="anp-card">
          <h2 className="anp-card-title">Dağıtım Tercihleri</h2>
          <div className="anp-options-form">
            <label className="anp-checkbox-row">
              <input
                type="checkbox"
                checked={options.balanceWorkload}
                onChange={(e) => setOptions((o) => ({ ...o, balanceWorkload: e.target.checked }))}
              />
              <span>Adil dağıtım</span>
            </label>
            <label className="anp-checkbox-row">
              <input
                type="checkbox"
                checked={options.diversifyAreas}
                onChange={(e) => setOptions((o) => ({ ...o, diversifyAreas: e.target.checked }))}
              />
              <span>Alan çeşitliliği</span>
            </label>

            <div className="anp-number-row">
              <label>
                Haftalık min
                <input
                  type="number"
                  min={0}
                  max={3}
                  value={options.minWeeklyDuties}
                  aria-invalid={!!validation.fieldErrors.minWeeklyDuties}
                  onChange={(e) => setOptions((o) => ({ ...o, minWeeklyDuties: Number(e.target.value) }))}
                />
              </label>
              <label>
                Hedef
                <input
                  type="number"
                  min={0}
                  max={3}
                  value={options.targetWeeklyDuties}
                  aria-invalid={!!validation.fieldErrors.targetWeeklyDuties}
                  onChange={(e) => setOptions((o) => ({ ...o, targetWeeklyDuties: Number(e.target.value) }))}
                />
              </label>
              <label>
                Max
                <input
                  type="number"
                  min={0}
                  max={3}
                  value={options.maxWeeklyDuties}
                  aria-invalid={!!validation.fieldErrors.maxWeeklyDuties}
                  onChange={(e) => setOptions((o) => ({ ...o, maxWeeklyDuties: Number(e.target.value) }))}
                />
              </label>
            </div>
            {validation.fieldErrors.minWeeklyDuties && <p className="anp-field-error">Min: {validation.fieldErrors.minWeeklyDuties}</p>}
            {validation.fieldErrors.targetWeeklyDuties && <p className="anp-field-error">Hedef: {validation.fieldErrors.targetWeeklyDuties}</p>}
            {validation.fieldErrors.maxWeeklyDuties && <p className="anp-field-error">Max: {validation.fieldErrors.maxWeeklyDuties}</p>}

            <details className="anp-advanced">
              <summary>Gelişmiş ayarlar</summary>
              <label className="anp-number-row">
                Seed (isteğe bağlı)
                <input
                  type="number"
                  step={1}
                  value={options.seed ?? ""}
                  aria-invalid={!!validation.fieldErrors.seed}
                  onChange={(e) => setOptions((o) => ({ ...o, seed: e.target.value === "" ? undefined : Number(e.target.value) }))}
                  placeholder="rastgele"
                />
              </label>
              {validation.fieldErrors.seed && <p className="anp-field-error">{validation.fieldErrors.seed}</p>}</details>
          </div>
        </section>
      </div>

      {generateError && (
        <div className="alert alert-error" role="alert">
          <span>{generateError}</span>
        </div>
      )}

      <div className="anp-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleGenerate}
          disabled={generating || !validation.valid || hasConfigError || hasPackageConfigError || activeDayOrders.length === 0 || new Date(`${weekStartDate}T00:00:00`).getDay() !== 1}
        >
          {generating ? (
            <>
              <Loader2 size={16} className="spin" aria-hidden="true" />
              Üretiliyor…
            </>
          ) : feasible ? (
            "Taslak Üret"
          ) : (
            "Eksiklerle Taslak Üret"
          )}
        </button>
      </div>
    </>
  );
}

function Fact({ label, value, emphasize }: { label: string; value: number; emphasize?: boolean }) {
  return (
    <div className={emphasize ? "anp-fact anp-fact--emphasize" : "anp-fact"}>
      <span className="anp-fact-value">{value}</span>
      <span className="anp-fact-label">{label}</span>
    </div>
  );
}

// ============================================================================
// Aşama B — Taslak İnceleme
// ============================================================================

interface SelectedCell {
  dayOrder: number;
  dutyLocationId: string;
  dutyLocationName: string;
  dutyBlockId: string;
  blockName: string;
}

function ReviewStage({
  draft,
  snapshot,
  onCancelled,
  onRegenerated,
  embedded,
  onPublished,
}: {
  draft: FoundDraft;
  snapshot: ImportedSnapshot | null;
  onCancelled: () => void;
  onRegenerated: (draft: FoundDraft) => void;
  embedded: boolean;
  onPublished?: () => void;
}) {
  const configuredDayOrders = draft.activeDayOrders ?? [1, 2, 3, 4, 5];
  const configuredDaySet = new Set(configuredDayOrders);
  const days = (snapshot?.days ?? Object.entries(WEEKDAY_NAMES).map(([order, name]) => ({ order: Number(order), name })))
    .filter((day) => configuredDaySet.has(day.order));
  const [activeDay, setActiveDay] = useState<number>(days[0]?.order ?? 1);
  const [selected, setSelected] = useState<SelectedCell | null>(null);
  const [busyAction, setBusyAction] = useState<"regenerate-same" | "regenerate-seed" | "cancel" | "publish" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [publishConfirmOpen, setPublishConfirmOpen] = useState(false);
  const [wipeConfirm, setWipeConfirm] = useState<{ kind: "regenerate-same" | "regenerate-seed" } | null>(null);
  const [showLoadDetails, setShowLoadDetails] = useState(false);

  const blocksById = useMemo(() => {
    const map = new Map<string, DutyBlock>();
    for (const b of snapshot?.blocks ?? []) map.set(b.id, b);
    return map;
  }, [snapshot]);

  // Sütun başlıkları: snapshot varsa gerçek blockCode/blockOrder kullanılır
  // (BLOCK_SHORT_LABELS ile kısa etiket). Snapshot YOKSA (bulgu 4) hiçbir
  // blockCode UYDURULMAZ — assignment.dutyBlockName DOĞRUDAN başlık olur,
  // her dutyBlockId için TEK, benzersiz bir sütun üretilir.
  interface ColumnDef {
    dutyBlockId: string;
    label: string;
    fullName: string;
    order: number;
    code: DutyBlockCode | null;
  }
  const columns: ColumnDef[] = useMemo(() => {
    const list = snapshot?.blocks ?? [];
    if (list.length > 0) {
      return [...list]
        .sort((a, b) => a.blockOrder - b.blockOrder)
        .map((b) => ({ dutyBlockId: b.id, label: BLOCK_SHORT_LABELS[b.code] ?? b.name, fullName: b.name, order: b.blockOrder, code: b.code }));
    }
    const seen = new Map<string, ColumnDef>();
    for (const a of draft.assignments) {
      if (!seen.has(a.dutyBlockId)) {
        seen.set(a.dutyBlockId, { dutyBlockId: a.dutyBlockId, label: a.dutyBlockName, fullName: a.dutyBlockName, order: seen.size + 1, code: null });
      }
    }
    return Array.from(seen.values());
  }, [snapshot, draft.assignments]);

  const categoryByLocation = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of snapshot?.tasks ?? []) map.set(t.dutyLocationId, t.category);
    return map;
  }, [snapshot]);

  // Bulgu 3: öğretmen adı ÖNCELİKLE snapshot.teachers'tan (en güncel ad),
  // sonra draft assignment'ın ad anlık görüntüsünden, en son teacherSourceId'den.
  const teacherNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of draft.assignments) {
      if (a.teacherSourceId && a.teacherName) map.set(a.teacherSourceId, a.teacherName);
    }
    for (const t of snapshot?.teachers ?? []) map.set(t.teacherSourceId, t.teacherName);
    return map;
  }, [snapshot, draft.assignments]);
  function resolveTeacherName(teacherSourceId: string): string {
    return teacherNameById.get(teacherSourceId) ?? teacherSourceId;
  }

  const dayAssignments = draft.assignments.filter((a) => a.dayOrder === activeDay);
  const locations = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of dayAssignments) map.set(a.dutyLocationId, a.dutyLocationName);
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "tr"));
  }, [dayAssignments]);

  function cellFor(locationId: string, blockId: string): DutyPlanDraftAssignmentDto | undefined {
    return dayAssignments.find((a) => a.dutyLocationId === locationId && a.dutyBlockId === blockId);
  }

  /** Solver sürümü; paket seçenekleri ve optimumluk metni buna göre değişir. */
  const isV3Plan = draft.algorithmVersion.startsWith("duty-plan-solver-v3");
  const isV4Plan = draft.algorithmVersion.startsWith("duty-plan-solver-v4");

  const packagesById = useMemo(() => {
    const map = new Map<string, DutyPlanDraftPackageDto>();
    for (const p of draft.packages ?? []) map.set(p.id, p);
    return map;
  }, [draft.packages]);

  /*
    Çok bloklu paket (FULL_DAY / SHORT_BREAKS) desteği YALNIZ normal atamaya
    açık bloklardan türetilir. Sabit görevler (kind === "fixed") sayılmaz:
    İLKOKUL-1/2 gibi karma yerlerde Sabah ve Öğleden Sonra fixed_only'dir ve
    o bloklara normal paket kurulamaz — sabit hücreleri saymak, sunucunun her
    zaman cell_not_open_for_normal ile reddedeceği bir düğme gösterirdi.
    Hiçbir yer adı hard-code edilmez.
  */
  const locationNormalBlockCodes = useMemo(() => {
    const map = new Map<string, Set<DutyBlockCode>>();
    for (const t of snapshot?.tasks ?? []) {
      if (t.kind !== "normal") continue;
      const set = map.get(t.dutyLocationId) ?? new Set<DutyBlockCode>();
      set.add(t.blockCode);
      map.set(t.dutyLocationId, set);
    }
    return map;
  }, [snapshot]);
  function locationSupports(locationId: string, mode: "FULL_DAY" | "SHORT_BREAKS"): boolean {
    // v3 planlarda normal paketler YALNIZ tek bloktur (bkz. migration
    // 20260921090000 ve set_duty_plan_manual_package'ın
    // normal_package_must_be_single_block reddi). Çok bloklu seçenek hiç
    // gösterilmez — sunucunun kesin reddedeceği bir eylem sunulmaz.
    if (isV3Plan) return false;
    const codes = locationNormalBlockCodes.get(locationId);
    if (!codes) return false;
    if (mode === "SHORT_BREAKS") return codes.has("MORNING_BREAKS") && codes.has("AFTERNOON_BREAKS");
    if (isV4Plan) return false; // v4'te FULL_DAY / öğle-çifti / üçlü paket yoktur.
    return codes.size === 4 && codes.has("MORNING_BREAKS") && codes.has("LONG_BREAK_1") && codes.has("LONG_BREAK_2") && codes.has("AFTERNOON_BREAKS");
  }

  const summary = draft.summary;
  const teacherLoads = (summary.teacherLoads as { teacherSourceId: string; normalDutyCount: number; fixedDutyDayCount: number; totalDutyCount: number }[]) ?? [];
  const generationOptions = draft.generationOptions;
  const min = generationOptions.minWeeklyDuties ?? DEFAULT_GENERATION_OPTIONS.minWeeklyDuties;
  const target = generationOptions.targetWeeklyDuties ?? DEFAULT_GENERATION_OPTIONS.targetWeeklyDuties;
  const max = generationOptions.maxWeeklyDuties ?? DEFAULT_GENERATION_OPTIONS.maxWeeklyDuties;

  const assignedCount = draft.assignments.filter((a) => a.assignmentKind === "generated" || a.assignmentKind === "manual").length;
  const assignedPackageCount = summary.v4?.assignedPackageCount ?? assignedCount;
  const manualCount = new Set(
    draft.assignments.filter((a) => a.assignmentKind === "manual").map((a) => a.packageId ?? a.id),
  ).size;
  const openCount = draft.assignments.filter((a) => a.assignmentKind === "unassigned").length;
  const fixedCellCount = draft.assignments.filter((a) => a.assignmentKind === "fixed").length;
  const warningCount = ((summary.warnings as unknown[]) ?? []).length;
  const canPublish = openCount === 0 && !draft.isStale;

  const diversificationOnly = isV3Plan && summary.v3?.optimalityReason === "diversification_heuristic";
  const optimalityLabel = summary.optimalityProven
    ? "Optimum çözüm"
    : diversificationOnly
      ? "Kapsama optimum — alan çeşitliliği sezgisel"
      : "En iyi bulunan çözüm — optimumluk kanıtlanamadı";
  /*
    "Arama düğüm bütçesi doldu" YALNIZ gerçekten öyleyse yazılır:
    searchLimitReached===true VE plan v3 DEĞİL. v3'te kesin min-cost-flow
    kullanılır, arama limiti YOKTUR — v3'ün hiçbir dalında bu metin çıkmaz.
    v3 teşhisleri eksik/tarihsel olduğunda (optimalityReason yok) SEBEP
    UYDURULMAZ; nötr "doğrulanamadı" metni gösterilir.
  */
  const searchBudgetExhausted = !isV3Plan && !isV4Plan && summary.searchLimitReached === true;
  const optimalityTitle = summary.optimalityProven
    ? "Sonuç, mevcut kurallar altında kanıtlanmış en iyi çözümdür."
    : diversificationOnly
      ? "Kapsama kesin maksimumdur. Yalnız alan çeşitliliği geçişi sezgisel olduğu için nihai sıralama kanıtlanmaz; arama limiti dolmadı."
      : searchBudgetExhausted
        ? `Arama düğüm bütçesi (${String(summary.exploredNodeCount ?? "?")}) doldu — optimumluk kanıtlanamadı, en iyi bulunan çözüm gösteriliyor.`
        : "Nihai sıralamanın optimumluğu doğrulanamadı — en iyi bulunan çözüm gösteriliyor.";

  const stripItems = days.map((d) => {
    const rows = draft.assignments.filter((a) => a.dayOrder === d.order);
    const required = rows.length;
    const covered = rows.filter((a) => a.assignmentKind !== "unassigned").length;
    return { order: d.order, name: d.name, covered, required };
  });

  async function runAction(kind: "regenerate-same" | "regenerate-seed" | "cancel" | "publish", wipeManualAssignments?: boolean) {
    setBusyAction(kind);
    setActionError(null);
    try {
      if (kind === "cancel") {
        await deleteDutyPlanDraft(draft.id);
        onCancelled();
        return;
      }
      if (kind === "publish") {
        await publishDutyPlanDraft(draft.id, { expectedPlanVersion: draft.version });
        if (onPublished) {
          onPublished();
          return;
        }
        const fresh = await fetchCurrentDutyPlanDraft();
        if (fresh.found) onRegenerated(fresh);
        else onCancelled();
        return;
      }
      const nextSeed = kind === "regenerate-seed" ? Math.floor(Math.random() * 1_000_000) : generationOptions.seed;
      const result = await regenerateDutyPlanDraft(draft.id, {
        options: { ...DEFAULT_GENERATION_OPTIONS, ...generationOptions, seed: nextSeed },
        expectedPlanVersion: draft.version,
        wipeManualAssignments,
      });
      const fresh = await fetchCurrentDutyPlanDraft();
      if (fresh.found) {
        onRegenerated(fresh);
      } else {
        setActionError(`Taslak yeniden üretildi (${result.planId}) ancak okunamadı. Sayfayı yenileyin.`);
      }
    } catch (err) {
      if (err instanceof GenerateDutyPlanDraftApiError || err instanceof PublishDutyPlanDraftApiError) {
        setActionError(err.body.message);
      } else {
        setActionError("İşlem tamamlanamadı. Yerel API bağlantısını kontrol edip tekrar deneyin.");
      }
    } finally {
      setBusyAction(null);
      setCancelConfirmOpen(false);
      setPublishConfirmOpen(false);
      setWipeConfirm(null);
    }
  }

  function handleRegenerateClick(kind: "regenerate-same" | "regenerate-seed") {
    if (manualCount > 0) {
      setWipeConfirm({ kind });
      return;
    }
    void runAction(kind, false);
  }

  return (
    <>
      <div className="anp-card">
        <div className="anp-review-top">
          <Fact label={isV4Plan ? "Atanan normal paket" : "Atanan normal görev"} value={assignedPackageCount} />
          {isV4Plan && <Fact label="Kapsanan görev hücresi" value={assignedCount} />}
          <Fact label="Manuel paket" value={manualCount} />
          <Fact label="Açık görev" value={openCount} emphasize={openCount > 0} />
          <Fact label="Sabit görev hücresi" value={fixedCellCount} />
          <Fact label="Uyarı" value={warningCount} emphasize={warningCount > 0} />
        </div>
        <div className="anp-review-meta">
          <span className={draft.isStale ? "anp-badge anp-badge--stale" : "anp-badge anp-badge--fresh"}>
            {draft.isStale ? "Kaynak veriler değişti" : "Kaynak güncel"}
          </span>
          {/*
            optimalityProven=false'ın NEDENİ sürüme göre değişir. v1/v2'de arama
            düğüm bütçesi dolmuş demektir. v3'te kesin min-cost-flow kullanılır,
            arama limiti YOKTUR: tek neden diversifyAreas sezgiselidir ve
            KAPSAMA yine kesin maksimumdur. Tek bir "düğüm bütçesi doldu" metni
            v3 için YANLIŞ olurdu.
          */}
          {typeof summary.optimalityProven === "boolean" && (
            <span
              className={summary.optimalityProven ? "anp-badge anp-badge--optimal" : "anp-badge anp-badge--bounded"}
              title={optimalityTitle}
            >
              {optimalityLabel}
            </span>
          )}
          {((isV3Plan && summary.v3?.coverageOptimalityProven) || (isV4Plan && summary.v4?.coverageOptimalityProven)) && (
            <span className="anp-badge anp-badge--optimal" title="Kapsama, mevcut kurallar altında kesin maksimumdur; açık görev varsa nedeni kural/kapasite kısıtıdır.">
              Kapsama kesin maksimum
            </span>
          )}
          <span className="anp-meta-text">Kaydedilme: {new Date(draft.createdAt).toLocaleString("tr-TR")}</span>
          {draft.weekStartDate && <span className="anp-meta-text">Hafta: {new Date(`${draft.weekStartDate}T00:00:00`).toLocaleDateString("tr-TR")} · {days.length} gün</span>}
        </div>
        {draft.isStale && (
          <div className="alert alert-warning" role="alert">
            <TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />
            <span>Kaynak veriler (öğretmen tercihleri, sabit nöbetler veya ders programı) bu taslak üretildikten sonra değişti. Düzenleme yapmadan önce yeniden üretin.</span>
          </div>
        )}
        {!snapshot && (
          <div className="alert alert-warning" role="status">
            <AlertCircle size={16} strokeWidth={2} aria-hidden="true" />
            <span>
              Güncel hazırlık verisi alınamadı — taslak hücreleri, kayıtlı öğretmenler ve kapsama sayıları görüntülenmeye devam ediyor, ancak aday
              listesi, uygun olmayan öğretmen gerekçeleri, kategori çeşitliliği hesaplanamıyor ve yeniden üretme geçici olarak devre dışı.
            </span>
          </div>
        )}
      </div>

      <div className="anp-card">
        <h2 className="anp-card-title">Haftalık Kapsama</h2>
        <CoverageStrip items={stripItems} />
      </div>

      <div className="anp-card anp-table-card">
        <div className="anp-day-tabs" role="tablist" aria-label="Gün seçimi">
          {days.map((d) => {
            const rows = draft.assignments.filter((a) => a.dayOrder === d.order);
            const required = rows.length;
            const covered = rows.filter((a) => a.assignmentKind !== "unassigned").length;
            const short = covered < required;
            return (
              <button
                key={d.order}
                type="button"
                role="tab"
                aria-selected={activeDay === d.order}
                className={activeDay === d.order ? "anp-day-tab anp-day-tab--active" : "anp-day-tab"}
                onClick={() => setActiveDay(d.order)}
              >
                <span>{d.name}</span>
                <span className={short ? "anp-day-tab-count anp-day-tab-count--short" : "anp-day-tab-count"}>
                  {covered}/{required}
                </span>
              </button>
            );
          })}
        </div>

        <div className="anp-table-scroll">
          <table className="anp-table">
            <thead>
              <tr>
                <th scope="col">Nöbet Yeri</th>
                {columns.map((b) => (
                  <th scope="col" key={b.dutyBlockId} title={b.fullName}>
                    {b.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {locations.map((loc) => (
                <tr key={loc.id}>
                  <th scope="row">{loc.name}</th>
                  {columns.map((b) => {
                    const cell = cellFor(loc.id, b.dutyBlockId);
                    if (!cell) {
                      return (
                        <td key={b.dutyBlockId} className="anp-cell anp-cell--none">
                          —
                        </td>
                      );
                    }
                    return (
                      <td key={b.dutyBlockId}>
                        <TableCell
                          cell={cell}
                          pkg={cell.packageId ? packagesById.get(cell.packageId) : undefined}
                          onSelect={() =>
                            setSelected({
                              dayOrder: activeDay,
                              dutyLocationId: loc.id,
                              dutyLocationName: loc.name,
                              dutyBlockId: b.dutyBlockId,
                              blockName: b.fullName,
                            })
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
              {locations.length === 0 && (
                <tr>
                  <td colSpan={columns.length + 1}>Bu gün için görev yok.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {embedded && (
        <button type="button" className="anp-detail-toggle" aria-expanded={showLoadDetails} onClick={() => setShowLoadDetails((value) => !value)}>
          {showLoadDetails ? "Öğretmen yük ayrıntılarını gizle" : "Öğretmen yük ayrıntılarını göster"}
        </button>
      )}

      {(!embedded || showLoadDetails) && <div className="anp-card anp-load-card">
        <h2 className="anp-card-title">Öğretmen Yük Dağılımı</h2>
        <div className="anp-table-scroll">
          <table className="anp-table">
            <thead>
              <tr>
                <th scope="col">Öğretmen</th>
                <th scope="col">Normal</th>
                <th scope="col">Sabit gün</th>
                <th scope="col">Toplam</th>
                <th scope="col">Durum</th>
                <th scope="col">Kategori çeşitliliği</th>
                <th scope="col">Bu gün görevi</th>
              </tr>
            </thead>
            <tbody>
              {teacherLoads.map((load) => {
                const status = load.totalDutyCount < min ? "Min altında" : load.totalDutyCount > max ? "Max üstünde" : load.totalDutyCount === target ? "Hedefte" : "Aralıkta";
                const categories = new Set(
                  draft.assignments
                    .filter((a) => a.teacherSourceId === load.teacherSourceId && a.assignmentKind !== "unassigned")
                    .map((a) => categoryByLocation.get(a.dutyLocationId))
                    .filter((c): c is string => Boolean(c)),
                );
                const hasDutyToday = draft.assignments.some((a) => a.teacherSourceId === load.teacherSourceId && a.dayOrder === activeDay && a.assignmentKind !== "unassigned");
                return (
                  <tr key={load.teacherSourceId}>
                    <td>{resolveTeacherName(load.teacherSourceId)}</td>
                    <td>{load.normalDutyCount}</td>
                    <td>{load.fixedDutyDayCount}</td>
                    <td>{load.totalDutyCount}</td>
                    <td>
                      <span className={status === "Min altında" || status === "Max üstünde" ? "anp-pill anp-pill--warn" : "anp-pill"}>{status}</span>
                    </td>
                    <td>{snapshot ? categories.size : <span title="Güncel hazırlık verisi alınamadığı için hesaplanamıyor.">—</span>}</td>
                    <td>{hasDutyToday ? "Var" : "Yok"}</td>
                  </tr>
                );
              })}
              {teacherLoads.length === 0 && (
                <tr>
                  <td colSpan={7}>Öğretmen yük verisi yok.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>}

      {actionError && (
        <div className="alert alert-error" role="alert">
          <span>{actionError}</span>
        </div>
      )}

      <div className="anp-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => handleRegenerateClick("regenerate-same")}
          disabled={busyAction !== null || !snapshot}
          title={!snapshot ? "Yeniden üretmek için güncel hazırlık verisi gerekir; şu anda alınamadı." : undefined}
        >
          {busyAction === "regenerate-same" ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />}
          Aynı Ayarlarla Yeniden Üret
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => handleRegenerateClick("regenerate-seed")}
          disabled={busyAction !== null || !snapshot}
          title={!snapshot ? "Yeniden üretmek için güncel hazırlık verisi gerekir; şu anda alınamadı." : undefined}
        >
          {busyAction === "regenerate-seed" ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Shuffle size={14} strokeWidth={2} aria-hidden="true" />}
          Farklı Seed ile Yeniden Üret
        </button>
        <button type="button" className="btn btn-secondary anp-btn-danger" onClick={() => setCancelConfirmOpen(true)} disabled={busyAction !== null}>
          <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
          Taslağı İptal Et
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setPublishConfirmOpen(true)}
          disabled={busyAction !== null || !canPublish}
          title={!canPublish ? "Yayımlamak için açık görev kalmamalı ve kaynak güncel olmalı." : undefined}
        >
          {busyAction === "publish" ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <UploadCloud size={14} strokeWidth={2} aria-hidden="true" />}
          Yayımla
        </button>
      </div>

      {cancelConfirmOpen && (
        <CancelConfirmDialog busy={busyAction === "cancel"} onConfirm={() => runAction("cancel")} onClose={() => setCancelConfirmOpen(false)} />
      )}

      {publishConfirmOpen && (
        <PublishConfirmDialog busy={busyAction === "publish"} onConfirm={() => runAction("publish")} onClose={() => setPublishConfirmOpen(false)} />
      )}

      {wipeConfirm && (
        <WipeManualConfirmDialog
          manualCount={manualCount}
          busy={busyAction !== null}
          onKeepManual={() => void runAction(wipeConfirm.kind, false)}
          onWipeManual={() => void runAction(wipeConfirm.kind, true)}
          onClose={() => setWipeConfirm(null)}
        />
      )}

      {selected && (
        <DetailPanel
          selected={selected}
          draft={draft}
          snapshot={snapshot}
          blocksById={blocksById}
          packagesById={packagesById}
          locationSupports={locationSupports}
          onClose={() => setSelected(null)}
          onAssigned={(fresh) => {
            onRegenerated(fresh);
            setSelected(null);
          }}
        />
      )}
    </>
  );
}

function TableCell({ cell, pkg, onSelect }: { cell: DutyPlanDraftAssignmentDto; pkg: DutyPlanDraftPackageDto | undefined; onSelect: () => void }) {
  const packageBadge = pkg ? <span className={`anp-cell-package anp-cell-package--${pkg.coverageMode.toLowerCase()}`}>{PACKAGE_COVERAGE_MODE_LABELS[pkg.coverageMode]}</span> : null;

  if (cell.assignmentKind === "fixed") {
    return (
      <button type="button" className="anp-cell anp-cell--fixed" onClick={onSelect} aria-label={`${cell.dutyLocationName} — sabit, ${cell.teacherName ?? "?"}`}>
        <LockKeyhole size={12} strokeWidth={2} aria-hidden="true" />
        {cell.teacherName ?? "—"}
        {packageBadge}
      </button>
    );
  }
  if (cell.assignmentKind === "unassigned") {
    return (
      <button type="button" className="anp-cell anp-cell--open" onClick={onSelect}>
        Öğretmen bulunamadı
      </button>
    );
  }
  return (
    <button type="button" className="anp-cell anp-cell--assigned" onClick={onSelect}>
      <span>{cell.teacherName}</span>
      <span className="anp-cell-tag">{cell.assignmentKind === "manual" ? "Manuel" : "Uygun tercih"}</span>
      {packageBadge}
    </button>
  );
}

function CancelConfirmDialog({ busy, onConfirm, onClose }: { busy: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <div className="anp-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="anp-confirm" role="alertdialog" aria-modal="true" aria-labelledby="anp-cancel-title">
        <h2 id="anp-cancel-title">Taslağı iptal et</h2>
        <p>Bu taslak kalıcı olarak silinecek. Emin misiniz?</p>
        <div className="anp-confirm-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <button type="button" className="btn btn-primary anp-btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Trash2 size={14} strokeWidth={2} aria-hidden="true" />}
            Evet, İptal Et
          </button>
        </div>
      </div>
    </div>
  );
}

function PublishConfirmDialog({ busy, onConfirm, onClose }: { busy: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <div className="anp-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="anp-confirm" role="alertdialog" aria-modal="true" aria-labelledby="anp-publish-title">
        <h2 id="anp-publish-title">Nöbet planını yayımla</h2>
        <p>Yayımlanan plan kalıcı ve değiştirilemez olur. Varsa önceki yayımlanmış plan arşivlenir. Devam edilsin mi?</p>
        <div className="anp-confirm-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <UploadCloud size={14} strokeWidth={2} aria-hidden="true" />}
            Evet, Yayımla
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Yeniden üretmeden önce, mevcut manuel atamalar varsa, kullanıcının AYRI ve
 * AÇIK bir eylemle seçim yapmasını zorunlu kılar — sessizce silinmezler.
 */
function WipeManualConfirmDialog({
  manualCount,
  busy,
  onKeepManual,
  onWipeManual,
  onClose,
}: {
  manualCount: number;
  busy: boolean;
  onKeepManual: () => void;
  onWipeManual: () => void;
  onClose: () => void;
}) {
  return (
    <div className="anp-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="anp-confirm" role="alertdialog" aria-modal="true" aria-labelledby="anp-wipe-title">
        <h2 id="anp-wipe-title">Manuel atamalar ne olsun?</h2>
        <p>
          Bu taslakta {manualCount} manuel atama var. Varsayılan olarak bunlar kilitli kısıt olarak korunur ve yeniden üretme yalnız kalan boş
          hücreleri doldurur. İsterseniz tüm manuel atamaları silip sıfırdan üretebilirsiniz.
        </p>
        <div className="anp-confirm-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Vazgeç
          </button>
          <button type="button" className="btn btn-secondary anp-btn-danger" onClick={onWipeManual} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <CircleSlash size={14} strokeWidth={2} aria-hidden="true" />}
            Manuel Atamaları Sil, Sıfırdan Üret
          </button>
          <button type="button" className="btn btn-primary" onClick={onKeepManual} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />}
            Manuel Atamaları Koru
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Görev detay paneli — geniş ekranda sağ panel, dar ekranda drawer/modal.
// ============================================================================
interface PendingPackageAction {
  teacherSourceId: string | null;
  coverageMode: ManualPackageCoverageMode;
  affectedTasks: ManualPackageAffectedTaskDto[];
}

/**
 * Aday isteğinin AÇIK görünüm durumu. RPC'nin döndürebileceği her biçim
 * (plan yok / görev yok / bayat / sürüm uyuşmazlığı) ayrı bir duruma
 * düşer; hiçbiri sonsuz "yükleniyor" olarak kalmaz.
 */
type CandidateViewStatus = "loading" | "error" | "plan_not_found" | "task_not_found" | "stale" | "version_mismatch" | "ready";

function DetailPanel({
  selected,
  draft,
  snapshot,
  blocksById,
  packagesById,
  locationSupports,
  onClose,
  onAssigned,
}: {
  selected: SelectedCell;
  draft: FoundDraft;
  snapshot: ImportedSnapshot | null;
  blocksById: Map<string, DutyBlock>;
  packagesById: Map<string, DutyPlanDraftPackageDto>;
  locationSupports: (locationId: string, mode: "FULL_DAY" | "SHORT_BREAKS") => boolean;
  onClose: () => void;
  onAssigned: (draft: FoundDraft) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const [assignBusyTeacherId, setAssignBusyTeacherId] = useState<string | null | "remove">(null);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [pendingPackageAction, setPendingPackageAction] = useState<PendingPackageAction | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>("button")?.focus();
    return () => previouslyFocused.current?.focus();
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusable = panelRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex]:not([tabindex='-1'])");
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const cell = draft.assignments.find(
    (a) => a.dayOrder === selected.dayOrder && a.dutyLocationId === selected.dutyLocationId && a.dutyBlockId === selected.dutyBlockId,
  );

  const currentTeacherLoad = cell?.teacherSourceId
    ? ((draft.summary.teacherLoads as { teacherSourceId: string; normalDutyCount: number; fixedDutyDayCount: number; totalDutyCount: number }[]) ?? []).find(
        (l) => l.teacherSourceId === cell.teacherSourceId,
      )
    : undefined;

  const otherDutyToday = cell?.teacherSourceId
    ? draft.assignments.find(
        (a) => a.teacherSourceId === cell.teacherSourceId && a.dayOrder === selected.dayOrder && a.id !== cell.id && a.assignmentKind !== "unassigned",
      )
    : undefined;

  const block = blocksById.get(selected.dutyBlockId);
  const configErrorForBlock = snapshot?.configurationErrors.find((c) => c.dayOrder === selected.dayOrder && c.blockCode === block?.code);

  /*
    ADAY LİSTESİ AUTHORITATIVE RPC'DEN OKUNUR.

    Eskiden bu panel kuralları tarayıcıda yeniden türetiyordu ve "o gün başka
    normal görevi var" diyerek HER öğretmeni günde tek göreve kısıtlıyordu. Bu
    ESKİ modeldir: yarım gün kuralı KAPALI öğretmen aynı gün FARKLI bloklarda
    görev alabilir, yalnız AYNI blokta ikinci bir yere atanamaz. Kural motorunu
    istemcide ikinci kez yazmak yerine get_duty_plan_task_candidates çağrılır;
    gerekçeler (half_day_daily_limit, already_assigned_same_block, ...) olduğu
    gibi gösterilir. RPC okunamazsa TAHMİN ÜRETİLMEZ — liste gösterilmez.
  */
  const taskId = cell?.id ?? null;
  /*
    Sonuç, hangi istek için geldiğini taşıyan TEK bir state'te tutulur
    (requestKey). Böylece efekt içinde senkron setState ile "sıfırlama"
    yapılmaz: hücre veya plan sürümü değişince eski sonuç render sırasında
    zaten eşleşmez ve "yükleniyor" durumuna düşülür.
  */
  const requestKey = taskId ? `${draft.id}:${draft.version}:${taskId}` : null;
  const [candidateState, setCandidateState] = useState<{ requestKey: string; data: TaskCandidatesDto | null; error: boolean } | null>(null);

  useEffect(() => {
    if (!taskId || !requestKey) return;
    const controller = new AbortController();
    let ignore = false;
    fetchDutyPlanTaskCandidates(draft.id, taskId, controller.signal)
      .then((data) => {
        if (!ignore) setCandidateState({ requestKey, data, error: false });
      })
      .catch((err: unknown) => {
        if (!ignore && !isAbortError(err)) setCandidateState({ requestKey, data: null, error: true });
      });
    return () => {
      ignore = true;
      controller.abort();
    };
  }, [draft.id, requestKey, taskId]);

  const currentCandidateState = candidateState && candidateState.requestKey === requestKey ? candidateState : null;
  const candidates = currentCandidateState?.data ?? null;

  /*
    Aday isteğinin TEK ve AÇIK görünüm durumu. Her yanıt biçimi ayrı bir
    duruma düşer; hiçbir biçim sonsuz "yükleniyor" göstermez ve hiçbir
    durumda istemci tarafında tahmini aday listesi üretilmez.
  */
  const candidateStatus: CandidateViewStatus = !currentCandidateState
    ? "loading"
    : currentCandidateState.error || !candidates
      ? "error"
      : !candidates.found
        ? "plan_not_found"
        : !candidates.taskFound
          ? "task_not_found"
          : candidates.planVersion !== draft.version
            ? "version_mismatch"
            : candidates.isStale
              ? "stale"
              : "ready";

  /* stale / version_mismatch: liste GÖSTERİLİR ama SALT OKUNURDUR. */
  const candidatesVisible = candidateStatus === "ready" || candidateStatus === "stale" || candidateStatus === "version_mismatch";
  const candidatesOutdated = candidateStatus === "stale" || candidateStatus === "version_mismatch";
  /*
    Plan/görev artık yoksa ya da aday yanıtı bayat/sürüm uyuşmazsa yazma
    eylemlerinin TAMAMI (aday atama, "Atamayı Kaldır", paket kaldırma)
    kapalıdır — bu durumlarda hiçbir PUT/preview isteği başlatılamaz.
  */
  const candidatesBlockEdit = candidatesOutdated || candidateStatus === "plan_not_found" || candidateStatus === "task_not_found";

  const candidateRows = candidates?.found && candidates.taskFound ? candidates.candidates : [];
  /*
    UYGUNLUK KARARININ TEK YETKİLİSİ RPC'nin `eligible` alanıdır. `isCurrent`
    yalnızca bir ETİKETTİR: eligible=false olan mevcut öğretmeni "uygun"
    yapmaz — aksi halde ekran, gerçekte kural ihlal eden bir atamayı uygun
    gösterir ve RPC'nin gerekçelerini gizlerdi.
  */
  const eligibleTeachers = candidateRows
    .filter((c) => c.eligible)
    .map((c) => ({ teacherSourceId: c.teacherSourceId, teacherName: c.teacherName, isCurrent: c.isCurrent }))
    .sort((a, b) => a.teacherName.localeCompare(b.teacherName, "tr"));
  const ineligible = candidateRows
    .filter((c) => !c.eligible)
    .map((c) => ({ teacherSourceId: c.teacherSourceId, teacherName: c.teacherName, isCurrent: c.isCurrent, reasons: c.reasons }))
    .sort((a, b) => a.teacherName.localeCompare(b.teacherName, "tr"));

  /*
    Bayat/sürümü uyuşmayan ya da plan/görev bulunamayan aday yanıtında
    manuel atama ve paket eylemleri KAPALIDIR — mevcut optimistic-concurrency koruması
    (expectedPlanVersion) aynen korunur, bu yalnız ONUN ÖNÜNDE ek bir
    kapıdır.
  */
  const canEdit = !!cell && cell.assignmentKind !== "fixed" && !draft.isStale && !candidatesBlockEdit;

  async function assignTeacher(teacherSourceId: string | null) {
    if (!cell) return;
    setAssignBusyTeacherId(teacherSourceId ?? "remove");
    setAssignError(null);
    try {
      const result = await updateDutyPlanAssignment(draft.id, cell.id, { teacherSourceId, expectedPlanVersion: draft.version });
      const fresh = await fetchCurrentDutyPlanDraft();
      if (fresh.found) {
        onAssigned(fresh);
      } else {
        setAssignError(`Atama kaydedildi (v${result.version}) ancak taslak okunamadı. Sayfayı yenileyin.`);
      }
    } catch (err) {
      if (err instanceof UpdateDutyPlanAssignmentApiError) {
        if (err.body.status === "teacher_day_conflict" && err.body.conflictingPackage) {
          setAssignError(`${err.body.message} (${PACKAGE_COVERAGE_MODE_LABELS[err.body.conflictingPackage.coverageMode]}). Önce o paketi kaldırın, sonra tekrar deneyin.`);
        } else if (err.body.status === "requires_package_action" && err.body.package) {
          setAssignError(
            `Bu hücre "${PACKAGE_COVERAGE_MODE_LABELS[err.body.package.coverageMode]}" paketinin parçası (${err.body.package.teacherName}). Tekil hücre olarak değiştirilemez — önce paketi düzenlemek için o hücrelerden birine tıklayıp paket seçeneklerini kullanın.`,
          );
        } else if (err.body.status === "v4_package_action_required") {
          setAssignError("Sabah ve Öğleden Sonra hücreleri ayrı düzenlenemez; Teneffüs paketini kullanın.");
        } else {
          setAssignError(err.body.message);
        }
      } else {
        setAssignError("Atama kaydedilemedi. Yerel API bağlantısını kontrol edip tekrar deneyin.");
      }
    } finally {
      setAssignBusyTeacherId(null);
    }
  }

  const currentPackage = cell?.packageId ? packagesById.get(cell.packageId) : undefined;
  const isMultiCellPackage = (currentPackage?.coveredTaskIds.length ?? 0) > 1;
  const isV4Plan = draft.algorithmVersion.startsWith("duty-plan-solver-v4");
  const selectedIsBreakPairCell = block?.code === "MORNING_BREAKS" || block?.code === "AFTERNOON_BREAKS";
  const supportsFullDay = locationSupports(selected.dutyLocationId, "FULL_DAY");
  const supportsShortBreaks = locationSupports(selected.dutyLocationId, "SHORT_BREAKS");

  /** Ön izleme + (gerekirse) affectedTasks onayı sonrası paket yazar. */
  async function commitPackageAction(teacherSourceId: string | null, coverageMode: ManualPackageCoverageMode, expectedAffectedTaskIds: string[]): Promise<void> {
    setAssignBusyTeacherId(teacherSourceId ?? "remove");
    setAssignError(null);
    try {
      const result = await setDutyPlanManualPackage(draft.id, {
        dayOrder: selected.dayOrder,
        dutyLocationId: selected.dutyLocationId,
        teacherSourceId,
        coverageMode,
        dutyBlockId: coverageMode === "SINGLE_BLOCK" ? selected.dutyBlockId : undefined,
        expectedPlanVersion: draft.version,
        expectedAffectedTaskIds: expectedAffectedTaskIds.length > 0 ? expectedAffectedTaskIds : null,
      });
      const fresh = await fetchCurrentDutyPlanDraft();
      if (fresh.found) {
        onAssigned(fresh);
      } else {
        setAssignError(`Paket kaydedildi (v${result.version}) ancak taslak okunamadı. Sayfayı yenileyin.`);
      }
      setPendingPackageAction(null);
    } catch (err) {
      if (err instanceof SetDutyPlanManualPackageApiError) {
        if ((err.body.status === "requires_confirmation" || err.body.status === "stale_affected_set") && err.body.affectedTasks) {
          // Taze etkilenen küme — kullanıcı GÜNCEL listeyle tekrar onaylamalı
          // (sessiz yazma yok, bkz. server tarafı tek-karar mantığı). Modal AÇIK
          // kalır — kapatılırsa güncel liste kullanıcıya hiç gösterilmemiş olur.
          setPendingPackageAction({ teacherSourceId, coverageMode, affectedTasks: err.body.affectedTasks });
        } else if (err.body.status === "teacher_day_conflict" && err.body.conflictingPackage) {
          setAssignError(`${err.body.message} (${PACKAGE_COVERAGE_MODE_LABELS[err.body.conflictingPackage.coverageMode]}).`);
          setPendingPackageAction(null);
        } else {
          setAssignError(err.body.message);
          setPendingPackageAction(null);
        }
      } else {
        setAssignError("Paket kaydedilemedi. Yerel API bağlantısını kontrol edip tekrar deneyin.");
        setPendingPackageAction(null);
      }
    } finally {
      setAssignBusyTeacherId(null);
    }
  }

  /** "Bu blok / Sabah+ÖS / Tüm gün ata" — önce ÖN İZLEME, uygun+etkisiz ise doğrudan yazar. */
  async function assignPackage(teacherSourceId: string, coverageMode: ManualPackageCoverageMode): Promise<void> {
    setAssignBusyTeacherId(teacherSourceId);
    setAssignError(null);
    try {
      const preview = await previewDutyPlanManualPackage(draft.id, {
        dayOrder: selected.dayOrder,
        dutyLocationId: selected.dutyLocationId,
        teacherSourceId,
        coverageMode,
        dutyBlockId: coverageMode === "SINGLE_BLOCK" ? selected.dutyBlockId : undefined,
      });
      if (!preview.found) {
        setAssignError("Plan bulunamadı.");
        return;
      }
      if (!preview.eligible) {
        setAssignError(`Öğretmen bu paket için uygun değil: ${preview.reasons.map((r) => TASK_CANDIDATE_REASON_LABELS[r as keyof typeof TASK_CANDIDATE_REASON_LABELS] ?? r).join(", ")}`);
        return;
      }
      if ((preview.affectedTasks?.length ?? 0) > 0) {
        setPendingPackageAction({ teacherSourceId, coverageMode, affectedTasks: preview.affectedTasks ?? [] });
        setAssignBusyTeacherId(null);
        return;
      }
      await commitPackageAction(teacherSourceId, coverageMode, []);
    } catch {
      setAssignError("Paket ön izlemesi alınamadı. Yerel API bağlantısını kontrol edip tekrar deneyin.");
      setAssignBusyTeacherId(null);
    }
  }

  /** Mevcut (>1 hücreli) paketi tamamen kaldırır — hücreler açıkça listelenip onaylanır. */
  async function removeCurrentPackage(): Promise<void> {
    if (!currentPackage) return;
    setAssignBusyTeacherId("remove");
    setAssignError(null);
    try {
      const preview = await previewDutyPlanManualPackage(draft.id, {
        dayOrder: selected.dayOrder,
        dutyLocationId: selected.dutyLocationId,
        teacherSourceId: null,
        coverageMode: currentPackage.coverageMode as ManualPackageCoverageMode,
      });
      if (preview.found && (preview.affectedTasks?.length ?? 0) > 0) {
        setPendingPackageAction({ teacherSourceId: null, coverageMode: currentPackage.coverageMode as ManualPackageCoverageMode, affectedTasks: preview.affectedTasks ?? [] });
        setAssignBusyTeacherId(null);
        return;
      }
      await commitPackageAction(null, currentPackage.coverageMode as ManualPackageCoverageMode, []);
    } catch {
      setAssignError("Paket kaldırılamadı. Yerel API bağlantısını kontrol edip tekrar deneyin.");
      setAssignBusyTeacherId(null);
    }
  }

  return (
    <div className="anp-overlay anp-detail-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="anp-detail-panel" role="dialog" aria-modal="true" aria-labelledby="anp-detail-title" ref={panelRef} onKeyDown={handleKeyDown}>
        <div className="anp-detail-header">
          <h2 id="anp-detail-title">{selected.dutyLocationName}</h2>
          <button type="button" className="anp-icon-btn" aria-label="Kapat" onClick={onClose}>
            <X size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        <div className="anp-detail-body">
          <dl className="anp-detail-stats">
            <div>
              <dt>Gün</dt>
              <dd>{WEEKDAY_NAMES[selected.dayOrder] ?? selected.dayOrder}</dd>
            </div>
            <div>
              <dt>Yer</dt>
              <dd>{selected.dutyLocationName}</dd>
            </div>
            <div>
              <dt>Blok</dt>
              <dd>{selected.blockName}</dd>
            </div>
          </dl>

          <section className="anp-detail-section">
            <h3>Mevcut öğretmen</h3>
            {cell?.assignmentKind === "fixed" && (
              <p>
                <LockKeyhole size={14} strokeWidth={2} aria-hidden="true" /> {cell.teacherName} — sabit, değiştirilemez.
              </p>
            )}
            {cell?.assignmentKind === "unassigned" && <p>Öğretmen bulunamadı.</p>}
            {(cell?.assignmentKind === "generated" || cell?.assignmentKind === "manual") && (
              <>
                <p>
                  {cell.teacherName} — {cell.assignmentKind === "manual" ? "manuel atama" : "uygun tercih"}
                </p>
                {currentTeacherLoad && (
                  <p className="anp-detail-note">
                    Haftalık yük: {currentTeacherLoad.totalDutyCount} ({currentTeacherLoad.normalDutyCount} normal + {currentTeacherLoad.fixedDutyDayCount} sabit)
                  </p>
                )}
                <p className="anp-detail-note">{otherDutyToday ? `Bu gün başka görevi de var: ${otherDutyToday.dutyLocationName}` : "Bu gün başka görevi yok."}</p>
                {canEdit && !isMultiCellPackage && (
                  <button type="button" className="btn btn-secondary anp-btn-danger" onClick={() => void assignTeacher(null)} disabled={assignBusyTeacherId !== null}>
                    {assignBusyTeacherId === "remove" ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <CircleSlash size={14} strokeWidth={2} aria-hidden="true" />}
                    Atamayı Kaldır
                  </button>
                )}
                {canEdit && isMultiCellPackage && currentPackage && (
                  <button type="button" className="btn btn-secondary anp-btn-danger" onClick={() => void removeCurrentPackage()} disabled={assignBusyTeacherId !== null}>
                    {assignBusyTeacherId === "remove" ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <CircleSlash size={14} strokeWidth={2} aria-hidden="true" />}
                    {PACKAGE_COVERAGE_MODE_LABELS[currentPackage.coverageMode]} paketini kaldır ({currentPackage.coveredTaskIds.length} hücre)
                  </button>
                )}
              </>
            )}
            {draft.isStale && cell?.assignmentKind !== "fixed" && <p className="anp-detail-note">Kaynak veriler değişti — düzenlemeden önce yeniden üretin.</p>}
          </section>

          {assignError && (
            <div className="alert alert-error" role="alert">
              <span>{assignError}</span>
            </div>
          )}

          {configErrorForBlock && (
            <div className="alert alert-warning" role="alert">
              <span>Bu blok için periyot konfigürasyonu eksik ({configErrorForBlock.teacherCount} öğretmen etkilendi) — adaylık tam hesaplanamıyor.</span>
            </div>
          )}

          {candidateStatus === "loading" && <p className="anp-detail-note">Aday öğretmen listesi yükleniyor…</p>}

          {candidateStatus === "error" && (
            <p className="anp-detail-note">
              Aday öğretmen listesi alınamadı. Kurallar tarayıcıda yeniden hesaplanmaz; listeyi görmek için paneli kapatıp yeniden açın.
            </p>
          )}

          {candidateStatus === "plan_not_found" && (
            <div className="alert alert-warning" role="alert">
              <span>Taslak artık bulunamadı. Sayfayı yenileyip güncel taslağı yükleyin.</span>
            </div>
          )}

          {candidateStatus === "task_not_found" && (
            <div className="alert alert-warning" role="alert">
              <span>Görev artık bu taslakta bulunmuyor. Sayfayı yenileyip güncel taslağı yükleyin.</span>
            </div>
          )}

          {candidateStatus === "version_mismatch" && (
            <div className="alert alert-warning" role="alert">
              <span>
                Taslak başka bir yerde değiştirildi — aday listesi bu ekrandaki sürümle uyuşmuyor. Aday listesi salt okunurdur; düzenlemeden önce
                güncel taslağı yükleyin.
              </span>
            </div>
          )}

          {candidateStatus === "stale" && (
            <div className="alert alert-warning" role="alert">
              <span>
                Kaynak veriler değiştiği için aday listesi güncelliğini kaybetti. Aday listesi salt okunurdur; manuel atama ve paket eylemleri için
                güncel taslağı yükleyin.
              </span>
            </div>
          )}

          {candidatesVisible && (
            <>
              <section className="anp-detail-section">
                <h3>Uygun öğretmenler ({eligibleTeachers.length})</h3>
                {eligibleTeachers.length === 0 && <p className="anp-detail-note">Bu hücre için hiç uygun öğretmen yok.</p>}
                <ul className="anp-detail-list anp-detail-list--plain">
                  {eligibleTeachers.map((t) => {
                    const isCurrent = t.isCurrent;
                    if (!canEdit || isCurrent) {
                      return (
                        <li key={t.teacherSourceId}>
                          {t.teacherName} {isCurrent && <span className="anp-code">(mevcut)</span>}
                        </li>
                      );
                    }
                    return (
                      <li key={t.teacherSourceId} className="anp-candidate-row">
                        <button
                          type="button"
                          className="anp-candidate-btn"
                          onClick={() => void (isV4Plan && selectedIsBreakPairCell
                            ? assignPackage(t.teacherSourceId, "SHORT_BREAKS")
                            : assignTeacher(t.teacherSourceId))}
                          disabled={assignBusyTeacherId !== null}
                        >
                          {assignBusyTeacherId === t.teacherSourceId ? <Loader2 size={12} className="spin" aria-hidden="true" /> : null}
                          {t.teacherName} — {isV4Plan && selectedIsBreakPairCell ? "Teneffüs (Sabah + Öğleden Sonra) için ata" : "bu blok için ata"}
                        </button>
                        {supportsShortBreaks && !(isV4Plan && selectedIsBreakPairCell) && (
                          <button
                            type="button"
                            className="anp-candidate-btn anp-candidate-btn--package"
                            onClick={() => void assignPackage(t.teacherSourceId, "SHORT_BREAKS")}
                            disabled={assignBusyTeacherId !== null}
                          >
                            Sabah + Öğleden Sonra ata
                          </button>
                        )}
                        {supportsFullDay && !isV4Plan && (
                          <button
                            type="button"
                            className="anp-candidate-btn anp-candidate-btn--package"
                            onClick={() => void assignPackage(t.teacherSourceId, "FULL_DAY")}
                            disabled={assignBusyTeacherId !== null}
                          >
                            Bu nöbet yerine tüm gün ata
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section className="anp-detail-section">
                <h3>Uygun olmayan öğretmenler ({ineligible.length})</h3>
                <ul className="anp-detail-list">
                  {ineligible.map((t) => {
                    const labels = t.reasons.map((r) => TASK_CANDIDATE_REASON_LABELS[r] ?? r).join(" · ");
                    return (
                      <li key={t.teacherSourceId}>
                        {t.teacherName} {t.isCurrent && <span className="anp-code">(mevcut atama)</span>}{" "}
                        <span className="anp-code" title={labels}>
                          {labels}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            </>
          )}
        </div>
      </div>
      {pendingPackageAction && (
        <AffectedTasksConfirmDialog
          action={pendingPackageAction}
          onCancel={() => setPendingPackageAction(null)}
          onConfirm={() =>
            void commitPackageAction(
              pendingPackageAction.teacherSourceId,
              pendingPackageAction.coverageMode,
              pendingPackageAction.affectedTasks.map((t) => t.id),
            )
          }
          busy={assignBusyTeacherId !== null}
        />
      )}
    </div>
  );
}

interface AffectedTasksConfirmDialogProps {
  action: PendingPackageAction;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}

/** Çok hücreli paket işleminden ÖNCE etkilenen (bölünecek/boşalacak) hücreleri açıkça listeler — sessiz yazma yok. */
function AffectedTasksConfirmDialog({ action, onCancel, onConfirm, busy }: AffectedTasksConfirmDialogProps) {
  return (
    <div className="anp-modal-overlay" role="presentation" onClick={onCancel}>
      <div className="anp-modal" role="alertdialog" aria-modal="true" aria-labelledby="anp-affected-tasks-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="anp-affected-tasks-title">
          {MANUAL_PACKAGE_COVERAGE_MODE_LABELS[action.coverageMode]} — {action.teacherSourceId ? "atama" : "kaldırma"} onayı
        </h3>
        <p>Bu işlem aşağıdaki hücreleri de etkileyecek (başka paketlerden çözülecek/boşalacak):</p>
        <ul className="anp-detail-list">
          {action.affectedTasks.map((t) => (
            <li key={t.id}>
              {t.dutyBlockName} {t.currentTeacherName ? `(şu an: ${t.currentTeacherName})` : "(boş)"}
            </li>
          ))}
        </ul>
        <div className="anp-modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Vazgeç
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : null}
            Onayla ve uygula
          </button>
        </div>
      </div>
    </div>
  );
}
