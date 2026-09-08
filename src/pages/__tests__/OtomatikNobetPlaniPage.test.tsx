import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import OtomatikNobetPlaniPage from "../OtomatikNobetPlaniPage";
import * as api from "../../lib/dutyPlanDrafts/api";
import { GenerateDutyPlanDraftApiError, SetDutyPlanManualPackageApiError } from "../../lib/dutyPlanDrafts/api";
import type {
  DutyPlanDraftAssignmentDto,
  DutyPlanDraftDto,
  DutyPlanDraftPackageDto,
  DutyPlanGenerationSnapshot,
  ManualPackageAffectedTaskDto,
  PreviewDutyPlanManualPackageResult,
  TaskCandidateDto,
  TaskCandidatesDto,
} from "../../lib/dutyPlanDrafts/types";

const BLOCK_MORNING = "blk-morning";
const BLOCK_LONG1 = "blk-long1";
const BLOCK_LONG2 = "blk-long2";
const BLOCK_AFTERNOON = "blk-afternoon";
const LOC_A = "loc-a";
const LOC_B = "loc-b";

function blocks() {
  return [
    { id: BLOCK_MORNING, code: "MORNING_BREAKS" as const, name: "Sabah Teneffüs Bloğu", blockOrder: 1, conflictPeriodName: null },
    { id: BLOCK_LONG1, code: "LONG_BREAK_1" as const, name: "Uzun Nöbet 1", blockOrder: 2, conflictPeriodName: "5-OO" },
    { id: BLOCK_LONG2, code: "LONG_BREAK_2" as const, name: "Uzun Nöbet 2", blockOrder: 3, conflictPeriodName: "5-IO" },
    { id: BLOCK_AFTERNOON, code: "AFTERNOON_BREAKS" as const, name: "Öğleden Sonra Teneffüs Bloğu", blockOrder: 4, conflictPeriodName: null },
  ];
}

function days() {
  return [
    { order: 1, name: "Pazartesi" },
    { order: 2, name: "Salı" },
    { order: 3, name: "Çarşamba" },
    { order: 4, name: "Perşembe" },
    { order: 5, name: "Cuma" },
  ];
}

function feasibleSnapshot(overrides: Partial<Extract<DutyPlanGenerationSnapshot, { hasImport: true }>> = {}): DutyPlanGenerationSnapshot {
  const d = days();
  return {
    hasImport: true,
    campusId: "campus-1",
    academicYearId: "year-1",
    timetableImportId: "import-1",
    importedAt: "2026-09-01T10:00:00.000Z",
    sourceFingerprint: "a".repeat(64),
    days: d,
    blocks: blocks(),
    tasks: [
      {
        dayOrder: 1,
        dutyLocationId: LOC_A,
        dutyLocationName: "Bahçe A",
        shortCode: "BAHCEA",
        category: "garden",
        dutyBlockId: BLOCK_LONG1,
        blockCode: "LONG_BREAK_1",
        blockName: "Uzun Nöbet 1",
        blockOrder: 2,
        kind: "normal",
        fixedCoveredByTeacherSourceId: null,
        fixedCoveredByTeacherName: null,
      },
    ],
    teachers: [
      { teacherSourceId: "T1", teacherName: "Ayşe Yılmaz" },
      { teacherSourceId: "T2", teacherName: "Can Demir" },
    ],
    candidateEdges: [{ dayOrder: 1, dutyLocationId: LOC_A, dutyBlockId: BLOCK_LONG1, teacherSourceId: "T1", teacherName: "Ayşe Yılmaz" }],
    teacherFixedDutyLoads: [],
    feasibility: {
      hasImport: true,
      days: d.map((day) => ({
        order: day.order,
        name: day.name,
        totals: {
          requiredTasks: 1,
          coveredTasks: 1,
          uncoveredTasks: 0,
          fixedRequired: 0,
          fixedCovered: 0,
          fixedMissing: 0,
          normalRequired: 1,
          normalMatched: 1,
          normalUncovered: 0,
          candidateTeacherCount: 1,
        },
      })),
      summary: { totalRequiredTasks: 5, totalCoveredTasks: 5, totalUncoveredTasks: 0, daysWithShortfall: [], feasible: true },
    },
    configurationErrors: [],
    ...overrides,
  };
}

function draftAssignment(overrides: Partial<DutyPlanDraftAssignmentDto> = {}): DutyPlanDraftAssignmentDto {
  return {
    id: `a-${Math.random()}`,
    dayOrder: 1,
    dutyLocationId: LOC_A,
    dutyLocationName: "Bahçe A",
    dutyBlockId: BLOCK_MORNING,
    dutyBlockName: "Sabah Teneffüs Bloğu",
    teacherSourceId: "T1",
    teacherName: "Ayşe Yılmaz",
    assignmentKind: "generated" as const,
    fixedDutyAssignmentId: null,
    packageId: null,
    scoreDetails: {},
    ...overrides,
  };
}

function foundDraft(overrides: Partial<Extract<DutyPlanDraftDto, { found: true }>> = {}): DutyPlanDraftDto {
  return {
    found: true,
    id: "plan-1",
    status: "draft",
    timetableImportId: "import-1",
    sourceFingerprint: "a".repeat(64),
    savedSourceFingerprint: "a".repeat(64),
    currentSourceFingerprint: "a".repeat(64),
    isStale: false,
    algorithmVersion: "duty-plan-solver-v1",
    generationSeed: null,
    generationOptions: { minWeeklyDuties: 1, targetWeeklyDuties: 2, maxWeeklyDuties: 3, balanceWorkload: true, diversifyAreas: true, allowPartial: true },
    summary: {
      totalTaskCount: 1,
      fixedTaskCount: 0,
      fixedCoveredCount: 0,
      normalTaskCount: 1,
      normalCoveredCount: 1,
      uncoveredCount: 0,
      teacherLoads: [{ teacherSourceId: "T1", normalDutyCount: 1, fixedDutyDayCount: 0, totalDutyCount: 1 }],
      warnings: [],
      optimalityProven: true,
      searchLimitReached: false,
      exploredNodeCount: 1,
      cellOnlyBaselineCoverage: 1,
    },
    version: 1,
    createdAt: "2026-09-10T09:00:00.000Z",
    updatedAt: "2026-09-10T09:00:00.000Z",
    assignments: [draftAssignment()],
    packages: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(api, "fetchCurrentDutyPlanDraft");
  vi.spyOn(api, "fetchDutyPlanPreparation");
  vi.spyOn(api, "generateDutyPlanDraft");
  vi.spyOn(api, "deleteDutyPlanDraft");
  vi.spyOn(api, "regenerateDutyPlanDraft");
  vi.spyOn(api, "publishDutyPlanDraft");
  vi.spyOn(api, "updateDutyPlanAssignment");
  vi.spyOn(api, "previewDutyPlanManualPackage");
  vi.spyOn(api, "setDutyPlanManualPackage");
  // Aday listesi AUTHORITATIVE RPC'den gelir; varsayılan olarak boş liste.
  vi.spyOn(api, "fetchDutyPlanTaskCandidates").mockResolvedValue(taskCandidates([]));
});

/** get_duty_plan_task_candidates yanıtı — panel adayları BUNDAN okur. */
function taskCandidates(candidates: TaskCandidateDto[], overrides: Record<string, unknown> = {}): TaskCandidatesDto {
  return {
    found: true,
    taskFound: true,
    planStatus: "draft",
    planVersion: 1,
    isFixed: false,
    currentAssignment: { teacherSourceId: "T1", teacherName: "Ayşe Yılmaz", assignmentKind: "generated" },
    isStale: false,
    currentSourceFingerprint: "a".repeat(64),
    candidates,
    ...overrides,
  } as TaskCandidatesDto;
}

function candidate(overrides: Partial<TaskCandidateDto> = {}): TaskCandidateDto {
  return { teacherSourceId: "T2", teacherName: "Mehmet Demir", isCurrent: false, eligible: true, reasons: [], ...overrides };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OtomatikNobetPlaniPage — yükleme/hata/boş durumlar", () => {
  it("1) yüklenirken iskelet gösterir", () => {
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.fetchDutyPlanPreparation).mockReturnValue(new Promise(() => {}));
    render(<OtomatikNobetPlaniPage />);
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it("2) API hatasında yeniden dene ile kurtarır", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ found: false });
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(feasibleSnapshot());
    render(<OtomatikNobetPlaniPage />);
    await screen.findByRole("alert");
    expect(screen.getByText("Veriler alınamadı.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Tekrar Dene/i }));
    await screen.findByText("Otomatik Nöbet Planı");
    expect(await screen.findByText("Taslak Üret")).toBeInTheDocument();
  });

  it("3) import yokken boş durum gösterir", async () => {
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue({ found: false });
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue({ hasImport: false });
    render(<OtomatikNobetPlaniPage />);
    expect(await screen.findByText(/İçe aktarılmış bir ders programı yok/)).toBeInTheDocument();
  });
});

