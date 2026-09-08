import {
  FileCode2,
  CalendarDays,
  Users,
  MapPin,
  LockKeyhole,
  PanelsTopLeft,
  ClipboardCheck,
  UserRoundX,
  BadgeTurkishLira,
} from "lucide-react";
import { ROUTES, navigate, usePathname } from "../lib/router";
import "./Sidebar.css";

const menuItems = [
  { label: "Veri ve XML", icon: FileCode2, path: ROUTES.dataXml },
  { label: "Sınıf Ders Programı", icon: CalendarDays, path: ROUTES.classTimetable },
  { label: "Öğretmen Ders Programı", icon: Users, path: ROUTES.teacherTimetable },
  { label: "Nöbet Yerleri", icon: MapPin, path: ROUTES.dutyLocations },
  { label: "Sabit Nöbetler", icon: LockKeyhole, path: ROUTES.fixedDuties },
  { label: "Nöbet Planlama", icon: PanelsTopLeft, path: ROUTES.dutyPlanning },
  { label: "Deneme Sınavı Gözetmen", icon: ClipboardCheck, path: ROUTES.examInvigilation },
  { label: "Ders Yerine Görevlendirme", icon: UserRoundX, path: ROUTES.substitutions },
  { label: "Puantaj", icon: BadgeTurkishLira, path: ROUTES.payroll },
];

const dutyPlanningPaths: readonly string[] = [
  ROUTES.dutyPlanFeasibility,
  ROUTES.otomatikNobetPlani,
  ROUTES.haftalikNobetPlani,
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-logo">Nöbet2027</div>
        <div className="sidebar-subtitle">Yönetim Paneli</div>
      </div>

      <nav className="sidebar-nav" aria-label="Ana menü">
        {menuItems.map(({ label, icon: Icon, path }) => {
          const active =
            path === pathname ||
            (path === ROUTES.dutyPlanning &&
              dutyPlanningPaths.includes(pathname));
          return (
            <button
              key={label}
              type="button"
              className={active ? "sidebar-item sidebar-item--active" : "sidebar-item"}
              aria-current={active ? "page" : undefined}
              onClick={() => navigate(path)}
            >
              <Icon size={18} strokeWidth={2} aria-hidden="true" />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
