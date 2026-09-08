import { useEffect, useState } from "react";
import { AlertCircle, RotateCcw, MapPin, Search } from "lucide-react";
import {
  CATEGORY_LABELS,
  DUTY_LOCATION_CATEGORIES,
  type DutyLocation,
  type DutyLocationCategory,
  type DutyLocationListParams,
  type DutyLocationListResponse,
  type DutyLocationSort,
  type DutyLocationStatusFilter,
} from "../lib/dutyLocations/types";
import { fetchDutyLocations } from "../lib/dutyLocations/api";
import DutyLocationForm from "../components/dutyLocations/DutyLocationForm";
import DutyLocationTable from "../components/dutyLocations/DutyLocationTable";
import DutyLocationEditDrawer from "../components/dutyLocations/DutyLocationEditDrawer";
import DeleteDutyLocationDialog from "../components/dutyLocations/DeleteDutyLocationDialog";
import "./DutyLocationsPage.css";

const PAGE_SIZE = 10;
const SEARCH_DEBOUNCE_MS = 300;

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

type ListOutcome = { status: "loaded"; data: DutyLocationListResponse } | { status: "error" };

export default function DutyLocationsPage() {
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [category, setCategory] = useState<DutyLocationCategory | "">("");
  const [status, setStatus] = useState<DutyLocationStatusFilter>("all");
  const [sort, setSort] = useState<DutyLocationSort>("order");
  const [page, setPage] = useState(1);
  const [refreshKey, setRefreshKey] = useState(0);

  const [outcome, setOutcome] = useState<ListOutcome | null>(null);
  const [editingItem, setEditingItem] = useState<DutyLocation | null>(null);
  const [deletingItem, setDeletingItem] = useState<DutyLocation | null>(null);

  // Arama debounce: her tuşta yarışan istek göndermemek için. Debounce süresi
  // sonunda arama uygulanınca sayfa 1'e dönülür (filtre değişince sayfalama sıfırlanır).
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const controller = new AbortController();
    let ignore = false;
    const params: DutyLocationListParams = { search: debouncedSearch, category, status, sort, page, pageSize: PAGE_SIZE };

    fetchDutyLocations(params, controller.signal)
      .then((data) => {
        if (ignore) return;
        setOutcome({ status: "loaded", data });
      })
      .catch((err) => {
        if (ignore || isAbortError(err)) return;
        setOutcome({ status: "error" });
      });

    return () => {
      ignore = true;
      controller.abort();
    };
  }, [debouncedSearch, category, status, sort, page, refreshKey]);

  function refresh() {
    setRefreshKey((k) => k + 1);
  }

  function handleCreated() {
    refresh();
  }

  function handleUpdated() {
    setEditingItem(null);
    refresh();
  }

  function handleDeleted() {
    // Son sayfadaki son kayıt silinirse geçerli önceki sayfaya dön.
    if (outcome?.status === "loaded" && outcome.data.items.length === 1 && page > 1) {
      setPage((p) => p - 1);
    } else {
      refresh();
    }
    setDeletingItem(null);
  }

  const loading = outcome === null;
  const hasActiveFilters = debouncedSearch.trim() !== "" || category !== "" || status !== "all";

  function handleClearFilters() {
    setSearchInput("");
    setDebouncedSearch("");
    setCategory("");
    setStatus("all");
    setPage(1);
  }

  return (
    <div className="dl-page">
      <div className="dl-page-header">
        <div>
          <h1 className="page-title">Nöbet Yerleri</h1>
          <p className="page-desc">Öğretmenlerin nöbet tutacağı alanları tanımlayın ve yönetin.</p>
        </div>
        <div className="dl-summary" aria-live="polite">
          <SummaryBox label="Toplam Yer" value={outcome?.status === "loaded" ? outcome.data.summary.total : null} />
          <SummaryBox label="Aktif" value={outcome?.status === "loaded" ? outcome.data.summary.active : null} tone="active" />
          <SummaryBox label="Pasif" value={outcome?.status === "loaded" ? outcome.data.summary.inactive : null} tone="inactive" />
        </div>
      </div>

      <div className="dl-grid">
        <DutyLocationForm
          key={outcome?.status === "loaded" ? outcome.data.blocks.map((block) => block.id).join("|") : "loading"}
          blocks={outcome?.status === "loaded" ? outcome.data.blocks : []}
          onCreated={handleCreated}
        />

        <div className="dl-list-card">
          <div className="dl-list-controls">
            <div className="dl-search">
              <Search size={16} strokeWidth={2} aria-hidden="true" />
              <input
                type="search"
                placeholder="Ara (ad veya kısa kod)"
                aria-label="Nöbet yeri ara"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </div>
            <select
              className="dl-filter-select"
              aria-label="Kategori filtresi"
              value={category}
              onChange={(e) => {
                setCategory(e.target.value as DutyLocationCategory | "");
                setPage(1);
              }}
            >
              <option value="">Tüm Kategoriler</option>
              {DUTY_LOCATION_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
            <select
              className="dl-filter-select"
              aria-label="Durum filtresi"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as DutyLocationStatusFilter);
                setPage(1);
              }}
            >
              <option value="all">Tüm Durumlar</option>
              <option value="active">Aktif</option>
              <option value="inactive">Pasif</option>
            </select>
            <select
              className="dl-filter-select"
              aria-label="Sıralama"
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as DutyLocationSort);
                setPage(1);
              }}
            >
              <option value="order">Sıraya Göre</option>
              <option value="name">Ada Göre</option>
              <option value="category">Kategoriye Göre</option>
              <option value="active">Duruma Göre</option>
            </select>
          </div>

          <div className="dl-list-body" aria-busy={loading}>
            {loading && <DutyLocationTableSkeleton />}

            {outcome?.status === "error" && (
              <div className="dl-error-card" role="alert">
                <AlertCircle size={20} strokeWidth={2} aria-hidden="true" />
                <div>
                  <p className="dl-error-title">Nöbet yerleri alınamadı.</p>
                  <p className="dl-error-desc">Yerel API bağlantısını kontrol edip tekrar deneyin.</p>
                  <button type="button" className="btn btn-secondary" onClick={refresh}>
                    <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
                    Tekrar Dene
                  </button>
                </div>
              </div>
            )}

            {outcome?.status === "loaded" && outcome.data.summary.total === 0 && (
              <div className="dl-empty-state">
                <MapPin size={32} strokeWidth={1.5} aria-hidden="true" />
                <p className="dl-empty-title">Henüz nöbet yeri tanımlanmadı.</p>
                <p className="dl-empty-desc">İlk nöbet yerini soldaki formdan ekleyin.</p>
              </div>
            )}

            {outcome?.status === "loaded" && outcome.data.summary.total > 0 && outcome.data.items.length === 0 && (
              <div className="dl-empty-state">
                <Search size={32} strokeWidth={1.5} aria-hidden="true" />
                <p className="dl-empty-title">Aramanızla eşleşen nöbet yeri bulunamadı.</p>
                {hasActiveFilters && (
                  <button type="button" className="btn btn-secondary" onClick={handleClearFilters}>
                    Filtreleri Temizle
                  </button>
                )}
              </div>
            )}

            {outcome?.status === "loaded" && outcome.data.items.length > 0 && (
              <DutyLocationTable
                items={outcome.data.items}
                blocks={outcome.data.blocks}
                onEdit={setEditingItem}
                onToggleActive={refresh}
                onDeleteRequest={setDeletingItem}
              />
            )}
          </div>

          {outcome?.status === "loaded" && outcome.data.pagination.totalPages > 1 && (
            <Pagination
              page={outcome.data.pagination.page}
              totalPages={outcome.data.pagination.totalPages}
              onChange={setPage}
            />
          )}
        </div>
      </div>

      {editingItem && (
        <DutyLocationEditDrawer
          item={editingItem}
          blocks={outcome?.status === "loaded" ? outcome.data.blocks : []}
          onClose={() => setEditingItem(null)}
          onSaved={handleUpdated}
        />
      )}
      {deletingItem && (
        <DeleteDutyLocationDialog item={deletingItem} onCancel={() => setDeletingItem(null)} onDeleted={handleDeleted} />
      )}
    </div>
  );
}

function SummaryBox({ label, value, tone }: { label: string; value: number | null; tone?: "active" | "inactive" }) {
  return (
    <div className={tone ? `dl-summary-box dl-summary-box--${tone}` : "dl-summary-box"}>
      <div className="dl-summary-value">{value === null ? "—" : value}</div>
      <div className="dl-summary-label">{label}</div>
    </div>
  );
}

function DutyLocationTableSkeleton() {
  return (
    <div className="dl-skeleton-wrap" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="dl-skeleton-row" />
      ))}
    </div>
  );
}

function Pagination({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (page: number) => void }) {
  return (
    <div className="dl-pagination">
      <button type="button" className="btn btn-secondary" onClick={() => onChange(page - 1)} disabled={page <= 1}>
        Önceki
      </button>
      <span className="dl-pagination-info">
        Sayfa {page} / {totalPages}
      </span>
      <button type="button" className="btn btn-secondary" onClick={() => onChange(page + 1)} disabled={page >= totalPages}>
        Sonraki
      </button>
    </div>
  );
}