describe("OtomatikNobetPlaniPage — Aşama A (hazırlık)", () => {
  it("4) karşılanabilir plan: 'Taslak Üret' gösterir, sayılar API'den dinamik gelir", async () => {
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue({ found: false });
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(feasibleSnapshot());
    render(<OtomatikNobetPlaniPage />);

    expect(await screen.findByRole("button", { name: "Taslak Üret" })).toBeEnabled();
    expect(screen.getByText("Plana dahil öğretmen").previousSibling).toHaveTextContent("2");
    expect(screen.getByText("Haftalık görev").previousSibling).toHaveTextContent("1");
    expect(screen.queryByText("Eksiklerle Taslak Üret")).not.toBeInTheDocument();
  });

  it("5) karşılanamayan görev varsa uyarı + 'Eksiklerle Taslak Üret' gösterir", async () => {
    const snapshot = feasibleSnapshot();
    if (snapshot.hasImport) {
      snapshot.feasibility.summary!.feasible = false;
      snapshot.feasibility.summary!.totalUncoveredTasks = 3;
    }
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue({ found: false });
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(snapshot);
    render(<OtomatikNobetPlaniPage />);

    expect(await screen.findByText(/teorik kapsamada 3 görev karşılanamıyor/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Eksiklerle Taslak Üret" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Taslak Üret" })).not.toBeInTheDocument();
  });

  it("6) period_configuration_missing varsa üretme butonu devre dışı", async () => {
    const snapshot = feasibleSnapshot({
      configurationErrors: [{ dayOrder: 1, blockCode: "LONG_BREAK_1", blockName: "Uzun Nöbet 1", periodName: "5-OO", teacherCount: 2 }],
    });
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue({ found: false });
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(snapshot);
    render(<OtomatikNobetPlaniPage />);

    const button = await screen.findByRole("button", { name: /Taslak Üret/i });
    expect(button).toBeDisabled();
  });

  it("7) seçili hafta/günlerle taslak üretir ve başarılı olunca Aşama B'ye geçer", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValueOnce({ found: false }).mockResolvedValueOnce(foundDraft());
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(feasibleSnapshot());
    vi.mocked(api.generateDutyPlanDraft).mockResolvedValue({
      status: "ok",
      planId: "plan-1",
      version: 1,
      sourceFingerprint: "a".repeat(64),
      createdAt: "2026-09-10T09:00:00.000Z",
      updatedAt: "2026-09-10T09:00:00.000Z",
      summary: {
        totalTaskCount: 1,
        fixedTaskCount: 0,
        fixedCoveredCount: 0,
        normalTaskCount: 1,
        normalCoveredCount: 1,
        uncoveredCount: 0,
        teacherLoads: [],
        warnings: [],
        optimalityProven: true,
        searchLimitReached: false,
        exploredNodeCount: 1,
        cellOnlyBaselineCoverage: 1,
        optionsUsed: { minWeeklyDuties: 1, targetWeeklyDuties: 2, maxWeeklyDuties: 3, balanceWorkload: true, diversifyAreas: true, allowPartial: true },
      },
    });
    render(<OtomatikNobetPlaniPage />);

    const weekdayPicker = await screen.findByLabelText("Planlanacak günler");
    await user.click(within(weekdayPicker).getByText("Cuma").closest("button")!);
    await user.click(await screen.findByRole("button", { name: "Taslak Üret" }));
    expect(await screen.findByText("Atanan normal görev")).toBeInTheDocument();
    expect(api.generateDutyPlanDraft).toHaveBeenCalledWith(expect.objectContaining({
      expectedPlanId: null,
      weekStartDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      activeDayOrders: [1, 2, 3, 4],
    }));
  });

  it("7a) bütün günler kapatılırsa üretimi engeller", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue({ found: false });
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(feasibleSnapshot());
    render(<OtomatikNobetPlaniPage />);
    const weekdayPicker = await screen.findByLabelText("Planlanacak günler");
    for (const day of days()) await user.click(within(weekdayPicker).getByText(day.name).closest("button")!);
    expect(screen.getByText("En az bir gün seçin.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Taslak Üret" })).toBeDisabled();
  });

  it("8) üretim reddedilirse hata gösterir, Aşama A'da kalır", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue({ found: false });
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(feasibleSnapshot());
    vi.mocked(api.generateDutyPlanDraft).mockRejectedValue(new GenerateDutyPlanDraftApiError({ status: "source_changed", message: "Kaynak veri değişti." }));
    render(<OtomatikNobetPlaniPage />);

    await user.click(await screen.findByRole("button", { name: "Taslak Üret" }));
    expect(await screen.findByText("Kaynak veri değişti.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Taslak Üret" })).toBeInTheDocument();
  });

  it("8a) Sabah ve Öğleden Sonra tek taraflı açıksa yapılandırmayı engeller", async () => {
    const snapshot = feasibleSnapshot();
    if (!snapshot.hasImport) throw new Error("fixture import içermeli");
    snapshot.tasks = [{
      ...snapshot.tasks[0]!,
      dutyBlockId: BLOCK_MORNING,
      blockCode: "MORNING_BREAKS",
      blockName: "Sabah Teneffüs Bloğu",
      blockOrder: 1,
    }];
    snapshot.candidateEdges = [{
      dayOrder: 1,
      dutyLocationId: LOC_A,
      dutyBlockId: BLOCK_MORNING,
      teacherSourceId: "T1",
      teacherName: "Ayşe Yılmaz",
    }];
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue({ found: false });
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(snapshot);

    render(<OtomatikNobetPlaniPage />);

    expect(await screen.findByText(/Sabah ve Öğleden Sonra birlikte açık değil/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Taslak Üret" })).toBeDisabled();
  });

  it("8b) üçlü paket kapasitesini ve haftalık sert tavan 3'ü açıkça gösterir", async () => {
    const snapshot = feasibleSnapshot({ teachers: [], candidateEdges: [] });
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue({ found: false });
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(snapshot);

    render(<OtomatikNobetPlaniPage />);

    expect(await screen.findByText(/En az 1 paket açık kalacaktır/)).toBeInTheDocument();
    expect(screen.getByText(/hiçbir öğretmene dördüncü nöbet verilmeyecek/)).toBeInTheDocument();
    expect(screen.getByLabelText("Max")).toHaveAttribute("max", "3");
  });
});

