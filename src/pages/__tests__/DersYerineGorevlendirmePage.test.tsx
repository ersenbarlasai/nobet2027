import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../lib/substitutions/api";
import type { SubDayList, SubListItem, SubPreparation } from "../../lib/substitutions/types";
import DersYerineGorevlendirmePage from "../DersYerineGorevlendirmePage";

vi.mock("../../lib/substitutions/api");

const TIMETABLE_CARD_ID = "11111111-1111-4111-8111-111111111111";
const preparation: SubPreparation = {
  hasImport: true,
  dailySoftLimit: 5,
  teachers: [{ sourceId: "teacher-1", name: "Bulut Eda", branch: "Türk Dili ve Edebiyatı" }],
  lessons: [{
    key: "2026-09-14:1:teacher-1",
    assignmentDate: "2026-09-14",
    timetableCardId: TIMETABLE_CARD_ID,
    periodOrder: 1,
    periodName: "1. Saat",
    startsAt: "09:15:00",
    endsAt: "09:50:00",
    subjectName: "Edebiyat",
    classNames: "9/C",
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.fetchSubPreparation).mockImplementation(async (query) =>
    query.has("teacherSourceId") ? preparation : { ...preparation, lessons: [] });
  vi.mocked(api.fetchSubLists).mockResolvedValue({ items: [] });
  vi.mocked(api.createAbsence).mockResolvedValue({ status: "ok" });
});

afterEach(cleanup);

