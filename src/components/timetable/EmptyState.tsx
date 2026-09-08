import type { ReactNode } from "react";

/**
 * Sınıf/Öğretmen ders programı ekranlarında ortak durum kartı (import yok,
 * seçim yok, program boş, vb.). Bkz. ClassTimetablePage.tsx'teki eşdeğeri —
 * burada paylaşılan sürüm yalnızca yeni Öğretmen Ders Programı ekranı
 * tarafından kullanılır; mevcut çalışan Sınıf ekranı davranışını korumak için
 * bilerek değiştirilmedi.
 */
export default function EmptyState({
  icon,
  title,
  desc,
  actionLabel,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  desc?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="tt-empty-state">
      {icon}
      <p className="tt-empty-title">{title}</p>
      {desc && <p className="tt-empty-desc">{desc}</p>}
      {actionLabel && onAction && (
        <button type="button" className="btn btn-primary" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
