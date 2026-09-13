import Sidebar from "./components/Sidebar";
import Topbar from "./components/Topbar";
import DataXmlPage from "./pages/DataXmlPage";
import ClassTimetablePage from "./pages/ClassTimetablePage";
import TeacherTimetablePage from "./pages/TeacherTimetablePage";
import DutyLocationsPage from "./pages/DutyLocationsPage";
import FixedDutyAssignmentsPage from "./pages/FixedDutyAssignmentsPage";
import NobetPlanlamaPage from "./pages/NobetPlanlamaPage";
import DenemeSinaviGozetmenPage from "./pages/DenemeSinaviGozetmenPage";
import DersYerineGorevlendirmePage from "./pages/DersYerineGorevlendirmePage";
import PuantajPage from "./pages/PuantajPage";
import SystemDataPage from "./pages/SystemDataPage";
import { ROUTES, usePathname } from "./lib/router";
import "./App.css";

function renderPage(pathname: string) {
  if (pathname === ROUTES.classTimetable) return <ClassTimetablePage />;
  if (pathname === ROUTES.teacherTimetable) return <TeacherTimetablePage />;
  if (pathname === ROUTES.dutyLocations) return <DutyLocationsPage />;
  if (pathname === ROUTES.fixedDuties) return <FixedDutyAssignmentsPage />;
  if (pathname === ROUTES.dutyPlanning) return <NobetPlanlamaPage key={pathname} />;
  if (pathname === ROUTES.dutyPlanFeasibility) return <NobetPlanlamaPage key={pathname} initialView="analysis" />;
  if (pathname === ROUTES.otomatikNobetPlani) return <NobetPlanlamaPage key={pathname} initialView="draft" />;
  if (pathname === ROUTES.haftalikNobetPlani) return <NobetPlanlamaPage key={pathname} initialView="published" />;
  if (pathname === ROUTES.examInvigilation) return <DenemeSinaviGozetmenPage />;
  if (pathname === ROUTES.substitutions) return <DersYerineGorevlendirmePage />;
  if (pathname === ROUTES.compensationSettings) return <PuantajPage initialView="settings" />;
  if (pathname === ROUTES.payroll) return <PuantajPage />;
  if (pathname === ROUTES.systemData) return <SystemDataPage />;
  return <DataXmlPage />;
}

export default function App() {
  const pathname = usePathname();

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <Topbar />
        <main className="app-content">{renderPage(pathname)}</main>
      </div>
    </div>
  );
}
