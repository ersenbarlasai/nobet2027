import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DenemeSinaviGozetmenPage from "../DenemeSinaviGozetmenPage";
import * as api from "../../lib/examInvigilation/api";
import { downloadExamInvigilationXlsx } from "../../lib/examInvigilationExport/downloadExamInvigilationXlsx";
import { ExamInvigilationApiError, type ExamPlanDetail, type ExamPlanListItem } from "../../lib/examInvigilation/types";

vi.mock("../../lib/examInvigilation/api");
vi.mock("../../lib/examInvigilationExport/downloadExamInvigilationXlsx", () => ({ downloadExamInvigilationXlsx: vi.fn(async () => {}) }));

const PLAN_ID = "plan-1";
const MIDDLE_SESSION = "middle-session";
const HIGH_SESSION = "high-session";

function detail(overrides: Partial<Extract<ExamPlanDetail, { found: true }>> = {}): Extract<ExamPlanDetail, { found: true }> {
  return {
    found: true,
    id: PLAN_ID,
    name: "18 Eylül Deneme Sınavı",
    weekStartDate: "2026-09-14",
    examDate: "2026-09-18",
    timetableImportId: "import-1",
    dutyPlanId: "duty-1",
    campusName: "Test Kampüs",
    academicYearName: "2026-2027",
    sourceFingerprint: "fingerprint",
    isStale: false,
    overallStatus: "draft",
    createdAt: "2026-09-10T10:00:00Z",
    updatedAt: "2026-09-10T10:00:00Z",
    scopes: [
      { id: "scope-middle", scopeCode: "MIDDLE_SCHOOL", status: "draft", listStatus: "draft", sessionCount: 1, version: 2, completedAt: null, sessions: [{ id: MIDDLE_SESSION, examDate:"2026-09-18",schoolClassId:"class-middle",schoolClassSourceId:"8a",schoolClassName:"8/A",periodOrder: 2, periodName: "2. Saat", startsAt: "09:20:00", endsAt: "10:00:00", requiredCount: 1, assignments: [] }] },
      { id: "scope-high", scopeCode: "HIGH_SCHOOL", status: "draft", listStatus: "draft", sessionCount: 1, version: 4, completedAt: null, sessions: [{ id: HIGH_SESSION, examDate:"2026-09-18",schoolClassId:"class-high",schoolClassSourceId:"11a",schoolClassName:"11/A",periodOrder: 2, periodName: "2. Saat", startsAt: "09:20:00", endsAt: "10:00:00", requiredCount: 1, assignments: [] }] },
    ],
    ...overrides,
  };
}

const preparation = { hasImport: true, teacherCount: 43, periods: [{ periodOrder: 2, name: "2. Saat", startsAt: "09:20:00", endsAt: "10:00:00" },{periodOrder:3,name:"3. Saat",startsAt:"10:10:00",endsAt:"10:50:00"}], classes:[{id:"33333333-3333-4333-8333-333333333333",sourceId:"8a",name:"8/A",grade:"8"},{id:"55555555-5555-4555-8555-555555555555",sourceId:"7a",name:"7/A",grade:""},{id:"44444444-4444-4444-8444-444444444444",sourceId:"11a",name:"11/A",grade:"11"},{id:"66666666-6666-4666-8666-666666666666",sourceId:"1a",name:"1/A",grade:""},{id:"77777777-7777-4777-8777-777777777777",sourceId:"6yas",name:"6YAS/A",grade:""}], publishedWeeks: [{ planId: "duty-1", weekStartDate: "2026-09-14", version: 3 }] };

function listItem(plan: Extract<ExamPlanDetail, { found: true }>, overrides: Partial<ExamPlanListItem> = {}): ExamPlanListItem {
  const assigned = plan.scopes.flatMap(s => s.sessions.flatMap(x => x.assignments)).length;
  const required = plan.scopes.reduce((sum, s) => sum + s.sessions.reduce((n, x) => n + x.requiredCount, 0), 0);
  return {
    id: plan.id, name: plan.name, weekStartDate: plan.weekStartDate, examDate: plan.examDate,
    examDates: Array.from(new Set(plan.scopes.flatMap(s => s.sessions.map(x => x.examDate ?? plan.examDate)))).sort(),
    createdAt: plan.createdAt, updatedAt: plan.updatedAt, isStale: plan.isStale, overallStatus: plan.overallStatus,
    requiredCount: required, assignedCount: assigned, openCount: required - assigned,
    dutyWarningCount: plan.scopes.flatMap(s => s.sessions.flatMap(x => x.assignments)).filter(a => a.dutyWarning?.length).length,
    scopes: plan.scopes.map(s => ({
      scopeCode: s.scopeCode, status: s.listStatus, rawStatus: s.status, planned: s.sessions.length > 0,
      version: s.version, completedAt: s.completedAt, sessionCount: s.sessions.length,
      requiredCount: s.sessions.reduce((n, x) => n + x.requiredCount, 0),
      assignedCount: s.sessions.flatMap(x => x.assignments).length,
      openCount: s.sessions.reduce((n, x) => n + x.requiredCount, 0) - s.sessions.flatMap(x => x.assignments).length,
      warningCount: s.sessions.flatMap(x => x.assignments).filter(a => a.dutyWarning?.length).length,
    })),
    ...overrides,
  };
}