describe("OtomatikNobetPlaniPage — Aşama B (taslak inceleme)", () => {
  async function renderStageB(draft: DutyPlanDraftDto) {
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue(draft);
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(feasibleSnapshot());
    render(<OtomatikNobetPlaniPage />);
    await screen.findByText("Atanan normal görev");
  }

  it("9) tamamlanmış taslak: sayfa doğrudan Aşama B'de açılır, kaynak 'güncel' rozetini gösterir", async () => {
    await renderStageB(foundDraft());
    expect(screen.getByText("Kaynak güncel")).toBeInTheDocument();
    expect(screen.queryByRole("alert", { name: /kaynak/i })).not.toBeInTheDocument();
  });

  it("10) bayat (stale) taslakta uyarı ve rozet gösterir", async () => {
    await renderStageB(foundDraft({ isStale: true, currentSourceFingerprint: "b".repeat(64) }));
    expect(screen.getByText("Kaynak veriler değişti")).toBeInTheDocument();
    expect(screen.getByText(/bu taslak üretildikten sonra değişti/)).toBeInTheDocument();
  });

  it("11) kısmi (açık görevli) taslakta gün sekmesi ve hücre 'Öğretmen bulunamadı' gösterir", async () => {
    await renderStageB(
      foundDraft({
        assignments: [draftAssignment({ assignmentKind: "unassigned", teacherSourceId: null, teacherName: null })],
        summary: { totalTaskCount: 1, fixedTaskCount: 0, fixedCoveredCount: 0, normalTaskCount: 1, normalCoveredCount: 0, uncoveredCount: 1, teacherLoads: [], warnings: [] },
      }),
    );
    expect(screen.getByText("Öğretmen bulunamadı")).toBeInTheDocument();
    expect(screen.getAllByText("Açık görev")[0]).toBeInTheDocument();
  });

  it("12) sabit hücre kilit ikonu + öğretmen adıyla gösterilir, tıklanınca 'Manuel'/'Uygun tercih' değil sabit bilgisi açılır", async () => {
    const user = userEvent.setup();
    await renderStageB(
      foundDraft({
        assignments: [draftAssignment({ assignmentKind: "fixed", teacherSourceId: "T1", teacherName: "Ayşe Yılmaz", fixedDutyAssignmentId: "fixed-1" })],
      }),
    );
    const cell = screen.getByRole("button", { name: /sabit, Ayşe Yılmaz/i });
    await user.click(cell);
    expect(await screen.findByText(/sabit, değiştirilemez/)).toBeInTheDocument();
  });

  it("13) otomatik atanan hücre 'Uygun tercih' etiketiyle gösterilir", async () => {
    await renderStageB(foundDraft());
    expect(screen.getByText("Uygun tercih")).toBeInTheDocument();
  });

  it("14) gün sekmesi değiştirilince tablo o günün verisini gösterir", async () => {
    const user = userEvent.setup();
    await renderStageB(
      foundDraft({
        assignments: [
          draftAssignment({ id: "a1", dayOrder: 1, dutyLocationName: "Bahçe A" }),
          draftAssignment({ id: "a2", dayOrder: 2, dutyLocationId: LOC_B, dutyLocationName: "Bahçe B", teacherSourceId: "T2", teacherName: "Can Demir" }),
        ],
      }),
    );
    expect(screen.getByText("Bahçe A")).toBeInTheDocument();
    expect(screen.queryByText("Bahçe B")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /Salı/i }));
    expect(screen.getByText("Bahçe B")).toBeInTheDocument();
    expect(screen.queryByText("Bahçe A")).not.toBeInTheDocument();
  });

  it("15) hücre seçilince detay paneli açılır; uygun/uygun olmayan öğretmenleri listeler; Escape ile kapanır", async () => {
    const user = userEvent.setup();
    await renderStageB(foundDraft());

    vi.mocked(api.fetchDutyPlanTaskCandidates).mockResolvedValue(
      taskCandidates([candidate({ teacherSourceId: "T1", teacherName: "Ayşe Yılmaz", isCurrent: true })]),
    );
    await user.click(screen.getByRole("button", { name: /Ayşe Yılmaz/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Uygun öğretmenler (1)")).toBeInTheDocument();
    expect(within(dialog).getAllByText(/Ayşe Yılmaz/).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/Uygun olmayan öğretmenler/)).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("16) 'Aynı Ayarlarla Yeniden Üret' expectedPlanVersion'ı mevcut plan versiyonuyla gönderir (manuel atama yoksa doğrudan)", async () => {
    const user = userEvent.setup();
    await renderStageB(foundDraft());
    vi.mocked(api.regenerateDutyPlanDraft).mockResolvedValue({
      status: "ok",
      planId: "plan-2",
      version: 2,
      sourceFingerprint: "a".repeat(64),
      createdAt: "now",
      updatedAt: "now",
      summary: {
        totalTaskCount: 1,
        fixedTaskCount: 0,
        fixedCoveredCount: 0,
        normalTaskCount: 1,
        normalCoveredCount: 1,
        uncoveredCount: 0,
        teacherLoads: [],
        warnings: [],
        optimalityProven: true,
        searchLimitReached: false,
        exploredNodeCount: 1,
        cellOnlyBaselineCoverage: 1,
        optionsUsed: { minWeeklyDuties: 1, targetWeeklyDuties: 2, maxWeeklyDuties: 3, balanceWorkload: true, diversifyAreas: true, allowPartial: true },
      },
    });
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValueOnce(foundDraft()).mockResolvedValue(foundDraft({ id: "plan-2" }));

    await user.click(screen.getByRole("button", { name: /Aynı Ayarlarla Yeniden Üret/i }));
    expect(api.regenerateDutyPlanDraft).toHaveBeenCalledWith("plan-1", expect.objectContaining({ expectedPlanVersion: 1, wipeManualAssignments: false }));
  });

  it("16b) manuel atama varken yeniden üretme önce kilitli/sıfırdan onayı ister", async () => {
    const user = userEvent.setup();
    const draftWithManual = foundDraft({ assignments: [draftAssignment({ assignmentKind: "manual" })] });
    await renderStageB(draftWithManual);
    vi.mocked(api.regenerateDutyPlanDraft).mockResolvedValue({
      status: "ok",
      planId: "plan-2",
      version: 2,
      sourceFingerprint: "a".repeat(64),
      createdAt: "now",
      updatedAt: "now",
      summary: {
        totalTaskCount: 1,
        fixedTaskCount: 0,
        fixedCoveredCount: 0,
        normalTaskCount: 1,
        normalCoveredCount: 1,
        uncoveredCount: 0,
        teacherLoads: [],
        warnings: [],
        optimalityProven: true,
        searchLimitReached: false,
        exploredNodeCount: 1,
        cellOnlyBaselineCoverage: 1,
        optionsUsed: { minWeeklyDuties: 1, targetWeeklyDuties: 2, maxWeeklyDuties: 3, balanceWorkload: true, diversifyAreas: true, allowPartial: true },
      },
    });
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValueOnce(draftWithManual).mockResolvedValue(foundDraft({ id: "plan-2" }));

    await user.click(screen.getByRole("button", { name: /Aynı Ayarlarla Yeniden Üret/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(api.regenerateDutyPlanDraft).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: /Manuel Atamaları Koru/i }));
    expect(api.regenerateDutyPlanDraft).toHaveBeenCalledWith("plan-1", expect.objectContaining({ wipeManualAssignments: false }));
  });

  it("17) 'Taslağı İptal Et' onay ister; onaylanınca siler ve Aşama A'ya döner", async () => {
    const user = userEvent.setup();
    await renderStageB(foundDraft());
    vi.mocked(api.deleteDutyPlanDraft).mockResolvedValue(undefined);
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue({ found: false });

    await user.click(screen.getByRole("button", { name: /Taslağı İptal Et/i }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /Evet, İptal Et/i }));

    expect(api.deleteDutyPlanDraft).toHaveBeenCalledWith("plan-1");
    expect(await screen.findByRole("button", { name: "Taslak Üret" })).toBeInTheDocument();
  });

  it("18) açık görev yokken Yayımla butonu etkin, tıklanınca onay ister ve doğru versiyonla çağrılır", async () => {
    const user = userEvent.setup();
    await renderStageB(foundDraft());
    vi.mocked(api.publishDutyPlanDraft).mockResolvedValue({ status: "ok", planId: "plan-1", version: 2, publishedAt: "now", archivedPreviousPlanId: null });
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue({ found: false });

    const publishBtn = screen.getByRole("button", { name: /Yayımla/i });
    expect(publishBtn).toBeEnabled();
    await user.click(publishBtn);
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /Evet, Yayımla/i }));
    expect(api.publishDutyPlanDraft).toHaveBeenCalledWith("plan-1", { expectedPlanVersion: 1 });
  });

  it("18b) açık görev varken Yayımla butonu devre dışıdır", async () => {
    const openDraft = foundDraft({ assignments: [draftAssignment({ assignmentKind: "unassigned", teacherSourceId: null, teacherName: null })] });
    await renderStageB(openDraft);
    expect(screen.getByRole("button", { name: /Yayımla/i })).toBeDisabled();
  });

  it("18c) hücre detayında uygun bir öğretmene tıklamak manuel atama isteği gönderir", async () => {
    const user = userEvent.setup();
    await renderStageB(foundDraft({ assignments: [draftAssignment({ assignmentKind: "unassigned", teacherSourceId: null, teacherName: null })] }));
    vi.mocked(api.updateDutyPlanAssignment).mockResolvedValue({
      status: "ok",
      version: 2,
      assignment: { taskId: "a-1", dayOrder: 1, dutyLocationId: LOC_A, dutyBlockId: BLOCK_MORNING, teacherSourceId: "T1", teacherName: "Ayşe Yılmaz", assignmentKind: "manual" },
      summary: {},
    });
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue(foundDraft({ assignments: [draftAssignment({ assignmentKind: "manual" })] }));
    vi.mocked(api.fetchDutyPlanTaskCandidates).mockResolvedValue(
      taskCandidates([candidate({ teacherSourceId: "T1", teacherName: "Ayşe Yılmaz" })], {
        currentAssignment: { teacherSourceId: null, teacherName: null, assignmentKind: "unassigned" },
      }),
    );

    await user.click(screen.getByText("Öğretmen bulunamadı"));
    await user.click(await screen.findByRole("button", { name: /Ayşe Yılmaz — bu blok için ata/i }));

    expect(api.updateDutyPlanAssignment).toHaveBeenCalledWith(
      "plan-1",
      expect.any(String),
      expect.objectContaining({ teacherSourceId: "T1", expectedPlanVersion: 1 }),
    );
  });
});

describe("OtomatikNobetPlaniPage — optimumluk rozeti (v1/v2 ile v3 ayrımı)", () => {
  async function renderWith(draft: DutyPlanDraftDto) {
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue(draft);
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(feasibleSnapshot());
    render(<OtomatikNobetPlaniPage />);
    await screen.findByText("Atanan normal görev");
  }

  it("v3 + diversifyAreas sezgiseli: 'düğüm bütçesi doldu' DEMEZ, kapsamanın kesin olduğunu söyler", async () => {
    const base = foundDraft() as Extract<DutyPlanDraftDto, { found: true }>;
    await renderWith(
      foundDraft({
        algorithmVersion: "duty-plan-solver-v3.0.0",
        summary: {
          ...base.summary,
          optimalityProven: false,
          searchLimitReached: false,
          v3: { optimalityReason: "diversification_heuristic", coverageOptimalityProven: true } as never,
        },
      }),
    );

    const badge = screen.getByText("Kapsama optimum — alan çeşitliliği sezgisel");
    expect(badge).toBeInTheDocument();
    expect(badge.getAttribute("title") ?? "").toMatch(/arama limiti dolmadı/i);
    expect(badge.getAttribute("title") ?? "").not.toMatch(/düğüm bütçesi/i);
    expect(screen.getByText("Kapsama kesin maksimum")).toBeInTheDocument();
  });

  it("v1 planda arama limiti metni KORUNUR (tarihsel taslaklar bozulmaz)", async () => {
    const base = foundDraft() as Extract<DutyPlanDraftDto, { found: true }>;
    await renderWith(
      foundDraft({
        algorithmVersion: "duty-plan-solver-v1",
        summary: { ...base.summary, optimalityProven: false, searchLimitReached: true, exploredNodeCount: 5000 },
      }),
    );

    const badge = screen.getByText("En iyi bulunan çözüm — optimumluk kanıtlanamadı");
    expect(badge.getAttribute("title") ?? "").toMatch(/Arama düğüm bütçesi \(5000\) doldu/);
    expect(screen.queryByText("Kapsama kesin maksimum")).not.toBeInTheDocument();
  });

  it("optimalityProven=true iken 'Optimum çözüm' rozeti görünür", async () => {
    await renderWith(foundDraft());
    expect(screen.getByText("Optimum çözüm")).toBeInTheDocument();
  });
});

