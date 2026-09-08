import { useState } from "react";
import { Pencil, Power, Trash2, User } from "lucide-react";
import { BLOCK_SHORT_LABELS, CATEGORY_LABELS, type DutyBlock, type DutyLocation } from "../../lib/dutyLocations/types";
import { updateDutyLocation } from "../../lib/dutyLocations/api";
import "./DutyLocationTable.css";

interface Props {
  items: DutyLocation[];
  /** Blok kataloğu (gün içi sırasında) — listeyle birlikte gelir. */
  blocks: DutyBlock[];
  onEdit: (item: DutyLocation) => void;
  onToggleActive: () => void;
  onDeleteRequest: (item: DutyLocation) => void;
}

export default function DutyLocationTable({ items, blocks, onEdit, onToggleActive, onDeleteRequest }: Props) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const blockById = new Map(blocks.map((b) => [b.id, b]));

  async function handleToggle(item: DutyLocation) {
    setPendingId(item.id);
    setToggleError(null);
    try {
      await updateDutyLocation(item.id, { isActive: !item.isActive });
      onToggleActive();
    } catch {
      setToggleError(`${item.name} için durum güncellenemedi.`);
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="dl-table-scroll">
      {toggleError && (
        <div className="alert alert-error" role="alert">
          <span>{toggleError}</span>
        </div>
      )}
      <table className="dl-table">
        <thead>
          <tr>
            <th scope="col" className="dl-col-icon" />
            <th scope="col">Nöbet Yeri</th>
            <th scope="col">Kısa Kod</th>
            <th scope="col">Kategori</th>
            <th scope="col">Nöbet Blokları</th>
            <th scope="col">Kapasite</th>
            <th scope="col">Durum</th>
            <th scope="col" className="dl-col-actions">
              İşlem
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const pending = pendingId === item.id;
            return (
              <tr key={item.id}>
                <td className="dl-col-icon">
                  <span className="dl-row-icon" aria-hidden="true">
                    <User size={14} strokeWidth={2} />
                  </span>
                </td>
                <td>
                  <div className="dl-cell-name">{item.name}</div>
                  {item.description && <div className="dl-cell-desc">{item.description}</div>}
                </td>
                <td>
                  <span className="dl-badge-code">{item.shortCode}</span>
                </td>
                <td>{CATEGORY_LABELS[item.category]}</td>
                <td>
                  {/* Blok gereksinimleri ve sabit nöbete uygunluk okulun
                      doğrulanmış iş kurallarıdır — SALT OKUNUR gösterilir,
                      düzenleme arayüzü bilinçli olarak yoktur. */}
                  <div className="dl-block-badges">
                    {item.blockIds.length === 0 ? (
                      <span className="dl-block-empty">Blok tanımlı değil</span>
                    ) : (
                      item.blockIds.map((id) => {
                        const block = blockById.get(id);
                        if (!block) return null;
                        return (
                          <span key={id} className="dl-block-badge" title={block.name}>
                            {BLOCK_SHORT_LABELS[block.code]}
                          </span>
                        );
                      })
                    )}
                    {item.allowsFixedAssignment && (
                      <span
                        className="dl-fixed-badge"
                        title="Bu nöbet yerine Sabit Nöbetler ekranından sabit öğretmen atanabilir."
                      >
                        Sabit nöbete uygun
                      </span>
                    )}
                  </div>
                </td>
                <td>
                  <span className="dl-capacity">
                    <User size={13} strokeWidth={2} aria-hidden="true" />
                    {item.capacity}
                  </span>
                </td>
                <td>
                  <span className={item.isActive ? "dl-status dl-status--active" : "dl-status dl-status--inactive"}>
                    <span className="dl-status-dot" aria-hidden="true" />
                    {item.isActive ? "Aktif" : "Pasif"}
                  </span>
                </td>
                <td className="dl-col-actions">
                  <div className="dl-row-actions">
                    <button
                      type="button"
                      className="dl-icon-btn"
                      aria-label={`${item.name} düzenle`}
                      onClick={() => onEdit(item)}
                      disabled={pending}
                    >
                      <Pencil size={15} strokeWidth={2} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="dl-icon-btn"
                      aria-label={item.isActive ? `${item.name} pasif yap` : `${item.name} aktif yap`}
                      onClick={() => handleToggle(item)}
                      disabled={pending}
                    >
                      <Power size={15} strokeWidth={2} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="dl-icon-btn dl-icon-btn--danger"
                      aria-label={`${item.name} sil`}
                      onClick={() => onDeleteRequest(item)}
                      disabled={pending}
                    >
                      <Trash2 size={15} strokeWidth={2} aria-hidden="true" />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
