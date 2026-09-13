import { useEffect, useState } from "react";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import { fetchTrialDataCounts } from "../lib/systemData/api";
import type { TrialDataCounts } from "../lib/systemData/types";
import ClearTrialRecordsDialog from "../components/systemData/ClearTrialRecordsDialog";
import { navigate, ROUTES } from "../lib/router";
import "./SystemDataPage.css";

const ZERO_COUNTS: TrialDataCounts = {
  dutyPlanCount: 0,
  examInvigilationPlanCount: 0,
  assignmentListCount: 0,
  payrollRecordCount: 0,
  closedPeriodCount: 0,
};

const SUMMARY_CARDS: Array<{ key: keyof TrialDataCounts; label: string }> = [
  { key: "dutyPlanCount", label: "Nöbet planı" },
  { key: "examInvigilationPlanCount", label: "Gözetmen planı" },
  { key: "assignmentListCount", label: "Görevlendirme listesi" },
  { key: "payrollRecordCount", label: "Puantaj kaydı" },
  { key: "closedPeriodCount", label: "Kapanmış dönem" },
];

const DELETED_ITEMS = [
  "Nöbet planı taslakları",
  "Yayımlanmış ve arşivlenmiş nöbet planları",
  "Öğretmen nöbet puanı geçmişi",
  "Deneme sınavı gözetmen planları",
  "Öğretmen yokluk ve ders yerine görevlendirme kayıtları",
  "Manuel puantaj görevleri",
  "Açık ve kapalı puantaj dönemleri",
  "Öğretmen ödeme ve dönem snapshot kayıtları",
];

const PRESERVED_ITEMS = [
  "Yüklenen XML ve mevcut ders programı",
  "Öğretmenler, sınıflar ve dersler",
  "Nöbet yerleri ve nöbet blokları",
  "Öğretmen nöbet uygunlukları",
  "Sabit nöbet tanımları",
  "Ücret türleri ve tarih sürümlü birim ücretler",
  "Kampüs, eğitim yılı ve uygulama ayarları",
];

export default function SystemDataPage() {
  const [counts, setCounts] = useState<TrialDataCounts | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [successMessage, setSuccessMessage] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let ignore = false;
    fetchTrialDataCounts(controller.signal)
      .then((result) => {
        if (ignore) return;
        setLoadError(null);
        setCounts(result);
      })
      .catch((err) => {
        if (ignore || (err instanceof DOMException && err.name === "AbortError")) return;
        setLoadError("Kayıt sayıları alınamadı. Lütfen sayfayı yenileyip tekrar deneyin.");
      });
    return () => {
      ignore = true;
      controller.abort();
    };
  }, []);

  function handleCleared(deleted: TrialDataCounts) {
    setDialogOpen(false);
    setSuccessMessage(true);
    // Sunucudaki gerçek durum sıfır olduğundan kartlar doğrudan sıfırlanır.
    void deleted;
    setCounts(ZERO_COUNTS);
  }

  return (
    <div className="sd-page">
      <h1 className="page-title">Sistem ve Veri</h1>

      {successMessage && (
        <div className="alert alert-success sd-success-banner" role="status">
          <CheckCircle2 size={18} aria-hidden="true" />
          <div>
            <p className="sd-success-title">Deneme kayıtları temizlendi. Sistem gerçek kullanım için hazır.</p>
            <p className="sd-success-sub">XML, ders programı ve sistem ayarları korunmuştur.</p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => navigate(ROUTES.dutyPlanning)}>
            Nöbet Planlamaya Git
          </button>
        </div>
      )}

      <section className="sd-section">
        <h2 className="sd-section-title">Deneme Kayıtlarını Temizle</h2>
        <p className="page-desc sd-section-desc">
          Deneme sürecinde oluşturulan planlama ve puantaj kayıtlarını temizleyerek sistemi gerçek kullanıma
          hazırlayın. Ders programı ve sistem ayarlarınız korunur.
        </p>

        {loadError && (
          <div className="alert alert-error" role="alert">
            <span>{loadError}</span>
          </div>
        )}

        <div className="sd-summary-row">
          {SUMMARY_CARDS.map(({ key, label }) => (
            <div className="sd-summary-box" key={key}>
              <div className="sd-summary-value">{counts ? counts[key] : "—"}</div>
              <div className="sd-summary-label">{label}</div>
            </div>
          ))}
        </div>

        <div className="sd-main-card">
          <div className="sd-columns">
            <div className="sd-column">
              <h3 className="sd-column-title sd-column-title--danger">Silinecek kayıtlar</h3>
              <ul className="sd-list">
                {DELETED_ITEMS.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div className="sd-column">
              <h3 className="sd-column-title sd-column-title--safe">
                <ShieldCheck size={16} aria-hidden="true" /> Korunacak veriler
              </h3>
              <ul className="sd-list">
                {PRESERVED_ITEMS.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>

          <div className="sd-danger-zone">
            <div className="sd-danger-zone-text">
              <h3>Tehlikeli Alan</h3>
              <p>Bu işlem geri alınamaz. Devam etmeden önce silinecek ve korunacak listeleri kontrol edin.</p>
            </div>
            <button
              type="button"
              className="btn sd-clear-btn"
              onClick={() => setDialogOpen(true)}
              disabled={!counts}
            >
              Kayıtları Temizle
            </button>
          </div>
        </div>
      </section>

      {dialogOpen && counts && (
        <ClearTrialRecordsDialog
          counts={counts}
          onCancel={() => setDialogOpen(false)}
          onCleared={handleCleared}
        />
      )}
    </div>
  );
}
