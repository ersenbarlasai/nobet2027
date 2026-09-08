import { useEffect, useState } from "react";
import { CheckCircle2, FileQuestion, AlertCircle, RotateCcw } from "lucide-react";
import { fetchCurrentImport } from "../lib/currentImport/fetchCurrentImport";
import { formatImportedAt } from "../lib/currentImport/formatImportedAt";
import type { CurrentImportSnapshot } from "../lib/currentImport/types";
import "./CurrentImportStatus.css";

type Outcome =
  | { forToken: string; status: "loaded"; snapshot: CurrentImportSnapshot }
  | { forToken: string; status: "error" };

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * "Veri ve XML" ekranının üstünde, veritabanında hâlihazırda kayıtlı en
 * güncel başarılı XML importunun durumunu gösterir. Supabase'e hiç
 * doğrudan bağlanmaz — yalnızca yerel backend'in
 * GET /api/timetable-imports/current endpoint'ini çağırır.
 *
 * `refreshKey` değiştiğinde yeniden sorgular (yeni bir içe aktarma
 * başarıyla tamamlandığında üst bileşen bu değeri artırır).
 *
 * Yükleme durumu, effect içinde AYRI bir setState çağrısıyla değil,
 * `outcome.forToken` (en son TAMAMLANAN isteğin token'ı) ile mevcut
 * `requestToken`'ın karşılaştırılmasıyla RENDER SIRASINDA türetilir — bu
 * hem "effect içinde senkron setState" durumunu ortadan kaldırır hem de
 * geç dönen eski bir isteğin sonucu asla güncel token'la eşleşmeyeceği
 * için ekranda hiçbir zaman "loading" durumunun üzerine yazamaz.
 */
export default function CurrentImportStatus({ refreshKey }: { refreshKey: number }) {
  const [retryNonce, setRetryNonce] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const requestToken = `${refreshKey}:${retryNonce}`;
  const isLoading = outcome === null || outcome.forToken !== requestToken;

  useEffect(() => {
    const controller = new AbortController();
    let ignore = false;
    const token = requestToken;

    fetchCurrentImport(controller.signal)
      .then((data) => {
        if (ignore) return;
        setOutcome({ forToken: token, status: "loaded", snapshot: data });
      })
      .catch((err) => {
        if (ignore || isAbortError(err)) return; // iptal edilen istek kullanıcıya hata olarak gösterilmez
        setOutcome({ forToken: token, status: "error" });
      });

    return () => {
      ignore = true;
      controller.abort();
    };
  }, [refreshKey, retryNonce, requestToken]);

  function handleRetry() {
    setRetryNonce((n) => n + 1);
  }

  if (isLoading) {
    return (
      <div className="current-import-card current-import-card--loading" aria-busy="true" aria-live="polite">
        <span className="visually-hidden">Mevcut ders programı bilgisi yükleniyor…</span>
        <div className="ci-skeleton ci-skeleton-title" />
        <div className="ci-skeleton ci-skeleton-text" />
        <div className="current-import-stats">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="ci-skeleton ci-skeleton-box" />
          ))}
        </div>
      </div>
    );
  }

  if (outcome.status === "error") {
    return (
      <div className="current-import-card current-import-card--error" role="alert">
        <div className="current-import-header">
          <AlertCircle size={20} strokeWidth={2} aria-hidden="true" />
          <h2 className="current-import-title">Mevcut ders programı bilgisi alınamadı.</h2>
        </div>
        <p className="current-import-desc">Yerel API bağlantısını kontrol edip tekrar deneyin.</p>
        <button type="button" className="btn btn-secondary" onClick={handleRetry}>
          <RotateCcw size={16} strokeWidth={2} aria-hidden="true" />
          Tekrar Dene
        </button>
      </div>
    );
  }

  const snapshot = outcome.snapshot;

  if (!snapshot.hasImport || !snapshot.import) {
    return (
      <div className="current-import-card current-import-card--empty">
        <div className="current-import-header">
          <FileQuestion size={20} strokeWidth={2} aria-hidden="true" className="current-import-icon-neutral" />
          <h2 className="current-import-title">Henüz bir XML dosyası yüklenmedi</h2>
        </div>
        <p className="current-import-desc">
          Ders programını kullanmaya başlamak için aşağıdaki alandan bir XML dosyası seçin.
        </p>
      </div>
    );
  }

  const info = snapshot.import;
  const formattedDate = formatImportedAt(info.importedAt);

  return (
    <div className="current-import-card current-import-card--success">
      <div className="current-import-header">
        <CheckCircle2 size={20} strokeWidth={2} className="current-import-icon-success" aria-hidden="true" />
        <h2 className="current-import-title">Mevcut ders programı</h2>
        <span className="current-import-badge">Yüklendi</span>
      </div>

      <dl className="current-import-meta">
        <div className="current-import-meta-item">
          <dt>Son yükleme</dt>
          <dd>
            <time dateTime={info.importedAt}>{formattedDate}</time>
          </dd>
        </div>
        <div className="current-import-meta-item">
          <dt>Dosya</dt>
          <dd>{info.sourceFilename}</dd>
        </div>
        <div className="current-import-meta-item">
          <dt>Eğitim yılı</dt>
          <dd>{info.academicYearName}</dd>
        </div>
      </dl>

      <div className="current-import-stats">
        <div className="current-import-stat" aria-label={`${info.teacherCount} Öğretmen`}>
          <span className="current-import-stat-value">{info.teacherCount}</span>
          <span className="current-import-stat-label">Öğretmen</span>
        </div>
        <div className="current-import-stat" aria-label={`${info.classCount} Sınıf`}>
          <span className="current-import-stat-value">{info.classCount}</span>
          <span className="current-import-stat-label">Sınıf</span>
        </div>
        <div className="current-import-stat" aria-label={`${info.dayCount} Gün`}>
          <span className="current-import-stat-value">{info.dayCount}</span>
          <span className="current-import-stat-label">Gün</span>
        </div>
        <div className="current-import-stat" aria-label={`${info.periodCount} Ders Saati`}>
          <span className="current-import-stat-value">{info.periodCount}</span>
          <span className="current-import-stat-label">Ders Saati</span>
        </div>
        <div className="current-import-stat" aria-label={`${info.sourceCardCount} Plan Kartı`}>
          <span className="current-import-stat-value">{info.sourceCardCount}</span>
          <span className="current-import-stat-label">Plan Kartı</span>
        </div>
        <div className="current-import-stat" aria-label={`${info.normalizedAssignmentCount} Atama Kaydı`}>
          <span className="current-import-stat-value">{info.normalizedAssignmentCount}</span>
          <span className="current-import-stat-label">Atama Kaydı</span>
        </div>
      </div>
    </div>
  );
}