describe("DersYerineGorevlendirmePage", () => {
  it("React'e özel selected alanını yokluk kayıt isteğine göndermez", async () => {
    const user = userEvent.setup();
    render(<DersYerineGorevlendirmePage />);

    fireEvent.change(await screen.findByLabelText("Başlangıç"), { target: { value: "2026-09-14" } });
    fireEvent.change(screen.getByLabelText("Bitiş"), { target: { value: "2026-09-14" } });
    await user.selectOptions(await screen.findByLabelText("Öğretmen"), "teacher-1");
    await user.click(screen.getByRole("button", { name: /Dersleri getir ve devam et/i }));
    expect(await screen.findByText(/9\/C · Edebiyat/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Yokluğu kaydet ve görevlendirmeye geç/i }));

    await waitFor(() => expect(api.createAbsence).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(api.createAbsence).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toEqual(expect.objectContaining({
      teacherSourceId: "teacher-1",
      absenceScope: "all_day",
      reasonCode: "medical_report",
      lessons: [{ assignmentDate: "2026-09-14", timetableCardId: TIMETABLE_CARD_ID }],
    }));
    expect(payload).not.toHaveProperty("selected");
  });

  it("yokluk kaydı sürerken butonda işlem durumunu, bitince başarıyı gösterir", async () => {
    let finish!: (value: Record<string, unknown>) => void;
    vi.mocked(api.createAbsence).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<DersYerineGorevlendirmePage />);

    fireEvent.change(await screen.findByLabelText("Başlangıç"), { target: { value: "2026-09-14" } });
    fireEvent.change(screen.getByLabelText("Bitiş"), { target: { value: "2026-09-14" } });
    await user.selectOptions(await screen.findByLabelText("Öğretmen"), "teacher-1");
    await user.click(screen.getByRole("button", { name: /Dersleri getir ve devam et/i }));
    await screen.findByText(/9\/C · Edebiyat/);
    await user.click(screen.getByRole("button", { name: /Yokluğu kaydet ve görevlendirmeye geç/i }));

    const pendingButton = screen.getByRole("button", { name: /Kaydediliyor/ });
    expect(pendingButton).toBeDisabled();
    expect(pendingButton).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Yokluk kaydediliyor");

    finish({ status: "ok" });
    expect(await screen.findByRole("status")).toHaveTextContent("Yokluk kaydedildi. Şimdi derslere öğretmen atayın.");
    expect(screen.queryByRole("button", { name: /Yokluğu kaydet ve görevlendirmeye geç/i })).not.toBeInTheDocument();
  });

  it("kayıt sonrası eski ders seçimlerini temizler ve boş ikinci isteği engeller", async () => {
    const user = userEvent.setup();
    render(<DersYerineGorevlendirmePage />);

    await user.selectOptions(await screen.findByLabelText("Öğretmen"), "teacher-1");
    await user.click(screen.getByRole("button", { name: /Dersleri getir ve devam et/i }));
    expect(await screen.findByText(/9\/C · Edebiyat/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Yokluğu kaydet ve görevlendirmeye geç/i }));

    expect(await screen.findByRole("status")).toHaveTextContent("Yokluk kaydedildi. Şimdi derslere öğretmen atayın.");
    const saveButton = screen.queryByRole("button", { name: /Yokluğu kaydet ve görevlendirmeye geç/i });
    expect(saveButton).not.toBeInTheDocument();
    expect(screen.queryByText(/9\/C · Edebiyat/)).not.toBeInTheDocument();
    expect(api.createAbsence).toHaveBeenCalledTimes(1);
  });

  it("öğretmen değiştiğinde önceki öğretmenin ders seçimini geçersiz kılar", async () => {
    const user = userEvent.setup();
    render(<DersYerineGorevlendirmePage />);

    const teacherSelect = await screen.findByLabelText("Öğretmen");
    await user.selectOptions(teacherSelect, "teacher-1");
    await user.click(screen.getByRole("button", { name: /Dersleri getir ve devam et/i }));
    expect(await screen.findByText(/9\/C · Edebiyat/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Yokluğu kaydet ve görevlendirmeye geç/i })).toBeEnabled();

    await user.selectOptions(teacherSelect, "");
    expect(screen.queryByText(/9\/C · Edebiyat/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Yokluğu kaydet ve görevlendirmeye geç/i })).not.toBeInTheDocument();
  });

  it("yokluk kaydından sonra ilgili günlük listeyi ve ilk açık dersi otomatik açar", async () => {
    const listItem: SubListItem = { id: "list-1", assignmentDate: "2026-09-14", status: "draft", version: 1, isHistorical: false, taskCount: 1, assignedCount: 0, unfilledCount: 0 };
    const dayList: SubDayList = { found: true, id: "list-1", assignmentDate: "2026-09-14", status: "draft", version: 1, isHistorical: false, tasks: [{ id: "task-1", absenceId: "absence-1", periodOrder: 1, periodName: "1. Saat", startsAt: "09:15:00", endsAt: "09:50:00", absentTeacherSourceId: "teacher-1", absentTeacherName: "Bulut Eda", subjectName: "Edebiyat", classNames: "9/C", resolutionStatus: "open", substituteTeacherSourceId: null, substituteTeacherName: null, dailyLimitOverride: false, overrideNote: null, unfilledNote: null }] };
    vi.mocked(api.fetchSubLists).mockResolvedValue({ items: [listItem] });
    vi.mocked(api.fetchSubList).mockResolvedValue(dayList);
    vi.mocked(api.fetchSubCandidates).mockResolvedValue({ found: true, items: [] });
    const user = userEvent.setup();
    render(<DersYerineGorevlendirmePage />);

    fireEvent.change(await screen.findByLabelText("Başlangıç"), { target: { value: "2026-09-14" } });
    fireEvent.change(screen.getByLabelText("Bitiş"), { target: { value: "2026-09-14" } });
    await user.selectOptions(await screen.findByLabelText("Öğretmen"), "teacher-1");
    await user.click(screen.getByRole("button", { name: /Dersleri getir ve devam et/i }));
    await user.click(await screen.findByRole("button", { name: /Yokluğu kaydet ve görevlendirmeye geç/i }));

    expect(await screen.findByRole("heading", { name: "2026-09-14 görevlendirme listesi" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Dersleri çözün" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "9/C · 1. Saat" })).toBeInTheDocument();
    expect(api.fetchSubCandidates).toHaveBeenCalledWith("task-1");
  });

  it("görev ayrıntısında kimin yerine kimin atandığını açık etiketlerle gösterir", async () => {
    const listItem: SubListItem = { id: "list-1", assignmentDate: "2026-09-14", status: "completed", version: 2, isHistorical: false, taskCount: 1, assignedCount: 1, unfilledCount: 0 };
    const dayList: SubDayList = { found: true, id: "list-1", assignmentDate: "2026-09-14", status: "completed", version: 2, isHistorical: false, tasks: [{ id: "task-1", absenceId: "absence-1", periodOrder: 1, periodName: "1. Saat", startsAt: "09:15:00", endsAt: "09:50:00", absentTeacherSourceId: "teacher-1", absentTeacherName: "Bulut Eda", subjectName: "Edebiyat", classNames: "9/C", resolutionStatus: "assigned", substituteTeacherSourceId: "teacher-2", substituteTeacherName: "Dağabakan Gül", dailyLimitOverride: false, overrideNote: null, unfilledNote: null }] };
    vi.mocked(api.fetchSubLists).mockResolvedValue({ items: [listItem] });
    vi.mocked(api.fetchSubList).mockResolvedValue(dayList);
    vi.mocked(api.fetchSubCandidates).mockResolvedValue({ found: true, items: [] });
    const user = userEvent.setup();
    render(<DersYerineGorevlendirmePage />);

    await user.click(await screen.findByRole("button", { name: /Kayıtlı listeler/ }));
    await user.click(await screen.findByRole("button", { name: /2026-09-14/ }));

    const relation = await screen.findByLabelText("Bulut Eda öğretmenin yerine Dağabakan Gül");
    expect(within(relation).getByText("Dersi bulunan öğretmen")).toBeInTheDocument();
    expect(within(relation).getByText("Bulut Eda")).toBeInTheDocument();
    expect(within(relation).getByText("Yerine görevlendirilen öğretmen")).toBeInTheDocument();
    expect(within(relation).getByText("Dağabakan Gül")).toBeInTheDocument();
  });

  it("liste tamamlanırken butonda işlem durumunu, bitince başarıyı gösterir", async () => {
    const listItem: SubListItem = { id: "list-1", assignmentDate: "2026-09-14", status: "draft", version: 1, isHistorical: false, taskCount: 0, assignedCount: 0, unfilledCount: 0 };
    const completedItem: SubListItem = { ...listItem, status: "completed", version: 2 };
    const dayList: SubDayList = { found: true, id: "list-1", assignmentDate: "2026-09-14", status: "draft", version: 1, isHistorical: false, tasks: [] };
    vi.mocked(api.fetchSubLists).mockResolvedValueOnce({ items: [listItem] }).mockResolvedValueOnce({ items: [completedItem] });
    vi.mocked(api.fetchSubList).mockResolvedValue(dayList);
    let finish!: (value: { status: string; version: number }) => void;
    vi.mocked(api.completeSubList).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<DersYerineGorevlendirmePage />);

    await user.click(await screen.findByRole("button", { name: /Kayıtlı listeler/ }));
    await user.click(await screen.findByRole("button", { name: /2026-09-14/ }));
    await user.click(await screen.findByRole("button", { name: /Listeyi tamamla/i }));

    const pendingButton = screen.getByRole("button", { name: /Tamamlanıyor/ });
    expect(pendingButton).toBeDisabled();
    expect(pendingButton).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Görevlendirme listesi tamamlanıyor");

    finish({ status: "ok", version: 2 });
    expect(await screen.findByRole("status")).toHaveTextContent("Görevlendirme listesi tamamlandı ve Kayıtlı Listeler'e kaydedildi.");
    expect(screen.getByRole("heading", { name: "Günlük görevlendirme listeleri" })).toBeInTheDocument();
    const savedCard=screen.getByRole("button",{name:/2026-09-14/});
    expect(savedCard).toHaveTextContent("Tamamlandı");
    expect(screen.queryByRole("heading", { name: "Bu günlük liste tamamlandı" })).not.toBeInTheDocument();
    expect(api.fetchSubLists).toHaveBeenCalledTimes(2);
  });
});