function mockLoad(plan = detail(), items: ExamPlanListItem[] = [listItem(plan)]) {
  vi.mocked(api.fetchExamPreparation).mockResolvedValue(preparation);
  vi.mocked(api.fetchExamPlans).mockResolvedValue({ items });
  vi.mocked(api.fetchExamPlan).mockResolvedValue(plan);
  vi.mocked(api.fetchExamCandidates).mockResolvedValue({ found: true, sessionFound: true, scopeVersion: 2, isStale: false, candidates: [], excludedCounts: { lessonConflict: 0, otherScope: 0, otherSession: 0 } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoad();
  vi.mocked(api.setExamAssignment).mockResolvedValue({ status: "ok", scopeVersion: 3, assignmentId: "assignment-1" });
  vi.mocked(api.completeExamScope).mockResolvedValue({ status: "ok", version: 3 });
  vi.mocked(api.createExamPlan).mockResolvedValue({status:"ok",planId:PLAN_ID});
  vi.mocked(api.deleteExamPlan).mockResolvedValue({status:"ok"});
});
afterEach(cleanup);

describe("DenemeSinaviGozetmenPage", () => {
  it("iş akışını altı anlaşılır adımda gösterir ve gözetmen seçimini işaretler", async () => {
    render(<DenemeSinaviGozetmenPage />);
    await screen.findByRole("heading", { name: "Ortaokul Gözetmen Matrisi" });
    const workflow = screen.getByRole("navigation", { name: "Gözetmen planlama aşamaları" });
    expect(within(workflow).getByText("Sınav adı")).toBeInTheDocument();
    expect(within(workflow).getByText("Sınav tarihi")).toBeInTheDocument();
    expect(within(workflow).getByText("Kademe ve sınıflar")).toBeInTheDocument();
    expect(within(workflow).getByText("Ders saatleri")).toBeInTheDocument();
    expect(within(workflow).getByText("Gözetmenleri seç").closest(".eig-workflow-step")).toHaveAttribute("aria-current", "step");
    expect(within(workflow).getByText("Görev listesini tamamla")).toBeInTheDocument();
  });

  it("açık görev varken listeyi tamamlatmaz ve kalan işi açıkça söyler", async () => {
    render(<DenemeSinaviGozetmenPage />);
    await screen.findByRole("heading", { name: "Ortaokul Gözetmen Matrisi" });
    expect(screen.getByText("1 görev daha atanmalı")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ortaokul Listesini Tamamla" })).toBeDisabled();
    expect(api.completeExamScope).not.toHaveBeenCalled();
  });

  it("kontrol ve rapor tablolarını varsayılan olarak kapalı ikincil alanda tutar", async () => {
    render(<DenemeSinaviGozetmenPage />);
    await screen.findByRole("heading", { name: "Ortaokul Gözetmen Matrisi" });
    const audit = screen.getByText("Kontrol ve raporlar").closest("details");
    expect(audit).toBeInTheDocument();
    expect(audit).not.toHaveAttribute("open");
  });

  it("iki okul grubunu aynı çalışma alanında bağımsız sekmelerle gösterir", async () => {
    const user = userEvent.setup();
    render(<DenemeSinaviGozetmenPage />);
    expect(await screen.findByRole("heading", { name: "Deneme Sınavı Gözetmen Planlama" })).toBeInTheDocument();
    expect(screen.getByText(/Ortak öğretmen havuzu/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Lise Planı/ }));
    expect(screen.getByRole("heading", { name: "Lise Gözetmen Matrisi" })).toBeInTheDocument();
    expect(api.fetchExamCandidates).toHaveBeenLastCalledWith(PLAN_ID, HIGH_SESSION, expect.any(AbortSignal));
  });

  it("doğrudan uygun ve nöbet devri gereken adayları ayrı gruplar", async () => {
    vi.mocked(api.fetchExamCandidates).mockResolvedValue({ found: true, sessionFound: true, scopeVersion: 2, isStale: false, candidates: [
      { teacherSourceId: "t1", teacherName: "Hasan Yılmaz", branch: "Matematik", dailyLessonCount: 1, previousInvigilationCount: 0, weeklyDutyPoints: 10, suitability: "direct", dutyWarnings: [] },
      { teacherSourceId: "t2", teacherName: "Selin Karaca", branch: "Türkçe", dailyLessonCount: 0, previousInvigilationCount: 1, weeklyDutyPoints: 20, suitability: "duty_coverage_required", dutyWarnings: [{ packageId: "pkg", locationName: "Alt Bahçe", coverageMode: "BREAKS" }] },
    ], excludedCounts: { lessonConflict: 3, otherScope: 1, otherSession: 0 } });
    render(<DenemeSinaviGozetmenPage />);
    expect(await screen.findByText("Hasan Yılmaz")).toBeInTheDocument();
    expect(screen.getByText("Doğrudan uygun")).toBeInTheDocument();
    expect(screen.getByText("Uygun — nöbet devri gerekiyor")).toBeInTheDocument();
    expect(screen.getByText("Selin Karaca")).toBeInTheDocument();
    expect(screen.getByText("3 öğretmen derste")).toBeInTheDocument();
    expect(screen.getByText("1 öğretmen diğer okul grubunda")).toBeInTheDocument();
  });

  it("nöbetli öğretmeni açık onay ve idari not olmadan kaydetmez", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchExamCandidates).mockResolvedValue({ found: true, sessionFound: true, scopeVersion: 2, isStale: false, candidates: [
      { teacherSourceId: "t2", teacherName: "Selin Karaca", branch: "Türkçe", dailyLessonCount: 0, previousInvigilationCount: 1, weeklyDutyPoints: 20, suitability: "duty_coverage_required", dutyWarnings: [{ packageId: "pkg", locationName: "Alt Bahçe", coverageMode: "BREAKS" }] },
    ], excludedCounts: { lessonConflict: 0, otherScope: 0, otherSession: 0 } });
    vi.mocked(api.setExamAssignment).mockRejectedValueOnce(new ExamInvigilationApiError("duty_coverage_acknowledgement_required", "Nöbet devri onayı gerekli."));
    render(<DenemeSinaviGozetmenPage />);
    const teacher = await screen.findByText("Selin Karaca");
    await user.click(within(teacher.closest("article")!).getByRole("button", { name: "Ata" }));
    const dialog = await screen.findByRole("dialog", { name: "Nöbet devri gerekiyor" });
    expect(api.setExamAssignment).toHaveBeenCalledWith(PLAN_ID, MIDDLE_SESSION, expect.objectContaining({ dutyCoverageAcknowledged: false }));
    await user.type(within(dialog).getByRole("textbox"), "Rehber öğretmen teneffüste devralacak.");
    await user.click(within(dialog).getByRole("button", { name: "Onayla ve Ata" }));
    expect(api.setExamAssignment).toHaveBeenLastCalledWith(PLAN_ID, MIDDLE_SESSION, expect.objectContaining({ dutyCoverageAcknowledged: true, dutyCoverageNote: "Rehber öğretmen teneffüste devralacak." }));
  });

  it("tamamlama isteğini yalnız etkin okul grubunun sürümüyle gönderir", async () => {
    const user = userEvent.setup();
    const readyPlan = detail();
    readyPlan.scopes[0].sessions[0].assignments = [{ id: "a-ready", slotNumber: 1, teacherSourceId: "t-ready", teacherName: "Hazır Öğretmen", dutyWarning: null, dutyCoverageAcknowledged: false, dutyCoverageNote: null }];
    mockLoad(readyPlan);
    render(<DenemeSinaviGozetmenPage />);
    await screen.findByRole("heading", { name: "Ortaokul Gözetmen Matrisi" });
    await user.click(screen.getByRole("button", { name: "Ortaokul Listesini Tamamla" }));
    await waitFor(() => expect(api.completeExamScope).toHaveBeenCalledWith(PLAN_ID, "MIDDLE_SCHOOL", 2));
  });

  it("kaynak değişmişse tüm yazma eylemlerini kapatır", async () => {
    mockLoad(detail({ isStale: true }));
    vi.mocked(api.fetchExamCandidates).mockResolvedValue({ found: true, sessionFound: true, scopeVersion: 2, isStale: true, candidates: [{ teacherSourceId: "t1", teacherName: "Ada", branch: null, dailyLessonCount: 0, previousInvigilationCount: 0, weeklyDutyPoints: 0, suitability: "direct", dutyWarnings: [] }], excludedCounts: { lessonConflict: 0, otherScope: 0, otherSession: 0 } });
    render(<DenemeSinaviGozetmenPage />);
    expect(await screen.findByText("Kaynak değişti")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ortaokul Listesini Tamamla" })).toBeDisabled();
    expect(within((await screen.findByText("Ada")).closest("article")!).getByRole("button", { name: "Ata" })).toBeDisabled();
  });

  it("takvim tarihi, XML kademeleri, sınıflar ve ders saatlerinden oturumları oluşturur", async () => {
    const user=userEvent.setup();
    render(<DenemeSinaviGozetmenPage/>);
    await screen.findByRole("heading",{name:"Deneme Sınavı Gözetmen Planlama"});
    await user.click(screen.getByRole("button",{name:"Yeni Plan"}));
    const form=screen.getByRole("heading",{name:"Yeni sınav planı"}).closest("form")!;
    expect(within(form).getByText("Sınava girecek kademe ve sınıfları seçin")).toBeInTheDocument();
    expect(within(form).getByText("Ortaokul")).toBeInTheDocument();
    expect(within(form).getByText("Lise")).toBeInTheDocument();
    expect(within(form).getByText("İlkokul")).toBeInTheDocument();
    expect(within(form).getByText("Okul öncesi")).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Sınav tarihi"),{target:{value:"2026-09-18"}});
    await user.click(within(form).getByRole("checkbox",{name:/8\/A/}));
    await user.click(within(form).getByRole("checkbox",{name:/11\/A/}));
    await user.click(within(form).getByRole("button",{name:/2\. Saat/}));
    await user.click(within(form).getByRole("button",{name:/3\. Saat/}));
    await user.click(within(form).getByRole("button",{name:"Uygun öğretmenleri seçmeye geç"}));
    await waitFor(()=>expect(api.createExamPlan).toHaveBeenCalledWith({name:"Deneme Sınavı",weekStartDate:"2026-09-14",sessions:[
      expect.objectContaining({scopeCode:"MIDDLE_SCHOOL",examDate:"2026-09-18",periodOrder:2,schoolClassIds:["33333333-3333-4333-8333-333333333333"],requiredCount:1}),
      expect.objectContaining({scopeCode:"MIDDLE_SCHOOL",examDate:"2026-09-18",periodOrder:3,schoolClassIds:["33333333-3333-4333-8333-333333333333"],requiredCount:1}),
      expect.objectContaining({scopeCode:"HIGH_SCHOOL",examDate:"2026-09-18",periodOrder:2,schoolClassIds:["44444444-4444-4444-8444-444444444444"],requiredCount:1}),
      expect.objectContaining({scopeCode:"HIGH_SCHOOL",examDate:"2026-09-18",periodOrder:3,schoolClassIds:["44444444-4444-4444-8444-444444444444"],requiredCount:1}),
    ]}));
  });

  it("gün ve sınıf seçilmeden görev sayısı üretmez; sınıf × saat kadar görev hesaplar", async () => {
    const user=userEvent.setup();
    render(<DenemeSinaviGozetmenPage/>);
    await screen.findByRole("heading",{name:"Deneme Sınavı Gözetmen Planlama"});
    await user.click(screen.getByRole("button",{name:"Yeni Plan"}));
    const form=screen.getByRole("heading",{name:"Yeni sınav planı"}).closest("form")!;
    const summary=form.querySelector(".eig-schedule-summary")!;
    expect(summary).toHaveTextContent("0 sınıf");
    expect(within(form).getByRole("button",{name:"Uygun öğretmenleri seçmeye geç"})).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Sınav tarihi"),{target:{value:"2026-09-18"}});
    await user.click(within(form).getByRole("checkbox",{name:/8\/A/}));
    await user.click(within(form).getByRole("checkbox",{name:/7\/A/}));
    await user.click(within(form).getByRole("button",{name:/2\. Saat/}));
    await user.click(within(form).getByRole("button",{name:/3\. Saat/}));
    expect(summary).toHaveTextContent("2 sınıf");
    expect(summary).toHaveTextContent("4 gözetmen görevi");
    expect(within(form).getByRole("button",{name:"Uygun öğretmenleri seçmeye geç"})).toBeEnabled();
    await user.click(within(form).getByRole("button",{name:"Uygun öğretmenleri seçmeye geç"}));
    await waitFor(()=>expect(api.createExamPlan).toHaveBeenCalledWith(expect.objectContaining({sessions:[
      expect.objectContaining({periodOrder:2,schoolClassIds:["33333333-3333-4333-8333-333333333333","55555555-5555-4555-8555-555555555555"]}),
      expect.objectContaining({periodOrder:3,schoolClassIds:["33333333-3333-4333-8333-333333333333","55555555-5555-4555-8555-555555555555"]}),
    ]})));
  });

  it("çok günlü planda günü seçince yalnız o günün sınıf oturumlarını gösterir", async () => {
    const user=userEvent.setup();
    const multi=detail();
    multi.scopes[0].sessions.push({id:"middle-wed",examDate:"2026-09-16",schoolClassId:"class-7a",schoolClassSourceId:"7a",schoolClassName:"7/A",periodOrder:2,periodName:"2. Saat",startsAt:"09:20:00",endsAt:"10:00:00",requiredCount:1,assignments:[]});
    mockLoad(multi);
    render(<DenemeSinaviGozetmenPage/>);
    expect(await screen.findByRole("row",{name:/8\/A/})).toBeInTheDocument();
    await user.click(screen.getByRole("button",{name:/16 Eyl Çar/}));
    expect(screen.getByRole("row",{name:/7\/A/})).toBeInTheDocument();
    expect(screen.queryByRole("row",{name:/8\/A/})).not.toBeInTheDocument();
  });

  it("gözetmen matrisini sınıf satırları ve ders saati sütunlarıyla kurar", async () => {
    const user=userEvent.setup();
    const matrixPlan=detail();
    matrixPlan.scopes[0].sessions=[
      {id:"8a-p2",examDate:"2026-09-18",schoolClassId:"class-8a",schoolClassSourceId:"8a",schoolClassName:"8/A",periodOrder:2,periodName:"2. Saat",startsAt:"09:20:00",endsAt:"10:00:00",requiredCount:1,assignments:[]},
      {id:"8a-p3",examDate:"2026-09-18",schoolClassId:"class-8a",schoolClassSourceId:"8a",schoolClassName:"8/A",periodOrder:3,periodName:"3. Saat",startsAt:"10:10:00",endsAt:"10:50:00",requiredCount:1,assignments:[]},
      {id:"7a-p2",examDate:"2026-09-18",schoolClassId:"class-7a",schoolClassSourceId:"7a",schoolClassName:"7/A",periodOrder:2,periodName:"2. Saat",startsAt:"09:20:00",endsAt:"10:00:00",requiredCount:1,assignments:[]},
    ];
    mockLoad(matrixPlan);
    render(<DenemeSinaviGozetmenPage/>);
    const matrix=await screen.findByRole("table",{name:"Ortaokul sınıf ve ders saati gözetmen matrisi"});
    expect(within(matrix).getByRole("columnheader",{name:/2\. Saat/})).toBeInTheDocument();
    expect(within(matrix).getByRole("columnheader",{name:/3\. Saat/})).toBeInTheDocument();
    const row8=within(matrix).getByRole("row",{name:/8\/A/});
    expect(within(row8).getAllByRole("button",{name:/Gözetmen seç/})).toHaveLength(2);
    const row7=within(matrix).getByRole("row",{name:/7\/A/});
    expect(within(row7).getByLabelText("7/A 3. Saat için sınav yok")).toHaveTextContent("—");
    await user.click(within(row8).getByRole("button",{name:/8\/A · 3\. Saat/}));
    expect(api.fetchExamCandidates).toHaveBeenLastCalledWith(PLAN_ID,"8a-p3",expect.any(AbortSignal));
  });

  it("eski sınıfsız oturumlarda plan tarihine düşer ve Invalid Date göstermez", async () => {
    const legacy=detail();
    legacy.scopes=legacy.scopes.map(scope=>({...scope,sessions:scope.sessions.map(session=>({id:session.id,periodOrder:session.periodOrder,periodName:session.periodName,startsAt:session.startsAt,endsAt:session.endsAt,requiredCount:session.requiredCount,assignments:session.assignments}))}));
    mockLoad(legacy);
    render(<DenemeSinaviGozetmenPage/>);
    expect(await screen.findByRole("button",{name:/18 Eyl Cum/})).toBeInTheDocument();
    expect(screen.getAllByText("Genel oturum").length).toBeGreaterThan(0);
    expect(screen.getByText(/Plan oluşturulurken sınıflar seçilmediği için görev adetleri/)).toBeInTheDocument();
    expect(screen.getByRole("button",{name:"Ortaokul Listesini Tamamla"})).toBeDisabled();
    expect(screen.getByRole("button",{name:"Doğru yapıyla yeni plan oluştur"})).toBeInTheDocument();
    expect(screen.queryByText("Invalid Date")).not.toBeInTheDocument();
  });
});

