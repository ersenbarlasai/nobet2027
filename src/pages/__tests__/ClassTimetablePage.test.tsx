import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ClassTimetablePage from "../ClassTimetablePage";
import * as fetchModule from "../../lib/classTimetables/fetchClassTimetables";
import type { ClassTimetableResponse, CurrentImportClassesResponse } from "../../lib/classTimetables/types";

const NO_IMPORT: CurrentImportClassesResponse = { hasImport: false, importedAt: null, classes: [] };

const CLASSES: CurrentImportClassesResponse = {
  hasImport: true,
  importedAt: "2026-08-31T20:23:46.000Z",
  classes: [
    { id: "c-5a", sourceId: "C1", name: "5/A", grade: "5" },
    { id: "c-5b", sourceId: "C2", name: "5/B", grade: "5" },
  ],
};

const TIMETABLE_5A: ClassTimetableResponse = {
  hasImport: true,
  classFound: true,
  class: { id: "c-5a", sourceId: "C1", name: "5/A", grade: "5", classTeacher: { id: "t-1", name: "YILDIRIM İREM" } },
  importedAt: "2026-08-31T20:23:46.000Z",
  days: [{ id: "d-1", sourceId: "D1", name: "Pazartesi", order: 1 }],
  periods: [
    { id: "p-1", sourceId: "P1", name: "1", order: 1, startTime: "08:30:00", endTime: "09:10:00" },
    // Gerçek XML'de period.order (teknik sıra) ile period.name (gerçek zil
    // adı) farklı olabilir — "5-OO"/"5-IO" burada tam bunu test eder.
    { id: "p-5oo", sourceId: "5", name: "5-OO", order: 5, startTime: "12:15:00", endTime: "12:50:00" },
    { id: "p-5io", sourceId: "6", name: "5-IO", order: 6, startTime: "12:50:00", endTime: "13:25:00" },
  ],
  lessons: [
    {
      cardId: "card-1",
      sourceCardKey: "card-1",
      dayId: "d-1",
      periodId: "p-1",
      subjectName: "Matematik",
      teacherNames: ["A. Yılmaz"],
      classroomNames: ["5A-D1"],
      mappingStatus: "exact",
      teacherAssignmentStatus: "assigned",
      conflict: false,
    },
    {
      cardId: "card-2",
      sourceCardKey: "card-2",
      dayId: "d-1",
      periodId: "p-5oo",
      subjectName: "ORTAOKUL FEN BİLİMLERİ",
      teacherNames: ["Y. Rukiye"],
      classroomNames: [],
      mappingStatus: "exact",
      teacherAssignmentStatus: "assigned",
      conflict: false,
    },
  ],
  summary: {
    dayCount: 1,
    periodCount: 3,
    weeklyLessonCount: 2,
    occupiedCellCount: 2,
    ambiguousCellCount: 0,
    conflictCellCount: 0,
  },
};

const EMPTY_TIMETABLE: ClassTimetableResponse = {
  ...TIMETABLE_5A,
  lessons: [],
  summary: { ...TIMETABLE_5A.summary, weeklyLessonCount: 0, occupiedCellCount: 0 },
};

