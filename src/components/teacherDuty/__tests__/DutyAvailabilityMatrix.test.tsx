import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DutyAvailabilityMatrix from "../DutyAvailabilityMatrix";
import * as api from "../../../lib/teacherDutyAvailability/api";
import { SaveDutyMatrixError } from "../../../lib/teacherDutyAvailability/api";
import type { DutyMatrixLocation, TeacherDutyMatrixResponse } from "../../../lib/teacherDutyAvailability/types";

/**
 * Test yardımcısı: yer×blok politikası. Sunucu (migration 20260920090000) her
 * yer için blockPolicies döndürür; fixture'lar bunu blockIds'ten türetir.
 * Sabit yerlerde (allowsFixedAssignment: true) mod fixed_only'dir.
 */
function policies(blockIds: string[], mode: "normal" | "fixed_only" = "normal") {
  return blockIds.map((dutyBlockId) => ({ dutyBlockId, blockCode: dutyBlockId, assignmentMode: mode }));
}


const TEACHER_ID = "11111111-1111-1111-1111-111111111111";
const LOC_A = "22222222-2222-2222-2222-222222222222";
const LOC_B = "33333333-3333-3333-3333-333333333333";
/** "Öğle Arası İlkokul" gibi YALNIZ tek blokta görev isteyen yer. */
const LOC_C = "55555555-5555-5555-5555-555555555555";
/** "İLKOKUL-1" gibi allowsFixedAssignment=true, yalnız Sabah+Öğleden Sonra ister. */
const LOC_D = "66666666-6666-6666-6666-666666666666";

const BLK_MORNING = "aaaaaaaa-0000-0000-0000-000000000001";
const BLK_LONG1 = "aaaaaaaa-0000-0000-0000-000000000002";
const BLK_LONG2 = "aaaaaaaa-0000-0000-0000-000000000003";
const BLK_AFTERNOON = "aaaaaaaa-0000-0000-0000-000000000004";

const ALL_BLOCK_IDS = [BLK_MORNING, BLK_LONG1, BLK_LONG2, BLK_AFTERNOON];
/** Karma politikalı sabit nöbet yeri (Sabah/ÖS fixed_only, Öğle Arası-1 normal). */
const LOC_FIXED = "bbbbbbbb-0000-0000-0000-00000000000f";

/**
 * İşaretlenebilir hücre sayısı (tek gün):
 *   LOC_A 4 + LOC_B 4 + LOC_C 1 + LOC_FIXED 1 (yalnız Öğle Arası-1 'normal') = 10.
 * İki gün için 20. Testlerde bu sayı elle tekrarlanmasın diye sabitlendi.
 */
const SELECTABLE_PER_DAY = 10;

function matrix(overrides: Partial<Extract<TeacherDutyMatrixResponse, { teacherFound: true }>> = {}): TeacherDutyMatrixResponse {
  return {
    hasImport: true,
    teacherFound: true,
    teacher: { id: TEACHER_ID, sourceId: "T1", name: "Ahmet Yılmaz" },
    halfDayRuleEnabled: true,
    isIncluded: true,
    days: [
      { order: 1, name: "Pazartesi" },
      { order: 2, name: "Salı" },
    ],
    blocks: [
      { id: BLK_MORNING, code: "MORNING_BREAKS", name: "Sabah Teneffüs Bloğu", blockOrder: 1, conflictPeriodName: null },
      { id: BLK_LONG1, code: "LONG_BREAK_1", name: "Uzun Nöbet 1", blockOrder: 2, conflictPeriodName: "5-OO" },
      { id: BLK_LONG2, code: "LONG_BREAK_2", name: "Uzun Nöbet 2", blockOrder: 3, conflictPeriodName: "5-IO" },
      { id: BLK_AFTERNOON, code: "AFTERNOON_BREAKS", name: "Öğleden Sonra Teneffüs Bloğu", blockOrder: 4, conflictPeriodName: null },
    ],
    dutyLocations: [
      {
        id: LOC_A,
        name: "Ön Bahçe",
        shortCode: "ON-BAH",
        category: "garden",
        capacity: 2,
        sortOrder: 1,
        allowsFixedAssignment: false,
        blockIds: ALL_BLOCK_IDS,
        blockPolicies: policies(ALL_BLOCK_IDS),
      },
      // KARMA politika (gerçek İLKOKUL-1/2 gibi): Sabah + Öğleden Sonra yalnız
      // sabit atamayla karşılanır, Öğle Arası-1 NORMAL tercih hücresidir,
      // Öğle Arası-2 için eşleme YOKTUR. Sabit nöbet fixture'ları bu yeri
      // kullanır — tüm blokları 'normal' olan bir yerde sabit atama bulunması
      // yeni modelde TUTARSIZ olurdu.
      {
        id: LOC_FIXED,
        name: "İlkokul Koridor",
        shortCode: "ILKOKUL1",
        category: "corridor",
        capacity: 1,
        sortOrder: 3,
        allowsFixedAssignment: true,
        blockIds: [BLK_MORNING, BLK_AFTERNOON, BLK_LONG1],
        blockPolicies: [
          { dutyBlockId: BLK_MORNING, blockCode: "MORNING_BREAKS", assignmentMode: "fixed_only" },
          { dutyBlockId: BLK_LONG1, blockCode: "LONG_BREAK_1", assignmentMode: "normal" },
          { dutyBlockId: BLK_AFTERNOON, blockCode: "AFTERNOON_BREAKS", assignmentMode: "fixed_only" },
        ],
      },
      {
        id: LOC_B,
        name: "Yemekhane",
        shortCode: "YEM",
        category: "cafeteria",
        capacity: 3,
        sortOrder: 2,
        allowsFixedAssignment: false,
        blockIds: ALL_BLOCK_IDS,
        blockPolicies: policies(ALL_BLOCK_IDS),
      },
      {
        id: LOC_C,
        name: "Öğle Arası İlkokul",
        shortCode: "OGLEARASIILKOKUL",
        category: "corridor",
        capacity: 1,
        sortOrder: 3,
        allowsFixedAssignment: false,
        blockIds: [BLK_LONG1],
        blockPolicies: policies([BLK_LONG1]),
      },
    ],
    selectedBlockCells: [],
    legacySelectedCells: [],
    lessonConflicts: [],
    fixedAssignments: [],
    fixedLocationAssignments: [],
    updatedAt: "2026-09-07T10:00:00.000Z",
    ...overrides,
  };
}

/** Kısa yol: hücre erişilebilir adı "<gün>, <blok>, <yer>: <durum>" biçimindedir. */
function cellName(day: string, block: string, location: string, state: "uygun" | "uygun değil") {
  return `${day}, ${block}, ${location}: ${state}`;
}

/**
 * Nöbet yeri satır başlığını bulur. Düz `getByText` yetmez: sabit nöbet olan
 * günlerde yer adı açıklama notunda da geçer.
 */
function rowHeader(name: string) {
  return screen.findByRole("rowheader", { name: new RegExp(name) });
}

/**
 * Özet paragrafının (.dam-summary) normalize edilmiş metni. JSX birden çok
 * text node'a bölündüğü için (`{a} metin · {b} metin`), tek bir string'e
 * karşı `getByText` EŞLEŞMEZ — bu yüzden textContent üzerinden karşılaştırma
 * yapılır (boşluklar tek boşluğa indirgenir).
 */
