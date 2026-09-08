import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TeacherTimetablePage from "../TeacherTimetablePage";
import * as fetchModule from "../../lib/teacherTimetables/fetchTeacherTimetables";
import * as dutyMatrixApi from "../../lib/teacherDutyAvailability/api";
import type { CurrentImportTeachersResponse, TeacherTimetableResponse } from "../../lib/teacherTimetables/types";
import type { TeacherDutyMatrixResponse } from "../../lib/teacherDutyAvailability/types";

const NO_IMPORT: CurrentImportTeachersResponse = { hasImport: false, importedAt: null, teachers: [] };

// Bu sayfa testleri "Nöbet Uygunluk Matrisi" davranışını KAPSAMAZ (ayrı test
// dosyası — bkz. TeacherTimetablePage.dutyMatrix.test.tsx). Burada matris
// yalnızca "aktif nöbet yeri yok" boş durumuna sabitlenir, böylece mevcut
// ders programı testleri (ör. "Tekrar Dene" buton seçicileri) matrisin kendi
// hata/retry UI'sıyla çakışmaz.
const EMPTY_DUTY_MATRIX: TeacherDutyMatrixResponse = {
  hasImport: true,
  teacherFound: true,
  teacher: { id: "t-yildirim", sourceId: "T1", name: "YILDIRIM İREM" },
  isIncluded: true,
  halfDayRuleEnabled: true,
  days: [],
  blocks: [],
  dutyLocations: [],
  selectedBlockCells: [],
  legacySelectedCells: [],
  lessonConflicts: [],
  fixedAssignments: [],
  fixedLocationAssignments: [],
  updatedAt: null,
};

// Bu dosya nöbet matrisini yalnızca "kaydedilmemiş değişiklik" akışı için
// kullanır; tek blok yeterlidir (matrisin kendi ayrıntılı testleri
// src/components/teacherDuty/__tests__ altındadır).
const MORNING_BLOCK = {
  id: "blk-morning",
  code: "MORNING_BREAKS" as const,
  name: "Sabah Teneffüs Bloğu",
  blockOrder: 1,
  conflictPeriodName: null,
};

const DUTY_MATRIX_WITH_ONE_CELL: TeacherDutyMatrixResponse = {
  ...EMPTY_DUTY_MATRIX,
  blocks: [MORNING_BLOCK],
  dutyLocations: [
    {
      id: "loc-1",
      name: "Ön Bahçe",
      shortCode: "ON-BAH",
      category: "garden",
      capacity: 2,
      sortOrder: 1,
      allowsFixedAssignment: false,
      blockIds: [MORNING_BLOCK.id],
      blockPolicies: [MORNING_BLOCK.id].map((id) => ({ dutyBlockId: id, blockCode: id, assignmentMode: "normal" as const })),
    },
  ],
  days: [{ order: 1, name: "Pazartesi" }],
};

const TEACHERS: CurrentImportTeachersResponse = {
  hasImport: true,
  importedAt: "2026-08-31T20:23:46.000Z",
  teachers: [
    { id: "t-yildirim", sourceId: "T1", name: "YILDIRIM İREM", branch: null },
    { id: "t-yildiz", sourceId: "T2", name: "YILDIZ RUKİYE", branch: null },
  ],
};

const TIMETABLE_YILDIRIM: TeacherTimetableResponse = {
  hasImport: true,
  teacherFound: true,
  teacher: { id: "t-yildirim", sourceId: "T1", name: "YILDIRIM İREM", branch: null },
  importedAt: "2026-08-31T20:23:46.000Z",
  days: [{ id: "d-1", sourceId: "D1", name: "Pazartesi", order: 1 }],
  periods: [
    { id: "p-1", sourceId: "P1", name: "5-OO", order: 5, startTime: "12:15:00", endTime: "12:50:00" },
    { id: "p-2", sourceId: "P2", name: "5-IO", order: 6, startTime: "12:50:00", endTime: "13:25:00" },
  ],
  lessons: [
    {
      cardId: "card-1",
      sourceCardKey: "card-1",
      dayId: "d-1",
      periodId: "p-1",
      subjectName: "KULÜP/LİSE",
      classNames: ["5/A", "5/B"],
      classroomNames: [],
      mappingStatus: "expanded",
      conflict: false,
    },
  ],
  summary: {
    dayCount: 1,
    periodCount: 2,
    weeklyLessonCount: 1,
    occupiedCellCount: 1,
    classCount: 2,
    ambiguousLessonCount: 0,
    conflictCellCount: 0,
  },
};