describe("ClassTimetablePage", () => {
  beforeEach(() => {
    vi.spyOn(fetchModule, "fetchClasses");
    vi.spyOn(fetchModule, "fetchClassTimetable");
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("16) yükleniyor durumunda skeleton (aria-busy) gösterir", () => {
    vi.mocked(fetchModule.fetchClasses).mockReturnValue(new Promise(() => {}));
    const { container } = render(<ClassTimetablePage />);
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it("17) import yokken yönlendirici boş durum gösterir", async () => {
    vi.mocked(fetchModule.fetchClasses).mockResolvedValue(NO_IMPORT);
    render(<ClassTimetablePage />);

    expect(await screen.findByText("Henüz bir XML dosyası yüklenmedi.")).toBeInTheDocument();
    expect(screen.getByText("Önce Veri ve XML ekranından ders programını yükleyin.")).toBeInTheDocument();
  });

  it("18) import var fakat sınıf yoksa uygun mesaj gösterir", async () => {
    vi.mocked(fetchModule.fetchClasses).mockResolvedValue({ hasImport: true, importedAt: "2026-08-31T20:23:46.000Z", classes: [] });
    render(<ClassTimetablePage />);

    expect(await screen.findByText("Yüklenen XML dosyasında sınıf bulunamadı.")).toBeInTheDocument();
  });

  it("19) sınıf seçilmeden önce takvim ikonlu bilgi mesajı gösterir, özet '—' olur", async () => {
    vi.mocked(fetchModule.fetchClasses).mockResolvedValue(CLASSES);
    render(<ClassTimetablePage />);

    expect(await screen.findByText("Ders programını görüntülemek için bir sınıf seçin.")).toBeInTheDocument();
    const pills = screen.getAllByText("—");
    expect(pills.length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole("button", { name: /yazdır/i })).toBeDisabled();
  });

  it("20) seçilen sınıfın programı boşsa uygun mesaj gösterir", async () => {
    vi.mocked(fetchModule.fetchClasses).mockResolvedValue(CLASSES);
    vi.mocked(fetchModule.fetchClassTimetable).mockResolvedValue(EMPTY_TIMETABLE);
    const user = userEvent.setup();
    render(<ClassTimetablePage />);

    const select = await screen.findByLabelText("Sınıf Seçin");
    await user.selectOptions(select, "c-5a");

    expect(await screen.findByText("Bu sınıf için ders programı bulunamadı.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /yazdır/i })).toBeDisabled();
  });

  it("16-20) öğretmensiz ders (ör. ORTAOKUL DENEME) boş hücre olarak GİZLENMEZ, 'Öğretmen atanmamış' gösterir", async () => {
    vi.mocked(fetchModule.fetchClasses).mockResolvedValue(CLASSES);
    vi.mocked(fetchModule.fetchClassTimetable).mockResolvedValue({
      ...TIMETABLE_5A,
      lessons: [
        {
          cardId: "card-exam-1",
          sourceCardKey: "card-exam-1",
          dayId: "d-1",
          periodId: "p-5oo",
          subjectName: "ORTAOKUL DENEME",
          teacherNames: [],
          classroomNames: [],
          mappingStatus: null,
          teacherAssignmentStatus: "unassigned",
          conflict: false,
        },
      ],
      summary: { ...TIMETABLE_5A.summary, weeklyLessonCount: 1, occupiedCellCount: 1, ambiguousCellCount: 0 },
    });
    const user = userEvent.setup();
    render(<ClassTimetablePage />);

    const select = await screen.findByLabelText("Sınıf Seçin");
    await user.selectOptions(select, "c-5a");

    expect(await screen.findByText("ORTAOKUL DENEME")).toBeInTheDocument();
    expect(screen.getByText("Öğretmen atanmamış")).toBeInTheDocument();
    // "Bu sınıf için ders programı bulunamadı." GÖSTERİLMEMELİ — öğretmensiz de olsa gerçek ders var.
    expect(screen.queryByText("Bu sınıf için ders programı bulunamadı.")).not.toBeInTheDocument();
  });

  it("21) program başarıyla görüntülenir; hücrede ders/öğretmen/derslik gösterilir", async () => {
    vi.mocked(fetchModule.fetchClasses).mockResolvedValue(CLASSES);
    vi.mocked(fetchModule.fetchClassTimetable).mockResolvedValue(TIMETABLE_5A);
    const user = userEvent.setup();
    render(<ClassTimetablePage />);

    const select = await screen.findByLabelText("Sınıf Seçin");
    await user.selectOptions(select, "c-5a");

    expect(await screen.findByText("Matematik")).toBeInTheDocument();
    expect(screen.getByText("A. Yılmaz")).toBeInTheDocument();
    expect(screen.getByText("5A-D1")).toBeInTheDocument();
    expect(screen.getByText("1 Gün")).toBeInTheDocument();
    expect(screen.getByText("3 Ders Saati")).toBeInTheDocument();
    expect(screen.getByText("2 Haftalık Ders")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /yazdır/i })).toBeEnabled();
  });

  it("16/17) gerçek period.name gösterir; '5. Ders'/'6. Ders' gibi order'dan üretilmiş yapay başlık göstermez", async () => {
    vi.mocked(fetchModule.fetchClasses).mockResolvedValue(CLASSES);
    vi.mocked(fetchModule.fetchClassTimetable).mockResolvedValue(TIMETABLE_5A);
    const user = userEvent.setup();
    render(<ClassTimetablePage />);

    const select = await screen.findByLabelText("Sınıf Seçin");
    await user.selectOptions(select, "c-5a");
    await screen.findByText("Matematik");

    expect(screen.getByText("12:15–12:50")).toBeInTheDocument();
    expect(screen.getByText("12:50–13:25")).toBeInTheDocument();
    expect(screen.queryByText("5. Ders")).not.toBeInTheDocument();
    expect(screen.queryByText("6. Ders")).not.toBeInTheDocument();
    expect(screen.queryByText(/YEMEK/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Öğle Arası/i)).not.toBeInTheDocument();
  });

  it("18) 5-OO ve 5-IO ayrı sütun olarak gösterilir", async () => {
    vi.mocked(fetchModule.fetchClasses).mockResolvedValue(CLASSES);
    vi.mocked(fetchModule.fetchClassTimetable).mockResolvedValue(TIMETABLE_5A);
    const user = userEvent.setup();
    render(<ClassTimetablePage />);

    const select = await screen.findByLabelText("Sınıf Seçin");
    await user.selectOptions(select, "c-5a");
    await screen.findByText("Matematik");

    const headers = screen.getAllByRole("columnheader");
    const headerTexts = headers.map((h) => h.textContent ?? "");
    expect(headerTexts.some((t) => t.includes("5-OO"))).toBe(true);
    expect(headerTexts.some((t) => t.includes("5-IO"))).toBe(true);
  });

  it("21) sınıf öğretmeni gösterilir", async () => {
    vi.mocked(fetchModule.fetchClasses).mockResolvedValue(CLASSES);
    vi.mocked(fetchModule.fetchClassTimetable).mockResolvedValue(TIMETABLE_5A);
    const user = userEvent.setup();
    render(<ClassTimetablePage />);

    const select = await screen.findByLabelText("Sınıf Seçin");
    await user.selectOptions(select, "c-5a");

    expect(await screen.findByText("Sınıf Öğretmeni")).toBeInTheDocument();
    expect(screen.getByText("YILDIRIM İREM")).toBeInTheDocument();
  });

  it("22) sınıf öğretmeni olmayan sınıfta 'Tanımlanmamış' gösterilir", async () => {
    vi.mocked(fetchModule.fetchClasses).mockResolvedValue(CLASSES);
    vi.mocked(fetchModule.fetchClassTimetable).mockResolvedValue({
      ...TIMETABLE_5A,
      class: { ...TIMETABLE_5A.class, classTeacher: null },
    });
    const user = userEvent.setup();
    render(<ClassTimetablePage />);

    const select = await screen.findByLabelText("Sınıf Seçin");
    await user.selectOptions(select, "c-5a");

    expect(await screen.findByText("Tanımlanmamış")).toBeInTheDocument();
  });

  it("19) sınıf seçilmeden önce sınıf öğretmeni alanı hiç gösterilmez", async () => {
    vi.mocked(fetchModule.fetchClasses).mockResolvedValue(CLASSES);
    render(<ClassTimetablePage />);

    await screen.findByText("Ders programını görüntülemek için bir sınıf seçin.");
    expect(screen.queryByText("Sınıf Öğretmeni")).not.toBeInTheDocument();
  });

  it("23) gerçek subject adları değiştirilmeden gösterilir", async () => {
    vi.mocked(fetchModule.fetchClasses).mockResolvedValue(CLASSES);
    vi.mocked(fetchModule.fetchClassTimetable).mockResolvedValue(TIMETABLE_5A);
    const user = userEvent.setup();
    render(<ClassTimetablePage />);

    const select = await screen.findByLabelText("Sınıf Seçin");
    await user.selectOptions(select, "c-5a");

    expect(await screen.findByText("ORTAOKUL FEN BİLİMLERİ")).toBeInTheDocument();
  });

  it("25) yazdırma görünümünde gerçek period adı ve sınıf öğretmeni yer alır", async () => {
    vi.mocked(fetchModule.fetchClasses).mockResolvedValue(CLASSES);
    vi.mocked(fetchModule.fetchClassTimetable).mockResolvedValue(TIMETABLE_5A);
    const user = userEvent.setup();
    const { container } = render(<ClassTimetablePage />);

    const select = await screen.findByLabelText("Sınıf Seçin");
    await user.selectOptions(select, "c-5a");
    await screen.findByText("Matematik");

    const printHeader = container.querySelector(".print-only");
    expect(printHeader?.textContent).toContain("YILDIRIM İREM");
    expect(screen.getByText("5-OO")).toBeInTheDocument();
  });

  it("22) uzun süre bekleyen ilk isteğin sonucu, hızlı geçişten sonra ikinci sınıfın verisini EZMEZ (stale-response koruması)", async () => {
    vi.mocked(fetchModule.fetchClasses).mockResolvedValue(CLASSES);
    let resolveFirst: (v: ClassTimetableResponse) => void = () => {};
    vi.mocked(fetchModule.fetchClassTimetable).mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve)),
    );
    const user = userEvent.setup();
    render(<ClassTimetablePage />);

    const select = await screen.findByLabelText("Sınıf Seçin");
    await user.selectOptions(select, "c-5a");

    const TIMETABLE_5B: ClassTimetableResponse = {
      ...TIMETABLE_5A,
      class: { id: "c-5b", sourceId: "C2", name: "5/B", grade: "5", classTeacher: null },
      lessons: [{ ...TIMETABLE_5A.lessons[0]!, subjectName: "Türkçe", teacherNames: ["M. Kaya"] }],
    };
    vi.mocked(fetchModule.fetchClassTimetable).mockResolvedValueOnce(TIMETABLE_5B);
    await user.selectOptions(select, "c-5b");

    expect(await screen.findByText("Türkçe")).toBeInTheDocument();

    // 5/A'nın (eski) isteği şimdi çözülüyor — ekranı ezmemeli.
    resolveFirst(TIMETABLE_5A);
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByText("Türkçe")).toBeInTheDocument();
    expect(screen.queryByText("Matematik")).not.toBeInTheDocument();
  });

  it("23/24) iptal edilen (AbortError) istek hata kartı oluşturmaz", async () => {
    vi.mocked(fetchModule.fetchClasses).mockResolvedValue(CLASSES);
    let rejectFirst: (err: unknown) => void = () => {};
    vi.mocked(fetchModule.fetchClassTimetable).mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectFirst = reject)),
    );
    const user = userEvent.setup();
    render(<ClassTimetablePage />);

    const select = await screen.findByLabelText("Sınıf Seçin");
    await user.selectOptions(select, "c-5a");

    vi.mocked(fetchModule.fetchClassTimetable).mockResolvedValueOnce(TIMETABLE_5A);
    await user.selectOptions(select, "c-5b");
    expect(await screen.findByText("Matematik")).toBeInTheDocument();

    rejectFirst(new DOMException("The operation was aborted.", "AbortError"));
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByText("Sınıf ders programı alınamadı.")).not.toBeInTheDocument();
  });

  it("25) backend hatasında hata kartı gösterir ve 'Tekrar Dene' iyileştirir", async () => {
    vi.mocked(fetchModule.fetchClasses).mockResolvedValue(CLASSES);
    vi.mocked(fetchModule.fetchClassTimetable).mockRejectedValueOnce(new Error("network down"));
    const user = userEvent.setup();
    render(<ClassTimetablePage />);

    const select = await screen.findByLabelText("Sınıf Seçin");
    await user.selectOptions(select, "c-5a");

    expect(await screen.findByText("Sınıf ders programı alınamadı.")).toBeInTheDocument();

    vi.mocked(fetchModule.fetchClassTimetable).mockResolvedValueOnce(TIMETABLE_5A);
    await user.click(screen.getByRole("button", { name: /tekrar dene/i }));

    expect(await screen.findByText("Matematik")).toBeInTheDocument();
  });

  it("seçilen sınıf artık güncel importta yoksa seçim temizlenir ve bilgi mesajı gösterilir", async () => {
    vi.mocked(fetchModule.fetchClasses).mockResolvedValue(CLASSES);
    vi.mocked(fetchModule.fetchClassTimetable).mockResolvedValueOnce({
      hasImport: true,
      classFound: false,
      importedAt: "2026-08-31T20:23:46.000Z",
    });
    const user = userEvent.setup();
    render(<ClassTimetablePage />);

    const select = await screen.findByLabelText("Sınıf Seçin");
    await user.selectOptions(select, "c-5a");

    expect(
      await screen.findByText(/Seçtiğiniz sınıf artık güncel içe aktarmada bulunmuyor/),
    ).toBeInTheDocument();
    expect((select as HTMLSelectElement).value).toBe("");
    expect(fetchModule.fetchClasses).toHaveBeenCalledTimes(2);
  });

  it("29) sınıf combobox'ı erişilebilir biçimde etiketlenmiştir", async () => {
    vi.mocked(fetchModule.fetchClasses).mockResolvedValue(CLASSES);
    render(<ClassTimetablePage />);

    const select = await screen.findByLabelText("Sınıf Seçin");
    expect(select.tagName).toBe("SELECT");
    expect(within(select).getByText("Sınıf seçiniz")).toBeInTheDocument();
  });
});
