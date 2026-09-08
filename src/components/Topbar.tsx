import { Bell, HelpCircle } from "lucide-react";
import "./Topbar.css";

export default function Topbar() {
  return (
    <header className="topbar">
      <div className="topbar-spacer" />
      <div className="topbar-right">
        <span className="topbar-campus">Kaplan Okulları · Üçevler Kampüsü</span>
        <span className="topbar-year">2026–2027</span>
        <button type="button" className="topbar-icon-btn" aria-label="Bildirimler">
          <Bell size={18} strokeWidth={2} aria-hidden="true" />
        </button>
        <button type="button" className="topbar-icon-btn" aria-label="Yardım">
          <HelpCircle size={18} strokeWidth={2} aria-hidden="true" />
        </button>
        <div className="topbar-avatar" aria-label="Kullanıcı" role="img">
          EB
        </div>
      </div>
    </header>
  );
}
