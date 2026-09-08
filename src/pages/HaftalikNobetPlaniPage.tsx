import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Archive, Award, CalendarDays, FileSpreadsheet, LockKeyhole, PencilLine, Printer, RotateCcw, Trash2, Wand2 } from "lucide-react";
import {
  archivePublishedDutyPlan,
  createDutyPlanRevision,
  deleteDutyPlanDraft,
  DutyPlanHistoryMutationApiError,
  fetchDutyPlanHistory,
  fetchDutyPlanHistoryDetail,
  fetchPublishedDutyPlan,
} from "../lib/dutyPlanDrafts/api";
import {
  PACKAGE_COVERAGE_MODE_LABELS,
  WEEKDAY_NAMES,
  type PublishedDutyPlanAssignmentDto,
  type PublishedDutyPlanDto,
  type PublishedDutyPlanPackageDto,
  type DutyPlanHistoryDetailDto,
  type DutyPlanHistoryListItem,
} from "../lib/dutyPlanDrafts/types";
import { ROUTES, navigate } from "../lib/router";
import { BLOCK_SHORT_LABELS, type DutyBlockCode } from "../lib/dutyLocations/types";
import "./HaftalikNobetPlaniPage.css";

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

type FoundPlan = Extract<DutyPlanHistoryDetailDto, { found: true }> | Extract<PublishedDutyPlanDto, { found: true }>;

type Phase = { status: "loading" } | { status: "error" } | { status: "empty" } | { status: "ready"; plan: FoundPlan };

/**
 * "Haftalık Nöbet Plani" — YAYIMLANMIŞ (published) nöbet planının salt
 * okunur, yazdırılabilir görünümü. Taslak üretimi/düzenlemesi burada
 * YOKTUR — bkz. OtomatikNobetPlaniPage. Tarihsel snapshot isimlerini
 * (duty_location_name_snapshot vb.) kullanır; daha sonraki bir XML importu
 * bu ekranı ETKİLEMEZ (bkz. get_published_duty_plan RPC).
 */
