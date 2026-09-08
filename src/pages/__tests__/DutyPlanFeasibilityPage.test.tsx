import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DutyPlanFeasibilityPage from "../DutyPlanFeasibilityPage";
import * as api from "../../lib/dutyPlanFeasibility/api";
import type { DutyPlanFeasibilityResponse, FeasibilityDay } from "../../lib/dutyPlanFeasibility/types";

const BLK_MORNING = "aaaaaaaa-0000-0000-0000-000000000001";
const BLK_LONG1 = "aaaaaaaa-0000-0000-0000-000000000002";

const BLOCKS = [
  { id: BLK_MORNING, code: "MORNING_BREAKS" as const, name: "Sabah Teneffüs Bloğu", blockOrder: 1, conflictPeriodName: null },
  { id: BLK_LONG1, code: "LONG_BREAK_1" as const, name: "Uzun Nöbet 1", blockOrder: 2, conflictPeriodName: "5-OO" },
];

function blockSummary(overrides: Partial<FeasibilityDay["blocks"][number]> = {}): FeasibilityDay["blocks"][number] {
  return {
    blockId: BLK_MORNING,
    blockCode: "MORNING_BREAKS",
    blockName: "Sabah Teneffüs Bloğu",
    blockOrder: 1,
    required: 2,
    fixedRequired: 0,
    fixedCovered: 0,
    fixedMissing: 0,
    normalRequired: 2,
    independentShortfall: 0,
    matchingUncovered: 0,
    candidateTeacherCount: 2,
    ...overrides,
  };
}

function day(overrides: Partial<FeasibilityDay> = {}): FeasibilityDay {
  return {
    order: 1,
    name: "Pazartesi",
    totals: {
      requiredTasks: 4,
      coveredTasks: 4,
      uncoveredTasks: 0,
      fixedRequired: 0,
      fixedCovered: 0,
      fixedMissing: 0,
      normalRequired: 4,
      normalMatched: 4,
      normalUncovered: 0,
      candidateTeacherCount: 4,
    },
    blocks: [blockSummary(), blockSummary({ blockId: BLK_LONG1, blockCode: "LONG_BREAK_1", blockName: "Uzun Nöbet 1", blockOrder: 2 })],
    uncoveredTasks: [],
    missingFixedAssignments: [],
    excludedByLessonConflict: [],
    excludedByConfigurationError: [],
    fixedAssignments: [],
    ...overrides,
  };
}

function response(overrides: Partial<Extract<DutyPlanFeasibilityResponse, { hasImport: true }>> = {}): DutyPlanFeasibilityResponse {
  const days = overrides.days ?? [day()];
  const uncovered = days.reduce((sum, d) => sum + d.totals.uncoveredTasks, 0);
  return {
    hasImport: true,
    importedAt: "2026-09-01T10:00:00.000Z",
    analyzedAt: "2026-09-10T09:00:00.000Z",
    blocks: BLOCKS,
    days,
    summary: {
      totalRequiredTasks: days.reduce((sum, d) => sum + d.totals.requiredTasks, 0),
      totalCoveredTasks: days.reduce((sum, d) => sum + d.totals.coveredTasks, 0),
      totalUncoveredTasks: uncovered,
      daysWithShortfall: days.filter((d) => d.totals.uncoveredTasks > 0).map((d) => d.order),
      feasible: uncovered === 0,
    },
    weeklyCapacity: {
      algorithmVersion: "duty-plan-solver-v3-teacher-half-day-rules",
      optionsSource: "current_draft",
      sourceDraftId: "draft-1",
      optionsUsed: {
        minWeeklyDuties: 1,
        targetWeeklyDuties: 2,
        maxWeeklyDuties: 3,
        balanceWorkload: true,
        diversifyAreas: true,
        allowPartial: true,
      },
      teacherCount: 2,
      totalTaskCount: days.reduce((sum, d) => sum + d.totals.requiredTasks, 0),
      fixedTaskCount: 0,
      fixedCoveredCount: 0,
      normalTaskCount: days.reduce((sum, d) => sum + d.totals.requiredTasks, 0),
      normalMaxCoverableCount: days.reduce((sum, d) => sum + d.totals.coveredTasks, 0),
      totalMaxCoverableCount: days.reduce((sum, d) => sum + d.totals.coveredTasks, 0),
      totalUncoveredCount: uncovered,
      feasible: uncovered === 0,
      coverageOptimalityProven: true,
      loadUnits: {
        normalRequiredUnits: days.reduce((sum, d) => sum + d.totals.requiredTasks, 0),
        fixedRequiredUnits: 0,
        fixedCoveredUnits: 0,
        fixedUncoveredUnits: 0,
        totalRequiredLoadUnits: days.reduce((sum, d) => sum + d.totals.requiredTasks, 0),
        aggregateTeacherCapacity: 6,
        aggregateCapacitySlack: 2,
        rawTaskCells: days.reduce((sum, d) => sum + d.totals.requiredTasks, 0),
        malformedFixedGroups: [],
      },
    },
    ...overrides,
  };
}

