import { useEffect, useState } from "react";
import { AlertCircle, AlertTriangle, BookX, CheckCircle2, LockKeyhole, RotateCcw, TriangleAlert } from "lucide-react";
import { fetchDutyPlanFeasibility } from "../lib/dutyPlanFeasibility/api";
import { UNCOVERED_REASON_LABELS, type DutyPlanFeasibilityResponse, type FeasibilityDay } from "../lib/dutyPlanFeasibility/types";
import { BLOCK_SHORT_LABELS } from "../lib/dutyLocations/types";
import "./DutyPlanFeasibilityPage.css";

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

type Outcome = { status: "loading" } | { status: "error" } | { status: "ready"; data: DutyPlanFeasibilityResponse };

/**
 * "Planlanabilirlik Analizi" — SALT OKUNUR ekran.
 *
 * Bu sayfa BİR NÖBET PLANI ÜRETMEZ ve hiçbir atama yazmaz. Yalnızca mevcut
 * nöbet yerleri, blok gereksinimleri, sabit nöbetler ve öğretmen uygunlukları
 * ile bir planın üretilebilir olup olmadığını gösterir. Sayfada bilinçli
 * olarak hiçbir yazma eylemi (buton/form) yoktur.
 */
export default function DutyPlanFeasibilityPage({ embedded = false }: { embedded?: boolean }) {
  const [outcome, setOutcome] = useState<Outcome>({ status: "loading" });
  const [retryNonce, setRetryNonce] = useState(0);
  const [openDay, setOpenDay] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let ignore = false;
    fetchDutyPlanFeasibility(controller.signal)
      .then((data) => {
        if (!ignore) setOutcome({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (!ignore && !isAbortError(err)) setOutcome({ status: "error" });
      });
    return () => {
      ignore = true;
      controller.abort();
    };
  }, [retryNonce]);

  function reload() {
    setOutcome({ status: "loading" });
    setRetryNonce((n) => n + 1);
  }

  return (
    <section className={embedded ? "dpf-page dpf-page--embedded" : "dpf-page"}>
      {embedded ? (
        <div className="dpf-embedded-toolbar">
          <div>
            <h2>Kapasite kontrolü</h2>
            <p>Plan üretmeden önce görevlerin mevcut kurallarla karşılanıp karşılanamadığını görün.</p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={reload} disabled={outcome.status === "loading"}>
            <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
            Analizi Yenile
          </button>
        </div>
      ) : (
        <header className="dpf-header">
          <div>
            <h1>Planlanabilirlik Analizi</h1>
            <p>
              Mevcut nöbet yerleri, blok gereksinimleri, sabit nöbetler ve öğretmen uygunluklarıyla bir nöbet planı üretilebilir mi?
              Bu ekran <strong>plan üretmez</strong> ve hiçbir atama kaydetmez.
            </p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={reload} disabled={outcome.status === "loading"}>
            <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
            Yeniden Analiz Et
          </button>
        </header>
      )}

      {outcome.status === "loading" && (
        <div className="dpf-card" aria-busy="true">
          <span className="visually-hidden">Analiz hesaplanıyor…</span>
          <div className="dpf-skeleton" />
          <div className="dpf-skeleton" />
          <div className="dpf-skeleton" />
        </div>
      )}

      {outcome.status === "error" && (
        <div className="dpf-card dpf-error" role="alert">
          <AlertCircle size={20} strokeWidth={2} aria-hidden="true" />
          <div>
            <p className="dpf-error-title">Planlanabilirlik analizi alınamadı.</p>
            <p className="dpf-error-desc">Yerel API bağlantısını kontrol edip tekrar deneyin.</p>
            <button type="button" className="btn btn-secondary" onClick={reload}>
              <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
              Tekrar Dene
            </button>
          </div>
        </div>
      )}

      {outcome.status === "ready" && !outcome.data.hasImport && (
        <div className="dpf-card">Planlanabilirlik analizi için önce bir XML ders programı yükleyin.</div>
      )}

      {outcome.status === "ready" && outcome.data.hasImport && (
        <>
          <div className={outcome.data.weeklyCapacity.feasible ? "dpf-verdict dpf-verdict--ok" : "dpf-verdict dpf-verdict--warn"}>
            {outcome.data.weeklyCapacity.feasible ? (
              <CheckCircle2 size={22} strokeWidth={2} aria-hidden="true" />
            ) : (
              <TriangleAlert size={22} strokeWidth={2} aria-hidden="true" />
            )}
            <div>
              <p className="dpf-verdict-title">
                {outcome.data.weeklyCapacity.feasible
                  ? "Haftalık kurallarla tüm görevler karşılanabiliyor."
                  : `Haftalık kurallar altında ${outcome.data.weeklyCapacity.totalUncoveredCount} görev açık kalıyor.`}
              </p>
              <p className="dpf-verdict-desc">
                En fazla {outcome.data.weeklyCapacity.totalMaxCoverableCount}/{outcome.data.weeklyCapacity.totalTaskCount} görev ·
                Haftalık üst sınır {outcome.data.weeklyCapacity.optionsUsed.maxWeeklyDuties} · {outcome.data.weeklyCapacity.teacherCount} öğretmen
              </p>
            </div>
          </div>

          <div className="dpf-capacity-comparison" aria-label="Günlük ve haftalık kapasite karşılaştırması">
            <section className="dpf-capacity-card">
              <span className="dpf-capacity-label">Günler ayrı ayrı incelendiğinde</span>
              <strong>
                {outcome.data.summary.totalCoveredTasks}/{outcome.data.summary.totalRequiredTasks}
              </strong>
              <span>Haftalık yük sınırı uygulanmadan</span>
            </section>
            <section className={outcome.data.weeklyCapacity.feasible ? "dpf-capacity-card dpf-capacity-card--ok" : "dpf-capacity-card dpf-capacity-card--warn"}>
              <span className="dpf-capacity-label">Haftalık plan kapasitesi</span>
              <strong>
                {outcome.data.weeklyCapacity.totalMaxCoverableCount}/{outcome.data.weeklyCapacity.totalTaskCount}
              </strong>
              <span>
                {outcome.data.weeklyCapacity.optionsSource === "current_draft" ? "Mevcut taslak ayarlarıyla" : "Varsayılan üretim ayarlarıyla"}
              </span>
            </section>
            <section className="dpf-capacity-card">
              <span className="dpf-capacity-label">Haftalık yük birimi</span>
              <strong>
                {outcome.data.weeklyCapacity.loadUnits.aggregateTeacherCapacity}/
                {outcome.data.weeklyCapacity.loadUnits.totalRequiredLoadUnits}
              </strong>
              <span>Toplam öğretmen kapasitesi / gereken yük</span>
            </section>
          </div>

          {!embedded && <p className="dpf-scope" role="note">
            <strong>Sonuç nasıl okunmalı?</strong> Ana karar, otomatik planla aynı aday evrenini, yarım gün kurallarını ve haftalık
            üst sınırı kullanan salt-okunur solver önizlemesidir. Aşağıdaki gün × blok tablosu yalnız günleri birbirinden bağımsız
            gösteren tanı aracıdır; tablodaki tam kapsama, haftalık planın tam olduğu anlamına gelmez. Kullanılan ayarlar: en az{" "}
            {outcome.data.weeklyCapacity.optionsUsed.minWeeklyDuties}, hedef {outcome.data.weeklyCapacity.optionsUsed.targetWeeklyDuties}, en fazla{" "}
            {outcome.data.weeklyCapacity.optionsUsed.maxWeeklyDuties} görev.
          </p>}

          {!embedded && <p className="dpf-method" role="note">
            <strong>Yöntem:</strong> Her nöbet yeri, görev istediği her blokta tam olarak 1 öğretmen ister. Bir bloğun yalnız
            sabit atamayla mı yoksa normal tercihle mi karşılandığı <strong>yer × blok</strong> düzeyinde tanımlıdır; yalnız sabit
            atamayla karşılanan bloklar normal aday üretmez. Analiz blok sayılarını tek tek karşılaştırmakla yetinmez, her gün için
            gerçek bir maksimum eşleştirme hesaplar. Bu eşleştirmede yarım gün kuralı <strong>açık</strong> öğretmen günde yalnız
            bir normal blok alabilir; kuralı <strong>kapalı</strong> öğretmen aynı gün farklı bloklarda görev alabilir, ancak aynı
            blokta iki nöbet yerine atanamaz. O gün sabit nöbeti olan öğretmen, kural açık ya da kapalı olsun, hiçbir normal görev
            almaz.
          </p>}

          {embedded ? (
            <details className="dpf-disclosure">
              <summary>Gün ve blok ayrıntılarını göster</summary>
              <AnalysisDetails days={outcome.data.days} openDay={openDay} setOpenDay={setOpenDay} />
            </details>
          ) : (
            <AnalysisDetails days={outcome.data.days} openDay={openDay} setOpenDay={setOpenDay} />
          )}
        </>
      )}
    </section>
  );
}