const COMPLETED_PLAN_ID = "plan-completed";

function completedPlan(): Extract<ExamPlanDetail, { found: true }> {
  return {
    ...detail(),
    id: COMPLETED_PLAN_ID,
    name: "Tamamlanmış Deneme Sınavı",
    overallStatus: "completed",
    scopes: [
      { id: "scope-middle", scopeCode: "MIDDLE_SCHOOL", status: "completed", listStatus: "completed", sessionCount: 3, version: 6, completedAt: "2026-09-19T08:00:00Z", sessions: [
        { id: "m-8a-p2", examDate: "2026-09-18", schoolClassId: "class-8a", schoolClassSourceId: "8a", schoolClassName: "8/A", periodOrder: 2, periodName: "2. Saat", startsAt: "09:20:00", endsAt: "10:00:00", requiredCount: 1, assignments: [{ id: "a1", slotNumber: 1, teacherSourceId: "t1", teacherName: "Hasan Yılmaz", dutyWarning: null, dutyCoverageAcknowledged: false, dutyCoverageNote: null }] },
        { id: "m-8a-p3", examDate: "2026-09-18", schoolClassId: "class-8a", schoolClassSourceId: "8a", schoolClassName: "8/A", periodOrder: 3, periodName: "3. Saat", startsAt: "10:10:00", endsAt: "10:50:00", requiredCount: 1, assignments: [{ id: "a2", slotNumber: 1, teacherSourceId: "t2", teacherName: "Selin Karaca", dutyWarning: [{ packageId: "pkg", locationName: "Alt Bahçe", coverageMode: "SHORT_BREAKS" }], dutyCoverageAcknowledged: true, dutyCoverageNote: "Rehber öğretmen devralacak." }] },
        { id: "m-7a-p2", examDate: "2026-09-17", schoolClassId: "class-7a", schoolClassSourceId: "7a", schoolClassName: "7/A", periodOrder: 2, periodName: "2. Saat", startsAt: "09:20:00", endsAt: "10:00:00", requiredCount: 1, assignments: [{ id: "a3", slotNumber: 1, teacherSourceId: "t1", teacherName: "Hasan Yılmaz", dutyWarning: null, dutyCoverageAcknowledged: false, dutyCoverageNote: null }] },
      ] },
      { id: "scope-high", scopeCode: "HIGH_SCHOOL", status: "draft", listStatus: "not_planned", sessionCount: 0, version: 1, completedAt: null, sessions: [] },
    ],
  };
}

