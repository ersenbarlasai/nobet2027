import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import HaftalikNobetPlaniPage from "../HaftalikNobetPlaniPage";
import * as api from "../../lib/dutyPlanDrafts/api";
import * as xlsxExport from "../../lib/dutyPlanExport/downloadPublishedDutyPlanXlsx";
import type { DutyPlanHistoryDetailDto, DutyPlanHistoryListDto, PublishedDutyPlanDto, PublishedDutyPlanPackageDto } from "../../lib/dutyPlanDrafts/types";

const LOC_BAHCE = "loc-bahce";
const LOC_ILKOKUL = "loc-ilkokul";
const BLK_MORNING = "blk-morning";
const BLK_AFTERNOON = "blk-afternoon";

function publishedPlan(overrides: Partial<Extract<PublishedDutyPlanDto, { found: true }>> = {}): PublishedDutyPlanDto {
  return {
    found: true,
    id: "plan-1",
    status: "published",
    algorithmVersion: "duty-plan-solver-v1",
    generationOptions: { minWeeklyDuties: 1, targetWeeklyDuties: 2, maxWeeklyDuties: 3, balanceWorkload: true, diversifyAreas: true, allowPartial: true },
    summary: {
      teacherLoads: [
        { teacherSourceId: "T1", normalDutyCount: 1, fixedDutyDayCount: 0, totalDutyCount: 1 },
        { teacherSourceId: "T5", normalDutyCount: 0, fixedDutyDayCount: 1, totalDutyCount: 1 },
      ],
    },
    version: 3,
    createdAt: "2026-09-10T09:00:00.000Z",
    updatedAt: "2026-09-11T10:30:00.000Z",
    assignments: [
      {
        id: "a-1",
        dayOrder: 1,
        dutyLocationId: LOC_BAHCE,
        // Tarihsel SNAPSHOT ismi — sonraki bir XML importunda yer adı
        // değişse bile bu ekran BUNU (canlı join'i DEĞİL) göstermelidir.
        dutyLocationName: "Bahçe (Eski Ad — Snapshot)",
        dutyBlockId: BLK_MORNING,
        dutyBlockName: "Sabah Teneffüs Bloğu",
        teacherSourceId: "T1",
        teacherName: "Ayşe Yılmaz",
        assignmentKind: "generated",
        packageId: null,
      },
      {
        id: "a-2",
        dayOrder: 1,
        dutyLocationId: LOC_ILKOKUL,
        dutyLocationName: "İlkokul Koridor",
        dutyBlockId: BLK_MORNING,
        dutyBlockName: "Sabah Teneffüs Bloğu",
        teacherSourceId: "T5",
        teacherName: "Deniz Kaya",
        assignmentKind: "fixed",
        packageId: null,
      },
      {
        id: "a-3",
        dayOrder: 1,
        dutyLocationId: LOC_ILKOKUL,
        dutyLocationName: "İlkokul Koridor",
        dutyBlockId: BLK_AFTERNOON,
        dutyBlockName: "Öğleden Sonra Teneffüs Bloğu",
        teacherSourceId: "T5",
        teacherName: "Deniz Kaya",
        assignmentKind: "fixed",
        packageId: null,
      },
    ],
    packages: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(api, "fetchPublishedDutyPlan");
  // Geçmiş listesi boşsa bile bileşen yayımlanmış plan fallback'ini dener.
  // Her test kendi veri kaynağını açıkça kontrol etsin; gerçek fetch'e düşmesin.
  vi.spyOn(api, "fetchDutyPlanHistory").mockResolvedValue({ plans: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("HaftalikNobetPlaniPage — durumlar", () => {
  it("1) yüklenirken iskelet gösterir", () => {
    vi.mocked(api.fetchPublishedDutyPlan).mockReturnValue(new Promise(() => {}));
    render(<HaftalikNobetPlaniPage />);
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it("2) API hatasında hata durumu + yeniden dene gösterir", async () => {
    vi.mocked(api.fetchPublishedDutyPlan).mockRejectedValue(new Error("boom"));
    render(<HaftalikNobetPlaniPage />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Veriler alınamadı.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Tekrar Dene/i })).toBeInTheDocument();
  });

  it("3) yayımlanmış plan yoksa boş durum + Otomatik Nöbet Planına yönlendirme gösterir", async () => {
    vi.mocked(api.fetchPublishedDutyPlan).mockResolvedValue({ found: false });
    render(<HaftalikNobetPlaniPage />);
    expect(await screen.findByText("Henüz yayımlanmış bir nöbet planı yok.")).toBeInTheDocument();
    expect(screen.getByText("Önce otomatik nöbet taslağını tamamlayıp yayımlayın.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Otomatik Nöbet Planına Git/i })).toBeInTheDocument();
    // Yayımlanmamışken Yazdır butonu YOKTUR.
    expect(screen.queryByRole("button", { name: /Yazdır/i })).not.toBeInTheDocument();
  });

  it("4) yayımlanmış plan bulununca tarihsel snapshot isimlerini gösterir (canlı yer adını DEĞİL)", async () => {
    vi.mocked(api.fetchPublishedDutyPlan).mockResolvedValue(publishedPlan());
    render(<HaftalikNobetPlaniPage />);
    expect(await screen.findByText("Bahçe (Eski Ad — Snapshot)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Yazdır/i })).toBeInTheDocument();
  });

  it("5) sabit ve normal görev ayrımı: sabit hücre kilit ikonu + 'manuel' etiketiyle ayrışır", async () => {
    vi.mocked(api.fetchPublishedDutyPlan).mockResolvedValue(
      publishedPlan({
        assignments: [
          {
            id: "a-1",
            dayOrder: 1,
            dutyLocationId: LOC_BAHCE,
            dutyLocationName: "Bahçe",
            dutyBlockId: BLK_MORNING,
            dutyBlockName: "Sabah Teneffüs Bloğu",
            teacherSourceId: "T1",
            teacherName: "Ayşe Yılmaz",
            assignmentKind: "manual",
            packageId: null,
          },
          {
            id: "a-2",
            dayOrder: 1,
            dutyLocationId: LOC_ILKOKUL,
            dutyLocationName: "İlkokul Koridor",
            dutyBlockId: BLK_MORNING,
            dutyBlockName: "Sabah Teneffüs Bloğu",
            teacherSourceId: "T5",
            teacherName: "Deniz Kaya",
            assignmentKind: "fixed",
            packageId: null,
          },
        ],
      }),
    );
    render(<HaftalikNobetPlaniPage />);
    // "Pazartesi" gün tablosu başlığı — öğretmen tablosundaki AYNI metinli
    // sütun başlığından ayırt etmek için heading rolüyle bulunur.
    const dayHeading = await screen.findByRole("heading", { name: "Pazartesi" });
    const dayTable = dayHeading.closest(".hnp-card") as HTMLElement;

    const fixedCell = within(dayTable).getByText("Deniz Kaya").closest(".hnp-tag");
    expect(fixedCell).toHaveClass("hnp-tag--fixed");

    const manualCell = within(dayTable).getByText("Ayşe Yılmaz").closest(".hnp-tag");
    expect(manualCell).not.toHaveClass("hnp-tag--fixed");
    expect(manualCell?.textContent).toContain("manuel");

    // Üst özet: 1 sabit + 1 normal (manuel).
    expect(screen.getByText(/Sabit görev: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Normal görev: 1/)).toBeInTheDocument();
  });

  it("6) öğretmen bazlı gruplama: her öğretmen kendi satırında, günlere göre görevleriyle listelenir", async () => {
    vi.mocked(api.fetchPublishedDutyPlan).mockResolvedValue(publishedPlan());
    render(<HaftalikNobetPlaniPage />);
    await screen.findByText("Öğretmen Bazlı Haftalık Görevler");

    const section = screen.getByText("Öğretmen Bazlı Haftalık Görevler").closest(".hnp-card") as HTMLElement;
    expect(section).not.toBeNull();
    // T1 (Ayşe Yılmaz) ve T5 (Deniz Kaya) AYRI satırlarda görünür.
    const ayseRow = screen.getAllByText("Ayşe Yılmaz").find((el) => el.closest("th"))?.closest("tr");
    const denizRow = screen.getAllByText("Deniz Kaya").find((el) => el.closest("th"))?.closest("tr");
    expect(ayseRow).toBeDefined();
    expect(denizRow).toBeDefined();
    expect(ayseRow).not.toBe(denizRow);
  });

  it("7) haftalık yük özeti summary.teacherLoads'tan gelir", async () => {
    vi.mocked(api.fetchPublishedDutyPlan).mockResolvedValue(publishedPlan());
    render(<HaftalikNobetPlaniPage />);
    const loadSection = (await screen.findByText("Haftalık Yük Özeti")).closest(".hnp-card") as HTMLElement;
    expect(loadSection.textContent).toContain("Ayşe Yılmaz");
    expect(loadSection.textContent).toContain("Deniz Kaya");
  });

  it("8) açıklamalı legend gösterilir", async () => {
    vi.mocked(api.fetchPublishedDutyPlan).mockResolvedValue(publishedPlan());
    render(<HaftalikNobetPlaniPage />);
    expect(await screen.findByText("Açıklamalar")).toBeInTheDocument();
    expect(screen.getByText(/Sabit nöbet \(değiştirilemez/)).toBeInTheDocument();
    expect(screen.getByText(/Normal nöbet \(otomatik üretilmiş/)).toBeInTheDocument();
  });

  it("9) print işaretlemesi: print-only başlık bloğu ve her tablo kartı print'te bölünmeyecek şekilde işaretlenir", async () => {
    vi.mocked(api.fetchPublishedDutyPlan).mockResolvedValue(publishedPlan());
    const { container } = render(<HaftalikNobetPlaniPage />);
    await screen.findAllByText("Pazartesi");
    expect(container.querySelector(".print-only")).not.toBeNull();
    const avoidBreakCards = container.querySelectorAll(".hnp-avoid-break");
    expect(avoidBreakCards.length).toBeGreaterThan(0);
  });
});

describe("HaftalikNobetPlaniPage — plan geçmişi ve puanlar", () => {
  function historyList(): DutyPlanHistoryListDto {
    return { plans: [
      { id: "plan-14", weekStartDate: "2026-09-14", activeDayOrders: [1, 2, 3, 4, 5], status: "published", version: 4, algorithmVersion: "v4", createdAt: "2026-09-14", updatedAt: "2026-09-14", packageCount: 100, assignedTeacherCount: 41, priorPointTotal: 200, weekPointTotal: 100, projectedWeekPointTotal: 100, cumulativePointTotal: 300, normalCoveredCount: 130, uncoveredCount: 0 },
      { id: "plan-07", weekStartDate: "2026-09-07", activeDayOrders: [1, 2, 3, 4, 5], status: "published", version: 3, algorithmVersion: "v4", createdAt: "2026-09-07", updatedAt: "2026-09-07", packageCount: 100, assignedTeacherCount: 41, priorPointTotal: 100, weekPointTotal: 100, projectedWeekPointTotal: 100, cumulativePointTotal: 200, normalCoveredCount: 130, uncoveredCount: 0 },
    ] };
  }

  function detail(id = "plan-14", week = "2026-09-14"): DutyPlanHistoryDetailDto {
    const base = publishedPlan({ id, weekStartDate: week, version: id === "plan-14" ? 4 : 3 });
    if (!base.found) throw new Error("fixture");
    return { ...base, status: "published", priorScoreSnapshot: { T1: id === "plan-14" ? 4 : 2 }, isStale: false, teacherPoints: [{ teacherSourceId: "T1", teacherName: "Ayşe Yılmaz", priorPoints: id === "plan-14" ? 4 : 2, weekPoints: 2, totalPoints: id === "plan-14" ? 6 : 4, isProjected: false }] };
  }

  beforeEach(() => {
    vi.spyOn(api, "fetchDutyPlanHistory").mockResolvedValue(historyList());
    vi.spyOn(api, "fetchDutyPlanHistoryDetail").mockImplementation(async (id) => detail(id, id === "plan-14" ? "2026-09-14" : "2026-09-07"));
    vi.spyOn(api, "createDutyPlanRevision").mockResolvedValue({ status: "ok", planId: "draft-new", version: 1 });
    vi.spyOn(api, "archivePublishedDutyPlan").mockResolvedValue({ status: "ok", planId: "plan-14", version: 5 });
  });

  it("7 ve 14 Eylül planlarını listeler; önceki, hafta ve toplam puanı gösterir", async () => {
    render(<HaftalikNobetPlaniPage />);
    expect(await screen.findByText("14 Eylül 2026")).toBeInTheDocument();
    expect(screen.getByText("7 Eylül 2026")).toBeInTheDocument();
    expect(screen.getByText(/Önce 200 \+ hafta 100 =/)).toHaveTextContent("300");
    expect(screen.getByRole("heading", { name: "Öğretmen Nöbet Puanları" })).toBeInTheDocument();
    expect(screen.getByText("Önceki toplam")).toBeInTheDocument();
    expect(screen.getByText("Plan sonrası toplam")).toBeInTheDocument();
  });

  it("geçmişten 7 Eylül seçilince o haftanın ayrıntı ve puanlarını getirir", async () => {
    render(<HaftalikNobetPlaniPage />);
    const oldWeek = await screen.findByRole("button", { name: /7 Eylül 2026/i });
    await act(async () => { fireEvent.click(oldWeek); });
    await waitFor(() => expect(api.fetchDutyPlanHistoryDetail).toHaveBeenCalledWith("plan-07", expect.anything()));
    expect(await screen.findByText("4")).toBeInTheDocument();
  });

  it("düzenleme geçmiş planı değiştirmeden revizyon taslağı açar", async () => {
    const onOpenDraft = vi.fn();
    render(<HaftalikNobetPlaniPage onOpenDraft={onOpenDraft} />);
    const button = await screen.findByRole("button", { name: /Düzenlenebilir Kopya/i });
    fireEvent.click(button);
    await waitFor(() => expect(api.createDutyPlanRevision).toHaveBeenCalledWith("plan-14", { expectedPlanVersion: 4 }));
    expect(onOpenDraft).toHaveBeenCalledTimes(1);
  });
});

describe("HaftalikNobetPlaniPage — paket gruplaması (öğretmen×gün görünümü)", () => {
  function pkg(overrides: Partial<PublishedDutyPlanPackageDto> = {}): PublishedDutyPlanPackageDto {
    return {
      id: "pkg-x",
      dayOrder: 1,
      dutyLocationId: LOC_BAHCE,
      dutyLocationName: "Bahçe (Eski Ad — Snapshot)",
      teacherSourceId: "T1",
      teacherName: "Ayşe Yılmaz",
      coverageMode: "FULL_DAY",
      assignmentKind: "generated",
      coveredBlockCodes: ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"],
      ...overrides,
    };
  }

  function packagedPlan(): PublishedDutyPlanDto {
    return publishedPlan({
      assignments: [
        { id: "a1", dayOrder: 1, dutyLocationId: LOC_BAHCE, dutyLocationName: "Bahçe (Eski Ad — Snapshot)", dutyBlockId: "b-morning", dutyBlockName: "Sabah Teneffüs Bloğu", teacherSourceId: "T1", teacherName: "Ayşe Yılmaz", assignmentKind: "generated", packageId: "pkg-full" },
        { id: "a2", dayOrder: 1, dutyLocationId: LOC_BAHCE, dutyLocationName: "Bahçe (Eski Ad — Snapshot)", dutyBlockId: "b-long1", dutyBlockName: "Uzun Nöbet 1", teacherSourceId: "T1", teacherName: "Ayşe Yılmaz", assignmentKind: "generated", packageId: "pkg-full" },
        { id: "a3", dayOrder: 1, dutyLocationId: LOC_BAHCE, dutyLocationName: "Bahçe (Eski Ad — Snapshot)", dutyBlockId: "b-long2", dutyBlockName: "Uzun Nöbet 2", teacherSourceId: "T1", teacherName: "Ayşe Yılmaz", assignmentKind: "generated", packageId: "pkg-full" },
        { id: "a4", dayOrder: 1, dutyLocationId: LOC_BAHCE, dutyLocationName: "Bahçe (Eski Ad — Snapshot)", dutyBlockId: BLK_AFTERNOON, dutyBlockName: "Öğleden Sonra Teneffüs Bloğu", teacherSourceId: "T1", teacherName: "Ayşe Yılmaz", assignmentKind: "generated", packageId: "pkg-full" },
        { id: "a5", dayOrder: 1, dutyLocationId: LOC_ILKOKUL, dutyLocationName: "İlkokul Koridor", dutyBlockId: BLK_MORNING, dutyBlockName: "Sabah Teneffüs Bloğu", teacherSourceId: "T5", teacherName: "Deniz Kaya", assignmentKind: "fixed", packageId: "pkg-fixed" },
        { id: "a6", dayOrder: 1, dutyLocationId: LOC_ILKOKUL, dutyLocationName: "İlkokul Koridor", dutyBlockId: BLK_AFTERNOON, dutyBlockName: "Öğleden Sonra Teneffüs Bloğu", teacherSourceId: "T5", teacherName: "Deniz Kaya", assignmentKind: "fixed", packageId: "pkg-fixed" },
        { id: "a7", dayOrder: 2, dutyLocationId: LOC_BAHCE, dutyLocationName: "Bahçe (Eski Ad — Snapshot)", dutyBlockId: BLK_MORNING, dutyBlockName: "Sabah Teneffüs Bloğu", teacherSourceId: "T5", teacherName: "Deniz Kaya", assignmentKind: "manual", packageId: "pkg-short-t5-d2" },
        { id: "a8", dayOrder: 2, dutyLocationId: LOC_BAHCE, dutyLocationName: "Bahçe (Eski Ad — Snapshot)", dutyBlockId: BLK_AFTERNOON, dutyBlockName: "Öğleden Sonra Teneffüs Bloğu", teacherSourceId: "T5", teacherName: "Deniz Kaya", assignmentKind: "manual", packageId: "pkg-short-t5-d2" },
        { id: "a9", dayOrder: 1, dutyLocationId: LOC_ILKOKUL, dutyLocationName: "İlkokul Koridor", dutyBlockId: BLK_MORNING, dutyBlockName: "Sabah Teneffüs Bloğu", teacherSourceId: "T2", teacherName: "Can Demir", assignmentKind: "generated", packageId: "pkg-single" },
      ],
      packages: [
        pkg({ id: "pkg-full", dayOrder: 1, dutyLocationId: LOC_BAHCE, dutyLocationName: "Bahçe (Eski Ad — Snapshot)", teacherSourceId: "T1", teacherName: "Ayşe Yılmaz", coverageMode: "FULL_DAY", assignmentKind: "generated" }),
        pkg({
          id: "pkg-fixed",
          dayOrder: 1,
          dutyLocationId: LOC_ILKOKUL,
          dutyLocationName: "İlkokul Koridor",
          teacherSourceId: "T5",
          teacherName: "Deniz Kaya",
          coverageMode: "FIXED_SHORT_BREAKS",
          assignmentKind: "fixed",
          coveredBlockCodes: ["MORNING_BREAKS", "AFTERNOON_BREAKS"],
        }),
        pkg({
          id: "pkg-short-t5-d2",
          dayOrder: 2,
          dutyLocationId: LOC_BAHCE,
          dutyLocationName: "Bahçe (Eski Ad — Snapshot)",
          teacherSourceId: "T5",
          teacherName: "Deniz Kaya",
          coverageMode: "SHORT_BREAKS",
          assignmentKind: "manual",
          coveredBlockCodes: ["MORNING_BREAKS", "AFTERNOON_BREAKS"],
        }),
        pkg({
          id: "pkg-single",
          dayOrder: 1,
          dutyLocationId: LOC_ILKOKUL,
          dutyLocationName: "İlkokul Koridor",
          teacherSourceId: "T2",
          teacherName: "Can Demir",
          coverageMode: "SINGLE_BLOCK",
          assignmentKind: "generated",
          coveredBlockCodes: ["MORNING_BREAKS"],
        }),
      ],
    });
  }

  async function teacherSection() {
    render(<HaftalikNobetPlaniPage />);
    await screen.findByText("Öğretmen Bazlı Haftalık Görevler");
    return screen.getByText("Öğretmen Bazlı Haftalık Görevler").closest(".hnp-card") as HTMLElement;
  }

  it("FULL_DAY paketi öğretmen×gün görünümünde dört hücre yerine TEK satır olarak gösterilir", async () => {
    vi.mocked(api.fetchPublishedDutyPlan).mockResolvedValue(packagedPlan());
    const section = await teacherSection();
    const ayseRow = within(section)
      .getAllByText("Ayşe Yılmaz")
      .find((el) => el.closest("th"))
      ?.closest("tr") as HTMLElement;
    const tags = within(ayseRow).getAllByText(/Tüm Gün/);
    expect(tags).toHaveLength(1);
    expect(within(ayseRow).getByText("Tüm Gün — Bahçe (Eski Ad — Snapshot)")).toBeInTheDocument();
  });

  it("SHORT_BREAKS paketi tek satır (hücre) olarak gösterilir", async () => {
    vi.mocked(api.fetchPublishedDutyPlan).mockResolvedValue(packagedPlan());
    const section = await teacherSection();
    const denizRow = within(section)
      .getAllByText("Deniz Kaya")
      .find((el) => el.closest("th"))
      ?.closest("tr") as HTMLElement;
    expect(within(denizRow).getByText("Teneffüs (Sabah + Öğleden Sonra) — Bahçe (Eski Ad — Snapshot)")).toBeInTheDocument();
  });

  it("SINGLE_BLOCK paketi yalnız ilgili blok adıyla gösterilir", async () => {
    vi.mocked(api.fetchPublishedDutyPlan).mockResolvedValue(packagedPlan());
    const section = await teacherSection();
    const canRow = within(section)
      .getAllByText("Can Demir")
      .find((el) => el.closest("th"))
      ?.closest("tr") as HTMLElement;
    expect(within(canRow).getByText("İlkokul Koridor · Sabah")).toBeInTheDocument();
  });

  it("sabit paket ile manuel/üretilmiş paket görsel olarak ayrılır (kilit ikonu + hnp-tag--fixed)", async () => {
    vi.mocked(api.fetchPublishedDutyPlan).mockResolvedValue(packagedPlan());
    const section = await teacherSection();
    const denizRow = within(section)
      .getAllByText("Deniz Kaya")
      .find((el) => el.closest("th"))
      ?.closest("tr") as HTMLElement;
    const dayCells = within(denizRow).getAllByRole("cell");
    const day1Cell = dayCells[0];
    const day2Cell = dayCells[1];
    expect(within(day1Cell).getByText(/İlkokul Koridor/).closest(".hnp-tag")).toHaveClass("hnp-tag--fixed");
    expect(within(day2Cell).getByText(/Bahçe/).closest(".hnp-tag")).not.toHaveClass("hnp-tag--fixed");
  });

  it("aynı öğretmenin farklı gün paketleri birbirine karışmaz (gün1 sabit, gün2 SHORT_BREAKS ayrı hücrelerde)", async () => {
    vi.mocked(api.fetchPublishedDutyPlan).mockResolvedValue(packagedPlan());
    const section = await teacherSection();
    const denizRow = within(section)
      .getAllByText("Deniz Kaya")
      .find((el) => el.closest("th"))
      ?.closest("tr") as HTMLElement;
    const dayCells = within(denizRow).getAllByRole("cell");
    expect(within(dayCells[0]).queryByText(/Sabah \+ Öğleden Sonra/)).not.toBeInTheDocument();
    expect(within(dayCells[1]).queryByText(/İlkokul Koridor/)).not.toBeInTheDocument();
    expect(within(dayCells[1]).getByText("Teneffüs (Sabah + Öğleden Sonra) — Bahçe (Eski Ad — Snapshot)")).toBeInTheDocument();
  });

  it("paket satırlarında tarihsel snapshot yer/öğretmen isimleri kullanılır", async () => {
    vi.mocked(api.fetchPublishedDutyPlan).mockResolvedValue(packagedPlan());
    const section = await teacherSection();
    expect(within(section).getByText("Tüm Gün — Bahçe (Eski Ad — Snapshot)")).toBeInTheDocument();
  });
});

describe("HaftalikNobetPlaniPage — XLSX indirme", () => {
  function mockDownload() {
    return vi.spyOn(xlsxExport, "downloadPublishedDutyPlanXlsx").mockResolvedValue(undefined);
  }

  /** Elle çözülebilen bekleyen promise — "işlem sürerken" durumunu gözlemlemek için. */
  function deferred() {
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = () => res();
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("16) ready durumda XLSX İndir butonu görünür", async () => {
    vi.mocked(api.fetchPublishedDutyPlan).mockResolvedValue(publishedPlan());
    render(<HaftalikNobetPlaniPage />);
    expect(await screen.findByRole("button", { name: /XLSX İndir/i })).toBeEnabled();
  });

  it("17) loading, error ve empty durumlarında XLSX butonu görünmez", async () => {
    vi.mocked(api.fetchPublishedDutyPlan).mockReturnValue(new Promise(() => {}));
    const loading = render(<HaftalikNobetPlaniPage />);
    expect(screen.queryByRole("button", { name: /XLSX İndir/i })).not.toBeInTheDocument();
    loading.unmount();

    vi.mocked(api.fetchPublishedDutyPlan).mockRejectedValue(new Error("boom"));
    const errored = render(<HaftalikNobetPlaniPage />);
    await screen.findByText("Veriler alınamadı.");
    expect(screen.queryByRole("button", { name: /XLSX İndir/i })).not.toBeInTheDocument();
    errored.unmount();

    vi.mocked(api.fetchPublishedDutyPlan).mockResolvedValue({ found: false });
    render(<HaftalikNobetPlaniPage />);
    await screen.findByText("Henüz yayımlanmış bir nöbet planı yok.");
    expect(screen.queryByRole("button", { name: /XLSX İndir/i })).not.toBeInTheDocument();
  });

  it("18) tıklama sırasında buton disabled olur ve metni 'Excel hazırlanıyor…' olur", async () => {
    vi.mocked(api.fetchPublishedDutyPlan).mockResolvedValue(publishedPlan());
    const pending = deferred();
    vi.spyOn(xlsxExport, "downloadPublishedDutyPlanXlsx").mockReturnValue(pending.promise);

    render(<HaftalikNobetPlaniPage />);
    const button = await screen.findByRole("button", { name: /XLSX İndir/i });
    fireEvent.click(button);

    const busy = await screen.findByRole("button", { name: /Excel hazırlanıyor…/i });
    expect(busy).toBeDisabled();

    await act(async () => {
      pending.resolve();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /XLSX İndir/i })).toBeEnabled());
  });

  it("22) çift tıklama iki eşzamanlı export başlatmaz", async () => {
    vi.mocked(api.fetchPublishedDutyPlan).mockResolvedValue(publishedPlan());
    const pending = deferred();
    const spy = vi.spyOn(xlsxExport, "downloadPublishedDutyPlanXlsx").mockReturnValue(pending.promise);

    render(<HaftalikNobetPlaniPage />);
    const button = await screen.findByRole("button", { name: /XLSX İndir/i });
    // Aynı tick içinde iki tıklama — state güncellemesi henüz uygulanmamışken.
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByRole("button", { name: /Excel hazırlanıyor…/i });
    fireEvent.click(screen.getByRole("button", { name: /Excel hazırlanıyor…/i }));

    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve();
    });
  });

  it("23) export hatasında güvenli Türkçe mesaj gösterilir ve plan ekranda kalır", async () => {
    vi.mocked(api.fetchPublishedDutyPlan).mockResolvedValue(publishedPlan());
    vi.spyOn(xlsxExport, "downloadPublishedDutyPlanXlsx").mockRejectedValue(new Error("ZipStream failed at lib/xlsx/xlsx.js:412"));

    render(<HaftalikNobetPlaniPage />);
    fireEvent.click(await screen.findByRole("button", { name: /XLSX İndir/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Excel dosyası hazırlanamadı. Lütfen tekrar deneyin.");
    // Teknik ayrıntı/stack SIZDIRILMAZ.
    expect(alert.textContent).not.toMatch(/ZipStream|xlsx\.js|Error/);
    // Haftalık plan görünümü KAPANMAZ.
    expect(screen.getByText("Bahçe (Eski Ad — Snapshot)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /XLSX İndir/i })).toBeEnabled();
  });

  it("24) export mevcut plan nesnesini kullanır — fetchPublishedDutyPlan ikinci kez çağrılmaz", async () => {
    vi.mocked(api.fetchPublishedDutyPlan).mockResolvedValue(publishedPlan());
    const spy = mockDownload();

    render(<HaftalikNobetPlaniPage />);
    fireEvent.click(await screen.findByRole("button", { name: /XLSX İndir/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    expect(api.fetchPublishedDutyPlan).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ found: true, id: "plan-1", updatedAt: "2026-09-11T10:30:00.000Z" });
  });
});