export default function HaftalikNobetPlaniPage({
  embedded = false,
  onOpenDraft,
}: {
  embedded?: boolean;
  onOpenDraft?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ status: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [history, setHistory] = useState<DutyPlanHistoryListItem[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Çift tıklamada iki eşzamanlı export başlamasın — state güncellemesi asenkron olduğu için senkron kilit. */
  const exportingRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let ignore = false;

    async function load() {
      try {
        const historyResult = await fetchDutyPlanHistory(controller.signal).catch(() => null);
        if (historyResult?.plans.length) {
          const first = historyResult.plans[0];
          const detail = await fetchDutyPlanHistoryDetail(first.id, controller.signal);
          if (ignore) return;
          setHistory(historyResult.plans);
          setSelectedPlanId(first.id);
          if (detail.found) {
            setPhase({ status: "ready", plan: detail });
            return;
          }
        } else if (historyResult) {
          setHistory([]);
        } else {
          setHistoryUnavailable(true);
        }

        const plan = await fetchPublishedDutyPlan(controller.signal);
        if (ignore) return;
        if (!plan.found) {
          setPhase({ status: "empty" });
          return;
        }
        setPhase({ status: "ready", plan });
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

  const plan = phase.status === "ready" ? phase.plan : null;
  const revisionIsStale = Boolean(plan && "isStale" in plan && plan.isStale);

  async function selectHistoryPlan(item: DutyPlanHistoryListItem) {
    if (item.id === selectedPlanId || actionBusy) return;
    const controller = new AbortController();
    setSelectedPlanId(item.id);
    setActionError(null);
    setPhase({ status: "loading" });
    try {
      const detail = await fetchDutyPlanHistoryDetail(item.id, controller.signal);
      setPhase(detail.found ? { status: "ready", plan: detail } : { status: "error" });
    } catch {
      setPhase({ status: "error" });
    }
  }

  function openDraft() {
    if (onOpenDraft) onOpenDraft();
    else navigate(ROUTES.otomatikNobetPlani);
  }

  async function reviseSelectedPlan() {
    if (!plan || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await createDutyPlanRevision(plan.id, { expectedPlanVersion: plan.version });
      openDraft();
    } catch (err) {
      setActionError(err instanceof DutyPlanHistoryMutationApiError ? err.body.message : "Düzenlenebilir plan kopyası oluşturulamadı.");
    } finally {
      setActionBusy(false);
    }
  }

  async function archiveSelectedPlan() {
    if (!plan || plan.status !== "published" || actionBusy) return;
    if (!window.confirm("Bu yayımlanmış plan arşive alınsın mı? Plan ve puan kayıtları silinmeyecek.")) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await archivePublishedDutyPlan(plan.id, { expectedPlanVersion: plan.version });
      reload();
    } catch (err) {
      setActionError(err instanceof DutyPlanHistoryMutationApiError ? err.body.message : "Plan arşivlenemedi.");
    } finally {
      setActionBusy(false);
    }
  }

  async function deleteSelectedDraft() {
    if (!plan || plan.status !== "draft" || actionBusy) return;
    if (!window.confirm("Bu taslak kalıcı olarak silinsin mi?")) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await deleteDutyPlanDraft(plan.id);
      reload();
    } catch {
      setActionError("Taslak silinemedi.");
    } finally {
      setActionBusy(false);
    }
  }

  /**
   * XLSX üretimi YALNIZ eldeki plan nesnesiyle yapılır — API'ye ikinci istek
   * atılmaz. ExcelJS sayfanın ilk bundle'ına girmesin diye dinamik import
   * edilir. Hata olursa plan görünümü ekranda KALIR, yalnız uyarı gösterilir.
   */
  const handleExportXlsx = useCallback(async () => {
    if (!plan || exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    setExportError(null);
    try {
      const { downloadPublishedDutyPlanXlsx } = await import("../lib/dutyPlanExport/downloadPublishedDutyPlanXlsx");
      await downloadPublishedDutyPlanXlsx(plan);
    } catch {
      // Teknik ayrıntı/stack KULLANICIYA GÖSTERİLMEZ.
      setExportError("Excel dosyası hazırlanamadı. Lütfen tekrar deneyin.");
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  }, [plan]);

  return (
    <section className={embedded ? "hnp-page hnp-page--embedded" : "hnp-page"}>
      <header className={embedded ? "hnp-header hnp-header--embedded" : "hnp-header"}>
        <div>
          {embedded ? <h2>Plan geçmişi</h2> : <h1>Haftalık Nöbet Planları</h1>}
          <p>Haftaları karşılaştırın, öğretmen puanlarını izleyin ve plan kayıtlarını güvenle yönetin.</p>
          {plan?.weekStartDate && <p><strong>{new Date(`${plan.weekStartDate}T00:00:00`).toLocaleDateString("tr-TR")}</strong> haftası · {(plan.activeDayOrders ?? [1, 2, 3, 4, 5]).length} planlanan gün</p>}
        </div>
        {phase.status === "ready" && (
          <div className="hnp-header-actions">
            <button type="button" className="btn btn-secondary hnp-print-btn" onClick={() => window.print()}>
              <Printer size={16} strokeWidth={2} aria-hidden="true" />
              Yazdır
            </button>
            <button type="button" className="btn btn-secondary hnp-export-btn" onClick={() => void handleExportXlsx()} disabled={exporting}>
              <FileSpreadsheet size={16} strokeWidth={2} aria-hidden="true" />
              {exporting ? "Excel hazırlanıyor…" : "XLSX İndir"}
            </button>
            {plan?.status === "draft" ? (
              <button type="button" className="btn btn-primary" onClick={openDraft}> <PencilLine size={15} aria-hidden="true" /> Taslağı Düzenle</button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={() => void reviseSelectedPlan()} disabled={actionBusy || revisionIsStale} title={revisionIsStale ? "Kaynaklar değişti; bu kayıttan revizyon oluşturulamaz." : undefined}>
                <PencilLine size={15} aria-hidden="true" /> Düzenlenebilir Kopya
              </button>
            )}
            {plan?.status === "published" && <button type="button" className="btn btn-secondary hnp-danger-action" onClick={() => void archiveSelectedPlan()} disabled={actionBusy}><Archive size={15} aria-hidden="true" /> Arşivle</button>}
            {plan?.status === "draft" && <button type="button" className="btn btn-secondary hnp-danger-action" onClick={() => void deleteSelectedDraft()} disabled={actionBusy}><Trash2 size={15} aria-hidden="true" /> Taslağı Sil</button>}
          </div>
        )}
      </header>

      {phase.status === "ready" && exportError && (
        <div className="hnp-card hnp-export-error" role="alert">
          <AlertCircle size={16} strokeWidth={2} aria-hidden="true" />
          <span>{exportError}</span>
        </div>
      )}

      {historyUnavailable && <div className="hnp-card hnp-history-note" role="status">Plan geçmişi servisi henüz kullanılamıyor; en son yayımlanmış plan gösteriliyor.</div>}
      {actionError && <div className="hnp-card hnp-export-error" role="alert"><AlertCircle size={16} aria-hidden="true" />{actionError}</div>}

      {history.length > 0 && (
        <div className="hnp-history" aria-label="Nöbet planı geçmişi">
          <div className="hnp-history-heading">
            <div><CalendarDays size={17} aria-hidden="true" /><strong>Haftalar</strong></div>
            <span>{history.length} plan kaydı</span>
          </div>
          <div className="hnp-history-rail">
            {history.map((item) => (
              <button key={item.id} type="button" className={item.id === selectedPlanId ? "hnp-history-card hnp-history-card--selected" : "hnp-history-card"} onClick={() => void selectHistoryPlan(item)} aria-pressed={item.id === selectedPlanId}>
                <span className={`hnp-status hnp-status--${item.status}`}>{item.status === "published" ? "Yayımlanmış" : item.status === "draft" ? "Taslak" : "Arşiv"}</span>
                <strong>{new Date(`${item.weekStartDate}T00:00:00`).toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" })}</strong>
                <small>{item.activeDayOrders.length} gün · {item.packageCount} puan · {item.assignedTeacherCount} öğretmen</small>
                <span className="hnp-history-score"><Award size={13} aria-hidden="true" /> Önce {item.priorPointTotal} + hafta {item.status === "draft" ? item.projectedWeekPointTotal : item.weekPointTotal} = <b>{item.cumulativePointTotal}</b></span>
              </button>
            ))}
          </div>
        </div>
      )}

      {phase.status === "loading" && (
        <div className="hnp-card" aria-busy="true">
          <span className="visually-hidden">Yükleniyor…</span>
          <div className="hnp-skeleton" />
          <div className="hnp-skeleton" />
          <div className="hnp-skeleton" />
        </div>
      )}

      {phase.status === "error" && (
        <div className="hnp-card hnp-error" role="alert">
          <AlertCircle size={20} strokeWidth={2} aria-hidden="true" />
          <div>
            <p className="hnp-error-title">Veriler alınamadı.</p>
            <p className="hnp-error-desc">Yerel API bağlantısını kontrol edip tekrar deneyin.</p>
            <button type="button" className="btn btn-secondary" onClick={reload}>
              <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
              Tekrar Dene
            </button>
          </div>
        </div>
      )}

      {phase.status === "empty" && (
        <div className="hnp-card hnp-empty">
          <p>Henüz yayımlanmış bir nöbet planı yok.</p>
          <p className="hnp-empty-desc">Önce otomatik nöbet taslağını tamamlayıp yayımlayın.</p>
          <button type="button" className="btn btn-primary" onClick={() => (onOpenDraft ? onOpenDraft() : navigate(ROUTES.otomatikNobetPlani))}>
            <Wand2 size={14} strokeWidth={2} aria-hidden="true" />
            Otomatik Nöbet Planına Git
          </button>
        </div>
      )}

      {phase.status === "ready" && <PublishedPlanView plan={phase.plan} compact={embedded} />}
    </section>
  );
}

function PublishedPlanView({ plan, compact = false }: { plan: FoundPlan; compact?: boolean }) {
  const days = useMemo(() => {
    const seen = new Map<number, string>();
    for (const a of plan.assignments) if (!seen.has(a.dayOrder)) seen.set(a.dayOrder, WEEKDAY_NAMES[a.dayOrder] ?? String(a.dayOrder));
    return Array.from(seen.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([order, name]) => ({ order, name }));
  }, [plan.assignments]);

  interface ColumnDef {
    dutyBlockId: string;
    name: string;
  }
  const columns: ColumnDef[] = useMemo(() => {
    const seen = new Map<string, ColumnDef>();
    for (const a of plan.assignments) {
      if (!seen.has(a.dutyBlockId)) seen.set(a.dutyBlockId, { dutyBlockId: a.dutyBlockId, name: a.dutyBlockName });
    }
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name, "tr"));
  }, [plan.assignments]);

  const teacherNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of plan.assignments) {
      if (a.teacherSourceId && a.teacherName) map.set(a.teacherSourceId, a.teacherName);
    }
    return map;
  }, [plan.assignments]);

  const teacherLoads = (plan.summary.teacherLoads as { teacherSourceId: string; normalDutyCount: number; fixedDutyDayCount: number; totalDutyCount: number }[]) ?? [];

  /** Öğretmen×gün başına paket(ler) — FULL_DAY paketi 4 ayrı hücre yerine TEK satır olarak gösterilsin diye. */
  const packagesByTeacherDay = useMemo(() => {
    const map = new Map<string, PublishedDutyPlanPackageDto[]>();
    for (const p of plan.packages) {
      const key = `${p.teacherSourceId}|${p.dayOrder}`;
      const list = map.get(key) ?? [];
      list.push(p);
      map.set(key, list);
    }
    return map;
  }, [plan.packages]);

  const fixedCount = plan.assignments.filter((a) => a.assignmentKind === "fixed").length;
  const normalCount = plan.assignments.filter((a) => a.assignmentKind === "generated" || a.assignmentKind === "manual").length;
  const manualCount = plan.assignments.filter((a) => a.assignmentKind === "manual").length;

  return (
    <>
      <div className="hnp-card print-only">
        <h2>Haftalık Nöbet Planı</h2>
        <p>Yayımlanma: {new Date(plan.updatedAt).toLocaleString("tr-TR")}</p>
      </div>

      <div className="hnp-card hnp-meta-card">
        <span className={`hnp-badge hnp-status--${plan.status}`}>{plan.status === "published" ? "Yayımlandı" : plan.status === "draft" ? "Taslak" : "Arşivlendi"}: {new Date(plan.updatedAt).toLocaleString("tr-TR")}</span>
        <span className="hnp-meta-text">Sabit görev: {fixedCount} · Normal görev: {normalCount} (bunlardan {manualCount} manuel)</span>
      </div>

      {"teacherPoints" in plan && (
        <div className="hnp-card hnp-avoid-break hnp-points-card">
          <div className="hnp-points-heading"><div><Award size={17} aria-hidden="true" /><h2 className="hnp-card-title">Öğretmen Nöbet Puanları</h2></div><p>Bu plan üretilirken taşınan puan ile haftanın katkısı ayrı gösterilir.</p></div>
          <div className="hnp-table-scroll">
            <table className="hnp-table">
              <thead><tr><th scope="col">Öğretmen</th><th scope="col">Önceki toplam</th><th scope="col">Bu hafta</th><th scope="col">Plan sonrası toplam</th></tr></thead>
              <tbody>
                {plan.teacherPoints.map((row) => <tr key={row.teacherSourceId}><td>{row.teacherName}</td><td>{row.priorPoints}</td><td>{row.weekPoints}{row.isProjected && <small className="hnp-projected"> tahmini</small>}</td><td><strong>{row.totalPoints}</strong></td></tr>)}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 1) Gün×yer×blok haftalık plan */}
      {days.map((day) => (
        <DayTable key={day.order} day={day} columns={columns} assignments={plan.assignments.filter((a) => a.dayOrder === day.order)} />
      ))}

      {/* 2) Öğretmen bazlı haftalık görev listesi */}
      <div className={compact ? "hnp-card hnp-avoid-break hnp-supporting-detail" : "hnp-card hnp-avoid-break"}>
        <h2 className="hnp-card-title">Öğretmen Bazlı Haftalık Görevler</h2>
        <div className="hnp-table-scroll">
          <table className="hnp-table">
            <thead>
              <tr>
                <th scope="col">Öğretmen</th>
                {days.map((d) => (
                  <th scope="col" key={d.order}>
                    {d.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from(teacherNameById.entries())
                .sort((a, b) => a[1].localeCompare(b[1], "tr"))
                .map(([teacherSourceId, teacherName]) => (
                  <tr key={teacherSourceId}>
                    <th scope="row">{teacherName}</th>
                    {days.map((d) => {
                      const packages = packagesByTeacherDay.get(`${teacherSourceId}|${d.order}`) ?? [];
                      if (packages.length === 0) {
                        return (
                          <td key={d.order} className="hnp-cell--none">
                            —
                          </td>
                        );
                      }
                      return (
                        <td key={d.order}>
                          {packages.map((p) => (
                            <div key={p.id} className={p.assignmentKind === "fixed" ? "hnp-tag hnp-tag--fixed" : "hnp-tag"}>
                              {p.assignmentKind === "fixed" && <LockKeyhole size={10} strokeWidth={2} aria-hidden="true" />}
                              {p.coverageMode === "FULL_DAY" || p.coverageMode === "SHORT_BREAKS"
                                ? `${PACKAGE_COVERAGE_MODE_LABELS[p.coverageMode]} — ${p.dutyLocationName}`
                                : `${p.dutyLocationName} · ${BLOCK_SHORT_LABELS[p.coveredBlockCodes[0] as DutyBlockCode] ?? p.coveredBlockCodes[0]}`}
                            </div>
                          ))}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              {teacherNameById.size === 0 && (
                <tr>
                  <td colSpan={days.length + 1}>Öğretmen verisi yok.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 4) Haftalık yük özeti */}
      <div className={compact ? "hnp-card hnp-avoid-break hnp-supporting-detail" : "hnp-card hnp-avoid-break"}>
        <h2 className="hnp-card-title">Haftalık Yük Özeti</h2>
        <div className="hnp-table-scroll">
          <table className="hnp-table">
            <thead>
              <tr>
                <th scope="col">Öğretmen</th>
                <th scope="col">Normal</th>
                <th scope="col">Sabit gün</th>
                <th scope="col">Toplam</th>
              </tr>
            </thead>
            <tbody>
              {teacherLoads
                .slice()
                .sort((a, b) => (teacherNameById.get(a.teacherSourceId) ?? a.teacherSourceId).localeCompare(teacherNameById.get(b.teacherSourceId) ?? b.teacherSourceId, "tr"))
                .map((load) => (
                  <tr key={load.teacherSourceId}>
                    <td>{teacherNameById.get(load.teacherSourceId) ?? load.teacherSourceId}</td>
                    <td>{load.normalDutyCount}</td>
                    <td>{load.fixedDutyDayCount}</td>
                    <td>{load.totalDutyCount}</td>
                  </tr>
                ))}
              {teacherLoads.length === 0 && (
                <tr>
                  <td colSpan={4}>Yük verisi yok.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 5) Açıklamalı legend */}
      <div className={compact ? "hnp-card hnp-avoid-break hnp-legend hnp-supporting-detail" : "hnp-card hnp-avoid-break hnp-legend"}>
        <h2 className="hnp-card-title">Açıklamalar</h2>
        <ul className="hnp-legend-list">
          <li>
            <span className="hnp-tag hnp-tag--fixed">
              <LockKeyhole size={10} strokeWidth={2} aria-hidden="true" /> Örnek
            </span>{" "}
            — Sabit nöbet (değiştirilemez, önceden atanmış).
          </li>
          <li>
            <span className="hnp-tag">Örnek</span> — Normal nöbet (otomatik üretilmiş uygun tercih veya manuel atama).
          </li>
        </ul>
      </div>
    </>
  );
}

function DayTable({
  day,
  columns,
  assignments,
}: {
  day: { order: number; name: string };
  columns: { dutyBlockId: string; name: string }[];
  assignments: PublishedDutyPlanAssignmentDto[];
}) {
  const locations = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of assignments) map.set(a.dutyLocationId, a.dutyLocationName);
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "tr"));
  }, [assignments]);

  function cellFor(locationId: string, blockId: string): PublishedDutyPlanAssignmentDto | undefined {
    return assignments.find((a) => a.dutyLocationId === locationId && a.dutyBlockId === blockId);
  }

  return (
    <div className="hnp-card hnp-avoid-break">
      <h2 className="hnp-card-title">{day.name}</h2>
      <div className="hnp-table-scroll">
        <table className="hnp-table">
          <thead>
            <tr>
              <th scope="col">Nöbet Yeri</th>
              {columns.map((c) => (
                <th scope="col" key={c.dutyBlockId}>
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {locations.map((loc) => (
              <tr key={loc.id}>
                <th scope="row">{loc.name}</th>
                {columns.map((c) => {
                  const cell = cellFor(loc.id, c.dutyBlockId);
                  if (!cell) {
                    return (
                      <td key={c.dutyBlockId} className="hnp-cell--none">
                        —
                      </td>
                    );
                  }
                  return (
                    <td key={c.dutyBlockId}>
                      <div className={cell.assignmentKind === "fixed" ? "hnp-tag hnp-tag--fixed" : "hnp-tag"}>
                        {cell.assignmentKind === "fixed" && <LockKeyhole size={10} strokeWidth={2} aria-hidden="true" />}
                        {cell.teacherName ?? "—"}
                        {cell.assignmentKind === "manual" && <span className="hnp-tag-note">manuel</span>}
                      </div>
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
  );
}