describe("DutyPlanFeasibilityPage", () => {
  beforeEach(() => {
    vi.spyOn(api, "fetchDutyPlanFeasibility");
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("1) yüklenirken aria-busy gösterir", () => {
    vi.mocked(api.fetchDutyPlanFeasibility).mockReturnValue(new Promise(() => {}));
    render(<DutyPlanFeasibilityPage />);
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it("2) hata durumunda hata kartı ve Tekrar Dene gösterir", async () => {
    vi.mocked(api.fetchDutyPlanFeasibility).mockRejectedValue(new api.DutyPlanFeasibilityFetchError("500"));
    render(<DutyPlanFeasibilityPage />);

    expect(await screen.findByText("Planlanabilirlik analizi alınamadı.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /tekrar dene/i })).toBeInTheDocument();
  });

  it("3) import yoksa yönlendirici mesaj gösterir", async () => {
    vi.mocked(api.fetchDutyPlanFeasibility).mockResolvedValue({ hasImport: false });
    render(<DutyPlanFeasibilityPage />);

    expect(await screen.findByText(/önce bir XML ders programı yükleyin/)).toBeInTheDocument();
  });

  it("4) haftalık solver tüm görevleri karşılıyorsa olumlu karar gösterir", async () => {
    vi.mocked(api.fetchDutyPlanFeasibility).mockResolvedValue(response());
    render(<DutyPlanFeasibilityPage />);

    expect(await screen.findByText("Haftalık kurallarla tüm görevler karşılanabiliyor.")).toBeInTheDocument();
  });

  it("5) açık varsa eksik görev sayısını ve eksik günleri gösterir", async () => {
    vi.mocked(api.fetchDutyPlanFeasibility).mockResolvedValue(
      response({
        days: [
          day({
            totals: { ...day().totals, coveredTasks: 2, uncoveredTasks: 2 },
            blocks: [blockSummary({ matchingUncovered: 2 }), blockSummary({ blockId: BLK_LONG1, blockCode: "LONG_BREAK_1", blockOrder: 2 })],
          }),
        ],
      }),
    );
    render(<DutyPlanFeasibilityPage />);

    expect(await screen.findByText("Haftalık kurallar altında 2 görev açık kalıyor.")).toBeInTheDocument();
  });

  it("6) 'eşleştirme darboğazı' yalnız naif sayımın açığı görmediği durumda gösterilir", async () => {
    // independentShortfall = 0 (blok tek başına yeterli görünüyor) ama
    // matchingUncovered > 0 (öğretmen günde tek blok alabildiği için gerçek
    // açık var) — bu ayrımı göstermek analizin varlık sebebi.
    vi.mocked(api.fetchDutyPlanFeasibility).mockResolvedValue(
      response({
        days: [
          day({
            totals: { ...day().totals, coveredTasks: 3, uncoveredTasks: 1 },
            blocks: [
              blockSummary({ independentShortfall: 0, matchingUncovered: 1 }),
              blockSummary({ blockId: BLK_LONG1, blockCode: "LONG_BREAK_1", blockOrder: 2, independentShortfall: 1, matchingUncovered: 1 }),
            ],
          }),
        ],
      }),
    );
    render(<DutyPlanFeasibilityPage />);

    // Yalnız BİR blokta gösterilir (independentShortfall=1 olan blokta değil).
    expect(await screen.findAllByText("eşleştirme darboğazı")).toHaveLength(1);
  });

  it("7) gün ayrıntısı açılınca eksik sabit atamalar, ders çakışmaları ve karşılanamayan görevler listelenir", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyPlanFeasibility).mockResolvedValue(
      response({
        days: [
          day({
            totals: { ...day().totals, coveredTasks: 2, uncoveredTasks: 2 },
            missingFixedAssignments: [
              {
                dutyLocationId: "loc-fixed",
                dutyLocationName: "İlkokul 2. Kat",
                shortCode: "ILKOKUL2",
                blockCodes: ["MORNING_BREAKS", "AFTERNOON_BREAKS"],
              },
            ],
            excludedByLessonConflict: [
              { blockId: BLK_LONG1, blockCode: "LONG_BREAK_1", blockName: "Uzun Nöbet 1", periodName: "5-OO", teacherCount: 3 },
            ],
            uncoveredTasks: [
              {
                dutyLocationId: "loc-1",
                dutyLocationName: "Yemekhane",
                shortCode: "YEMEK",
                blockId: BLK_LONG1,
                blockCode: "LONG_BREAK_1",
                blockName: "Uzun Nöbet 1",
                kind: "normal",
                candidateCount: 0,
                reason: "no_candidate",
              },
              {
                dutyLocationId: "loc-fixed",
                dutyLocationName: "İlkokul 2. Kat",
                shortCode: "ILKOKUL2",
                blockId: BLK_MORNING,
                blockCode: "MORNING_BREAKS",
                blockName: "Sabah Teneffüs Bloğu",
                kind: "fixed",
                candidateCount: null,
                reason: "missing_fixed_assignment",
              },
            ],
          }),
        ],
      }),
    );
    render(<DutyPlanFeasibilityPage />);

    await user.click(await screen.findByRole("button", { name: /Pazartesi/ }));

    expect(screen.getByText("Eksik sabit atamalar")).toBeInTheDocument();
    expect(screen.getByText(/3 öğretmen bu blokta uygunluk beyan etmiş/)).toBeInTheDocument();

    // Sayfada iki tablo var: gün×blok özeti ve gün ayrıntısındaki
    // "karşılanamayan nöbet yerleri". İkincisi hedefleniyor.
    const detailTable = screen.getAllByRole("table")[1];
    const rows = within(detailTable).getAllByRole("row");
    // Başlık satırı + iki karşılanamayan görev.
    expect(rows).toHaveLength(3);
    expect(screen.getByText("Uygun öğretmen yok")).toBeInTheDocument();
    expect(screen.getByText("Sabit öğretmen atanmamış")).toBeInTheDocument();
  });

  it("10) yöntem metni sabitliği YER değil BLOK düzeyinde anlatır; yer adı hard-code edilmez", async () => {
    vi.mocked(api.fetchDutyPlanFeasibility).mockResolvedValue(response());
    render(<DutyPlanFeasibilityPage />);
    await screen.findByText("Haftalık kurallarla tüm görevler karşılanabiliyor.");

    const method = document.querySelector(".dpf-method") as HTMLElement;
    expect(method).toHaveTextContent("yer × blok");
    expect(method).toHaveTextContent(/yalnız\s+sabit\s+atamayla karşılanan bloklar normal aday üretmez/);
    // Eski model kalıntıları: yer adı hard-code'u ve "sabit nöbete uygun yer".
    expect(method.textContent ?? "").not.toMatch(/ilkokul/i);
    expect(method.textContent ?? "").not.toMatch(/koridor/i);
    expect(method.textContent ?? "").not.toMatch(/sabit nöbete uygun yer/i);
  });

  it("11) yöntem metni yarım gün kuralını AÇIK/KAPALI ayrımıyla anlatır; 'alt sınır' ifadesi kalmadı", async () => {
    vi.mocked(api.fetchDutyPlanFeasibility).mockResolvedValue(response());
    render(<DutyPlanFeasibilityPage />);
    await screen.findByText("Haftalık kurallarla tüm görevler karşılanabiliyor.");

    const text = ((document.querySelector(".dpf-method") as HTMLElement).textContent ?? "").replace(/\s+/g, " ");
    expect(text).toMatch(/açık öğretmen günde yalnız bir normal blok alabilir/);
    expect(text).toMatch(/kapalı öğretmen aynı gün farklı bloklarda görev alabilir/);
    expect(text).toMatch(/aynı blokta iki nöbet yerine atanamaz/);
    expect(text).toMatch(/sabit nöbeti olan öğretmen, kural açık ya da kapalı olsun, hiçbir normal görev almaz/);
    // Backend artık kapalı öğretmenlerin blok kapasitesini GERÇEKTEN
    // hesapladığı için "temkinli alt sınır" açıklaması kaldırıldı.
    expect(text).not.toMatch(/alt sınır/i);
    expect(text).not.toMatch(/Bir öğretmen aynı gün yalnız bir normal blok alabilir/);
  });

  it("15) kapsam açıklaması ana kararın haftalık sınırı uyguladığını, gün tablosunun bağımsız olduğunu söyler", async () => {
    vi.mocked(api.fetchDutyPlanFeasibility).mockResolvedValue(response());
    render(<DutyPlanFeasibilityPage />);
    await screen.findByText("Haftalık kurallarla tüm görevler karşılanabiliyor.");

    const scope = ((document.querySelector(".dpf-scope") as HTMLElement).textContent ?? "").replace(/\s+/g, " ");
    expect(scope).toMatch(/Ana karar.*haftalık üst sınırı kullanan salt-okunur solver önizlemesidir/i);
    expect(scope).toMatch(/günleri birbirinden bağımsız gösteren tanı aracıdır/i);
    expect(scope).toMatch(/en az 1, hedef 2, en fazla 3 görev/i);
  });

  it("16) günlük analiz tam görünse bile haftalık kapasite açığını ana karar olarak gösterir", async () => {
    vi.mocked(api.fetchDutyPlanFeasibility).mockResolvedValue(
      response({
        weeklyCapacity: {
          ...(response() as Extract<DutyPlanFeasibilityResponse, { hasImport: true }>).weeklyCapacity,
          normalMaxCoverableCount: 2,
          totalMaxCoverableCount: 2,
          totalUncoveredCount: 2,
          feasible: false,
          loadUnits: {
            ...(response() as Extract<DutyPlanFeasibilityResponse, { hasImport: true }>).weeklyCapacity.loadUnits,
            aggregateTeacherCapacity: 3,
            totalRequiredLoadUnits: 4,
            aggregateCapacitySlack: -1,
          },
        },
      }),
    );
    render(<DutyPlanFeasibilityPage />);

    expect(await screen.findByText("Haftalık kurallar altında 2 görev açık kalıyor.")).toBeInTheDocument();
    expect(screen.getAllByText("4/4").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("2/4")).toBeInTheDocument();
  });

  it("12) periyot tanımı eksikliği AYRI bölümde gösterilir, ders çakışması sayılmaz", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyPlanFeasibility).mockResolvedValue(
      response({
        days: [
          day({
            excludedByConfigurationError: [
              { blockId: BLK_LONG1, blockCode: "LONG_BREAK_1", blockName: "Uzun Nöbet 1", periodName: "5-OO", teacherCount: 4 },
            ],
          }),
        ],
      }),
    );
    render(<DutyPlanFeasibilityPage />);
    await user.click(await screen.findByRole("button", { name: /Pazartesi/ }));

    const heading = screen.getByText("Periyot tanımı eksik olduğu için elenenler");
    expect(heading).toBeInTheDocument();
    const section = heading.closest("section") as HTMLElement;
    expect(within(section).getByText(/4 öğretmen bu blokta uygunluk beyan etmiş/)).toBeInTheDocument();
    expect(within(section).getByText(/Bu bir ders çakışması değildir/)).toBeInTheDocument();

    // Ders çakışması bölümü HİÇ açılmaz (o listede kayıt yok).
    expect(screen.queryByText("Ders çakışması nedeniyle elenenler")).not.toBeInTheDocument();
  });

  it("13) iki liste birlikte geldiğinde ayrı bölümlerde ve karışmadan gösterilir", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyPlanFeasibility).mockResolvedValue(
      response({
        days: [
          day({
            excludedByLessonConflict: [
              { blockId: BLK_LONG1, blockCode: "LONG_BREAK_1", blockName: "Uzun Nöbet 1", periodName: "5-OO", teacherCount: 3 },
            ],
            excludedByConfigurationError: [
              { blockId: BLK_MORNING, blockCode: "MORNING_BREAKS", blockName: "Sabah Teneffüs Bloğu", periodName: "1", teacherCount: 2 },
            ],
          }),
        ],
      }),
    );
    render(<DutyPlanFeasibilityPage />);
    await user.click(await screen.findByRole("button", { name: /Pazartesi/ }));

    const conflict = screen.getByText("Ders çakışması nedeniyle elenenler").closest("section") as HTMLElement;
    const config = screen.getByText("Periyot tanımı eksik olduğu için elenenler").closest("section") as HTMLElement;
    expect(conflict).not.toBe(config);
    expect(within(conflict).getByText(/dersi olduğu için aday olamıyor/)).toBeInTheDocument();
    expect(within(conflict).queryByText(/tanımı güncel ders programında bulunamadığı/)).not.toBeInTheDocument();
    expect(within(config).getByText(/tanımı güncel ders programında bulunamadığı/)).toBeInTheDocument();
    expect(within(config).queryByText(/dersi olduğu için aday olamıyor/)).not.toBeInTheDocument();
  });

  it("14) teacherCount=0 olan konfigürasyon kaydı bölümü AÇMAZ", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyPlanFeasibility).mockResolvedValue(
      response({
        days: [
          day({
            excludedByConfigurationError: [
              { blockId: BLK_LONG1, blockCode: "LONG_BREAK_1", blockName: "Uzun Nöbet 1", periodName: "5-OO", teacherCount: 0 },
            ],
          }),
        ],
      }),
    );
    render(<DutyPlanFeasibilityPage />);
    await user.click(await screen.findByRole("button", { name: /Pazartesi/ }));

    expect(screen.queryByText("Periyot tanımı eksik olduğu için elenenler")).not.toBeInTheDocument();
  });

  it("8) 'Yeniden Analiz Et' veriyi tekrar çeker", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyPlanFeasibility).mockResolvedValue(response());
    render(<DutyPlanFeasibilityPage />);

    await screen.findByText("Haftalık kurallarla tüm görevler karşılanabiliyor.");
    await user.click(screen.getByRole("button", { name: /Yeniden Analiz Et/ }));

    expect(api.fetchDutyPlanFeasibility).toHaveBeenCalledTimes(2);
  });

  it("9) sayfa hiçbir yazma eylemi sunmaz (plan üretme/kaydetme butonu yok)", async () => {
    vi.mocked(api.fetchDutyPlanFeasibility).mockResolvedValue(response());
    render(<DutyPlanFeasibilityPage />);

    await screen.findByText("Haftalık kurallarla tüm görevler karşılanabiliyor.");
    for (const label of [/kaydet/i, /plan oluştur/i, /ata/i, /sil/i]) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
  });
});
