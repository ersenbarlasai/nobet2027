import { useState } from "react";
import { BarChart3, CalendarCheck2, ChevronRight, Wand2 } from "lucide-react";
import DutyPlanFeasibilityPage from "./DutyPlanFeasibilityPage";
import OtomatikNobetPlaniPage from "./OtomatikNobetPlaniPage";
import HaftalikNobetPlaniPage from "./HaftalikNobetPlaniPage";
import "./NobetPlanlamaPage.css";

export type DutyPlanningView = "analysis" | "draft" | "published";

interface NobetPlanlamaPageProps {
  initialView?: DutyPlanningView;
}

const stages = [
  {
    id: "analysis" as const,
    step: "01",
    label: "Hazırlık",
    description: "Kapasiteyi kontrol et",
    icon: BarChart3,
  },
  {
    id: "draft" as const,
    step: "02",
    label: "Taslak",
    description: "Üret ve düzenle",
    icon: Wand2,
  },
  {
    id: "published" as const,
    step: "03",
    label: "Plan geçmişi",
    description: "Haftaları ve puanları yönet",
    icon: CalendarCheck2,
  },
];

/**
 * Nöbet planlama sürecinin tek çalışma alanı. Alt ekranlar kendi yetkili API
 * akışlarını korur; bu bileşen yalnız aşamalar arası bağlamı ve gezinmeyi
 * birleştirir. Böylece analiz, düzenlenebilir taslak ve değişmez yayımlanmış
 * planın anlamları birbirine karışmaz.
 */
export default function NobetPlanlamaPage({ initialView = "analysis" }: NobetPlanlamaPageProps) {
  const [activeView, setActiveView] = useState<DutyPlanningView>(initialView);

  return (
    <section className="npw-page">
      <header className="npw-header">
        <div>
          <span className="npw-eyebrow">Haftalık planlama çalışma alanı</span>
          <h1>Nöbet Planlama</h1>
          <p>Kapasiteyi kontrol edin, taslağı tamamlayın ve yayımlanmış planı aynı akışta yönetin.</p>
        </div>
        <div className="npw-flow-note" aria-label="Planlama sırası">
          <span>Kontrol</span>
          <ChevronRight size={13} aria-hidden="true" />
          <span>Taslak</span>
          <ChevronRight size={13} aria-hidden="true" />
          <span>Yayın</span>
        </div>
      </header>

      <nav className="npw-stage-rail" role="tablist" aria-label="Nöbet planlama aşamaları">
        {stages.map(({ id, step, label, description, icon: Icon }) => {
          const selected = activeView === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`npw-panel-${id}`}
              className={selected ? "npw-stage npw-stage--active" : "npw-stage"}
              onClick={() => setActiveView(id)}
            >
              <span className="npw-stage-step">{step}</span>
              <Icon size={18} strokeWidth={2} aria-hidden="true" />
              <span className="npw-stage-copy">
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
            </button>
          );
        })}
      </nav>

      <div
        className="npw-workspace"
        role="tabpanel"
        id={`npw-panel-${activeView}`}
        aria-label={stages.find((stage) => stage.id === activeView)?.label}
      >
        {activeView === "analysis" && <DutyPlanFeasibilityPage embedded />}
        {activeView === "draft" && <OtomatikNobetPlaniPage embedded onPublished={() => setActiveView("published")} />}
        {activeView === "published" && <HaftalikNobetPlaniPage embedded onOpenDraft={() => setActiveView("draft")} />}
      </div>
    </section>
  );
}
