import { useSyncExternalStore } from "react";

// Uygulama tek sayfalık ve küçük kapsamlı olduğu için harici bir router
// kütüphanesi yerine minimal, bağımlılıksız bir history-API sarmalayıcı
// kullanılıyor. Sayfa yenilendiğinde doğru rotanın açılması, Vite dev/preview
// sunucusunun varsayılan SPA fallback davranışına (appType: "spa") dayanır.

export const ROUTES = {
  dataXml: "/",
  classTimetable: "/sinif-ders-programi",
  teacherTimetable: "/ogretmen-ders-programi",
  dutyLocations: "/nobet-yerleri",
  fixedDuties: "/sabit-nobetler",
  dutyPlanning: "/nobet-planlama",
  dutyPlanFeasibility: "/planlanabilirlik-analizi",
  otomatikNobetPlani: "/otomatik-nobet-plani",
  haftalikNobetPlani: "/haftalik-nobet-plani",
  examInvigilation: "/deneme-sinavi-gozetmen",
  substitutions: "/ders-yerine-gorevlendirme",
  compensationSettings: "/ucret-turleri",
  payroll: "/puantaj",
} as const;

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

function getSnapshot(): string {
  return window.location.pathname;
}

function getServerSnapshot(): string {
  return ROUTES.dataXml;
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function navigate(path: string): void {
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
