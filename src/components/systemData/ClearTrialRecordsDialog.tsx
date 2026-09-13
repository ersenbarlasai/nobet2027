import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import type { TrialDataCounts } from "../../lib/systemData/types";
import { clearTrialRecords, CLEAR_TRIAL_RECORDS_CONFIRMATION, SystemDataApiFieldError } from "../../lib/systemData/api";
import "./ClearTrialRecordsDialog.css";

interface Props {
  counts: TrialDataCounts;
  onCancel: () => void;
  onCleared: (counts: TrialDataCounts) => void;
}

const GENERIC_ERROR_MESSAGE = "Kayıtlar temizlenemedi. Veritabanında değişiklik yapılmadı. Lütfen tekrar deneyin.";

const SUMMARY_ROWS: Array<{ key: keyof TrialDataCounts; label: string }> = [
  { key: "dutyPlanCount", label: "Nöbet planı" },
  { key: "examInvigilationPlanCount", label: "Gözetmen planı" },
  { key: "assignmentListCount", label: "Görevlendirme listesi" },
  { key: "payrollRecordCount", label: "Puantaj kaydı" },
  { key: "closedPeriodCount", label: "Kapanmış dönem" },
];

function downloadCountsSummary(counts: TrialDataCounts) {
  const payload = {
    exportedAt: new Date().toISOString(),
    note: "Temizlemeden önce alınan kayıt sayısı özeti. Ders programı, sistem ayarları ve nöbet yapılandırması bu dosyaya dahil değildir; onlar zaten silinmez.",
    counts,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `nobet2027-deneme-kayit-ozeti-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export default function ClearTrialRecordsDialog({ counts, onCancel, onCleared }: Props) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      previouslyFocused.current?.focus();
    };
  }, []);

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      if (!submitting) onCancel();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const focusable = dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)");
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

  const canSubmit = acknowledged && confirmText === CLEAR_TRIAL_RECORDS_CONFIRMATION && !submitting;

  async function handleClear() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const deleted = await clearTrialRecords();
      onCleared(deleted);
    } catch (err) {
      if (err instanceof SystemDataApiFieldError) {
        setError(err.apiError.message || GENERIC_ERROR_MESSAGE);
      } else {
        setError(GENERIC_ERROR_MESSAGE);
      }
      setSubmitting(false);
    }
  }

  return (
    <div
      className="ctr-dialog-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && !submitting && onCancel()}
    >
      <div
        className="ctr-dialog-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ctr-dialog-title"
        ref={dialogRef}
        onKeyDown={handleKeyDown}
      >
        <div className="ctr-dialog-icon" aria-hidden="true">
          <TriangleAlert size={22} />
        </div>
        <h2 id="ctr-dialog-title">Deneme kayıtları temizlensin mi?</h2>
        <p className="ctr-dialog-warning">
          Bu işlem geri alınamaz. Planlama, görevlendirme ve puantaj geçmişi kalıcı olarak silinecektir. XML
          dosyanız, ders programınız ve sistem ayarlarınız korunacaktır.
        </p>

        <ul className="ctr-summary-list">
          {SUMMARY_ROWS.map(({ key, label }) => (
            <li key={key}>
              <span>{label}</span>
              <strong>{counts[key]}</strong>
            </li>
          ))}
        </ul>

        <button type="button" className="btn btn-secondary ctr-backup-btn" onClick={() => downloadCountsSummary(counts)} disabled={submitting}>
          Kayıt özeti indir
        </button>

        {error && (
          <div className="alert alert-error" role="alert">
            <span>{error}</span>
          </div>
        )}

        <label className="ctr-checkbox-row">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            disabled={submitting}
          />
          <span>Silinecek kayıtları ve korunacak verileri kontrol ettim.</span>
        </label>

        <label className="ctr-confirm-field">
          <span>Devam etmek için <strong>{CLEAR_TRIAL_RECORDS_CONFIRMATION}</strong> yazın.</span>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            disabled={submitting}
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <div className="ctr-dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={submitting}>
            Vazgeç
          </button>
          <button type="button" className="btn ctr-btn-danger" onClick={handleClear} disabled={!canSubmit}>
            {submitting ? (
              <>
                <Loader2 size={16} className="spin" aria-hidden="true" />
                Kayıtlar temizleniyor…
              </>
            ) : (
              "Kayıtları Kalıcı Olarak Temizle"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