describe("OtomatikNobetPlaniPage — detay paneli aday sınıflandırması (bulgu 1+2)", () => {
  const LOC_C = "loc-c";

  function classificationSnapshot(): DutyPlanGenerationSnapshot {
    const s = feasibleSnapshot();
    if (!s.hasImport) throw new Error("unreachable");
    s.teachers = [
      { teacherSourceId: "T1", teacherName: "Aday Ama Meşgul" },
      { teacherSourceId: "T2", teacherName: "Aday Ama Limitte" },
      { teacherSourceId: "T3", teacherName: "Mevcut Öğretmen" },
      { teacherSourceId: "T4", teacherName: "Aday Değil" },
      { teacherSourceId: "T5", teacherName: "Sıfır Yüklü Öğretmen" },
    ];
    // Hepsi (T4 hariç) LOC_A/day1/BLOCK_MORNING hücresi için temel aday.
    s.candidateEdges = [
      { dayOrder: 1, dutyLocationId: LOC_A, dutyBlockId: BLOCK_MORNING, teacherSourceId: "T1", teacherName: "Aday Ama Meşgul" },
      { dayOrder: 1, dutyLocationId: LOC_A, dutyBlockId: BLOCK_MORNING, teacherSourceId: "T2", teacherName: "Aday Ama Limitte" },
      { dayOrder: 1, dutyLocationId: LOC_A, dutyBlockId: BLOCK_MORNING, teacherSourceId: "T3", teacherName: "Mevcut Öğretmen" },
    ];
    return s;
  }

  function classificationDraft(): DutyPlanDraftDto {
    return foundDraft({
      generationOptions: { minWeeklyDuties: 0, targetWeeklyDuties: 2, maxWeeklyDuties: 3, balanceWorkload: true, diversifyAreas: true, allowPartial: true },
      assignments: [
        draftAssignment({ id: "cell-under-test", dayOrder: 1, dutyLocationId: LOC_A, dutyLocationName: "Bahçe A", dutyBlockId: BLOCK_MORNING, teacherSourceId: "T3", teacherName: "Mevcut Öğretmen" }),
        // T1 aday ama AYNI GÜN başka bir hücrede görevli.
        draftAssignment({ id: "a-t1-elsewhere", dayOrder: 1, dutyLocationId: LOC_C, dutyLocationName: "Bahçe C", dutyBlockId: BLOCK_LONG1, teacherSourceId: "T1", teacherName: "Aday Ama Meşgul" }),
      ],
      summary: {
        totalTaskCount: 2,
        fixedTaskCount: 0,
        fixedCoveredCount: 0,
        normalTaskCount: 2,
        normalCoveredCount: 2,
        uncoveredCount: 0,
        teacherLoads: [
          { teacherSourceId: "T1", normalDutyCount: 1, fixedDutyDayCount: 0, totalDutyCount: 1 },
          { teacherSourceId: "T2", normalDutyCount: 3, fixedDutyDayCount: 0, totalDutyCount: 3 },
          { teacherSourceId: "T3", normalDutyCount: 1, fixedDutyDayCount: 2, totalDutyCount: 3 },
          { teacherSourceId: "T5", normalDutyCount: 0, fixedDutyDayCount: 0, totalDutyCount: 0 },
        ],
        warnings: [],
      },
    });
  }

  /**
   * Aday listesi ARTIK tarayıcıda türetilmez. AUTHORITATIVE kaynak
   * get_duty_plan_task_candidates'tır; ekran onun gerekçelerini gösterir.
   */
  async function openWithCandidates(rows: TaskCandidateDto[], overrides: Record<string, unknown> = {}) {
    const user = userEvent.setup();
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue(classificationDraft());
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(classificationSnapshot());
    vi.mocked(api.fetchDutyPlanTaskCandidates).mockResolvedValue(taskCandidates(rows, overrides));
    render(<OtomatikNobetPlaniPage />);
    await screen.findByText("Atanan normal görev");
    await user.click(screen.getByRole("button", { name: /Mevcut Öğretmen/ }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/^Uygun öğretmenler/);
    return { user, dialog };
  }

  it("20) yarım gün gerekçesi half_day_daily_limit olarak gösterilir (eski 'o gün başka görevi var' DEĞİL)", async () => {
    const { dialog } = await openWithCandidates([
      candidate({ teacherSourceId: "T9", teacherName: "Yarım Gün Açık", eligible: false, reasons: ["half_day_daily_limit"] }),
    ]);
    const ineligibleSection = within(dialog).getByText(/Uygun olmayan öğretmenler/).closest("section")!;
    expect(within(ineligibleSection).getByText("Yarım Gün Açık")).toBeInTheDocument();
    expect(within(ineligibleSection).getByText("Yarım gün kuralı: o gün normal görev sınırına ulaşmış")).toBeInTheDocument();
    expect(within(ineligibleSection).queryByText("O gün başka normal görevi var")).not.toBeInTheDocument();
  });

  it("20b) yarım gün kuralı KAPALI öğretmen, aynı gün başka blokta görevli olsa bile UYGUN listesinde kalır", async () => {
    const { dialog } = await openWithCandidates([
      candidate({ teacherSourceId: "T8", teacherName: "Yarım Gün Kapalı", eligible: true, reasons: [] }),
    ]);
    const eligibleSection = within(dialog).getByText(/^Uygun öğretmenler/).closest("section")!;
    expect(within(eligibleSection).getByText(/Yarım Gün Kapalı/)).toBeInTheDocument();
    const ineligibleSection = within(dialog).getByText(/Uygun olmayan öğretmenler/).closest("section")!;
    expect(within(ineligibleSection).queryByText("Yarım Gün Kapalı")).not.toBeInTheDocument();
  });

  it("20c) aynı gün AYNI blokta başka yerde görevli aday already_assigned_same_block gerekçesini görür", async () => {
    const { dialog } = await openWithCandidates([
      candidate({ teacherSourceId: "T7", teacherName: "Ayni Blok Mesgul", eligible: false, reasons: ["already_assigned_same_block"] }),
    ]);
    const ineligibleSection = within(dialog).getByText(/Uygun olmayan öğretmenler/).closest("section")!;
    expect(within(ineligibleSection).getByText("Aynı gün aynı blokta başka yerde görevli")).toBeInTheDocument();
  });

  it("21) haftalık limite ulaşan aday weekly_limit_reached gösterir", async () => {
    const { dialog } = await openWithCandidates([
      candidate({ teacherSourceId: "T6", teacherName: "Aday Ama Limitte", eligible: false, reasons: ["weekly_limit_reached"] }),
    ]);
    const ineligibleSection = within(dialog).getByText(/Uygun olmayan öğretmenler/).closest("section")!;
    expect(within(ineligibleSection).getByText("Aday Ama Limitte")).toBeInTheDocument();
    expect(within(ineligibleSection).getByText("Haftalık üst sınıra ulaşmış")).toBeInTheDocument();
  });

  it("22) mevcut öğretmen GERÇEKTEN uygunsa (eligible=true) uygun listesinde 'mevcut' etiketiyle kalır", async () => {
    const { dialog } = await openWithCandidates([
      candidate({ teacherSourceId: "T1", teacherName: "Mevcut Öğretmen", isCurrent: true, eligible: true, reasons: [] }),
    ]);
    const eligibleSection = within(dialog).getByText(/^Uygun öğretmenler/).closest("section")!;
    const row = within(eligibleSection).getByText(/Mevcut Öğretmen/).closest("li") as HTMLElement;
    expect(row.textContent).toContain("(mevcut)");
    const ineligibleSection = within(dialog).getByText(/Uygun olmayan öğretmenler/).closest("section")!;
    expect(within(ineligibleSection).queryByText(/Mevcut Öğretmen/)).not.toBeInTheDocument();
  });

  it("22b) mevcut öğretmen eligible=false ise UYGUN listesine YAZILMAZ; 'mevcut atama' etiketi ve TÜM gerekçelerle uygun olmayanlarda çıkar", async () => {
    const { dialog } = await openWithCandidates([
      candidate({
        teacherSourceId: "T1",
        teacherName: "Mevcut Öğretmen",
        isCurrent: true,
        eligible: false,
        reasons: ["weekly_limit_reached", "half_day_daily_limit", "time_rule_violation"],
      }),
    ]);
    const eligibleSection = within(dialog).getByText(/^Uygun öğretmenler/).closest("section")!;
    expect(within(eligibleSection).queryByText(/Mevcut Öğretmen/)).not.toBeInTheDocument();
    expect(within(eligibleSection).getByText("Bu hücre için hiç uygun öğretmen yok.")).toBeInTheDocument();

    const ineligibleSection = within(dialog).getByText(/Uygun olmayan öğretmenler/).closest("section")!;
    const row = within(ineligibleSection).getByText(/Mevcut Öğretmen/).closest("li") as HTMLElement;
    expect(row.textContent).toContain("(mevcut atama)");
    expect(row.textContent).toContain("Haftalık üst sınıra ulaşmış");
    expect(row.textContent).toContain("Yarım gün kuralı: o gün normal görev sınırına ulaşmış");
    expect(row.textContent).toContain("Ders/zaman kuralı nedeniyle uygun değil");
  });

  it("23) birden çok gerekçe TAMAMI gösterilir, tek bir birleşik metne indirgenmez", async () => {
    const { dialog } = await openWithCandidates([
      candidate({
        teacherSourceId: "T5",
        teacherName: "Cok Gerekceli",
        eligible: false,
        reasons: ["no_preference_for_cell", "time_rule_violation"],
      }),
    ]);
    const ineligibleSection = within(dialog).getByText(/Uygun olmayan öğretmenler/).closest("section")!;
    const item = within(ineligibleSection).getByText("Cok Gerekceli").closest("li") as HTMLElement;
    expect(item.textContent).toContain("Bu hücre için uygunluk işaretlememiş");
    expect(item.textContent).toContain("Ders/zaman kuralı nedeniyle uygun değil");
  });

  it("23b) fixed_only hücre gerekçesi cell_not_open_for_normal olarak gösterilir", async () => {
    const { dialog } = await openWithCandidates([
      candidate({ teacherSourceId: "T4", teacherName: "Sabit Blok", eligible: false, reasons: ["cell_not_open_for_normal"] }),
    ]);
    const ineligibleSection = within(dialog).getByText(/Uygun olmayan öğretmenler/).closest("section")!;
    expect(within(ineligibleSection).getByText("Bu blok normal atamaya kapalı (yalnız sabit)")).toBeInTheDocument();
  });

  it("24) sıfır yüklü öğretmenin adı snapshot.teachers üzerinden Öğretmen Yük Dağılımı tablosunda gösterilir", async () => {
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue(classificationDraft());
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(classificationSnapshot());
    render(<OtomatikNobetPlaniPage />);
    await screen.findByText("Atanan normal görev");
    expect(screen.getByText("Sıfır Yüklü Öğretmen")).toBeInTheDocument();
    expect(screen.queryByText("T5")).not.toBeInTheDocument();
  });
});

describe("OtomatikNobetPlaniPage — preparation snapshot alınamadığında fallback (bulgu 4)", () => {
  it("25) snapshot hatası: sütunlar dutyBlockName'den gelir (hepsi 'Sabah' olmaz), kategori/aday 0 diye uydurulmaz, yeniden üretme devre dışı", async () => {
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue(
      foundDraft({
        assignments: [
          draftAssignment({ id: "a1", dutyBlockId: BLOCK_MORNING, dutyBlockName: "Sabah Teneffüs Bloğu" }),
          draftAssignment({ id: "a2", dutyBlockId: BLOCK_LONG1, dutyBlockName: "Uzun Nöbet 1", dutyLocationId: LOC_B, dutyLocationName: "Bahçe B" }),
        ],
      }),
    );
    vi.mocked(api.fetchDutyPlanPreparation).mockRejectedValue(new Error("network down"));
    render(<OtomatikNobetPlaniPage />);

    await screen.findByText("Atanan normal görev");
    expect(screen.getByText(/Güncel hazırlık verisi alınamadı/)).toBeInTheDocument();

    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toContain("Sabah Teneffüs Bloğu");
    expect(headers).toContain("Uzun Nöbet 1");
    expect(headers.filter((h) => h === "Sabah")).toHaveLength(0);

    expect(screen.getByRole("button", { name: /Aynı Ayarlarla Yeniden Üret/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Farklı Seed ile Yeniden Üret/i })).toBeDisabled();

    // Kategori çeşitliliği 0 diye UYDURULMAZ — "hesaplanamıyor" göstergesi (title).
    const loadTable = screen.getByText("Öğretmen Yük Dağılımı").closest(".anp-card") as HTMLElement;
    expect(within(loadTable).getByTitle("Güncel hazırlık verisi alınamadığı için hesaplanamıyor.")).toBeInTheDocument();
  });

  it("26) aday RPC hatasında liste GÖSTERİLMEZ; kurallar tarayıcıda yeniden hesaplanmaz", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue(foundDraft());
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(feasibleSnapshot());
    vi.mocked(api.fetchDutyPlanTaskCandidates).mockRejectedValue(new Error("network down"));
    render(<OtomatikNobetPlaniPage />);
    await screen.findByText("Atanan normal görev");

    await user.click(screen.getByRole("button", { name: /Ayşe Yılmaz/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/Aday öğretmen listesi alınamadı/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/^Uygun öğretmenler/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Uygun olmayan öğretmenler/)).not.toBeInTheDocument();
  });

  it("26b) hazırlık snapshot alınamasa bile aday listesi RPC'den gelmeye devam eder", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue(foundDraft());
    vi.mocked(api.fetchDutyPlanPreparation).mockRejectedValue(new Error("network down"));
    vi.mocked(api.fetchDutyPlanTaskCandidates).mockResolvedValue(
      taskCandidates([candidate({ teacherSourceId: "T2", teacherName: "Mehmet Demir" })]),
    );
    render(<OtomatikNobetPlaniPage />);
    await screen.findByText("Atanan normal görev");

    await user.click(screen.getByRole("button", { name: /Ayşe Yılmaz/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Uygun öğretmenler (1)")).toBeInTheDocument();
    expect(within(dialog).getByText(/Mehmet Demir/)).toBeInTheDocument();
  });
});

describe("OtomatikNobetPlaniPage — AbortController", () => {
  it("19) unmount olunca bekleyen istekleri iptal eder", async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockImplementation((signal) => {
      capturedSignal = signal;
      return new Promise(() => {});
    });
    vi.mocked(api.fetchDutyPlanPreparation).mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<OtomatikNobetPlaniPage />);
    expect(capturedSignal?.aborted).toBe(false);
    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe("OtomatikNobetPlaniPage — paket arayüzü (coverage-mode seçimi + affectedTasks onayı)", () => {
  const LOC_FULL = "loc-full";
  const LOC_SHORT = "loc-short";
  const LOC_SINGLE = "loc-single";

  function packageSnapshot(): DutyPlanGenerationSnapshot {
    const d = days();
    const task = (locationId: string, locationName: string, shortCode: string, blockId: string, blockCode: "MORNING_BREAKS" | "LONG_BREAK_1" | "LONG_BREAK_2" | "AFTERNOON_BREAKS", blockName: string, blockOrder: number) => ({
      dayOrder: 1,
      dutyLocationId: locationId,
      dutyLocationName: locationName,
      shortCode,
      category: "garden",
      dutyBlockId: blockId,
      blockCode,
      blockName,
      blockOrder,
      kind: "normal" as const,
      fixedCoveredByTeacherSourceId: null,
      fixedCoveredByTeacherName: null,
    });
    return {
      hasImport: true,
      campusId: "campus-1",
      academicYearId: "year-1",
      timetableImportId: "import-1",
      importedAt: "2026-09-01T10:00:00.000Z",
      sourceFingerprint: "a".repeat(64),
      days: d,
      blocks: blocks(),
      tasks: [
        task(LOC_FULL, "Tam Yer", "TAM", BLOCK_MORNING, "MORNING_BREAKS", "Sabah Teneffüs Bloğu", 1),
        task(LOC_FULL, "Tam Yer", "TAM", BLOCK_LONG1, "LONG_BREAK_1", "Uzun Nöbet 1", 2),
        task(LOC_FULL, "Tam Yer", "TAM", BLOCK_LONG2, "LONG_BREAK_2", "Uzun Nöbet 2", 3),
        task(LOC_FULL, "Tam Yer", "TAM", BLOCK_AFTERNOON, "AFTERNOON_BREAKS", "Öğleden Sonra Teneffüs Bloğu", 4),
        task(LOC_SHORT, "Kısa Yer", "KISA", BLOCK_MORNING, "MORNING_BREAKS", "Sabah Teneffüs Bloğu", 1),
        task(LOC_SHORT, "Kısa Yer", "KISA", BLOCK_AFTERNOON, "AFTERNOON_BREAKS", "Öğleden Sonra Teneffüs Bloğu", 4),
        task(LOC_SINGLE, "Tek Yer", "TEK", BLOCK_MORNING, "MORNING_BREAKS", "Sabah Teneffüs Bloğu", 1),
      ],
      teachers: [{ teacherSourceId: "T1", teacherName: "Ayşe Yılmaz" }],
      candidateEdges: [
        { dayOrder: 1, dutyLocationId: LOC_FULL, dutyBlockId: BLOCK_MORNING, teacherSourceId: "T1", teacherName: "Ayşe Yılmaz" },
        { dayOrder: 1, dutyLocationId: LOC_SHORT, dutyBlockId: BLOCK_MORNING, teacherSourceId: "T1", teacherName: "Ayşe Yılmaz" },
        { dayOrder: 1, dutyLocationId: LOC_SINGLE, dutyBlockId: BLOCK_MORNING, teacherSourceId: "T1", teacherName: "Ayşe Yılmaz" },
      ],
      teacherFixedDutyLoads: [],
      feasibility: {
        hasImport: true,
        days: d.map((day) => ({
          order: day.order,
          name: day.name,
          totals: { requiredTasks: 3, coveredTasks: 0, uncoveredTasks: 3, fixedRequired: 0, fixedCovered: 0, fixedMissing: 0, normalRequired: 3, normalMatched: 0, normalUncovered: 3, candidateTeacherCount: 1 },
        })),
        summary: { totalRequiredTasks: 15, totalCoveredTasks: 0, totalUncoveredTasks: 15, daysWithShortfall: [], feasible: false },
      },
      configurationErrors: [],
    };
  }

  function packageDraft(overrides: Partial<Extract<DutyPlanDraftDto, { found: true }>> = {}): DutyPlanDraftDto {
    return foundDraft({
      assignments: [
        draftAssignment({ id: "cell-full", dayOrder: 1, dutyLocationId: LOC_FULL, dutyLocationName: "Tam Yer", dutyBlockId: BLOCK_MORNING, dutyBlockName: "Sabah Teneffüs Bloğu", assignmentKind: "unassigned", teacherSourceId: null, teacherName: null }),
        draftAssignment({ id: "cell-short", dayOrder: 1, dutyLocationId: LOC_SHORT, dutyLocationName: "Kısa Yer", dutyBlockId: BLOCK_MORNING, dutyBlockName: "Sabah Teneffüs Bloğu", assignmentKind: "unassigned", teacherSourceId: null, teacherName: null }),
        draftAssignment({ id: "cell-single", dayOrder: 1, dutyLocationId: LOC_SINGLE, dutyLocationName: "Tek Yer", dutyBlockId: BLOCK_MORNING, dutyBlockName: "Sabah Teneffüs Bloğu", assignmentKind: "unassigned", teacherSourceId: null, teacherName: null }),
      ],
      ...overrides,
    });
  }

  async function renderAndOpen(locationName: string, draft: DutyPlanDraftDto = packageDraft(), candidateOverrides: Record<string, unknown> = {}) {
    const user = userEvent.setup();
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue(draft);
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(packageSnapshot());
    vi.mocked(api.fetchDutyPlanTaskCandidates).mockResolvedValue(
      taskCandidates([candidate({ teacherSourceId: "T1", teacherName: "Ayşe Yılmaz" })], {
        currentAssignment: { teacherSourceId: null, teacherName: null, assignmentKind: "unassigned" },
        ...candidateOverrides,
      }),
    );
    render(<OtomatikNobetPlaniPage />);
    await screen.findByText("Atanan normal görev");
    const row = screen.getByRole("row", { name: new RegExp(locationName) });
    await user.click(within(row).getByText("Öğretmen bulunamadı"));
    const dialog = await screen.findByRole("dialog");
    return { user, dialog };
  }

  function affectedTask(overrides: Partial<ManualPackageAffectedTaskDto> = {}): ManualPackageAffectedTaskDto {
    return { id: "other-1", dutyBlockId: BLOCK_LONG1, dutyBlockName: "Uzun Nöbet 1", currentTeacherSourceId: "T9", currentTeacherName: "Deniz Kaya", packageId: "pkg-old", ...overrides };
  }

  function eligiblePreviewResult(overrides: Partial<Extract<PreviewDutyPlanManualPackageResult, { found: true; eligible: boolean }>> = {}): PreviewDutyPlanManualPackageResult {
    return {
      found: true,
      planStatus: "draft",
      planVersion: 1,
      targetTaskIds: ["cell-full"],
      targetTasks: [],
      affectedTasks: [],
      eligible: true,
      reasons: [],
      conflictingPackage: null,
      ...overrides,
    };
  }

  /*
    v3 planlarda NORMAL paket yalnız tek bloktur (bkz. migration 20260921090000
    ve set_duty_plan_manual_package'ın normal_package_must_be_single_block
    reddi). Çok bloklu düğmeler gösterilmemelidir; aksi halde kullanıcı her
    zaman reddedilen bir eylem dener.
  */
  it("v3 planda FULL_DAY ve SHORT_BREAKS düğmeleri HİÇ gösterilmez (yalnız tek blok)", async () => {
    const { dialog } = await renderAndOpen("Tam Yer", packageDraft({ algorithmVersion: "duty-plan-solver-v3.0.0" }));
    expect(within(dialog).queryByRole("button", { name: /Bu nöbet yerine tüm gün ata/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Sabah \+ Öğleden Sonra ata/i })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /bu blok için ata/i })).toBeInTheDocument();
  });

  it("v3 olmayan planda FULL_DAY düğmesi görünmeye devam eder (tarihsel taslaklar bozulmaz)", async () => {
    const { dialog } = await renderAndOpen("Tam Yer", packageDraft({ algorithmVersion: "duty-plan-solver-v2" }));
    expect(within(dialog).getByRole("button", { name: /Bu nöbet yerine tüm gün ata/i })).toBeInTheDocument();
  });

  /*
    Karma politikalı yer: Sabah ve Öğleden Sonra SABİT (kind === "fixed"),
    Öğle Arası-1 normal. Sabit hücreleri sayarak SHORT_BREAKS önermek,
    sunucunun cell_not_open_for_normal ile reddedeceği bir düğme üretirdi.
  */
  it("sabit bloklar paket kapsamına SAYILMAZ: karma yerde SHORT_BREAKS önerilmez", async () => {
    const snap = packageSnapshot() as Extract<DutyPlanGenerationSnapshot, { hasImport: true }>;
    const mixed: DutyPlanGenerationSnapshot = {
      ...snap,
      tasks: snap.tasks.map((t) =>
        t.dutyLocationId === LOC_SHORT && (t.dutyBlockId === BLOCK_MORNING || t.dutyBlockId === BLOCK_AFTERNOON)
          ? { ...t, kind: "fixed" as const }
          : t,
      ),
    };
    const user = userEvent.setup();
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue(packageDraft({ algorithmVersion: "duty-plan-solver-v2" }));
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(mixed);
    vi.mocked(api.fetchDutyPlanTaskCandidates).mockResolvedValue(
      taskCandidates([candidate({ teacherSourceId: "T1", teacherName: "Ayşe Yılmaz" })], {
        currentAssignment: { teacherSourceId: null, teacherName: null, assignmentKind: "unassigned" },
      }),
    );
    render(<OtomatikNobetPlaniPage />);
    await screen.findByText("Atanan normal görev");
    const row = screen.getByRole("row", { name: /Kısa Yer/ });
    await user.click(within(row).getByText("Öğretmen bulunamadı"));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("button", { name: /bu blok için ata/i });
    expect(within(dialog).queryByRole("button", { name: /Sabah \+ Öğleden Sonra ata/i })).not.toBeInTheDocument();
  });

  it("paket rozeti doğru coverageMode etiketiyle görünür", async () => {
    const pkg: DutyPlanDraftPackageDto = {
      id: "pkg-1",
      dayOrder: 1,
      dutyLocationId: LOC_SHORT,
      teacherSourceId: "T1",
      teacherName: "Ayşe Yılmaz",
      coverageMode: "SHORT_BREAKS",
      assignmentKind: "generated",
      coveredTaskIds: ["cell-short", "cell-short-2"],
    };
    const draft = packageDraft({
      assignments: [
        draftAssignment({ id: "cell-full", dayOrder: 1, dutyLocationId: LOC_FULL, dutyLocationName: "Tam Yer", dutyBlockId: BLOCK_MORNING, assignmentKind: "unassigned", teacherSourceId: null, teacherName: null }),
        draftAssignment({ id: "cell-short", dayOrder: 1, dutyLocationId: LOC_SHORT, dutyLocationName: "Kısa Yer", dutyBlockId: BLOCK_MORNING, teacherSourceId: "T1", teacherName: "Ayşe Yılmaz", assignmentKind: "generated", packageId: "pkg-1" }),
        draftAssignment({ id: "cell-single", dayOrder: 1, dutyLocationId: LOC_SINGLE, dutyLocationName: "Tek Yer", dutyBlockId: BLOCK_MORNING, assignmentKind: "unassigned", teacherSourceId: null, teacherName: null }),
      ],
      packages: [pkg],
    });
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue(draft);
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(packageSnapshot());
    render(<OtomatikNobetPlaniPage />);
    await screen.findByText("Atanan normal görev");
    const row = screen.getByRole("row", { name: /Kısa Yer/ });
    expect(within(row).getByText("Teneffüs (Sabah + Öğleden Sonra)")).toBeInTheDocument();
  });

  it("FULL_DAY butonu yalnız yer dört bloğu destekliyorsa görünür", async () => {
    const { dialog } = await renderAndOpen("Tam Yer");
    expect(within(dialog).getByRole("button", { name: /Bu nöbet yerine tüm gün ata/i })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Sabah \+ Öğleden Sonra ata/i })).toBeInTheDocument();
  });

  it("SHORT_BREAKS butonu yalnız Sabah\\+Öğleden Sonra blokları varsa görünür (FULL_DAY görünmez)", async () => {
    const { dialog } = await renderAndOpen("Kısa Yer");
    expect(within(dialog).queryByRole("button", { name: /Bu nöbet yerine tüm gün ata/i })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Sabah \+ Öğleden Sonra ata/i })).toBeInTheDocument();
  });

  it("tek bloklu yerde ne FULL_DAY ne SHORT_BREAKS butonu görünür — yalnız tekil atama", async () => {
    const { dialog } = await renderAndOpen("Tek Yer");
    expect(within(dialog).queryByRole("button", { name: /Bu nöbet yerine tüm gün ata/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Sabah \+ Öğleden Sonra ata/i })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Ayşe Yılmaz — bu blok için ata/i })).toBeInTheDocument();
  });

  it("aday yanıtı isStale:true iken paket düğmeleri KAYBOLUR (kontrol: aynı hücrede taze yanıtta görünür)", async () => {
    const fresh = await renderAndOpen("Tam Yer");
    expect(within(fresh.dialog).getByRole("button", { name: /tüm gün ata/ })).toBeInTheDocument();
    cleanup();

    const { dialog } = await renderAndOpen("Tam Yer", packageDraft(), { isStale: true });
    expect(await within(dialog).findByText(/Kaynak veriler değiştiği için aday listesi güncelliğini kaybetti/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /tüm gün ata/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Sabah . Öğleden Sonra ata/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /bu blok için ata/ })).not.toBeInTheDocument();
  });

  it("planVersion uyuşmazlığında paket düğmeleri KAYBOLUR", async () => {
    const { dialog } = await renderAndOpen("Tam Yer", packageDraft(), { planVersion: 9 });
    expect(await within(dialog).findByText(/Taslak başka bir yerde değiştirildi/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /tüm gün ata/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /bu blok için ata/ })).not.toBeInTheDocument();
  });

  it("paket ön izlemesinde affectedTasks varsa PUT yapılmadan önce onay modalı açılır", async () => {
    const { user, dialog } = await renderAndOpen("Tam Yer");
    vi.mocked(api.previewDutyPlanManualPackage).mockResolvedValue(eligiblePreviewResult({ affectedTasks: [affectedTask()] }));

    await user.click(within(dialog).getByRole("button", { name: /Bu nöbet yerine tüm gün ata/i }));

    const confirm = await screen.findByRole("alertdialog", { name: /onayı/i });
    expect(within(confirm).getByText(/Uzun Nöbet 1/)).toBeInTheDocument();
    expect(within(confirm).getByText(/Deniz Kaya/)).toBeInTheDocument();
    expect(api.setDutyPlanManualPackage).not.toHaveBeenCalled();
  });

  it("vazgeçildiğinde PUT çağrılmaz, modal kapanır", async () => {
    const { user, dialog } = await renderAndOpen("Tam Yer");
    vi.mocked(api.previewDutyPlanManualPackage).mockResolvedValue(eligiblePreviewResult({ affectedTasks: [affectedTask()] }));

    await user.click(within(dialog).getByRole("button", { name: /Bu nöbet yerine tüm gün ata/i }));
    const confirm = await screen.findByRole("alertdialog", { name: /onayı/i });
    await user.click(within(confirm).getByRole("button", { name: /Vazgeç/i }));

    expect(screen.queryByRole("alertdialog", { name: /onayı/i })).not.toBeInTheDocument();
    expect(api.setDutyPlanManualPackage).not.toHaveBeenCalled();
  });

  it("onaylandığında PUT doğru expectedPlanVersion ve expectedAffectedTaskIds ile çağrılır", async () => {
    const { user, dialog } = await renderAndOpen("Tam Yer");
    vi.mocked(api.previewDutyPlanManualPackage).mockResolvedValue(eligiblePreviewResult({ affectedTasks: [affectedTask()] }));
    vi.mocked(api.setDutyPlanManualPackage).mockResolvedValue({ status: "ok", version: 2, packageId: "pkg-new", summary: {} });

    await user.click(within(dialog).getByRole("button", { name: /Bu nöbet yerine tüm gün ata/i }));
    const confirm = await screen.findByRole("alertdialog", { name: /onayı/i });
    await user.click(within(confirm).getByRole("button", { name: /Onayla ve uygula/i }));

    expect(api.setDutyPlanManualPackage).toHaveBeenCalledWith(
      "plan-1",
      expect.objectContaining({
        dayOrder: 1,
        dutyLocationId: LOC_FULL,
        teacherSourceId: "T1",
        coverageMode: "FULL_DAY",
        expectedPlanVersion: 1,
        expectedAffectedTaskIds: ["other-1"],
      }),
    );
    await screen.findByText("Atanan normal görev");
    expect(screen.queryByRole("alertdialog", { name: /onayı/i })).not.toBeInTheDocument();
  });

  it("set isteği stale_affected_set döndürürse modal güncel affectedTasks ile açık kalır; yeniden onaylanınca ikinci PUT güncel kimlikleri taşır", async () => {
    const { user, dialog } = await renderAndOpen("Tam Yer");
    vi.mocked(api.previewDutyPlanManualPackage).mockResolvedValue(eligiblePreviewResult({ affectedTasks: [affectedTask()] }));
    const staleError = new SetDutyPlanManualPackageApiError({
      status: "stale_affected_set",
      message: "Etkilenen küme değişti.",
      affectedTasks: [affectedTask(), affectedTask({ id: "other-2", dutyBlockId: BLOCK_LONG2, dutyBlockName: "Uzun Nöbet 2", currentTeacherSourceId: "T8", currentTeacherName: "Elif Şahin" })],
    });
    vi.mocked(api.setDutyPlanManualPackage).mockRejectedValueOnce(staleError).mockResolvedValueOnce({ status: "ok", version: 2, packageId: "pkg-new", summary: {} });

    await user.click(within(dialog).getByRole("button", { name: /Bu nöbet yerine tüm gün ata/i }));
    let confirm = await screen.findByRole("alertdialog", { name: /onayı/i });
    await user.click(within(confirm).getByRole("button", { name: /Onayla ve uygula/i }));

    // Modal AÇIK kalır, güncel (2 öğeli) liste gösterilir — sessizce kapanmaz.
    confirm = await screen.findByRole("alertdialog", { name: /onayı/i });
    expect(within(confirm).getByText(/Uzun Nöbet 2/)).toBeInTheDocument();
    expect(within(confirm).getByText(/Elif Şahin/)).toBeInTheDocument();

    await user.click(within(confirm).getByRole("button", { name: /Onayla ve uygula/i }));

    expect(api.setDutyPlanManualPackage).toHaveBeenCalledTimes(2);
    expect(api.setDutyPlanManualPackage).toHaveBeenLastCalledWith(
      "plan-1",
      expect.objectContaining({ expectedAffectedTaskIds: ["other-1", "other-2"] }),
    );
  });

  it("çok hücreli paket kaldırılırken önce etkilenen hücreler gösterilir, PUT önce çağrılmaz", async () => {
    const pkg: DutyPlanDraftPackageDto = {
      id: "pkg-full",
      dayOrder: 1,
      dutyLocationId: LOC_FULL,
      teacherSourceId: "T1",
      teacherName: "Ayşe Yılmaz",
      coverageMode: "FULL_DAY",
      assignmentKind: "generated",
      coveredTaskIds: ["cell-full", "cell-full-2", "cell-full-3", "cell-full-4"],
    };
    const draft = packageDraft({
      assignments: [
        draftAssignment({ id: "cell-full", dayOrder: 1, dutyLocationId: LOC_FULL, dutyLocationName: "Tam Yer", dutyBlockId: BLOCK_MORNING, teacherSourceId: "T1", teacherName: "Ayşe Yılmaz", assignmentKind: "generated", packageId: "pkg-full" }),
        draftAssignment({ id: "cell-short", dayOrder: 1, dutyLocationId: LOC_SHORT, dutyLocationName: "Kısa Yer", dutyBlockId: BLOCK_MORNING, assignmentKind: "unassigned", teacherSourceId: null, teacherName: null }),
        draftAssignment({ id: "cell-single", dayOrder: 1, dutyLocationId: LOC_SINGLE, dutyLocationName: "Tek Yer", dutyBlockId: BLOCK_MORNING, assignmentKind: "unassigned", teacherSourceId: null, teacherName: null }),
      ],
      packages: [pkg],
    });
    const user = userEvent.setup();
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue(draft);
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(packageSnapshot());
    vi.mocked(api.previewDutyPlanManualPackage).mockResolvedValue(
      eligiblePreviewResult({ affectedTasks: [affectedTask({ id: "cell-full-2", dutyBlockName: "Uzun Nöbet 1", currentTeacherName: "Ayşe Yılmaz" })] }),
    );
    render(<OtomatikNobetPlaniPage />);
    await screen.findByText("Atanan normal görev");

    await user.click(screen.getByRole("button", { name: /Ayşe Yılmaz/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Tüm Gün paketini kaldır/i }));

    const confirm = await screen.findByRole("alertdialog", { name: /onayı/i });
    expect(within(confirm).getByText(/Uzun Nöbet 1/)).toBeInTheDocument();
    expect(api.setDutyPlanManualPackage).not.toHaveBeenCalled();
  });

  it("sabit paket/hücre düzenlenemez — hiçbir paket eylemi butonu görünmez", async () => {
    const draft = packageDraft({
      assignments: [
        draftAssignment({ id: "cell-full", dayOrder: 1, dutyLocationId: LOC_FULL, dutyLocationName: "Tam Yer", dutyBlockId: BLOCK_MORNING, teacherSourceId: "T1", teacherName: "Ayşe Yılmaz", assignmentKind: "fixed", fixedDutyAssignmentId: "fixed-1" }),
        draftAssignment({ id: "cell-short", dayOrder: 1, dutyLocationId: LOC_SHORT, dutyLocationName: "Kısa Yer", dutyBlockId: BLOCK_MORNING, assignmentKind: "unassigned", teacherSourceId: null, teacherName: null }),
        draftAssignment({ id: "cell-single", dayOrder: 1, dutyLocationId: LOC_SINGLE, dutyLocationName: "Tek Yer", dutyBlockId: BLOCK_MORNING, assignmentKind: "unassigned", teacherSourceId: null, teacherName: null }),
      ],
    });
    const user = userEvent.setup();
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue(draft);
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(packageSnapshot());
    render(<OtomatikNobetPlaniPage />);
    await screen.findByText("Atanan normal görev");

    await user.click(screen.getByRole("button", { name: /sabit, Ayşe Yılmaz/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: /Bu nöbet yerine tüm gün ata/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Sabah \+ Öğleden Sonra ata/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /bu blok için ata/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /paketini kaldır/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Atamayı Kaldır/i })).not.toBeInTheDocument();
  });

  it("optimalityProven=true iken 'Optimum çözüm' rozeti gösterilir", async () => {
    await (async () => {
      vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue(foundDraft());
      vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(packageSnapshot());
      render(<OtomatikNobetPlaniPage />);
      await screen.findByText("Atanan normal görev");
    })();
    expect(screen.getByText("Optimum çözüm")).toBeInTheDocument();
    expect(screen.queryByText(/optimumluk kanıtlanamadı/)).not.toBeInTheDocument();
  });

  it("searchLimitReached=true / optimalityProven=false iken 'en iyi bulunan çözüm' rozeti gösterilir", async () => {
    const draft = foundDraft({
      summary: {
        totalTaskCount: 1,
        fixedTaskCount: 0,
        fixedCoveredCount: 0,
        normalTaskCount: 1,
        normalCoveredCount: 1,
        uncoveredCount: 0,
        teacherLoads: [],
        warnings: [],
        optimalityProven: false,
        searchLimitReached: true,
        exploredNodeCount: 5,
        cellOnlyBaselineCoverage: 1,
      },
    });
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue(draft);
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(packageSnapshot());
    render(<OtomatikNobetPlaniPage />);
    await screen.findByText("Atanan normal görev");
    expect(screen.getByText("En iyi bulunan çözüm — optimumluk kanıtlanamadı")).toBeInTheDocument();
    expect(screen.queryByText("Optimum çözüm")).not.toBeInTheDocument();
  });
});

