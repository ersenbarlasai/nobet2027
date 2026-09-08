import { AlertTriangle } from "lucide-react";
import { formatImportedAt } from "../../lib/currentImport/formatImportedAt";

/** Program kartının alt bilgisi: son güncelleme zamanı + legend. Sınıf ve Öğretmen Ders Programı arasında paylaşılır. */
export default function TimetableFooter({
  importedAt,
  hasAmbiguous,
  hasConflict,
}: {
  importedAt: string;
  hasAmbiguous: boolean;
  hasConflict: boolean;
}) {
  return (
    <div className="tt-footer">
      <p className="tt-footer-updated">
        Son güncelleme: <time dateTime={importedAt}>{formatImportedAt(importedAt)}</time>
      </p>
      <div className="tt-legend">
        <span className="tt-legend-item">
          <span className="tt-legend-swatch tt-legend-swatch--filled" /> Dolu ders
        </span>
        <span className="tt-legend-item">
          <span className="tt-legend-swatch tt-legend-swatch--empty" /> Boş periyot
        </span>
        {hasAmbiguous && (
          <span className="tt-legend-item">
            <AlertTriangle size={14} strokeWidth={2} className="tt-legend-icon-warning" aria-hidden="true" />
            Belirsiz eşleşme
          </span>
        )}
        {hasConflict && (
          <span className="tt-legend-item">
            <AlertTriangle size={14} strokeWidth={2} className="tt-legend-icon-error" aria-hidden="true" />
            Ders çakışması
          </span>
        )}
      </div>
    </div>
  );
}