function AnalysisDetails({
  days,
  openDay,
  setOpenDay,
}: {
  days: FeasibilityDay[];
  openDay: number | null;
  setOpenDay: (value: number | null) => void;
}) {
  return (
    <div className="dpf-analysis-details">
      <DayGrid days={days} />
      <div className="dpf-details">
        <h2>Gün Ayrıntıları</h2>
        {days.map((day) => (
          <DayDetail key={day.order} day={day} open={openDay === day.order} onToggle={() => setOpenDay(openDay === day.order ? null : day.order)} />
        ))}
      </div>
    </div>
  );
}

/**
 * Gün × blok ızgarası. Her hücrede "karşılanan / gereken" ve varsa açık
 * sayısı gösterilir.
 */
function DayGrid({ days }: { days: FeasibilityDay[] }) {
  const blocks = days[0]?.blocks ?? [];
  if (blocks.length === 0) return null;

  return (
    <div className="dpf-card">
      <h2 className="dpf-card-title">Gün × Blok Özeti — Günlük Bağımsız Analiz</h2>
      <div className="dpf-grid-scroll">
        <table className="dpf-grid">
          <thead>
            <tr>
              <th scope="col">Gün</th>
              {blocks.map((b) => (
                <th scope="col" key={b.blockId} title={b.blockName}>
                  {BLOCK_SHORT_LABELS[b.blockCode]}
                </th>
              ))}
              <th scope="col">Gün Toplamı</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.order}>
                <th scope="row">{day.name}</th>
                {day.blocks.map((b) => {
                  const uncovered = b.matchingUncovered + b.fixedMissing;
                  const covered = b.required - uncovered;
                  return (
                    <td key={b.blockId} className={uncovered > 0 ? "dpf-cell dpf-cell--short" : "dpf-cell"}>
                      <span className="dpf-cell-main">
                        {covered}/{b.required}
                      </span>
                      <span className="dpf-cell-sub">{b.candidateTeacherCount} aday</span>
                      {uncovered > 0 && <span className="dpf-cell-badge">−{uncovered}</span>}
                      {/* Naif blok sayımının "sorun yok" dediği ama gerçek
                          eşleştirmenin açık bulduğu durum: kullanıcıya
                          neden farkının nereden geldiğini gösterir. */}
                      {b.independentShortfall === 0 && b.matchingUncovered > 0 && (
                        <span className="dpf-cell-note" title="Blok tek başına bakıldığında yeterli aday var; ancak aynı öğretmenler aynı gün başka bloklara da gerekiyor.">
                          eşleştirme darboğazı
                        </span>
                      )}
                    </td>
                  );
                })}
                <td className={day.totals.uncoveredTasks > 0 ? "dpf-cell dpf-cell--short" : "dpf-cell"}>
                  <span className="dpf-cell-main">
                    {day.totals.coveredTasks}/{day.totals.requiredTasks}
                  </span>
                  <span className="dpf-cell-sub">{day.totals.candidateTeacherCount} aday öğretmen</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DayDetail({ day, open, onToggle }: { day: FeasibilityDay; open: boolean; onToggle: () => void }) {
  const hasProblem = day.totals.uncoveredTasks > 0;
  return (
    <div className={hasProblem ? "dpf-day dpf-day--problem" : "dpf-day"}>
      <button type="button" className="dpf-day-head" onClick={onToggle} aria-expanded={open}>
        <span className="dpf-day-name">{day.name}</span>
        {hasProblem ? (
          <span className="dpf-day-status dpf-day-status--warn">
            <AlertTriangle size={14} strokeWidth={2} aria-hidden="true" />
            {day.totals.uncoveredTasks} görev açıkta
          </span>
        ) : (
          <span className="dpf-day-status dpf-day-status--ok">
            <CheckCircle2 size={14} strokeWidth={2} aria-hidden="true" />
            Tüm görevler karşılanıyor
          </span>
        )}
        <span className="dpf-day-toggle">{open ? "Gizle" : "Ayrıntı"}</span>
      </button>

      {open && (
        <div className="dpf-day-body">
          <dl className="dpf-stats">
            <div>
              <dt>Toplam görev</dt>
              <dd>{day.totals.requiredTasks}</dd>
            </div>
            <div>
              <dt>Sabit görev</dt>
              <dd>
                {day.totals.fixedCovered}/{day.totals.fixedRequired}
              </dd>
            </div>
            <div>
              <dt>Normal görev</dt>
              <dd>
                {day.totals.normalMatched}/{day.totals.normalRequired}
              </dd>
            </div>
            <div>
              <dt>Aday öğretmen</dt>
              <dd>{day.totals.candidateTeacherCount}</dd>
            </div>
          </dl>

          {day.missingFixedAssignments.length > 0 && (
            <section className="dpf-section">
              <h3>
                <LockKeyhole size={14} strokeWidth={2} aria-hidden="true" />
                Eksik sabit atamalar
              </h3>
              <ul className="dpf-list">
                {day.missingFixedAssignments.map((m) => (
                  <li key={m.dutyLocationId}>
                    <strong>{m.dutyLocationName}</strong> <span className="dpf-code">{m.shortCode}</span> — bu gün sabit öğretmeni
                    atanmamış ({m.blockCodes.map((c) => BLOCK_SHORT_LABELS[c]).join(", ")}).
                  </li>
                ))}
              </ul>
            </section>
          )}

          {day.fixedAssignments.length > 0 && (
            <section className="dpf-section">
              <h3>
                <LockKeyhole size={14} strokeWidth={2} aria-hidden="true" />
                Sabit nöbetçiler
              </h3>
              <ul className="dpf-list">
                {day.fixedAssignments.map((f) => (
                  <li key={`${f.teacherSourceId}-${f.dutyLocationId}`}>
                    <strong>{f.teacherName}</strong> — {f.dutyLocationName} <span className="dpf-code">{f.shortCode}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {day.excludedByLessonConflict.some((c) => c.teacherCount > 0) && (
            <section className="dpf-section">
              <h3>
                <BookX size={14} strokeWidth={2} aria-hidden="true" />
                Ders çakışması nedeniyle elenenler
              </h3>
              <ul className="dpf-list">
                {day.excludedByLessonConflict
                  .filter((c) => c.teacherCount > 0)
                  .map((c) => (
                    <li key={c.blockId}>
                      <strong>{c.blockName}</strong> — {c.teacherCount} öğretmen bu blokta uygunluk beyan etmiş ancak{" "}
                      <span className="dpf-code">{c.periodName}</span> dersi olduğu için aday olamıyor.
                    </li>
                  ))}
              </ul>
            </section>
          )}

          {/*
            Konfigürasyon hatası DERS ÇAKIŞMASI DEĞİLDİR: hedef/komşu periyot
            tanımı güncel importta bulunamadığı için öğretmen güvenlik gereği
            aday sayılmaz. RPC bunu ayrı alanda döndürür; ekran da AYRI bir
            bölümde ve farklı gerekçeyle gösterir.
          */}
          {day.excludedByConfigurationError.some((c) => c.teacherCount > 0) && (
            <section className="dpf-section">
              <h3>
                <AlertCircle size={14} strokeWidth={2} aria-hidden="true" />
                Periyot tanımı eksik olduğu için elenenler
              </h3>
              <ul className="dpf-list">
                {day.excludedByConfigurationError
                  .filter((c) => c.teacherCount > 0)
                  .map((c) => (
                    <li key={c.blockId}>
                      <strong>{c.blockName}</strong> — {c.teacherCount} öğretmen bu blokta uygunluk beyan etmiş ancak{" "}
                      <span className="dpf-code">{c.periodName}</span> periyodunun tanımı güncel ders programında bulunamadığı
                      için aday sayılamıyor. Bu bir ders çakışması değildir; ders programı içe aktarımı gözden geçirilmelidir.
                    </li>
                  ))}
              </ul>
            </section>
          )}

          {day.uncoveredTasks.length > 0 && (
            <section className="dpf-section">
              <h3>
                <AlertTriangle size={14} strokeWidth={2} aria-hidden="true" />
                Karşılanamayan nöbet yerleri
              </h3>
              <div className="dpf-table-scroll">
                <table className="dpf-table">
                  <thead>
                    <tr>
                      <th scope="col">Nöbet Yeri</th>
                      <th scope="col">Blok</th>
                      <th scope="col">Aday</th>
                      <th scope="col">Gerekçe</th>
                    </tr>
                  </thead>
                  <tbody>
                    {day.uncoveredTasks.map((t) => (
                      <tr key={`${t.dutyLocationId}-${t.blockId}`}>
                        <td>
                          {t.dutyLocationName} <span className="dpf-code">{t.shortCode}</span>
                        </td>
                        <td>{BLOCK_SHORT_LABELS[t.blockCode]}</td>
                        <td>{t.candidateCount === null ? "—" : t.candidateCount}</td>
                        <td>{UNCOVERED_REASON_LABELS[t.reason]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