describe("OtomatikNobetPlaniPage — aday isteği görünüm durumları (plan/görev yok, bayat, sürüm uyuşmazlığı)", () => {
  /** İki hücreli taslak: ikisinin de görev kimliği SABİT, böylece istek anahtarı test edilebilir. */
  function twoCellDraft(): DutyPlanDraftDto {
    return foundDraft({
      assignments: [
        draftAssignment({ id: "task-1", dutyLocationId: LOC_A, dutyLocationName: "Bahçe A", dutyBlockId: BLOCK_MORNING, teacherSourceId: "T1", teacherName: "Birinci Hucre" }),
        draftAssignment({ id: "task-2", dutyLocationId: LOC_B, dutyLocationName: "Bahçe B", dutyBlockId: BLOCK_MORNING, teacherSourceId: "T2", teacherName: "Ikinci Hucre" }),
      ],
    });
  }

  async function openFirstCell(response: TaskCandidatesDto) {
    const user = userEvent.setup();
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue(twoCellDraft());
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(feasibleSnapshot());
    vi.mocked(api.fetchDutyPlanTaskCandidates).mockResolvedValue(response);
    render(<OtomatikNobetPlaniPage />);
    await screen.findByText("Atanan normal görev");
    await user.click(screen.getByRole("button", { name: /Birinci Hucre/ }));
    return { user, dialog: await screen.findByRole("dialog") };
  }

  it("found:false → 'Taslak artık bulunamadı' der, sonsuz yükleniyor göstermez", async () => {
    const { dialog } = await openFirstCell({ found: false });
    expect(await within(dialog).findByText(/Taslak artık bulunamadı/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Aday öğretmen listesi yükleniyor/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/^Uygun öğretmenler/)).not.toBeInTheDocument();
  });

  it("taskFound:false → 'Görev artık bu taslakta bulunmuyor' der, sonsuz yükleniyor göstermez", async () => {
    const { dialog } = await openFirstCell({ found: true, taskFound: false, planStatus: "draft", planVersion: 1 });
    expect(await within(dialog).findByText(/Görev artık bu taslakta bulunmuyor/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Aday öğretmen listesi yükleniyor/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/^Uygun öğretmenler/)).not.toBeInTheDocument();
  });

  it("planVersion uyuşmazlığında adaylar SALT OKUNUR gösterilir, atama düğmesi çıkmaz", async () => {
    const { dialog } = await openFirstCell(
      taskCandidates([candidate({ teacherSourceId: "T9", teacherName: "Uygun Aday" })], { planVersion: 7 }),
    );
    expect(await within(dialog).findByText(/Taslak başka bir yerde değiştirildi/)).toBeInTheDocument();
    expect(within(dialog).getByText("Uygun öğretmenler (1)")).toBeInTheDocument();
    expect(within(dialog).getByText(/Uygun Aday/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /bu blok için ata/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Atamayı Kaldır/ })).not.toBeInTheDocument();
  });

  it("aday yanıtı isStale:true iken manuel atama ve paket eylemleri kapalıdır", async () => {
    const { dialog } = await openFirstCell(
      taskCandidates([candidate({ teacherSourceId: "T9", teacherName: "Uygun Aday" })], { isStale: true }),
    );
    expect(await within(dialog).findByText(/Kaynak veriler değiştiği için aday listesi güncelliğini kaybetti/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Uygun Aday/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /bu blok için ata/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /tüm gün ata/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Sabah . Öğleden Sonra ata/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Atamayı Kaldır/ })).not.toBeInTheDocument();
  });

  /*
    Plan artık yoksa yalnız aday atama değil, MEVCUT atamayı kaldırma da
    kapalıdır — kaldırma da bir PUT'tur ve var olmayan plana yazılamaz.
  */
  it("found:false + atanmış hücre → 'Atamayı Kaldır' yok ve hiçbir yazma API'si çağrılmaz", async () => {
    const { dialog } = await openFirstCell({ found: false });
    expect(await within(dialog).findByText(/Taslak artık bulunamadı/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Birinci Hucre/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Atamayı Kaldır/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /paketini kaldır/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /bu blok için ata/ })).not.toBeInTheDocument();
    expect(api.updateDutyPlanAssignment).not.toHaveBeenCalled();
    expect(api.previewDutyPlanManualPackage).not.toHaveBeenCalled();
    expect(api.setDutyPlanManualPackage).not.toHaveBeenCalled();
  });

  /** Görev artık taslakta yoksa çok hücreli "paketini kaldır" düğmesi de gösterilmemelidir. */
  it("taskFound:false + atanmış çok hücreli paket → paket kaldırma/atama eylemleri yok, yazma API'si çağrılmaz", async () => {
    const user = userEvent.setup();
    const pkg: DutyPlanDraftPackageDto = {
      id: "pkg-1",
      dayOrder: 1,
      dutyLocationId: LOC_A,
      teacherSourceId: "T1",
      teacherName: "Birinci Hucre",
      coverageMode: "FULL_DAY",
      assignmentKind: "generated",
      coveredTaskIds: ["task-1", "task-1b"],
    };
    const draft = foundDraft({
      assignments: [
        draftAssignment({ id: "task-1", dutyLocationId: LOC_A, dutyLocationName: "Bahçe A", dutyBlockId: BLOCK_MORNING, teacherSourceId: "T1", teacherName: "Birinci Hucre", packageId: "pkg-1" }),
        draftAssignment({ id: "task-1b", dutyLocationId: LOC_A, dutyLocationName: "Bahçe A", dutyBlockId: BLOCK_LONG1, dutyBlockName: "Uzun Nöbet 1", teacherSourceId: "T1", teacherName: "Birinci Hucre", packageId: "pkg-1" }),
      ],
      packages: [pkg],
    });
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue(draft);
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(feasibleSnapshot());
    vi.mocked(api.fetchDutyPlanTaskCandidates).mockResolvedValue({ found: true, taskFound: false, planStatus: "draft", planVersion: 1 } as TaskCandidatesDto);
    render(<OtomatikNobetPlaniPage />);
    await screen.findByText("Atanan normal görev");

    await user.click(screen.getAllByRole("button", { name: /Birinci Hucre/ })[0]);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/Görev artık bu taslakta bulunmuyor/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /paketini kaldır/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Atamayı Kaldır/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /bu blok için ata/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /tüm gün ata/ })).not.toBeInTheDocument();
    expect(api.previewDutyPlanManualPackage).not.toHaveBeenCalled();
    expect(api.setDutyPlanManualPackage).not.toHaveBeenCalled();
    expect(api.updateDutyPlanAssignment).not.toHaveBeenCalled();
  });

  it("hücre değişince önceki isteğin GEÇ gelen sonucu yeni hücreye taşınmaz", async () => {
    const user = userEvent.setup();
    let resolveFirst: (value: TaskCandidatesDto) => void = () => {};
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue(twoCellDraft());
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(feasibleSnapshot());
    vi.mocked(api.fetchDutyPlanTaskCandidates).mockImplementation((_planId: string, taskId: string) => {
      if (taskId === "task-1") {
        return new Promise<TaskCandidatesDto>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(taskCandidates([candidate({ teacherSourceId: "T8", teacherName: "Ikinci Hucre Adayi" })]));
    });
    render(<OtomatikNobetPlaniPage />);
    await screen.findByText("Atanan normal görev");

    await user.click(screen.getByRole("button", { name: /Birinci Hucre/ }));
    const firstDialog = await screen.findByRole("dialog");
    expect(within(firstDialog).getByText(/Aday öğretmen listesi yükleniyor/)).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /Ikinci Hucre/ }));
    const secondDialog = await screen.findByRole("dialog");
    expect(await within(secondDialog).findByText(/Ikinci Hucre Adayi/)).toBeInTheDocument();

    // Birinci hücrenin yanıtı ŞİMDİ gelir — ikinci hücrenin listesine sızmamalı.
    resolveFirst(taskCandidates([candidate({ teacherSourceId: "T7", teacherName: "Birinci Hucre Adayi" })]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(within(secondDialog).queryByText(/Birinci Hucre Adayi/)).not.toBeInTheDocument();
    expect(within(secondDialog).getByText(/Ikinci Hucre Adayi/)).toBeInTheDocument();
  });
});