const EMPTY_TIMETABLE: TeacherTimetableResponse = {
  ...TIMETABLE_YILDIRIM,
  lessons: [],
  summary: { ...TIMETABLE_YILDIRIM.summary, weeklyLessonCount: 0, occupiedCellCount: 0, classCount: 0 },
};

describe("TeacherTimetablePage", () => {
  beforeEach(() => {
    vi.spyOn(fetchModule, "fetchTeachers");
    vi.spyOn(fetchModule, "fetchTeacherTimetable");
    vi.spyOn(dutyMatrixApi, "fetchDutyMatrix").mockResolvedValue(EMPTY_DUTY_MATRIX);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("21) yükleniyor durumunda skeleton (aria-busy) gösterir", () => {
    vi.mocked(fetchModule.fetchTeachers).mockReturnValue(new Promise(() => {}));
    const { container } = render(<TeacherTimetablePage />);
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it("22) import yokken yönlendirici boş durum gösterir", async () => {
    vi.mocked(fetchModule.fetchTeachers).mockResolvedValue(NO_IMPORT);
    render(<TeacherTimetablePage />);

    expect(await screen.findByText("Henüz bir XML dosyası yüklenmedi.")).toBeInTheDocument();
    expect(screen.getByText("Önce Veri ve XML ekranından ders programını yükleyin.")).toBeInTheDocument();
  });

  it("23) import var fakat öğretmen yoksa uygun mesaj gösterir", async () => {
    vi.mocked(fetchModule.fetchTeachers).mockResolvedValue({ hasImport: true, importedAt: "2026-08-31T20:23:46.000Z", teachers: [] });
    render(<TeacherTimetablePage />);

    expect(await screen.findByText("Yüklenen XML dosyasında öğretmen bulunamadı.")).toBeInTheDocument();
  });

  it("24) öğretmen seçilmeden önce bilgi mesajı gösterir, özet '—' olur, yazdır pasif", async () => {
    vi.mocked(fetchModule.fetchTeachers).mockResolvedValue(TEACHERS);
    render(<TeacherTimetablePage />);

    expect(await screen.findByText("Ders programını görüntülemek için bir öğretmen seçin.")).toBeInTheDocument();
    const pills = screen.getAllByText("—");
    expect(pills.length).toBeGreaterThanOrEqual(4);
    expect(screen.getByRole("button", { name: /yazdır/i })).toBeDisabled();
  });

  it("25) seçilen öğretmenin programı boşsa uygun mesaj gösterir", async () => {
    vi.mocked(fetchModule.fetchTeachers).mockResolvedValue(TEACHERS);
    vi.mocked(fetchModule.fetchTeacherTimetable).mockResolvedValue(EMPTY_TIMETABLE);
    const user = userEvent.setup();
    render(<TeacherTimetablePage />);

    const select = await screen.findByLabelText("Öğretmen Seçin");
    await user.selectOptions(select, "t-yildirim");

    expect(await screen.findByText("Bu öğretmen için ders programı bulunamadı.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /yazdır/i })).toBeDisabled();
  });

  it("26/27/28/29/30/31/32) program başarıyla görüntülenir; gerçek period.name, 5-OO/5-IO ayrı, subject/sınıf adları, yemek yok", async () => {
    vi.mocked(fetchModule.fetchTeachers).mockResolvedValue(TEACHERS);
    vi.mocked(fetchModule.fetchTeacherTimetable).mockResolvedValue(TIMETABLE_YILDIRIM);
    const user = userEvent.setup();
    render(<TeacherTimetablePage />);

    const select = await screen.findByLabelText("Öğretmen Seçin");
    await user.selectOptions(select, "t-yildirim");

    expect(await screen.findByText("KULÜP/LİSE")).toBeInTheDocument();
    expect(screen.getByText("5/A, 5/B")).toBeInTheDocument();
    expect(screen.getByText("1 Gün")).toBeInTheDocument();
    expect(screen.getByText("2 Ders Saati")).toBeInTheDocument();
    expect(screen.getByText("1 Haftalık Ders")).toBeInTheDocument();
    expect(screen.getByText("2 Sınıf")).toBeInTheDocument();

    const headers = screen.getAllByRole("columnheader");
    const headerTexts = headers.map((h) => h.textContent ?? "");
    expect(headerTexts.some((t) => t.includes("5-OO"))).toBe(true);
    expect(headerTexts.some((t) => t.includes("5-IO"))).toBe(true);
    // Kapsam DERS TABLOSUDUR: sayfadaki başka bileşenlerin (uygunluk matrisi
    // yardım metni gibi) "öğle arası" kelimesini kullanması bu iddiayı
    // ilgilendirmez.
    const grid = document.querySelector(".tt-table") as HTMLElement;
    expect(within(grid).queryByText("5. Ders")).not.toBeInTheDocument();
    expect(within(grid).queryByText(/YEMEK/i)).not.toBeInTheDocument();
    expect(within(grid).queryByText(/Öğle Arası/i)).not.toBeInTheDocument();

    expect(screen.getByRole("button", { name: /yazdır/i })).toBeEnabled();
  });

  it("33) ambiguous eşleşmede turuncu uyarı ve legend gösterilir", async () => {
    vi.mocked(fetchModule.fetchTeachers).mockResolvedValue(TEACHERS);
    vi.mocked(fetchModule.fetchTeacherTimetable).mockResolvedValue({
      ...TIMETABLE_YILDIRIM,
      lessons: [{ ...TIMETABLE_YILDIRIM.lessons[0]!, mappingStatus: "ambiguous" }],
      summary: { ...TIMETABLE_YILDIRIM.summary, ambiguousLessonCount: 1 },
    });
    const user = userEvent.setup();
    render(<TeacherTimetablePage />);

    const select = await screen.findByLabelText("Öğretmen Seçin");
    await user.selectOptions(select, "t-yildirim");
    await screen.findByText("KULÜP/LİSE");

    expect(screen.getByText("Belirsiz eşleşme")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Bu dersin öğretmen–sınıf eşleşmesi kaynak XML'den kesin olarak belirlenemiyor."),
    ).toBeInTheDocument();
    // Ambiguous ders GİZLENMEZ, sınıflar hâlâ görünür.
    expect(screen.getByText("5/A, 5/B")).toBeInTheDocument();
  });

  it("34) aynı hücrede farklı card conflict uyarısı gösterir", async () => {
    vi.mocked(fetchModule.fetchTeachers).mockResolvedValue(TEACHERS);
    vi.mocked(fetchModule.fetchTeacherTimetable).mockResolvedValue({
      ...TIMETABLE_YILDIRIM,
      lessons: [
        { ...TIMETABLE_YILDIRIM.lessons[0]!, conflict: true },
        {
          cardId: "card-2",
          sourceCardKey: "card-2",
          dayId: "d-1",
          periodId: "p-1",
          subjectName: "SKILLS",
          classNames: ["6/B"],
          classroomNames: [],
          mappingStatus: "exact",
          conflict: true,
        },
      ],
      summary: { ...TIMETABLE_YILDIRIM.summary, weeklyLessonCount: 2, conflictCellCount: 1 },
    });
    const user = userEvent.setup();
    render(<TeacherTimetablePage />);

    const select = await screen.findByLabelText("Öğretmen Seçin");
    await user.selectOptions(select, "t-yildirim");
    await screen.findByText("KULÜP/LİSE");

    expect(screen.getByText("SKILLS")).toBeInTheDocument();
    expect(screen.getAllByText("Ders çakışması").length).toBeGreaterThan(0);
  });

  it("35) hızlı öğretmen değişiminde eski isteğin sonucu yenisini EZMEZ (stale-response koruması)", async () => {
    vi.mocked(fetchModule.fetchTeachers).mockResolvedValue(TEACHERS);
    let resolveFirst: (v: TeacherTimetableResponse) => void = () => {};
    vi.mocked(fetchModule.fetchTeacherTimetable).mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve)),
    );
    const user = userEvent.setup();
    render(<TeacherTimetablePage />);

    const select = await screen.findByLabelText("Öğretmen Seçin");
    await user.selectOptions(select, "t-yildirim");

    const TIMETABLE_YILDIZ: TeacherTimetableResponse = {
      ...TIMETABLE_YILDIRIM,
      teacher: { id: "t-yildiz", sourceId: "T2", name: "YILDIZ RUKİYE", branch: null },
      lessons: [{ ...TIMETABLE_YILDIRIM.lessons[0]!, subjectName: "ORTAOKUL FEN BİLİMLERİ" }],
    };
    vi.mocked(fetchModule.fetchTeacherTimetable).mockResolvedValueOnce(TIMETABLE_YILDIZ);
    await user.selectOptions(select, "t-yildiz");

    expect(await screen.findByText("ORTAOKUL FEN BİLİMLERİ")).toBeInTheDocument();

    resolveFirst(TIMETABLE_YILDIRIM);
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByText("ORTAOKUL FEN BİLİMLERİ")).toBeInTheDocument();
    expect(screen.queryByText("KULÜP/LİSE")).not.toBeInTheDocument();
  });

  it("36) iptal edilen (AbortError) istek hata kartı oluşturmaz", async () => {
    vi.mocked(fetchModule.fetchTeachers).mockResolvedValue(TEACHERS);
    let rejectFirst: (err: unknown) => void = () => {};
    vi.mocked(fetchModule.fetchTeacherTimetable).mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectFirst = reject)),
    );
    const user = userEvent.setup();
    render(<TeacherTimetablePage />);

    const select = await screen.findByLabelText("Öğretmen Seçin");
    await user.selectOptions(select, "t-yildirim");

    vi.mocked(fetchModule.fetchTeacherTimetable).mockResolvedValueOnce(TIMETABLE_YILDIRIM);
    await user.selectOptions(select, "t-yildiz");
    expect(await screen.findByText("KULÜP/LİSE")).toBeInTheDocument();

    rejectFirst(new DOMException("The operation was aborted.", "AbortError"));
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByText("Öğretmen ders programı alınamadı.")).not.toBeInTheDocument();
  });

  it("37) backend hatasında hata kartı gösterir ve 'Tekrar Dene' iyileştirir", async () => {
    vi.mocked(fetchModule.fetchTeachers).mockResolvedValue(TEACHERS);
    vi.mocked(fetchModule.fetchTeacherTimetable).mockRejectedValueOnce(new Error("network down"));
    const user = userEvent.setup();
    render(<TeacherTimetablePage />);

    const select = await screen.findByLabelText("Öğretmen Seçin");
    await user.selectOptions(select, "t-yildirim");

    expect(await screen.findByText("Öğretmen ders programı alınamadı.")).toBeInTheDocument();

    vi.mocked(fetchModule.fetchTeacherTimetable).mockResolvedValueOnce(TIMETABLE_YILDIRIM);
    await user.click(screen.getByRole("button", { name: /tekrar dene/i }));

    expect(await screen.findByText("KULÜP/LİSE")).toBeInTheDocument();
  });

  it("seçilen öğretmen artık güncel importta yoksa seçim temizlenir ve bilgi mesajı gösterilir", async () => {
    vi.mocked(fetchModule.fetchTeachers).mockResolvedValue(TEACHERS);
    vi.mocked(fetchModule.fetchTeacherTimetable).mockResolvedValueOnce({
      hasImport: true,
      teacherFound: false,
      importedAt: "2026-08-31T20:23:46.000Z",
    });
    const user = userEvent.setup();
    render(<TeacherTimetablePage />);

    const select = await screen.findByLabelText("Öğretmen Seçin");
    await user.selectOptions(select, "t-yildirim");

    expect(await screen.findByText(/Seçtiğiniz öğretmen artık güncel içe aktarmada bulunmuyor/)).toBeInTheDocument();
    expect((select as HTMLSelectElement).value).toBe("");
    expect(fetchModule.fetchTeachers).toHaveBeenCalledTimes(2);
  });

  it("erişilebilir combobox etiketlenmiştir", async () => {
    vi.mocked(fetchModule.fetchTeachers).mockResolvedValue(TEACHERS);
    render(<TeacherTimetablePage />);

    const select = await screen.findByLabelText("Öğretmen Seçin");
    expect(select.tagName).toBe("SELECT");
    expect(within(select).getByText("Öğretmen seçiniz")).toBeInTheDocument();
  });

  it("40) yazdırma görünümünde başlık, öğretmen adı ve gerçek period adı yer alır", async () => {
    vi.mocked(fetchModule.fetchTeachers).mockResolvedValue(TEACHERS);
    vi.mocked(fetchModule.fetchTeacherTimetable).mockResolvedValue(TIMETABLE_YILDIRIM);
    const user = userEvent.setup();
    const { container } = render(<TeacherTimetablePage />);

    const select = await screen.findByLabelText("Öğretmen Seçin");
    await user.selectOptions(select, "t-yildirim");
    await screen.findByText("KULÜP/LİSE");

    const printHeader = container.querySelector(".print-only");
    expect(printHeader?.textContent).toContain("Öğretmen Ders Programı");
    expect(printHeader?.textContent).toContain("YILDIRIM İREM");
    // "5-OO" metni artık nöbet matrisinin bilgi balonunda da geçiyor; bu test
    // ders programı ızgarasındaki GERÇEK period adını doğrular, o yüzden
    // sorgu ızgaraya daraltıldı.
    const grid = container.querySelector(".tt-table")!;
    expect(within(grid as HTMLElement).getByText("5-OO")).toBeInTheDocument();
  });

  it("41) matriste kaydedilmemiş değişiklik varken öğretmen değiştirilirse onay ister; vazgeçilirse seçim/matris korunur", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchModule.fetchTeachers).mockResolvedValue(TEACHERS);
    vi.mocked(fetchModule.fetchTeacherTimetable).mockResolvedValue(TIMETABLE_YILDIRIM);
    vi.mocked(dutyMatrixApi.fetchDutyMatrix).mockResolvedValue(DUTY_MATRIX_WITH_ONE_CELL);
    render(<TeacherTimetablePage />);

    const select = await screen.findByLabelText("Öğretmen Seçin");
    await user.selectOptions(select, "t-yildirim");
    await user.click(await screen.findByRole("checkbox", { name: "Pazartesi, Sabah Teneffüs Bloğu, Ön Bahçe: uygun değil" }));
    expect(screen.getByText("Kaydedilmemiş değişiklikler var")).toBeInTheDocument();

    await user.selectOptions(select, "t-yildiz");
    expect(await screen.findByRole("heading", { name: "Kaydedilmemiş değişiklikler var" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Vazgeç" }));
    expect(select).toHaveValue("t-yildirim");
    expect(screen.getByRole("checkbox", { name: "Pazartesi, Sabah Teneffüs Bloğu, Ön Bahçe: uygun" })).toBeChecked();
  });

  it("42) onaylanırsa yeni öğretmenin matrisi (temiz state ile) yüklenir", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchModule.fetchTeachers).mockResolvedValue(TEACHERS);
    vi.mocked(fetchModule.fetchTeacherTimetable).mockResolvedValue(TIMETABLE_YILDIRIM);
    vi.mocked(dutyMatrixApi.fetchDutyMatrix).mockResolvedValue(DUTY_MATRIX_WITH_ONE_CELL);
    render(<TeacherTimetablePage />);

    const select = await screen.findByLabelText("Öğretmen Seçin");
    await user.selectOptions(select, "t-yildirim");
    await user.click(await screen.findByRole("checkbox", { name: "Pazartesi, Sabah Teneffüs Bloğu, Ön Bahçe: uygun değil" }));

    await user.selectOptions(select, "t-yildiz");
    await user.click(await screen.findByRole("button", { name: "Yine de Devam Et" }));

    expect(select).toHaveValue("t-yildiz");
    expect(await screen.findByRole("checkbox", { name: "Pazartesi, Sabah Teneffüs Bloğu, Ön Bahçe: uygun değil" })).not.toBeChecked();
  });
});