describe("Plan kayıtları ve tamamlanmış plan görüntüleme", () => {
  it("taslak kaydı düzenlemeye açar ve onayla silebilir", async () => {
    const user=userEvent.setup();
    const confirm=vi.spyOn(window,"confirm").mockReturnValue(true);
    render(<DenemeSinaviGozetmenPage/>);
    await screen.findByRole("heading",{name:"Ortaokul Gözetmen Matrisi"});
    await user.click(screen.getByRole("button",{name:"Plan kayıtları"}));
    let record=await screen.findByRole("listitem",{name:"18 Eylül Deneme Sınavı"});
    expect(within(record).getByRole("button",{name:"Düzenle"})).toBeInTheDocument();
    await user.click(within(record).getByRole("button",{name:"Düzenle"}));
    expect(await screen.findByRole("heading",{name:"Ortaokul Gözetmen Matrisi"})).toBeInTheDocument();
    await user.click(screen.getByRole("button",{name:"Plan kayıtları"}));
    record=await screen.findByRole("listitem",{name:"18 Eylül Deneme Sınavı"});
    await user.click(within(record).getByRole("button",{name:"Sil"}));
    await waitFor(()=>expect(api.deleteExamPlan).toHaveBeenCalledWith(PLAN_ID));
    expect(await screen.findByRole("status")).toHaveTextContent("18 Eylül Deneme Sınavı silindi.");
    confirm.mockRestore();
  });

  it("tamamlanmış planı etkisi açıklanan onaydan sonra silebilir", async () => {
    const user=userEvent.setup();
    const plan=completedPlan();
    mockLoad(plan,[listItem(plan)]);
    const confirm=vi.spyOn(window,"confirm").mockReturnValue(true);
    render(<DenemeSinaviGozetmenPage/>);
    await screen.findByRole("heading",{name:"Deneme Sınavı Gözetmen Planlama"});
    await user.click(screen.getByRole("button",{name:"Plan kayıtları"}));
    const record=await screen.findByRole("listitem",{name:"Tamamlanmış Deneme Sınavı"});
    await user.click(within(record).getByRole("button",{name:"Sil"}));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/tamamlanmış planı kalıcı olarak silinecek.*gözetmen atamaları/));
    await waitFor(()=>expect(api.deleteExamPlan).toHaveBeenCalledWith(plan.id));
    expect(await screen.findByRole("status")).toHaveTextContent("Tamamlanmış Deneme Sınavı silindi.");
    confirm.mockRestore();
  });

  it("son okul grubu tamamlanınca kayıtlar ekranına geçer ve başarı bildirimi verir", async () => {
    const user = userEvent.setup();
    const initial = completedPlan();
    initial.overallStatus = "draft";
    initial.scopes[0] = { ...initial.scopes[0], status: "draft", listStatus: "draft", completedAt: null };
    const fresh = completedPlan();
    mockLoad(initial, [listItem(initial)]);
    vi.mocked(api.fetchExamPlan).mockResolvedValueOnce(initial).mockResolvedValueOnce(fresh);
    render(<DenemeSinaviGozetmenPage />);
    await screen.findByRole("heading", { name: "Ortaokul Gözetmen Matrisi" });
    await user.click(screen.getByRole("button", { name: "Ortaokul Listesini Tamamla" }));
    expect(await screen.findByRole("heading", { name: "Plan kayıtları" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Tamamlanmış Deneme Sınavı tamamlandı ve Plan Kayıtları'na kaydedildi.");
  });

  it("durum sekmesini ve süzgeçleri sunucuya taşır, kuralı istemcide yeniden kurmaz", async () => {
    const user = userEvent.setup();
    render(<DenemeSinaviGozetmenPage />);
    await screen.findByRole("heading", { name: "Deneme Sınavı Gözetmen Planlama" });
    await user.click(screen.getByRole("button", { name: "Plan kayıtları" }));
    await user.click(screen.getByRole("button", { name: "Tamamlananlar" }));
    await waitFor(() => expect(api.fetchExamPlans).toHaveBeenLastCalledWith(expect.objectContaining({ status: "completed" }), expect.any(AbortSignal)));
    await user.click(screen.getByRole("button", { name: "Kaynağı değişenler" }));
    await waitFor(() => expect(api.fetchExamPlans).toHaveBeenLastCalledWith(expect.objectContaining({ status: "stale" }), expect.any(AbortSignal)));
    await user.type(screen.getByLabelText("Sınav adı ara"), "Deneme");
    await waitFor(() => expect(api.fetchExamPlans).toHaveBeenLastCalledWith(expect.objectContaining({ search: "Deneme" }), expect.any(AbortSignal)));
    await user.selectOptions(screen.getByLabelText("Kademe"), "HIGH_SCHOOL");
    await waitFor(() => expect(api.fetchExamPlans).toHaveBeenLastCalledWith(expect.objectContaining({ scopeCode: "HIGH_SCHOOL" }), expect.any(AbortSignal)));
    await user.selectOptions(screen.getByLabelText("Sıralama"), "oldest");
    await waitFor(() => expect(api.fetchExamPlans).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "oldest" }), expect.any(AbortSignal)));
    fireEvent.change(screen.getByLabelText("Başlangıç tarihi"), { target: { value: "2026-09-14" } });
    await waitFor(() => expect(api.fetchExamPlans).toHaveBeenLastCalledWith(expect.objectContaining({ dateFrom: "2026-09-14" }), expect.any(AbortSignal)));
    fireEvent.change(screen.getByLabelText("Bitiş tarihi"), { target: { value: "2026-09-18" } });
    await waitFor(() => expect(api.fetchExamPlans).toHaveBeenLastCalledWith(expect.objectContaining({ dateTo: "2026-09-18" }), expect.any(AbortSignal)));
  });

  it("planlanmamış okul grubunu genel tamamlanma durumundan ayrı gösterir", async () => {
    const user = userEvent.setup();
    const plan = completedPlan();
    mockLoad(plan, [listItem(plan)]);
    render(<DenemeSinaviGozetmenPage />);
    await screen.findByRole("heading", { name: "Deneme Sınavı Gözetmen Planlama" });
    await user.click(screen.getByRole("button", { name: "Plan kayıtları" }));
    const record = await screen.findByRole("listitem", { name: "Tamamlanmış Deneme Sınavı" });
    expect(within(within(record).getByLabelText("Plan durumu")).getByText("Tamamlandı")).toBeInTheDocument();
    expect(within(record).getByText("Ortaokul durumu").nextSibling).toHaveTextContent("Tamamlandı");
    expect(within(record).getByText("Lise durumu").nextSibling).toHaveTextContent("Planlanmadı");
    expect(within(record).getByText("Toplam görev").nextSibling).toHaveTextContent("3");
    expect(within(record).getByText("Nöbet devri uyarısı").nextSibling).toHaveTextContent("1");
    expect(within(record).getByText("Kaynak güncel")).toBeInTheDocument();
  });

  it("yalnız bir okul grubu tamamlandığında planı taslak gösterir", async () => {
    const user = userEvent.setup();
    const plan = completedPlan();
    plan.overallStatus = "draft";
    plan.scopes[1] = { ...plan.scopes[1], listStatus: "draft", sessionCount: 1, sessions: [{ id: "h-11a", examDate: "2026-09-18", schoolClassId: "class-11a", schoolClassSourceId: "11a", schoolClassName: "11/A", periodOrder: 2, periodName: "2. Saat", startsAt: "09:20:00", endsAt: "10:00:00", requiredCount: 1, assignments: [] }] };
    mockLoad(plan, [listItem(plan)]);
    render(<DenemeSinaviGozetmenPage />);
    await screen.findByRole("heading", { name: "Deneme Sınavı Gözetmen Planlama" });
    await user.click(screen.getByRole("button", { name: "Plan kayıtları" }));
    const record = await screen.findByRole("listitem", { name: "Tamamlanmış Deneme Sınavı" });
    expect(within(within(record).getByLabelText("Plan durumu")).getByText("Taslak")).toBeInTheDocument();
    expect(within(record).getByText("Ortaokul durumu").nextSibling).toHaveTextContent("Tamamlandı");
    expect(within(record).getByText("Lise durumu").nextSibling).toHaveTextContent("Taslak");
  });

  it("tamamlanmış planı salt okunur açar ve yazma düğmelerini göstermez", async () => {
    const user = userEvent.setup();
    const plan = completedPlan();
    mockLoad(plan, [listItem(plan)]);
    render(<DenemeSinaviGozetmenPage />);
    await screen.findByRole("heading", { name: "Deneme Sınavı Gözetmen Planlama" });
    await user.click(screen.getByRole("button", { name: "Plan kayıtları" }));
    await user.click(await screen.findByRole("button", { name: "Görüntüle" }));
    expect(await screen.findByText("Tamamlanmış plan · Salt okunur")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ortaokul Listesini Tamamla" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ata" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /atamasını kaldır/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Gözetmen seç/ })).not.toBeInTheDocument();
    expect(api.fetchExamCandidates).not.toHaveBeenCalled();
  });

  it("salt okunur matrisi sınıf × ders saati kurar ve tarihsel öğretmen adlarını yazar", async () => {
    const plan = completedPlan();
    mockLoad(plan, [listItem(plan)]);
    render(<DenemeSinaviGozetmenPage />);
    const matrix = await screen.findByRole("table", { name: "Ortaokul sınıf ve ders saati gözetmen matrisi" });
    expect(within(matrix).getByRole("columnheader", { name: /2\. Saat/ })).toBeInTheDocument();
    expect(within(matrix).getByRole("columnheader", { name: /3\. Saat/ })).toBeInTheDocument();
    const row = within(matrix).getByRole("row", { name: /8\/A/ });
    expect(within(row).getByText("Hasan Yılmaz")).toBeInTheDocument();
    expect(within(row).getByText("Selin Karaca")).toBeInTheDocument();
  });

  it("gün sekmeleri yalnız o günün oturumlarını gösterir ve boş kesişimi — yapar", async () => {
    const user = userEvent.setup();
    const plan = completedPlan();
    mockLoad(plan, [listItem(plan)]);
    render(<DenemeSinaviGozetmenPage />);
    await screen.findByRole("table", { name: "Ortaokul sınıf ve ders saati gözetmen matrisi" });
    await user.click(screen.getByRole("button", { name: /17 Eyl Per/ }));
    const thursday = screen.getByRole("table", { name: "Ortaokul sınıf ve ders saati gözetmen matrisi" });
    expect(within(thursday).getByRole("row", { name: /7\/A/ })).toBeInTheDocument();
    expect(within(thursday).queryByRole("row", { name: /8\/A/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /18 Eyl Cum/ }));
    const friday = screen.getByRole("table", { name: "Ortaokul sınıf ve ders saati gözetmen matrisi" });
    expect(within(friday).getByRole("row", { name: /8\/A/ })).toBeInTheDocument();
  });

  it("sınav yapılmayan sınıf–saat kesişimini — olarak gösterir", async () => {
    const plan = completedPlan();
    plan.scopes[0].sessions.push({ id: "m-7a-p2b", examDate: "2026-09-18", schoolClassId: "class-7a", schoolClassSourceId: "7a", schoolClassName: "7/A", periodOrder: 2, periodName: "2. Saat", startsAt: "09:20:00", endsAt: "10:00:00", requiredCount: 1, assignments: [] });
    mockLoad(plan, [listItem(plan)]);
    render(<DenemeSinaviGozetmenPage />);
    const matrix = await screen.findByRole("table", { name: "Ortaokul sınıf ve ders saati gözetmen matrisi" });
    expect(within(matrix).getByLabelText("7/A 3. Saat için sınav yok")).toHaveTextContent("—");
  });

  it("tarihsel snapshot adlarını, nöbet devri uyarısını ve idari notu korur", async () => {
    const plan = completedPlan();
    mockLoad(plan, [listItem(plan)]);
    render(<DenemeSinaviGozetmenPage />);
    expect(await screen.findByRole("heading", { name: "Nöbet Devri Gereken Görevlendirmeler" })).toBeInTheDocument();
    expect(screen.getByText("Rehber öğretmen devralacak.")).toBeInTheDocument();
    expect(screen.getByText(/Alt Bahçe · SHORT_BREAKS/)).toBeInTheDocument();
    const summary = screen.getByRole("table", { name: "Öğretmen bazlı gözetmenlik özeti" });
    expect(within(summary).getByRole("row", { name: /Hasan Yılmaz/ })).toHaveTextContent("2");
  });

  it("tamamlanmış planda yazdır ve XLSX indir eylemlerini sunar", async () => {
    const user = userEvent.setup();
    const plan = completedPlan();
    mockLoad(plan, [listItem(plan)]);
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    render(<DenemeSinaviGozetmenPage />);
    await screen.findByText("Tamamlanmış plan · Salt okunur");
    await user.click(screen.getByRole("button", { name: "Yazdır" }));
    expect(print).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "XLSX indir" }));
    await waitFor(() => expect(downloadExamInvigilationXlsx).toHaveBeenCalledWith(plan));
    print.mockRestore();
  });

  it("taslak planda salt okunur rozetini ve dışa aktarma eylemlerini göstermez", async () => {
    render(<DenemeSinaviGozetmenPage />);
    await screen.findByRole("heading", { name: "Ortaokul Gözetmen Matrisi" });
    expect(screen.queryByText("Tamamlanmış plan · Salt okunur")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "XLSX indir" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ortaokul Listesini Tamamla" })).toBeInTheDocument();
  });
});