describe("OtomatikNobetPlaniPage — optimumluk metni savunmalı (arama bütçesi uydurulmaz)", () => {
  async function renderWith(draft: DutyPlanDraftDto) {
    vi.mocked(api.fetchCurrentDutyPlanDraft).mockResolvedValue(draft);
    vi.mocked(api.fetchDutyPlanPreparation).mockResolvedValue(feasibleSnapshot());
    render(<OtomatikNobetPlaniPage />);
    await screen.findByText("Atanan normal görev");
  }

  it("v3 planda optimalityReason EKSİK iken 'düğüm bütçesi' metni ÇIKMAZ, nötr metin gösterilir", async () => {
    const base = foundDraft() as Extract<DutyPlanDraftDto, { found: true }>;
    await renderWith(
      foundDraft({
        algorithmVersion: "duty-plan-solver-v3.1.0",
        summary: { ...base.summary, optimalityProven: false, searchLimitReached: false, exploredNodeCount: 4200, v3: {} as never },
      }),
    );
    const badge = screen.getByText("En iyi bulunan çözüm — optimumluk kanıtlanamadı");
    expect(badge.getAttribute("title") ?? "").toBe("Nihai sıralamanın optimumluğu doğrulanamadı — en iyi bulunan çözüm gösteriliyor.");
    expect(badge.getAttribute("title") ?? "").not.toMatch(/düğüm bütçesi/i);
  });

  it("v3 planda searchLimitReached=true gelse bile 'düğüm bütçesi' metni ÇIKMAZ", async () => {
    const base = foundDraft() as Extract<DutyPlanDraftDto, { found: true }>;
    await renderWith(
      foundDraft({
        algorithmVersion: "duty-plan-solver-v3.1.0",
        summary: { ...base.summary, optimalityProven: false, searchLimitReached: true, exploredNodeCount: 4200 },
      }),
    );
    const badge = screen.getByText("En iyi bulunan çözüm — optimumluk kanıtlanamadı");
    expect(badge.getAttribute("title") ?? "").not.toMatch(/düğüm bütçesi/i);
  });

  it("v1 planda searchLimitReached=false iken de 'düğüm bütçesi' metni ÇIKMAZ", async () => {
    const base = foundDraft() as Extract<DutyPlanDraftDto, { found: true }>;
    await renderWith(
      foundDraft({
        algorithmVersion: "duty-plan-solver-v1",
        summary: { ...base.summary, optimalityProven: false, searchLimitReached: false, exploredNodeCount: 9 },
      }),
    );
    const badge = screen.getByText("En iyi bulunan çözüm — optimumluk kanıtlanamadı");
    expect(badge.getAttribute("title") ?? "").not.toMatch(/düğüm bütçesi/i);
  });

  it("v3 + coverageOptimalityProven=true iken 'Kapsama kesin maksimum' korunur", async () => {
    const base = foundDraft() as Extract<DutyPlanDraftDto, { found: true }>;
    await renderWith(
      foundDraft({
        algorithmVersion: "duty-plan-solver-v3.1.0",
        summary: { ...base.summary, optimalityProven: false, searchLimitReached: false, v3: { coverageOptimalityProven: true } as never },
      }),
    );
    expect(screen.getByText("Kapsama kesin maksimum")).toBeInTheDocument();
  });
});