function summaryText(): string {
  return (document.querySelector(".dam-summary")?.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("DutyAvailabilityMatrix (dört bloklu model)", () => {
  beforeEach(() => {
    vi.spyOn(api, "fetchDutyMatrix");
    vi.spyOn(api, "saveDutyMatrix");
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("1) yükleniyor durumunda aria-busy skeleton gösterir", () => {
    vi.mocked(api.fetchDutyMatrix).mockReturnValue(new Promise(() => {}));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it("2) başarılı matris: seçili blok hücresi checked, diğerleri unchecked", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      matrix({ selectedBlockCells: [{ dutyLocationId: LOC_A, dayOrder: 1, dutyBlockId: BLK_MORNING }] }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    expect(await screen.findByRole("checkbox", { name: cellName("Pazartesi", "Sabah Teneffüs Bloğu", "Ön Bahçe", "uygun") })).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: cellName("Pazartesi", "Uzun Nöbet 1", "Ön Bahçe", "uygun değil") }),
    ).not.toBeChecked();
  });

  it("3) gün sekmeleri: varsayılan ilk gün açık, sekmeye tıklayınca o günün hücreleri gelir", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    const monday = await screen.findByRole("tab", { name: /Pazartesi/ });
    expect(monday).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("checkbox", { name: cellName("Pazartesi", "Sabah Teneffüs Bloğu", "Ön Bahçe", "uygun değil") })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /Salı/ }));
    expect(screen.getByRole("checkbox", { name: cellName("Salı", "Sabah Teneffüs Bloğu", "Ön Bahçe", "uygun değil") })).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: cellName("Pazartesi", "Sabah Teneffüs Bloğu", "Ön Bahçe", "uygun değil") }),
    ).not.toBeInTheDocument();
  });

  it("4) yerin istemediği blokta hücre yok: 'Öğle Arası İlkokul' yalnız Uzun Nöbet 1'de tıklanabilir", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await screen.findByText("Öğle Arası İlkokul");
    expect(
      screen.getByRole("checkbox", { name: cellName("Pazartesi", "Uzun Nöbet 1", "Öğle Arası İlkokul", "uygun değil") }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: cellName("Pazartesi", "Sabah Teneffüs Bloğu", "Öğle Arası İlkokul", "uygun değil") }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Pazartesi, Sabah Teneffüs Bloğu, Öğle Arası İlkokul: bu blokta nöbetçi gerekmiyor")).toBeInTheDocument();
  });

  it("5) ders çakışması: 5-OO dersi olan gün+blok kilitli, checkbox yok", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      matrix({ lessonConflicts: [{ dayOrder: 1, dutyBlockId: BLK_LONG1, periodName: "5-OO" }] }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await screen.findByText("Ön Bahçe");
    expect(
      screen.queryByRole("checkbox", { name: cellName("Pazartesi", "Uzun Nöbet 1", "Ön Bahçe", "uygun değil") }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Pazartesi, Uzun Nöbet 1, Ön Bahçe: ders çakışması nedeniyle kullanılamaz" }),
    ).toBeInTheDocument();
    // Aynı blok, ÇAKIŞMAYAN günde normal davranır.
    expect(
      screen.getByRole("checkbox", { name: cellName("Pazartesi", "Uzun Nöbet 2", "Ön Bahçe", "uygun değil") }),
    ).toBeInTheDocument();
  });

  it("6) ders çakışması olan hücre toplu seçimlere de dahil edilmez", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      matrix({ lessonConflicts: [{ dayOrder: 1, dutyBlockId: BLK_LONG1, periodName: "5-OO" }] }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await screen.findByText("Ön Bahçe");
    await user.click(screen.getByRole("button", { name: "Günü Seç" }));
    // Pazartesi'nin 10 hücresinden Uzun Nöbet 1'e ait 4'ü elenir
    // (LOC_A, LOC_B, LOC_C ve LOC_FIXED — sonuncusunun Öğle Arası-1 hücresi 'normal').
    expect(screen.getByText(new RegExp(`Toplam ${SELECTABLE_PER_DAY - 4} uygun seçenek`))).toBeInTheDocument();
  });

  it("7) aktif nöbet yeri yoksa boş durum ve 'Nöbet Yerlerine Git' butonu gösterir", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix({ dutyLocations: [], days: [] }));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    expect(await screen.findByText("Henüz aktif nöbet yeri tanımlanmadı.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nöbet Yerlerine Git" })).toBeInTheDocument();
  });

  it("8) API hatasında hata kartı ve Tekrar Dene gösterir; kayıt yok gibi göstermez", async () => {
    vi.mocked(api.fetchDutyMatrix).mockRejectedValue(new api.DutyMatrixFetchError("Beklenmeyen HTTP durumu: 500"));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    expect(await screen.findByText("Nöbet uygunlukları alınamadı.")).toBeInTheDocument();
    expect(screen.queryByText("Henüz aktif nöbet yeri tanımlanmadı.")).not.toBeInTheDocument();
  });

  it("8b) eski RPC sözleşmesi tüm sayfayı düşürmez; matriste şema uyumsuzluğu gösterir", async () => {
    const current = matrix() as Extract<TeacherDutyMatrixResponse, { teacherFound: true }>;
    const legacyPayload = {
      ...current,
      halfDayRuleEnabled: undefined,
      dutyLocations: current.dutyLocations.map(({ blockPolicies: _blockPolicies, ...location }) => location),
    } as unknown as TeacherDutyMatrixResponse;
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(legacyPayload);

    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    expect(await screen.findByText("Nöbet uygunluk matrisi henüz kullanılamıyor.")).toBeInTheDocument();
    expect(screen.getByText(/Veritabanındaki nöbet blok yapısı bu arayüz sürümüyle uyumlu değil/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Pazartesi/ })).not.toBeInTheDocument();
  });

  it("9) tekrar dene, veriyi yeniden çeker", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockRejectedValueOnce(new api.DutyMatrixFetchError("500")).mockResolvedValueOnce(matrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await user.click(await screen.findByRole("button", { name: /tekrar dene/i }));
    expect(await screen.findByText("Ön Bahçe")).toBeInTheDocument();
  });

  it("10) hücre seçimi özet sayılarını gerçek state'ten günceller", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await screen.findByText("Ön Bahçe");
    expect(screen.getByText(/Toplam 0 uygun seçenek/)).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: cellName("Pazartesi", "Uzun Nöbet 2", "Ön Bahçe", "uygun değil") }));
    expect(screen.getByText(/Toplam 1 uygun seçenek/)).toBeInTheDocument();
    expect(screen.getByText(/1 günde seçim var/)).toBeInTheDocument();
  });

  it("11) blok başlığında Seç, o bloğun tüm uygun satırlarını işaretler", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await screen.findByText("Ön Bahçe");
    const blockHeader = screen.getByText("Sabah").closest("th")!;
    await user.click(within(blockHeader).getByText("Seç"));

    expect(screen.getByRole("checkbox", { name: cellName("Pazartesi", "Sabah Teneffüs Bloğu", "Ön Bahçe", "uygun") })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: cellName("Pazartesi", "Sabah Teneffüs Bloğu", "Yemekhane", "uygun") })).toBeChecked();
    // Sabah bloğunda görev istemeyen yer etkilenmez: yalnız 2 hücre.
    expect(screen.getByText(/Toplam 2 uygun seçenek/)).toBeInTheDocument();
  });

  it("12) Günü Seç / Günü Temizle yalnız açık günü etkiler", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await screen.findByText("Ön Bahçe");
    await user.click(screen.getByRole("button", { name: "Günü Seç" }));
    expect(screen.getByText(new RegExp(`Toplam ${SELECTABLE_PER_DAY} uygun seçenek`))).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /Salı/ }));
    await user.click(screen.getByRole("button", { name: "Günü Seç" }));
    expect(screen.getByText(new RegExp(`Toplam ${SELECTABLE_PER_DAY * 2} uygun seçenek`))).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Günü Temizle" }));
    expect(screen.getByText(new RegExp(`Toplam ${SELECTABLE_PER_DAY} uygun seçenek`))).toBeInTheDocument();
  });

  it("13) Tüm Günleri Seç / Tümünü Temizle", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await screen.findByText("Ön Bahçe");
    await user.click(screen.getByRole("button", { name: "Tüm Günleri Seç" }));
    expect(screen.getByText(new RegExp(`Toplam ${SELECTABLE_PER_DAY * 2} uygun seçenek`))).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tümünü Temizle" }));
    expect(screen.getByText(/Toplam 0 uygun seçenek/)).toBeInTheDocument();
  });

  it("14) toggle kapatılınca mevcut seçimler korunur ve etkileşim devre dışı kalır", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      matrix({ selectedBlockCells: [{ dutyLocationId: LOC_A, dayOrder: 1, dutyBlockId: BLK_MORNING }] }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    const checkbox = await screen.findByRole("checkbox", { name: cellName("Pazartesi", "Sabah Teneffüs Bloğu", "Ön Bahçe", "uygun") });
    expect(checkbox).toBeChecked();

    await user.click(screen.getByRole("checkbox", { name: "Nöbet planına dahil" }));
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeDisabled();
  });

  it("15) dirty state: değişiklik yoksa Kaydet/Geri Al disabled, değişiklik varsa etkin ve rozet görünür", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix());
    const onDirtyChange = vi.fn();
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={onDirtyChange} />);

    await screen.findByText("Ön Bahçe");
    expect(screen.getByRole("button", { name: "Kaydet" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Değişiklikleri Geri Al" })).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: cellName("Pazartesi", "Sabah Teneffüs Bloğu", "Ön Bahçe", "uygun değil") }));

    expect(screen.getByText("Kaydedilmemiş değişiklikler var")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Kaydet" })).not.toBeDisabled();
    expect(onDirtyChange).toHaveBeenCalledWith(true);
  });

  it("16) Geri Al son kaydedilen snapshot'a döner", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await screen.findByText("Ön Bahçe");
    await user.click(screen.getByRole("checkbox", { name: cellName("Pazartesi", "Sabah Teneffüs Bloğu", "Ön Bahçe", "uygun değil") }));
    expect(screen.getByText(/Toplam 1 uygun seçenek/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Değişiklikleri Geri Al" }));
    expect(screen.getByText(/Toplam 0 uygun seçenek/)).toBeInTheDocument();
  });

  it("17) kaydetme, blok kimliğini içeren hücreleri gönderir", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix());
    vi.mocked(api.saveDutyMatrix).mockResolvedValue({ savedAt: "2026-09-07T11:00:00.000Z", updatedAt: "2026-09-07T11:00:00.000Z", halfDayRuleEnabled: true });
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await screen.findByText("Ön Bahçe");
    await user.click(screen.getByRole("checkbox", { name: cellName("Pazartesi", "Uzun Nöbet 2", "Ön Bahçe", "uygun değil") }));
    await user.click(screen.getByRole("button", { name: "Kaydet" }));

    await waitFor(() => expect(api.saveDutyMatrix).toHaveBeenCalled());
    expect(vi.mocked(api.saveDutyMatrix).mock.calls[0][1]).toEqual({
      isIncluded: true,
      // Yarım gün kuralı matris tercihleriyle AYNI istekte gönderilir.
      halfDayRuleEnabled: true,
      cells: [{ dutyLocationId: LOC_A, dayOrder: 1, dutyBlockId: BLK_LONG2 }],
      expectedUpdatedAt: "2026-09-07T10:00:00.000Z",
    });
    expect(await screen.findByText("Nöbet uygunlukları kaydedildi.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Kaydet" })).toBeDisabled();
  });

  it("18) çift gönderim engellenir: kaydederken buton disabled/loading", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix());
    let resolveSave: (v: { savedAt: string; updatedAt: string; halfDayRuleEnabled: boolean }) => void = () => {};
    vi.mocked(api.saveDutyMatrix).mockReturnValue(new Promise((resolve) => (resolveSave = resolve)));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await screen.findByText("Ön Bahçe");
    await user.click(screen.getByRole("checkbox", { name: cellName("Pazartesi", "Sabah Teneffüs Bloğu", "Ön Bahçe", "uygun değil") }));
    await user.click(screen.getByRole("button", { name: "Kaydet" }));

    expect(screen.getByRole("button", { name: /kaydediliyor/i })).toBeDisabled();
    expect(api.saveDutyMatrix).toHaveBeenCalledTimes(1);

    resolveSave({ savedAt: "x", updatedAt: "x", halfDayRuleEnabled: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Kaydet" })).toBeInTheDocument());
  });

  it("19) 409 çakışma: mesaj ve Yenile seçeneği gösterir", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValueOnce(matrix()).mockResolvedValueOnce(matrix());
    vi.mocked(api.saveDutyMatrix).mockRejectedValue(
      new SaveDutyMatrixError({ error: "conflict", message: "Bu kayıt başka bir işlem tarafından güncellendi. Güncel veriyi yeniden yükleyin." }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await screen.findByText("Ön Bahçe");
    await user.click(screen.getByRole("checkbox", { name: cellName("Pazartesi", "Sabah Teneffüs Bloğu", "Ön Bahçe", "uygun değil") }));
    await user.click(screen.getByRole("button", { name: "Kaydet" }));

    expect(await screen.findByText(/başka bir işlem tarafından güncellendi/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Yenile" })).toBeInTheDocument();
  });

  it("20) invalid_cells (ör. block_not_allowed_for_location) sunucu mesajını gösterir", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix());
    vi.mocked(api.saveDutyMatrix).mockRejectedValue(
      new SaveDutyMatrixError({
        error: "invalid_cells",
        message: "Bu nöbet yeri seçilen blokta görev istemiyor.",
        reason: "block_not_allowed_for_location",
      }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await screen.findByText("Ön Bahçe");
    await user.click(screen.getByRole("checkbox", { name: cellName("Pazartesi", "Sabah Teneffüs Bloğu", "Ön Bahçe", "uygun değil") }));
    await user.click(screen.getByRole("button", { name: "Kaydet" }));

    expect(await screen.findByText("Bu nöbet yeri seçilen blokta görev istemiyor.")).toBeInTheDocument();
  });

  it("21) klavye ile Space hücreyi değiştirir (native checkbox davranışı)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    const checkbox = await screen.findByRole("checkbox", {
      name: cellName("Pazartesi", "Sabah Teneffüs Bloğu", "Ön Bahçe", "uygun değil"),
    });
    checkbox.focus();
    await user.keyboard(" ");
    expect(checkbox).toBeChecked();
  });

  it("22) unmount sonrası state güncellemesi denemez (abort/ignore)", async () => {
    let resolveFetch: (v: TeacherDutyMatrixResponse) => void = () => {};
    vi.mocked(api.fetchDutyMatrix).mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)));
    const { unmount } = render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    unmount();
    expect(() => resolveFetch(matrix())).not.toThrow();
  });

  // === Sabit Nöbetler entegrasyonu ===

  const FIXED_MON = {
    assignmentId: "fx-1",
    dayOrder: 1,
    dutyLocationId: LOC_FIXED,
    dutyLocationName: "İlkokul Koridor",
    dutyLocationShortCode: "ILKOKUL1",
    dutyLocationIsActive: true,
  };

  it("23a) sabit yerde Sabah/Öğleden Sonra: checkbox değil, 'Sabit' rozetiyle gösterilir (yalnız bu iki blok)", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix({ fixedAssignments: [FIXED_MON] }));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("İlkokul Koridor");
    expect(screen.queryByRole("checkbox", { name: /Pazartesi, .*, İlkokul Koridor/ })).not.toBeInTheDocument();
    // fixed_only bloklar ⇒ 'Sabit'.
    expect(
      screen.getByRole("img", { name: "Pazartesi, Sabah Teneffüs Bloğu, İlkokul Koridor: sabit nöbet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Pazartesi, Öğleden Sonra Teneffüs Bloğu, İlkokul Koridor: sabit nöbet" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Sabit")).toHaveLength(2);
  });

  it("23b) kendi sabit gününde Öğle Arası-1 'Dinlenme' DEĞİL — sabit nöbet nedeniyle kilitli", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix({ fixedAssignments: [FIXED_MON] }));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("İlkokul Koridor");
    // Blok koduna bakarak üretilen eski "Dinlenme" durumu ARTIK YOK.
    expect(screen.queryByText("Dinlenme")).not.toBeInTheDocument();
    // Hücre 'normal' politikadadır ama öğretmenin o gün sabit nöbeti vardır.
    expect(
      screen.getByRole("img", { name: "Pazartesi, Uzun Nöbet 1, İlkokul Koridor: sabit nöbet nedeniyle kullanılamaz" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Pazartesi, Uzun Nöbet 1, İlkokul Koridor/ })).not.toBeInTheDocument();
  });

  it("23c) sabit yerde Uzun Nöbet 2: 'nöbetçi gerekmiyor' — block_not_required, Sabit/Dinlenme değil", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix({ fixedAssignments: [FIXED_MON] }));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("İlkokul Koridor");
    expect(
      screen.getByText("Pazartesi, Uzun Nöbet 2, İlkokul Koridor: bu blokta nöbetçi gerekmiyor"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Uzun Nöbet 2, İlkokul Koridor: sabit nöbet/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Pazartesi, Uzun Nöbet 2, İlkokul Koridor/ })).not.toBeInTheDocument();
  });

  it("24) sabit günün diğer yerleri kilitli ve tıklanamaz", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix({ fixedAssignments: [FIXED_MON] }));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    const locked = await screen.findByRole("img", {
      name: "Pazartesi, Sabah Teneffüs Bloğu, Yemekhane: sabit nöbet nedeniyle kullanılamaz",
    });
    await user.click(locked);
    expect(screen.queryByRole("checkbox", { name: /Pazartesi, .*, Yemekhane/ })).not.toBeInTheDocument();
  });

  it("25) sabit günde Günü Seç/Temizle yok; açıklama notu ve blok başlıklarında 'kilitli' gösterilir", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix({ fixedAssignments: [FIXED_MON] }));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Ön Bahçe");
    expect(screen.queryByRole("button", { name: "Günü Seç" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Günü Temizle" })).not.toBeInTheDocument();
    expect(screen.getByText(/dört blok da kilitlidir/)).toBeInTheDocument();
    expect(screen.getAllByText("kilitli")).toHaveLength(4);
  });

  it("26) Tüm Günleri Seç sabit günü atlar, Tümünü Temizle sabit hücreyi değiştirmez", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix({ fixedAssignments: [FIXED_MON] }));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("İlkokul Koridor");
    await user.click(screen.getByRole("button", { name: "Tüm Günleri Seç" }));
    // Yalnız Salı seçilebilir (Pazartesi sabit).
    expect(screen.getByText(new RegExp(`Toplam ${SELECTABLE_PER_DAY} uygun seçenek`))).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tümünü Temizle" }));
    expect(screen.getByText(/Toplam 0 uygun seçenek/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Pazartesi, Sabah Teneffüs Bloğu, İlkokul Koridor: sabit nöbet" })).toBeInTheDocument();
  });

  it("27) özet sabit nöbet sayısını ayrı gösterir, normal sayılara katmaz", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      matrix({
        fixedAssignments: [FIXED_MON],
        selectedBlockCells: [{ dutyLocationId: LOC_B, dayOrder: 2, dutyBlockId: BLK_MORNING }],
      }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await screen.findByText(/Toplam 1 uygun seçenek · 1 günde seçim var · 1 sabit nöbet/);
  });

  it("28) sabit atamaların yüklenmesi dirty state oluşturmaz", async () => {
    const onDirtyChange = vi.fn();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix({ fixedAssignments: [FIXED_MON] }));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={onDirtyChange} />);

    await rowHeader("Ön Bahçe");
    expect(onDirtyChange).toHaveBeenCalledWith(false);
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
  });

  it("29) kaydetmede fixed_day_locked → mesaj ve 'Güncel Veriyi Yükle' gösterir", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValueOnce(matrix()).mockResolvedValueOnce(matrix({ fixedAssignments: [FIXED_MON] }));
    vi.mocked(api.saveDutyMatrix).mockRejectedValue(
      new SaveDutyMatrixError({
        error: "fixed_day_locked",
        message: "Sabit nöbet bulunan günlerde hiçbir blokta uygunluk değiştirilemez.",
        lockedDayOrders: [1],
      }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await screen.findByText("Ön Bahçe");
    await user.click(screen.getByRole("checkbox", { name: cellName("Pazartesi", "Sabah Teneffüs Bloğu", "Ön Bahçe", "uygun değil") }));
    await user.click(screen.getByRole("button", { name: "Kaydet" }));

    expect(await screen.findByText(/Sabit nöbet bulunan günlerde hiçbir blokta/)).toBeInTheDocument();
    const reloadButton = screen.getByRole("button", { name: "Güncel Veriyi Yükle" });

    await user.click(reloadButton);
    expect(
      await screen.findByRole("img", { name: "Pazartesi, Sabah Teneffüs Bloğu, İlkokul Koridor: sabit nöbet" }),
    ).toBeInTheDocument();
  });

  it("30) pasif sabit nöbet yeri: dutyLocations listesinde yoksa bile salt-okunur satır olarak gösterilir", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      matrix({
        fixedAssignments: [
          {
            assignmentId: "fx-2",
            dayOrder: 1,
            dutyLocationId: "44444444-4444-4444-4444-444444444444",
            dutyLocationName: "Eski Kat",
            dutyLocationShortCode: "ESKI-KAT",
            dutyLocationIsActive: false,
          },
        ],
      }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    expect(await rowHeader("Eski Kat")).toBeInTheDocument();
    expect(screen.getByText("Pasif sabit nöbet yeri")).toBeInTheDocument();
    // Blok kapsamı BİLİNMEDİĞİ için tek bir salt-okunur hücre gösterilir.
    expect(
      screen.getByRole("img", {
        name: "Pazartesi, Eski Kat: geçmiş sabit atama, nöbet yeri pasif. Nöbet yeri pasif olduğu için güncel blok politikası gösterilemiyor.",
      }),
    ).toBeInTheDocument();
  });

  /**
   * PASİF sabit nöbet yeri için sunucu blockPolicies göndermez (yer aktif
   * listede yoktur). Bu yüzden UI hangi blokların sabit atamayla karşılandığını
   * BİLEMEZ ve tahmin ETMEZ: blok sütunları tek bir kapsam iddiasız hücreyle
   * temsil edilir.
   */
  const INACTIVE_FIXED = {
    assignmentId: "fx-inactive",
    dayOrder: 1,
    dutyLocationId: "44444444-4444-4444-4444-444444444444",
    dutyLocationName: "Eski Kat",
    dutyLocationShortCode: "ESKI-KAT",
    dutyLocationIsActive: false,
  };
  const INACTIVE_CELL_LABEL =
    "Pazartesi, Eski Kat: geçmiş sabit atama, nöbet yeri pasif. Nöbet yeri pasif olduğu için güncel blok politikası gösterilemiyor.";

  it("30a) pasif sabit yerde DÖRT adet 'Sabit' rozeti oluşmaz (kapsam tahmini yok)", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix({ fixedAssignments: [INACTIVE_FIXED] }));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);
    await rowHeader("Eski Kat");

    const row = screen.getByRole("row", { name: /Eski Kat/ });
    // Blok başına hücre YOK: dört blok sütunu tek bir td ile kaplanır.
    const cells = within(row).getAllByRole("cell");
    expect(cells).toHaveLength(1);
    expect(cells[0]).toHaveAttribute("colspan", "4");

    // Satırda hiç "Sabit" rozeti yok; blok adlı sabit nöbet etiketi de yok.
    expect(within(row).queryByText("Sabit")).not.toBeInTheDocument();
    for (const blockName of ["Sabah Teneffüs Bloğu", "Uzun Nöbet 1", "Uzun Nöbet 2", "Öğleden Sonra Teneffüs Bloğu"]) {
      expect(
        screen.queryByRole("img", { name: `Pazartesi, ${blockName}, Eski Kat: sabit nöbet` }),
      ).not.toBeInTheDocument();
    }
  });

  it("30b) pasif sabit yerde 'Dinlenme' / 'nöbetçi gerekmiyor' gibi tahmini blok anlamı üretilmez", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix({ fixedAssignments: [INACTIVE_FIXED] }));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);
    await rowHeader("Eski Kat");
    const row = screen.getByRole("row", { name: /Eski Kat/ });

    expect(within(row).queryByText(/Dinlenme/)).not.toBeInTheDocument();
    expect(within(row).queryByText(/nöbetçi gerekmiyor/i)).not.toBeInTheDocument();
    expect(within(row).queryByText(/Sabit atama bekleniyor/)).not.toBeInTheDocument();
    expect((row.textContent ?? "")).not.toMatch(/Dinlenme|gerekmiyor/i);
  });

  it("30c) geçmiş sabit atama ve yerin PASİF olduğu erişilebilir biçimde görünür", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix({ fixedAssignments: [INACTIVE_FIXED] }));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    const cell = await screen.findByRole("img", { name: INACTIVE_CELL_LABEL });
    expect(cell).toBeInTheDocument();
    expect(cell).toHaveTextContent("Geçmiş sabit atama · Nöbet yeri pasif");
    expect(cell.closest("td")).toHaveAttribute(
      "title",
      "Nöbet yeri pasif olduğu için güncel blok politikası gösterilemiyor.",
    );
    // Satır başlığı yerin pasif olduğunu ayrıca yazar.
    expect(within(screen.getByRole("row", { name: /Eski Kat/ })).getByText("Pasif sabit nöbet yeri")).toBeInTheDocument();

    // Sabit atama BULUNMAYAN günde kapsam iddiası yerine nötr "—".
    await userEvent.setup().click(screen.getByRole("tab", { name: /Salı/ }));
    const other = await screen.findByRole("img", {
      name: "Salı, Eski Kat: bu gün sabit atama yok, nöbet yeri pasif. Nöbet yeri pasif olduğu için güncel blok politikası gösterilemiyor.",
    });
    expect(other).toHaveTextContent("—");
  });

  it("30d) pasif sabit satır sayaç, dirty-state ve kaydetme payload'ını ETKİLEMEZ", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix({ fixedAssignments: [INACTIVE_FIXED] }));
    vi.mocked(api.saveDutyMatrix).mockResolvedValue({
      savedAt: "2026-09-07T11:00:00.000Z",
      updatedAt: "2026-09-07T11:00:00.000Z",
      halfDayRuleEnabled: true,
    });
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={onDirtyChange} />);
    await rowHeader("Eski Kat");

    // Başlangıç: seçim yok; pasif satır sayaca hiç girmez.
    expect(summaryText()).toContain("Toplam 0 uygun seçenek");
    onDirtyChange.mockClear();

    // Pasif satır hücresine tıklamak hiçbir şey değiştirmez (checkbox değil).
    const inactiveCell = screen.getByRole("img", { name: INACTIVE_CELL_LABEL });
    await user.click(inactiveCell);
    expect(summaryText()).toContain("Toplam 0 uygun seçenek");
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);

    // Pazartesi sabit nöbet nedeniyle kilitli; Salı'da seçim yapılır.
    await user.click(screen.getByRole("tab", { name: /Salı/ }));
    await user.click(await screen.findByRole("checkbox", { name: cellName("Salı", "Sabah Teneffüs Bloğu", "Ön Bahçe", "uygun değil") }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(true));
    expect(summaryText()).toContain("Toplam 1 uygun seçenek");

    await user.click(screen.getByRole("button", { name: "Kaydet" }));
    await waitFor(() => expect(api.saveDutyMatrix).toHaveBeenCalled());
    const payload = vi.mocked(api.saveDutyMatrix).mock.calls[0][1];
    expect(payload.cells).toEqual([{ dutyLocationId: LOC_A, dayOrder: 2, dutyBlockId: BLK_MORNING }]);
    expect(payload.cells.some((c) => c.dutyLocationId === INACTIVE_FIXED.dutyLocationId)).toBe(false);
  });

  it("30e) pasif satır varken AKTİF karma-politikalı yer regresyonsuz kalır", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix({ fixedAssignments: [INACTIVE_FIXED] }));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);
    await rowHeader("Eski Kat");

    // İlkokul Koridor: rozet politikadan gelir, Sabah/ÖS fixed_only,
    // Öğle Arası-2 eşlemesiz, Öğle Arası-1 normal (Pazartesi sabit kilidiyle).
    expect(screen.getByText("Bazı bloklar sabit")).toBeInTheDocument();
    const ilkokulRow = screen.getByRole("row", { name: /İlkokul Koridor/ });
    expect(within(ilkokulRow).getAllByRole("cell")).toHaveLength(4);
    expect(screen.getByText("Pazartesi, Uzun Nöbet 2, İlkokul Koridor: bu blokta nöbetçi gerekmiyor")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Pazartesi, Sabah Teneffüs Bloğu, İlkokul Koridor: sabit atama bekleniyor" }),
    ).toBeInTheDocument();
  });

  it("31) sabit nöbete uygun yer, matriste salt-okunur rozetle işaretlenir", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      matrix({
        dutyLocations: [
          {
            id: LOC_A,
            name: "İlkokul 1. Kat",
            shortCode: "ILKOKUL1",
            category: "corridor",
            capacity: 1,
            sortOrder: 1,
            allowsFixedAssignment: true,
            blockIds: [BLK_MORNING, BLK_AFTERNOON],
            blockPolicies: policies([BLK_MORNING, BLK_AFTERNOON], "fixed_only"),
          },
        ],
      }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    // Rozet allowsFixedAssignment'tan DEĞİL, blockPolicies'ten türetilir.
    expect(await screen.findByText("Bazı bloklar sabit")).toBeInTheDocument();
  });

  it("32) sabit günde BAŞKA yerde gerekli blok: sabit gün nedeniyle kilitli (locked_by_fixed_duty)", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix({ fixedAssignments: [FIXED_MON] }));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    // Yemekhane (LOC_B) Uzun Nöbet 1'i istiyor (blockIds tümü) ama sabit yer DEĞİL.
    expect(
      await screen.findByRole("img", { name: "Pazartesi, Uzun Nöbet 1, Yemekhane: sabit nöbet nedeniyle kullanılamaz" }),
    ).toBeInTheDocument();
  });

  it("33) sabit günde BAŞKA yerde TANIMSIZ blok: 'nöbetçi gerekmiyor' — sabit kilidi değil", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix({ fixedAssignments: [FIXED_MON] }));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    // Öğle Arası İlkokul (LOC_C) yalnız Uzun Nöbet 1 ister; Sabah bloğu o yerde hiç tanımlı değil.
    await rowHeader("Öğle Arası İlkokul");
    expect(
      screen.getByText("Pazartesi, Sabah Teneffüs Bloğu, Öğle Arası İlkokul: bu blokta nöbetçi gerekmiyor"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: /Sabah Teneffüs Bloğu, Öğle Arası İlkokul: sabit nöbet nedeniyle kullanılamaz/ }),
    ).not.toBeInTheDocument();
  });

  it("34) sabit yerin Sabit/Dinlenme/nöbetçi-gerekmiyor hücreleri sayaca ve dirty-state'e katılmaz", async () => {
    const onDirtyChange = vi.fn();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix({ fixedAssignments: [FIXED_MON] }));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={onDirtyChange} />);

    await rowHeader("Ön Bahçe");
    // Pazartesi sabit: Sabit(Sabah+Öğleden Sonra) + Dinlenme(Uzun1) + nöbetçi-gerekmiyor(Uzun2)
    // hiçbiri draftCells'e girmez — toplam 0 kalmalı.
    expect(screen.getByText(/Toplam 0 uygun seçenek/)).toBeInTheDocument();
    expect(onDirtyChange).toHaveBeenCalledWith(false);
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "Kaydet" })).toBeDisabled();
  });

  it("35) normal öğretmen (sabit atama yok) ve ders çakışması davranışı bu değişiklikten ETKİLENMEZ", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      matrix({ lessonConflicts: [{ dayOrder: 1, dutyBlockId: BLK_LONG1, periodName: "5-OO" }] }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await screen.findByText("Ön Bahçe");
    // Normal (sabit olmayan) hücre hâlâ checkbox'tır.
    expect(
      screen.getByRole("checkbox", { name: cellName("Pazartesi", "Sabah Teneffüs Bloğu", "Ön Bahçe", "uygun değil") }),
    ).toBeInTheDocument();
    // Ders çakışması hâlâ ayrı ikonla gösterilir, "Dinlenme"/"Sabit" değildir.
    expect(
      screen.getByRole("img", { name: "Pazartesi, Uzun Nöbet 1, Ön Bahçe: ders çakışması nedeniyle kullanılamaz" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Dinlenme")).not.toBeInTheDocument();
    expect(screen.queryByText("Sabit")).not.toBeInTheDocument();
  });

  // === Sabit YER (allowsFixedAssignment=true, ör. İLKOKUL-1) — global farkındalık ===

  const FIXED_LOC = {
    id: LOC_D,
    name: "İlkokul 1. Kat",
    shortCode: "ILKOKUL1",
    category: "corridor" as const,
    capacity: 1,
    sortOrder: 4,
    allowsFixedAssignment: true,
    blockIds: [BLK_MORNING, BLK_AFTERNOON],
    blockPolicies: policies([BLK_MORNING, BLK_AFTERNOON], "fixed_only"),
  };

  const OTHER_TEACHER_ASSIGNMENT = {
    assignmentId: "flx-1",
    dayOrder: 1,
    dutyLocationId: LOC_D,
    dutyLocationName: "İlkokul 1. Kat",
    dutyLocationShortCode: "ILKOKUL1",
    teacherSourceId: "T-OTHER",
    teacherName: "Zeynep Uzunisimli Öğretmen Kaydı",
    dutyLocationIsActive: true,
  };

  it("36) başka öğretmenin sabit yeri: Sabah/Öğleden Sonra'da adı görünür, checkbox yok, tıklanamaz", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      matrix({ dutyLocations: [FIXED_LOC], fixedLocationAssignments: [OTHER_TEACHER_ASSIGNMENT] }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("İlkokul 1. Kat");
    const morningImg = screen.getByRole("img", {
      name: "Pazartesi, Sabah Teneffüs Bloğu, İlkokul 1. Kat: Zeynep Uzunisimli Öğretmen Kaydı sabit nöbetçi",
    });
    expect(morningImg).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Pazartesi, Öğleden Sonra Teneffüs Bloğu, İlkokul 1. Kat: Zeynep Uzunisimli Öğretmen Kaydı sabit nöbetçi",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /İlkokul 1. Kat/ })).not.toBeInTheDocument();

    // Tıklama hiçbir şeyi değiştirmez (checkbox olmadığı için click hedefi img'dir, toggle tetiklenmez).
    await user.click(morningImg);
    expect(screen.getByText(/Toplam 0 uygun seçenek/)).toBeInTheDocument();
  });

  it("37) başka öğretmenin sabit yerinde Uzun 1/Uzun 2: block_not_required ('nöbetçi gerekmiyor')", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      matrix({ dutyLocations: [FIXED_LOC], fixedLocationAssignments: [OTHER_TEACHER_ASSIGNMENT] }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("İlkokul 1. Kat");
    expect(screen.getByText("Pazartesi, Uzun Nöbet 1, İlkokul 1. Kat: bu blokta nöbetçi gerekmiyor")).toBeInTheDocument();
    expect(screen.getByText("Pazartesi, Uzun Nöbet 2, İlkokul 1. Kat: bu blokta nöbetçi gerekmiyor")).toBeInTheDocument();
  });

  it("38) başka öğretmenin sabit yeri, seçilen öğretmenin GÜNÜNÜ KİLİTLEMEZ: normal yer ve OGLEARASIILKOKUL×Uzun1 seçilebilir kalır", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      matrix({ dutyLocations: [{ ...FIXED_LOC }, ...(matrix() as Extract<TeacherDutyMatrixResponse, { teacherFound: true }>).dutyLocations], fixedLocationAssignments: [OTHER_TEACHER_ASSIGNMENT] }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("İlkokul 1. Kat");
    // Ön Bahçe (normal yer) hâlâ tıklanabilir checkbox'tır.
    const normalCell = screen.getByRole("checkbox", { name: cellName("Pazartesi", "Sabah Teneffüs Bloğu", "Ön Bahçe", "uygun değil") });
    await user.click(normalCell);
    expect(normalCell).toBeChecked();

    // OGLEARASIILKOKUL × Uzun Nöbet 1 hâlâ tıklanabilir.
    const ogleCell = screen.getByRole("checkbox", {
      name: cellName("Pazartesi", "Uzun Nöbet 1", "Öğle Arası İlkokul", "uygun değil"),
    });
    await user.click(ogleCell);
    expect(ogleCell).toBeChecked();
  });

  it("39) atamasız sabit yer: 'Sabit atama bekleniyor', tıklanamaz", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(matrix({ dutyLocations: [FIXED_LOC], fixedLocationAssignments: [] }));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("İlkokul 1. Kat");
    expect(
      screen.getByRole("img", { name: "Pazartesi, Sabah Teneffüs Bloğu, İlkokul 1. Kat: sabit atama bekleniyor" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Sabit atama bekleniyor").length).toBeGreaterThan(0);
    expect(screen.queryByRole("checkbox", { name: /İlkokul 1. Kat/ })).not.toBeInTheDocument();
  });

  it("40) toplu seçim (Tüm Günleri Seç) allowsFixedAssignment yerini atlar, sayaç ve dirty-state etkilenmez", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      matrix({ dutyLocations: [{ ...FIXED_LOC }, ...(matrix() as Extract<TeacherDutyMatrixResponse, { teacherFound: true }>).dutyLocations], fixedLocationAssignments: [OTHER_TEACHER_ASSIGNMENT] }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={onDirtyChange} />);

    await rowHeader("İlkokul 1. Kat");
    await user.click(screen.getByRole("button", { name: "Tüm Günleri Seç" }));
    // LOC_D (allowsFixedAssignment) hiç eklenmez: sayı yalnız LOC_A/B/C'nin
    // normal SELECTABLE_PER_DAY toplamı kadar artar (2 gün).
    expect(screen.getByText(new RegExp(`Toplam ${SELECTABLE_PER_DAY * 2} uygun seçenek`))).toBeInTheDocument();
    expect(onDirtyChange).toHaveBeenCalledWith(true);

    await user.click(screen.getByRole("button", { name: "Tümünü Temizle" }));
    expect(screen.getByText(/Toplam 0 uygun seçenek/)).toBeInTheDocument();
  });

  it("41) uzun öğretmen adı aria-label içinde EKSİKSİZ görünür (görsel kırpma yalnız CSS'tedir)", async () => {
    const longName = "Ayşe Fatma Zehra Muhammed Efendioğlu Aşçıoğlu Uzunsoyadlıoğulları";
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      matrix({
        dutyLocations: [FIXED_LOC],
        fixedLocationAssignments: [{ ...OTHER_TEACHER_ASSIGNMENT, teacherName: longName }],
      }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("İlkokul 1. Kat");
    expect(
      screen.getByRole("img", { name: `Pazartesi, Sabah Teneffüs Bloğu, İlkokul 1. Kat: ${longName} sabit nöbetçi` }),
    ).toBeInTheDocument();
    expect(screen.getAllByText(longName).length).toBeGreaterThan(0);
  });

  // === Sayaç ayrımı: kullanılabilir vs ders çakışması nedeniyle korunmuş tercih ===

  const THREE_DAYS = [
    { order: 2, name: "Salı" },
    { order: 3, name: "Çarşamba" },
    { order: 4, name: "Perşembe" },
  ];

  /**
   * Kök neden senaryosu: 3 gün, her günde LOC_A+LOC_B × 4 blok = 8 seçili
   * tercih; LONG_BREAK_1 o üç günde de ders çakışmalı. Gün başına 6
   * kullanılabilir + 2 korunmuş = 8; toplamda 18 + 6 = 24.
   */
  function conflictLoadedMatrix(overrides: Partial<Extract<TeacherDutyMatrixResponse, { teacherFound: true }>> = {}): TeacherDutyMatrixResponse {
    const selectedBlockCells: { dutyLocationId: string; dayOrder: number; dutyBlockId: string }[] = [];
    const lessonConflicts: { dayOrder: number; dutyBlockId: string; periodName: string }[] = [];
    for (const d of THREE_DAYS) {
      for (const loc of [LOC_A, LOC_B]) {
        for (const blk of ALL_BLOCK_IDS) selectedBlockCells.push({ dutyLocationId: loc, dayOrder: d.order, dutyBlockId: blk });
      }
      lessonConflicts.push({ dayOrder: d.order, dutyBlockId: BLK_LONG1, periodName: "5-OO" });
    }
    return matrix({ days: THREE_DAYS, selectedBlockCells, lessonConflicts, ...overrides });
  }

  it("42) gün sekmesi: 8 toplam seçiliden 2'si LONG_BREAK_1 çakışmalı → '6 uygun · 2 kilitli'", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(conflictLoadedMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    const salıTab = await screen.findByRole("tab", { name: /Salı: 6 kullanılabilir tercih, 2 ders çakışması nedeniyle kilitli tercih/ });
    expect(within(salıTab).getByText("6 uygun")).toBeInTheDocument();
    expect(within(salıTab).getByText("2 kilitli")).toBeInTheDocument();
  });

  it("43) genel özet: 3 gün × (6 uygun+2 kilitli) = 18 kullanılabilir · 6 kilitli · 24 toplam", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(conflictLoadedMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Ön Bahçe");
    await waitFor(() =>
      expect(summaryText()).toContain("18 kullanılabilir tercih · 6 ders çakışması nedeniyle kilitli · 24 toplam seçili tercih"),
    );
  });

  it("44) yalnız lesson_conflict olan ama ÖNCEDEN SEÇİLİ OLMAYAN hücre conflictPreservedCount'a katılmaz", async () => {
    // conflictLoadedMatrix varsayılan dutyLocations'ı (LOC_A, LOC_B, LOC_C)
    // korur. LOC_C ("Öğle Arası İlkokul") THREE_DAYS senaryosunda HİÇ
    // seçilmemiş, ama Salı LONG_BREAK_1 için genel ders çakışması zaten var
    // (conflictKey yer bağımsızdır) — LOC_C draftCells'e hiç girmediği için
    // sayaç etkilenmemeli.
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(conflictLoadedMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Öğle Arası İlkokul");
    // LOC_C'nin Uzun 1 hücresi normal (seçilmemiş) lesson_conflict'tir, "Korunan tercih" DEĞİLDİR.
    expect(
      screen.getByRole("img", { name: "Salı, Uzun Nöbet 1, Öğle Arası İlkokul: ders çakışması nedeniyle kullanılamaz" }),
    ).toBeInTheDocument();
    // Toplam hâlâ 18/6/24 — LOC_C'nin (seçilmemiş) çakışması sayaca hiç girmedi.
    expect(summaryText()).toContain("18 kullanılabilir tercih · 6 ders çakışması nedeniyle kilitli · 24 toplam seçili tercih");
  });

  it("45) LONG_BREAK_1 blok başlığı '0 uygun · 2 kilitli' gösterir; diğer bloklar yalnız '2 uygun'", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(conflictLoadedMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Ön Bahçe");
    const long1Header = screen.getByText("Uzun 1").closest("th")!;
    expect(within(long1Header).getByText("0 uygun ·")).toBeInTheDocument();
    expect(within(long1Header).getByText("2 kilitli")).toBeInTheDocument();

    const morningHeader = screen.getByText("Sabah").closest("th")!;
    expect(within(morningHeader).getByText("2 uygun")).toBeInTheDocument();
  });

  it("46) seçili+çakışmalı hücre 'Korunan tercih' ile ayrı görünür (sıradan seçilmemiş çakışmadan farklı)", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(conflictLoadedMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Ön Bahçe");
    expect(screen.getAllByText("Korunan tercih").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("img", { name: "Salı, Uzun Nöbet 1, Ön Bahçe: korunan tercih, ders çakışması nedeniyle şu an kullanılamıyor" }),
    ).toBeInTheDocument();
    // Sıradan (seçilmemiş) ders çakışması "Korunan tercih" YAZISI TAŞIMAZ.
    expect(
      screen.queryByRole("img", { name: /Öğle Arası İlkokul.*ders çakışması nedeniyle kullanılamaz$/ }),
    ).not.toHaveTextContent("Korunan tercih");
  });

  it("47) tooltip/aria-label korunmuş tercih durumunu eksiksiz açıklar", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(conflictLoadedMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Ön Bahçe");
    const img = screen.getAllByRole("img", { name: /korunan tercih, ders çakışması nedeniyle şu an kullanılamıyor/ })[0];
    const cell = img.closest("td")!;
    expect(cell).toHaveAttribute(
      "title",
      "Bu tercih kayıtlıdır ancak öğretmenin bu bloğa denk gelen dersi nedeniyle şu anda kullanılamaz. Ders çakışması kalkarsa tercih yeniden kullanılabilir olur.",
    );
  });

  it("48) Günü Temizle korunmuş çatışmalı hücreleri draft'tan ÇIKARMAZ", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(conflictLoadedMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Ön Bahçe");
    await waitFor(() => expect(summaryText()).toContain("18 kullanılabilir tercih · 6 ders çakışması nedeniyle kilitli · 24 toplam seçili tercih"));
    await user.click(screen.getByRole("button", { name: "Günü Temizle" }));

    // Salı'nın 6 kullanılabilir hücresi silindi (18-6=12), ama 6 korunmuş hücre AYNEN kaldı.
    await waitFor(() =>
      expect(summaryText()).toContain("12 kullanılabilir tercih · 6 ders çakışması nedeniyle kilitli · 18 toplam seçili tercih"),
    );
    expect(screen.getAllByText("Korunan tercih").length).toBeGreaterThan(0);
  });

  it("49) Blok Temizle (LONG_BREAK_1) korunmuş çatışmalı hücreleri ÇIKARMAZ", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(conflictLoadedMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Ön Bahçe");
    const long1Header = screen.getByText("Uzun 1").closest("th")!;
    await user.click(within(long1Header).getByText("Temizle"));

    // Salı'nın LONG_BREAK_1 hücreleri (2 korunmuş) hiç etkilenmedi — toplam aynı.
    await waitFor(() =>
      expect(summaryText()).toContain("18 kullanılabilir tercih · 6 ders çakışması nedeniyle kilitli · 24 toplam seçili tercih"),
    );
  });

  it("50) Tümünü Temizle korunmuş çatışmalı hücreleri ÇIKARMAZ, yalnız kullanılabilirleri temizler", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(conflictLoadedMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Ön Bahçe");
    await waitFor(() => expect(summaryText()).toContain("18 kullanılabilir tercih · 6 ders çakışması nedeniyle kilitli · 24 toplam seçili tercih"));
    await user.click(screen.getByRole("button", { name: "Tümünü Temizle" }));

    // 6 korunmuş hücre hâlâ draftCells'te (0 kullanılabilir) — conflictPreserved
    // > 0 olduğu için özet YİNE açık ayrım biçimini kullanır ("0 kullanılabilir"
    // gösterir, sessizce "Toplam 0"a düşmez).
    await waitFor(() =>
      expect(summaryText()).toContain("0 kullanılabilir tercih · 6 ders çakışması nedeniyle kilitli · 6 toplam seçili tercih"),
    );
    // Yalnız aktif gün (Salı) paneli DOM'dadır — o günün 2 korunmuş hücresi görünür.
    expect(screen.getAllByText("Korunan tercih").length).toBe(2);
  });

  it("51) korunmuş hücrelere dokunmayan bir temizleme dirty-state ÜRETMEZ; başka hücre temizlemek dirty=true yapar", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(conflictLoadedMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={onDirtyChange} />);

    await rowHeader("Ön Bahçe");
    onDirtyChange.mockClear();
    const long1Header = screen.getByText("Uzun 1").closest("th")!;
    await user.click(within(long1Header).getByText("Temizle"));
    // Yalnız korunmuş hücreler hedeflendi, hiçbiri silinmedi -> dirty olmamalı.
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);

    const morningHeader = screen.getByText("Sabah").closest("th")!;
    await user.click(within(morningHeader).getByText("Temizle"));
    expect(onDirtyChange).toHaveBeenCalledWith(true);
  });

  it("52) kaydetme: çakışmalı (korunmuş) hücre payload'a HİÇ girmez, normal hücre değişikliği başarıyla kaydedilir", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(conflictLoadedMatrix());
    vi.mocked(api.saveDutyMatrix).mockResolvedValue({ savedAt: "x", updatedAt: "2026-09-07T12:00:00.000Z", halfDayRuleEnabled: true });
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Ön Bahçe");
    // Salı Sabah (LOC_A) zaten seçili+kullanılabilir; toggle ile kaldır.
    await user.click(screen.getByRole("checkbox", { name: cellName("Salı", "Sabah Teneffüs Bloğu", "Ön Bahçe", "uygun") }));
    await user.click(screen.getByRole("button", { name: "Kaydet" }));

    await waitFor(() => expect(api.saveDutyMatrix).toHaveBeenCalled());
    const sentCells = vi.mocked(api.saveDutyMatrix).mock.calls[0][1].cells;
    // 6 korunmuş (çakışmalı) hücre isSelectable tarafından payload'dan
    // TAMAMEN elenir (RPC'ye hiç gönderilmez) — 18 kullanılabilirden 1'i
    // (Salı Sabah/Ön Bahçe) kaldırıldı: 18 - 1 = 17.
    expect(sentCells.some((c) => c.dutyBlockId === BLK_LONG1)).toBe(false);
    expect(sentCells.length).toBe(17);
  });

  it("53) ders çakışması kaldırılmış yeni snapshot'ta korunmuş hücre normal uygun sayaca geçer", async () => {
    // Yeni XML import sonrası: aynı hücreler seçili ama artık lessonConflicts boş.
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(conflictLoadedMatrix({ lessonConflicts: [] }));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    expect(await screen.findByText(/Toplam 24 uygun seçenek/)).toBeInTheDocument();
    expect(screen.queryByText("Korunan tercih")).not.toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: cellName("Salı", "Uzun Nöbet 1", "Ön Bahçe", "uygun") }),
    ).toBeChecked();
  });

  it("54) çakışma kalktıktan sonra kullanıcı hücreyi TEMİZLEYEBİLİR (artık normal checkbox)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(conflictLoadedMatrix({ lessonConflicts: [] }));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    const checkbox = await screen.findByRole("checkbox", { name: cellName("Salı", "Uzun Nöbet 1", "Ön Bahçe", "uygun") });
    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();
  });

  it("55) sabit nöbet / fixed_by_other / fixed_assignment_required / block_not_required hücreleri sayaçlara katılmaz", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      conflictLoadedMatrix({
        dutyLocations: [
          ...(matrix() as Extract<TeacherDutyMatrixResponse, { teacherFound: true }>).dutyLocations,
          FIXED_LOC,
        ],
        fixedLocationAssignments: [{ ...OTHER_TEACHER_ASSIGNMENT, dayOrder: 2 }],
      }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    // FIXED_LOC (allowsFixedAssignment) hiçbir zaman draftCells'e giremez —
    // sayaç hâlâ tam olarak 18/6/24, LOC_D'nin varlığı sayacı değiştirmedi.
    await rowHeader("İlkokul 1. Kat");
    await waitFor(() =>
      expect(summaryText()).toContain("18 kullanılabilir tercih · 6 ders çakışması nedeniyle kilitli · 24 toplam seçili tercih"),
    );
  });

  // === YEMEKHANE-1/2: blockIds tabanlı davranış (bkz. migration 20260912090000) ===
  // Mimari config-driven'dır — cellStatus/isSelectable YEMEKHANE için özel bir
  // koşul İÇERMEZ, yalnız location.blockIds'e bakar. Bu yüzden aşağıdaki
  // testler ÜRETİM KODUNU DEĞİL, yalnız gerçek short_code'larla kurulmuş bir
  // fixture'ı doğrular (aynı mekanizma zaten LOC_C ile de test ediliyor).

  const YEMEKHANE1_ID = "77777777-1111-1111-1111-111111111111";
  const YEMEKHANE2_ID = "77777777-2222-2222-2222-222222222222";

  const YEMEKHANE_LOCATIONS = [
    {
      id: YEMEKHANE1_ID,
      name: "Yemekhane-1",
      shortCode: "YEMEKHANE1",
      category: "cafeteria" as const,
      capacity: 1,
      sortOrder: 1,
      allowsFixedAssignment: false,
      blockIds: [BLK_LONG1],
      blockPolicies: policies([BLK_LONG1]),
    },
    {
      id: YEMEKHANE2_ID,
      name: "Yemekhane-2",
      shortCode: "YEMEKHANE2",
      category: "cafeteria" as const,
      capacity: 1,
      sortOrder: 2,
      allowsFixedAssignment: false,
      blockIds: [BLK_LONG2],
      blockPolicies: policies([BLK_LONG2]),
    },
  ];

  function yemekhaneMatrix(overrides: Partial<Extract<TeacherDutyMatrixResponse, { teacherFound: true }>> = {}): TeacherDutyMatrixResponse {
    return matrix({ dutyLocations: YEMEKHANE_LOCATIONS, ...overrides });
  }

  it("56) YEMEKHANE-1 yalnız Uzun Nöbet 1 hücresini seçilebilir gösterir; diğerleri 'nöbetçi gerekmiyor'", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(yemekhaneMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Yemekhane-1");
    expect(
      screen.getByRole("checkbox", { name: cellName("Pazartesi", "Uzun Nöbet 1", "Yemekhane-1", "uygun değil") }),
    ).toBeInTheDocument();
    expect(screen.getByText("Pazartesi, Sabah Teneffüs Bloğu, Yemekhane-1: bu blokta nöbetçi gerekmiyor")).toBeInTheDocument();
    expect(screen.getByText("Pazartesi, Uzun Nöbet 2, Yemekhane-1: bu blokta nöbetçi gerekmiyor")).toBeInTheDocument();
    expect(screen.getByText("Pazartesi, Öğleden Sonra Teneffüs Bloğu, Yemekhane-1: bu blokta nöbetçi gerekmiyor")).toBeInTheDocument();
  });

  it("57) YEMEKHANE-2 yalnız Uzun Nöbet 2 hücresini seçilebilir gösterir; diğerleri 'nöbetçi gerekmiyor'", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(yemekhaneMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Yemekhane-2");
    expect(
      screen.getByRole("checkbox", { name: cellName("Pazartesi", "Uzun Nöbet 2", "Yemekhane-2", "uygun değil") }),
    ).toBeInTheDocument();
    expect(screen.getByText("Pazartesi, Sabah Teneffüs Bloğu, Yemekhane-2: bu blokta nöbetçi gerekmiyor")).toBeInTheDocument();
    expect(screen.getByText("Pazartesi, Uzun Nöbet 1, Yemekhane-2: bu blokta nöbetçi gerekmiyor")).toBeInTheDocument();
    expect(screen.getByText("Pazartesi, Öğleden Sonra Teneffüs Bloğu, Yemekhane-2: bu blokta nöbetçi gerekmiyor")).toBeInTheDocument();
  });

  it("58) Tüm Günleri Seç yalnız YEMEKHANE için geçerli tek hücreyi işaretler (Sabah/Uzun2/Öğleden atlanır)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(yemekhaneMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Yemekhane-1");
    await user.click(screen.getByRole("button", { name: "Tüm Günleri Seç" }));

    // 2 gün × (YEMEKHANE1'in 1 geçerli hücresi + YEMEKHANE2'nin 1 geçerli hücresi) = 4.
    expect(screen.getByText(/Toplam 4 uygun seçenek/)).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: cellName("Pazartesi", "Uzun Nöbet 1", "Yemekhane-1", "uygun") }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: cellName("Pazartesi", "Uzun Nöbet 2", "Yemekhane-2", "uygun") }),
    ).toBeChecked();
  });

  it("59) sayaçlar yalnız geçerli YEMEKHANE hücrelerini sayar (gereksiz olanlar sayaca girmez)", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      yemekhaneMatrix({
        selectedBlockCells: [
          { dutyLocationId: YEMEKHANE1_ID, dayOrder: 1, dutyBlockId: BLK_LONG1 },
          { dutyLocationId: YEMEKHANE2_ID, dayOrder: 1, dutyBlockId: BLK_LONG2 },
        ],
      }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Yemekhane-1");
    expect(await screen.findByText(/Toplam 2 uygun seçenek/)).toBeInTheDocument();
  });

  it("60) YEMEKHANE-1 × Uzun Nöbet 1'de seçili+ders çakışmalı korunmuş tercih davranışı bozulmaz", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      yemekhaneMatrix({
        selectedBlockCells: [{ dutyLocationId: YEMEKHANE1_ID, dayOrder: 1, dutyBlockId: BLK_LONG1 }],
        lessonConflicts: [{ dayOrder: 1, dutyBlockId: BLK_LONG1, periodName: "5-OO" }],
      }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Yemekhane-1");
    expect(
      screen.getByRole("img", { name: "Pazartesi, Uzun Nöbet 1, Yemekhane-1: korunan tercih, ders çakışması nedeniyle şu an kullanılamıyor" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: /Pazartesi, Uzun Nöbet 1, Yemekhane-1/ }),
    ).not.toBeInTheDocument();
  });

  it("61) YEMEKHANE-1/2 ile birlikte sabit nöbet, ILKOKUL1/2 ve OGLEARASIILKOKUL davranışları regresyonsuz kalır", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      matrix({
        dutyLocations: [
          ...YEMEKHANE_LOCATIONS,
          ...(matrix() as Extract<TeacherDutyMatrixResponse, { teacherFound: true }>).dutyLocations,
          FIXED_LOC,
        ],
        fixedLocationAssignments: [OTHER_TEACHER_ASSIGNMENT],
      }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Yemekhane-1");
    // OGLEARASIILKOKUL (LOC_C) hâlâ yalnız Uzun 1'de normal seçilebilir.
    expect(
      screen.getByRole("checkbox", { name: cellName("Pazartesi", "Uzun Nöbet 1", "Öğle Arası İlkokul", "uygun değil") }),
    ).toBeInTheDocument();
    // İLKOKUL-1 (FIXED_LOC) başka öğretmene sabit — isim görünür, checkbox yok.
    expect(
      screen.getByRole("img", { name: "Pazartesi, Sabah Teneffüs Bloğu, İlkokul 1. Kat: Zeynep Uzunisimli Öğretmen Kaydı sabit nöbetçi" }),
    ).toBeInTheDocument();
    // YEMEKHANE-1/2 hâlâ doğru tek blokta seçilebilir.
    expect(
      screen.getByRole("checkbox", { name: cellName("Pazartesi", "Uzun Nöbet 1", "Yemekhane-1", "uygun değil") }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: cellName("Pazartesi", "Uzun Nöbet 2", "Yemekhane-2", "uygun değil") }),
    ).toBeInTheDocument();
  });

  it("62) LB1 target_period_busy: reasonCode'a göre tooltip/aria-label periyot adını kullanır", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      matrix({
        lessonConflicts: [
          { dayOrder: 1, dutyBlockId: BLK_LONG1, periodName: "5-OO", reasonCode: "target_period_busy", busyPeriodNames: ["5-OO"] },
        ],
      }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Ön Bahçe");
    const img = screen.getByRole("img", { name: "Pazartesi, Uzun Nöbet 1, Ön Bahçe: 5-OO periyodunda dersi var" });
    expect(img).toBeInTheDocument();
    expect(img.closest("td")).toHaveAttribute("title", "Öğretmenin bu gün 5-OO periyodunda dersi var.");
  });

  it("63) LB1 no_adjacent_period_free: tooltip/aria-label busyPeriodNames'i (4, 5-IO) gerçek isimlerle gösterir", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      matrix({
        lessonConflicts: [
          {
            dayOrder: 1,
            dutyBlockId: BLK_LONG1,
            periodName: "5-OO",
            reasonCode: "no_adjacent_period_free",
            busyPeriodNames: ["4", "5-IO"],
          },
        ],
      }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Ön Bahçe");
    const img = screen.getByRole("img", { name: "Pazartesi, Uzun Nöbet 1, Ön Bahçe: komşu periyotlar (4, 5-IO) dolu olduğundan kullanılamaz" });
    expect(img).toBeInTheDocument();
    expect(img.closest("td")).toHaveAttribute(
      "title",
      "Öğretmenin 5-OO periyodu boş, ancak komşu periyotların ikisi de (4, 5-IO) dolu olduğundan bu blok uygun değil.",
    );
  });

  it("64) LB2 no_adjacent_period_free: 5-OO/6 komşularıyla doğru tooltip üretir", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      matrix({
        lessonConflicts: [
          {
            dayOrder: 1,
            dutyBlockId: BLK_LONG2,
            periodName: "5-IO",
            reasonCode: "no_adjacent_period_free",
            busyPeriodNames: ["5-OO", "6"],
          },
        ],
      }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Ön Bahçe");
    expect(
      screen.getByRole("img", { name: "Pazartesi, Uzun Nöbet 2, Ön Bahçe: komşu periyotlar (5-OO, 6) dolu olduğundan kullanılamaz" }),
    ).toBeInTheDocument();
  });

  it("65) reasonCode=period_configuration_missing için güvenli genel tooltip gösterilir", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      matrix({
        lessonConflicts: [
          { dayOrder: 1, dutyBlockId: BLK_LONG1, periodName: null as unknown as string, reasonCode: "period_configuration_missing", busyPeriodNames: [] },
        ],
      }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Ön Bahçe");
    const img = screen.getByRole("img", { name: "Pazartesi, Uzun Nöbet 1, Ön Bahçe: periyot tanımı eksik olduğundan uygun değil" });
    expect(img.closest("td")).toHaveAttribute(
      "title",
      "Bu blok için gerekli ders periyodu tanımı ders programında bulunamadı, güvenlik nedeniyle uygun değil olarak işaretlendi.",
    );
  });

  it("66) bilinmeyen reasonCode için güvenli fallback (eski genel metin) kullanılır", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      matrix({
        lessonConflicts: [
          {
            dayOrder: 1,
            dutyBlockId: BLK_LONG1,
            periodName: "5-OO",
            reasonCode: "some_future_reason" as unknown as "target_period_busy",
            busyPeriodNames: ["5-OO"],
          },
        ],
      }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Ön Bahçe");
    expect(
      screen.getByRole("img", { name: "Pazartesi, Uzun Nöbet 1, Ön Bahçe: ders çakışması nedeniyle kullanılamaz" }),
    ).toBeInTheDocument();
  });

  it("67) seçili+kilitli (Korunan tercih) hücrede de reasonCode'a göre busyPeriodNames aria-label'a yansır", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      matrix({
        selectedBlockCells: [{ dutyLocationId: LOC_A, dayOrder: 1, dutyBlockId: BLK_LONG1 }],
        lessonConflicts: [
          {
            dayOrder: 1,
            dutyBlockId: BLK_LONG1,
            periodName: "5-OO",
            reasonCode: "no_adjacent_period_free",
            busyPeriodNames: ["4", "5-IO"],
          },
        ],
      }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await rowHeader("Ön Bahçe");
    expect(
      screen.getByRole("img", {
        name: "Pazartesi, Uzun Nöbet 1, Ön Bahçe: korunan tercih, komşu periyotlar (4, 5-IO) dolu olduğundan şu an kullanılamıyor",
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Korunan tercih").length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Yarım gün kuralı toggle'ı + blok politikası (migration 20260919/20/21)
// ============================================================================
describe("DutyAvailabilityMatrix — yarım gün kuralı ve blok politikası", () => {
  beforeEach(() => {
    vi.spyOn(api, "fetchDutyMatrix");
    vi.spyOn(api, "saveDutyMatrix");
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const B_M = BLK_MORNING;
  const B_L1 = BLK_LONG1;
  const B_L2 = BLK_LONG2;
  const B_A = BLK_AFTERNOON;

  /** Gerçek modeldeki gibi karma yer: Sabah/ÖS fixed_only, Öğle Arası-1 normal. */
  const ILKOKUL: DutyMatrixLocation = {
    id: "loc-ilkokul",
    name: "İLKOKUL-1",
    shortCode: "ILKOKUL1",
    category: "corridor",
    capacity: 1,
    sortOrder: 10,
    allowsFixedAssignment: true,
    blockIds: [B_M, B_A, B_L1],
    blockPolicies: [
      { dutyBlockId: B_M, blockCode: "MORNING_BREAKS", assignmentMode: "fixed_only" },
      { dutyBlockId: B_L1, blockCode: "LONG_BREAK_1", assignmentMode: "normal" },
      { dutyBlockId: B_A, blockCode: "AFTERNOON_BREAKS", assignmentMode: "fixed_only" },
    ],
  };

  /** ALT BAHÇE: Öğle Arası-1 KAPALI (eşleme yok). */
  const ALT_BAHCE: DutyMatrixLocation = {
    id: "loc-altbahce",
    name: "ALT BAHÇE",
    shortCode: "ALTBAHCE",
    category: "garden",
    capacity: 1,
    sortOrder: 11,
    allowsFixedAssignment: false,
    blockIds: [B_M, B_L2, B_A],
    blockPolicies: [
      { dutyBlockId: B_M, blockCode: "MORNING_BREAKS", assignmentMode: "normal" },
      { dutyBlockId: B_L2, blockCode: "LONG_BREAK_2", assignmentMode: "normal" },
      { dutyBlockId: B_A, blockCode: "AFTERNOON_BREAKS", assignmentMode: "normal" },
    ],
  };

  /** YEMEKHANE: yalnız iki öğle arası. */
  const YEMEKHANE: DutyMatrixLocation = {
    id: "loc-yemekhane",
    name: "YEMEKHANE",
    shortCode: "YEMEKHANE1",
    category: "cafeteria",
    capacity: 1,
    sortOrder: 12,
    allowsFixedAssignment: false,
    blockIds: [B_L1, B_L2],
    blockPolicies: [
      { dutyBlockId: B_L1, blockCode: "LONG_BREAK_1", assignmentMode: "normal" },
      { dutyBlockId: B_L2, blockCode: "LONG_BREAK_2", assignmentMode: "normal" },
    ],
  };

  function policyMatrix(overrides: Partial<Extract<TeacherDutyMatrixResponse, { teacherFound: true }>> = {}): TeacherDutyMatrixResponse {
    return matrix({ dutyLocations: [ILKOKUL, ALT_BAHCE, YEMEKHANE], ...overrides });
  }

  it("toggle görünür, varsayılan AÇIK ve snapshot değerini yansıtır", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(policyMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);
    const toggle = await screen.findByRole("checkbox", { name: "Yarım gün kuralı" });
    expect(toggle).toBeChecked();
    expect(screen.getByText(/Açıkken bu öğretmene aynı gün yalnız bir normal nöbet bloğu atanabilir/)).toBeInTheDocument();
  });

  it("halfDayRuleEnabled=false snapshot'ta toggle KAPALI gelir", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(policyMatrix({ halfDayRuleEnabled: false }));
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);
    expect(await screen.findByRole("checkbox", { name: "Yarım gün kuralı" })).not.toBeChecked();
  });

  it("toggle DIRTY state üretir, Geri Al ile eski değere döner", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(policyMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={onDirtyChange} />);

    const toggle = await screen.findByRole("checkbox", { name: "Yarım gün kuralı" });
    onDirtyChange.mockClear();
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(true));

    await user.click(screen.getByRole("button", { name: /Geri Al/i }));
    expect(await screen.findByRole("checkbox", { name: "Yarım gün kuralı" })).toBeChecked();
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it("toggle değişikliği KAYDET isteğinde gönderilir", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(policyMatrix());
    vi.mocked(api.saveDutyMatrix).mockResolvedValue({ savedAt: "2026-09-07T11:00:00.000Z", updatedAt: "2026-09-07T11:00:00.000Z", halfDayRuleEnabled: false });
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);

    await user.click(await screen.findByRole("checkbox", { name: "Yarım gün kuralı" }));
    await user.click(screen.getByRole("button", { name: "Kaydet" }));

    await waitFor(() => expect(api.saveDutyMatrix).toHaveBeenCalled());
    expect(vi.mocked(api.saveDutyMatrix).mock.calls[0][1]).toMatchObject({ halfDayRuleEnabled: false });
  });

  it("İLKOKUL × Öğle Arası-1 SEÇİLEBİLİR (aynı yerin Sabah/ÖS hücreleri değil)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(policyMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);
    await screen.findByText("İLKOKUL-1");

    // normal hücre ⇒ tıklanabilir
    const long1 = screen.getByRole("checkbox", { name: cellName("Pazartesi", "Uzun Nöbet 1", "İLKOKUL-1", "uygun değil") });
    expect(long1).toBeEnabled();
    await user.click(long1);
    expect(screen.getByRole("checkbox", { name: cellName("Pazartesi", "Uzun Nöbet 1", "İLKOKUL-1", "uygun") })).toBeChecked();

    // fixed_only hücreler checkbox olarak HİÇ render edilmez.
    expect(screen.queryByRole("checkbox", { name: cellName("Pazartesi", "Sabah Teneffüs Bloğu", "İLKOKUL-1", "uygun değil") })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: cellName("Pazartesi", "Öğleden Sonra Teneffüs Bloğu", "İLKOKUL-1", "uygun değil") })).not.toBeInTheDocument();
  });

  it("İLKOKUL × Öğle Arası-2 eşlemesi YOK ⇒ nöbetçi gerekmiyor (seçilemez)", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(policyMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);
    await screen.findByText("İLKOKUL-1");
    expect(screen.queryByRole("checkbox", { name: cellName("Pazartesi", "Uzun Nöbet 2", "İLKOKUL-1", "uygun değil") })).not.toBeInTheDocument();
  });

  it("ALT BAHÇE × Öğle Arası-1 KAPALI, diğer üç blok seçilebilir", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(policyMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);
    await screen.findByText("ALT BAHÇE");
    expect(screen.queryByRole("checkbox", { name: cellName("Pazartesi", "Uzun Nöbet 1", "ALT BAHÇE", "uygun değil") })).not.toBeInTheDocument();
    for (const blockName of ["Sabah Teneffüs Bloğu", "Uzun Nöbet 2", "Öğleden Sonra Teneffüs Bloğu"]) {
      expect(screen.getByRole("checkbox", { name: cellName("Pazartesi", blockName, "ALT BAHÇE", "uygun değil") })).toBeEnabled();
    }
  });

  it("YEMEKHANE yalnız iki öğle arasında seçilebilir; kısa bloklar kapalı", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(policyMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);
    await screen.findByText("YEMEKHANE");
    for (const blockName of ["Uzun Nöbet 1", "Uzun Nöbet 2"]) {
      expect(screen.getByRole("checkbox", { name: cellName("Pazartesi", blockName, "YEMEKHANE", "uygun değil") })).toBeEnabled();
    }
    for (const blockName of ["Sabah Teneffüs Bloğu", "Öğleden Sonra Teneffüs Bloğu"]) {
      expect(screen.queryByRole("checkbox", { name: cellName("Pazartesi", blockName, "YEMEKHANE", "uygun değil") })).not.toBeInTheDocument();
    }
  });

  it("yarım gün kuralı AÇIKKEN bile aynı gün BİRDEN FAZLA tercih işaretlenebilir (giriş kısıtlanmaz)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(policyMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);
    await screen.findByText("ALT BAHÇE");
    expect(screen.getByRole("checkbox", { name: "Yarım gün kuralı" })).toBeChecked();

    await user.click(screen.getByRole("checkbox", { name: cellName("Pazartesi", "Sabah Teneffüs Bloğu", "ALT BAHÇE", "uygun değil") }));
    await user.click(screen.getByRole("checkbox", { name: cellName("Pazartesi", "Uzun Nöbet 2", "ALT BAHÇE", "uygun değil") }));

    // Kural yalnız ATAMAYI sınırlar; tercih girişini DEĞİL.
    expect(screen.getByRole("checkbox", { name: cellName("Pazartesi", "Sabah Teneffüs Bloğu", "ALT BAHÇE", "uygun") })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: cellName("Pazartesi", "Uzun Nöbet 2", "ALT BAHÇE", "uygun") })).toBeChecked();
  });

  it("toplu seçim yalnız NORMAL blokları seçer; fixed_only ve eşlemesiz blokları atlar", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(policyMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);
    await screen.findByText("İLKOKUL-1");

    await user.click(screen.getByRole("button", { name: "Tüm Günleri Seç" }));

    // Normal hücreler işaretlendi: İLKOKUL Uzun1, ALT BAHÇE 3 blok, YEMEKHANE 2 blok.
    for (const [loc, blockName] of [
      ["İLKOKUL-1", "Uzun Nöbet 1"],
      ["ALT BAHÇE", "Sabah Teneffüs Bloğu"],
      ["ALT BAHÇE", "Uzun Nöbet 2"],
      ["ALT BAHÇE", "Öğleden Sonra Teneffüs Bloğu"],
      ["YEMEKHANE", "Uzun Nöbet 1"],
      ["YEMEKHANE", "Uzun Nöbet 2"],
    ] as const) {
      expect(screen.getByRole("checkbox", { name: cellName("Pazartesi", blockName, loc, "uygun") })).toBeChecked();
    }

    // fixed_only ve eşlemesiz hücreler HİÇ checkbox değildir ⇒ seçilemez.
    for (const [loc, blockName] of [
      ["İLKOKUL-1", "Sabah Teneffüs Bloğu"],
      ["İLKOKUL-1", "Öğleden Sonra Teneffüs Bloğu"],
      ["İLKOKUL-1", "Uzun Nöbet 2"],
      ["ALT BAHÇE", "Uzun Nöbet 1"],
      ["YEMEKHANE", "Sabah Teneffüs Bloğu"],
    ] as const) {
      for (const state of ["uygun", "uygun değil"] as const) {
        expect(screen.queryByRole("checkbox", { name: cellName("Pazartesi", blockName, loc, state) })).not.toBeInTheDocument();
      }
    }

    // Payload da yalnız normal hücreleri içerir: 2 gün × 6 normal hücre = 12.
    vi.mocked(api.saveDutyMatrix).mockResolvedValue({ savedAt: "2026-09-07T11:00:00.000Z", updatedAt: "2026-09-07T11:00:00.000Z", halfDayRuleEnabled: true });
    await user.click(screen.getByRole("button", { name: "Kaydet" }));
    await waitFor(() => expect(api.saveDutyMatrix).toHaveBeenCalled());
    const payload = vi.mocked(api.saveDutyMatrix).mock.calls[0][1];
    expect(payload.cells).toHaveLength(12);
    expect(payload.cells.some((c) => c.dutyLocationId === ILKOKUL.id && c.dutyBlockId !== B_L1)).toBe(false);
  });

  it("karma politikalı yerde rozet 'Bazı bloklar sabit' der; 'yalnız sabit atanır' YANLIŞ ipucu yoktur", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(policyMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);
    await screen.findByText("İLKOKUL-1");

    const badge = screen.getByText("Bazı bloklar sabit");
    expect(badge).toBeInTheDocument();
    // Rozet SABİT blokları ada göre listeler; yerin tamamını sabit ilan ETMEZ.
    expect(badge).toHaveAttribute(
      "title",
      "Bu yerin sabit blokları Sabit Nöbetler ekranından yönetilir; normal blokları uygunluk matrisinden seçilebilir. Sabit bloklar: Sabah Teneffüs Bloğu, Öğleden Sonra Teneffüs Bloğu.",
    );
    // Yerin TAMAMINI sabit ilan eden eski metinler kalmadı.
    expect(screen.queryByText(/yalnız sabit atanır/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Sabit atanabilir")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/yalnız sabit atan/i);

    // Tümü normal olan yerlerde rozet hiç çıkmaz.
    expect(screen.getAllByText("Bazı bloklar sabit")).toHaveLength(1);
  });

  it("BAŞKA öğretmenin sabit nöbeti karma yerde: fixed_only hücrelerde adı görünür, NORMAL blok yine seçilebilir", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(
      policyMatrix({
        fixedLocationAssignments: [
          {
            assignmentId: "fx-other-1",
            dayOrder: 1,
            dutyLocationId: ILKOKUL.id,
            dutyLocationName: ILKOKUL.name,
            dutyLocationShortCode: ILKOKUL.shortCode,
            teacherSourceId: "T9",
            teacherName: "Zeynep Kaya",
            dutyLocationIsActive: true,
          },
        ],
      }),
    );
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);
    await screen.findByText("İLKOKUL-1");

    // fixed_only hücrelerde BAŞKA sabit öğretmenin adı görünür.
    for (const blockName of ["Sabah Teneffüs Bloğu", "Öğleden Sonra Teneffüs Bloğu"]) {
      expect(
        screen.getByRole("img", { name: `Pazartesi, ${blockName}, İLKOKUL-1: Zeynep Kaya sabit nöbetçi` }),
      ).toBeInTheDocument();
    }
    expect(screen.getAllByText("Zeynep Kaya")).toHaveLength(2);

    // Aynı yerin NORMAL bloğu bu öğretmen için hâlâ seçilebilir: başkasının
    // sabit nöbeti YALNIZ fixed_only hücreleri kapatır.
    const long1 = screen.getByRole("checkbox", { name: cellName("Pazartesi", "Uzun Nöbet 1", "İLKOKUL-1", "uygun değil") });
    expect(long1).toBeEnabled();
    await user.click(long1);
    expect(screen.getByRole("checkbox", { name: cellName("Pazartesi", "Uzun Nöbet 1", "İLKOKUL-1", "uygun") })).toBeChecked();

    // Salı'da sabit atama yok ⇒ o günün sekmesinde 'Sabit atama bekleniyor'.
    await user.click(screen.getByRole("tab", { name: /Salı/ }));
    expect(
      await screen.findByRole("img", { name: "Salı, Sabah Teneffüs Bloğu, İLKOKUL-1: sabit atama bekleniyor" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Zeynep Kaya")).not.toBeInTheDocument();
  });

  it("sabit atama olmayan karma yerde fixed_only hücreler 'Sabit atama bekleniyor' der, 'Dinlenme' DEMEZ", async () => {
    vi.mocked(api.fetchDutyMatrix).mockResolvedValue(policyMatrix());
    render(<DutyAvailabilityMatrix teacherId={TEACHER_ID} onDirtyChange={() => {}} />);
    await screen.findByText("İLKOKUL-1");
    expect(screen.getAllByText("Sabit atama bekleniyor").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Dinlenme/)).not.toBeInTheDocument();
  });
});
