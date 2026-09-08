import { Bell, HelpCircle, LogOut } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import "./Topbar.css";

export default function Topbar() {
  const { user, signOut } = useAuth();
  const initials = user?.email
    ? user.email.slice(0, 2).toLocaleUpperCase("tr-TR")
    : "EB";

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
        {user ? (
          <button type="button" className="topbar-icon-btn" aria-label="Çıkış yap" title="Çıkış yap" onClick={signOut}>
            <LogOut size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        ) : null}
        <div className="topbar-avatar" aria-label={user?.email ?? "Kullanıcı"} role="img">{initials}</div>
      </div>
    </header>
  );
}
