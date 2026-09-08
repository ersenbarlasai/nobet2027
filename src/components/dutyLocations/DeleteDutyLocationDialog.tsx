import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Loader2 } from "lucide-react";
import type { DutyLocation } from "../../lib/dutyLocations/types";
import { deleteDutyLocation, DutyLocationApiFieldError } from "../../lib/dutyLocations/api";
import "./DeleteDutyLocationDialog.css";

interface Props {
  item: DutyLocation;
  onCancel: () => void;
  onDeleted: () => void;
}

export default function DeleteDutyLocationDialog({ item, onCancel, onDeleted }: Props) {
  const [deleting, setDeleting] = useState(false);
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
      onCancel();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const focusable = dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled)");
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

  async function handleDelete() {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteDutyLocation(item.id);
      onDeleted();
    } catch (err) {
      if (err instanceof DutyLocationApiFieldError) {
        setError(err.apiError.message);
      } else {
        setError("Nöbet yeri silinemedi. Yerel API bağlantısını kontrol edip tekrar deneyin.");
      }
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="dl-dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="dl-dialog-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dl-delete-title"
        ref={dialogRef}
        onKeyDown={handleKeyDown}
      >
        <h2 id="dl-delete-title">Nöbet yeri silinsin mi?</h2>
        <p>
          Bu nöbet yeri yeni planlarda kullanılamayacak. Geçmiş planlardaki kayıtların korunabilmesi için sistemde
          arşivlenecek.
        </p>
        {error && (
          <div className="alert alert-error" role="alert">
            <span>{error}</span>
          </div>
        )}
        <div className="dl-dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={deleting}>
            Vazgeç
          </button>
          <button type="button" className="btn dl-btn-danger" onClick={handleDelete} disabled={deleting}>
            {deleting ? (
              <>
                <Loader2 size={16} className="spin" aria-hidden="true" />
                Siliniyor…
              </>
            ) : (
              "Nöbet Yerini Sil"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
