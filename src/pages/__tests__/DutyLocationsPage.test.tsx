import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DutyLocationsPage from "../DutyLocationsPage";
import * as api from "../../lib/dutyLocations/api";
import { DutyLocationApiFieldError } from "../../lib/dutyLocations/api";
import type { DutyBlock, DutyLocation, DutyLocationListResponse } from "../../lib/dutyLocations/types";

const BLK_MORNING = "aaaaaaaa-0000-0000-0000-000000000001";
const BLK_LONG1 = "aaaaaaaa-0000-0000-0000-000000000002";
const BLK_LONG2 = "aaaaaaaa-0000-0000-0000-000000000003";
const BLK_AFTERNOON = "aaaaaaaa-0000-0000-0000-000000000004";

const BLOCKS: DutyBlock[] = [
  { id: BLK_MORNING, code: "MORNING_BREAKS", name: "Sabah Teneffüs Bloğu", blockOrder: 1, conflictPeriodName: null },
  { id: BLK_LONG1, code: "LONG_BREAK_1", name: "Uzun Nöbet 1", blockOrder: 2, conflictPeriodName: "5-OO" },
  { id: BLK_LONG2, code: "LONG_BREAK_2", name: "Uzun Nöbet 2", blockOrder: 3, conflictPeriodName: "5-IO" },
  { id: BLK_AFTERNOON, code: "AFTERNOON_BREAKS", name: "Öğleden Sonra Teneffüs Bloğu", blockOrder: 4, conflictPeriodName: null },
];

function loc(overrides: Partial<DutyLocation> = {}): DutyLocation {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    name: "Ön Bahçe",
    shortCode: "ON-BAH",
    category: "garden",
    capacity: 2,
    description: null,
    isActive: true,
    sortOrder: 1,
    allowsFixedAssignment: false,
    blockIds: [BLK_MORNING, BLK_LONG1, BLK_LONG2, BLK_AFTERNOON],
    blockPolicies: [BLK_MORNING, BLK_LONG1, BLK_LONG2, BLK_AFTERNOON].map((dutyBlockId) => ({ dutyBlockId, assignmentMode: "normal" })),
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function listResponse(items: DutyLocation[], overrides: Partial<DutyLocationListResponse> = {}): DutyLocationListResponse {
  return {
    items,
    blocks: BLOCKS,
    summary: { total: items.length, active: items.filter((i) => i.isActive).length, inactive: items.filter((i) => !i.isActive).length },
    pagination: { page: 1, pageSize: 10, totalItems: items.length, totalPages: 1 },
    ...overrides,
  };
}

describe("DutyLocationsPage", () => {
  beforeEach(() => {
    vi.spyOn(api, "fetchDutyLocations");
    vi.spyOn(api, "createDutyLocation");
    vi.spyOn(api, "updateDutyLocation");
    vi.spyOn(api, "deleteDutyLocation");
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("29) yükleniyor durumunda aria-busy skeleton gösterir", () => {
    vi.mocked(api.fetchDutyLocations).mockReturnValue(new Promise(() => {}));
    render(<DutyLocationsPage />);
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it("30) tablo tamamen boşsa 'Henüz nöbet yeri tanımlanmadı.' gösterir", async () => {
    vi.mocked(api.fetchDutyLocations).mockResolvedValue(listResponse([]));
    render(<DutyLocationsPage />);

    expect(await screen.findByText("Henüz nöbet yeri tanımlanmadı.")).toBeInTheDocument();
    expect(screen.getByText("İlk nöbet yerini soldaki formdan ekleyin.")).toBeInTheDocument();
  });

  it("31) API hatasında hata kartı ve tekrar dene butonu gösterir; tekrar dene başarılı olursa liste gelir", async () => {
    vi.mocked(api.fetchDutyLocations).mockRejectedValueOnce(new Error("network"));
    const user = userEvent.setup();
    render(<DutyLocationsPage />);

    expect(await screen.findByText("Nöbet yerleri alınamadı.")).toBeInTheDocument();
    expect(screen.getByText("Yerel API bağlantısını kontrol edip tekrar deneyin.")).toBeInTheDocument();

    vi.mocked(api.fetchDutyLocations).mockResolvedValueOnce(listResponse([loc()]));
    await user.click(screen.getByRole("button", { name: "Tekrar Dene" }));

    expect(await screen.findByText("Ön Bahçe")).toBeInTheDocument();
  });

  it("49) özet kutuları gerçek değerleri gösterir", async () => {
    vi.mocked(api.fetchDutyLocations).mockResolvedValue(
      listResponse([loc(), loc({ id: "3", isActive: false, name: "Yemekhane" })], {
        summary: { total: 8, active: 7, inactive: 1 },
      }),
    );
    render(<DutyLocationsPage />);

    await screen.findByText("Ön Bahçe");
    expect(screen.getByText("8")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("32) form validasyonu: geçersiz kısa kod göndermeye çalışınca alan hatası gösterir, API çağrılmaz", async () => {
    vi.mocked(api.fetchDutyLocations).mockResolvedValue(listResponse([]));
    const user = userEvent.setup();
    render(<DutyLocationsPage />);
    await screen.findByText("Henüz nöbet yeri tanımlanmadı.");

    await user.type(screen.getByLabelText("Nöbet Yeri Adı"), "Ön Bahçe");
    await user.type(screen.getByLabelText("Kısa Kod"), "-BAD-");
    await user.click(screen.getByRole("button", { name: /Nöbet Yeri Ekle/ }));

    expect(
      await screen.findByText("Kısa kod yalnız büyük harf, rakam ve tek tirelerden oluşabilir (ör. ON-BAH)."),
    ).toBeInTheDocument();
    expect(api.createDutyLocation).not.toHaveBeenCalled();
  });

  it("33) başarılı oluşturma: başarı mesajı gösterir, formu temizler, listeyi yeniler", async () => {
    vi.mocked(api.fetchDutyLocations).mockResolvedValue(listResponse([]));
    vi.mocked(api.createDutyLocation).mockResolvedValue(loc());
    const user = userEvent.setup();
    render(<DutyLocationsPage />);
    await screen.findByText("Henüz nöbet yeri tanımlanmadı.");

    const nameInput = screen.getByLabelText("Nöbet Yeri Adı") as HTMLInputElement;
    await user.type(nameInput, "Ön Bahçe");
    await user.type(screen.getByLabelText("Kısa Kod"), "ON-BAH");

    vi.mocked(api.fetchDutyLocations).mockResolvedValue(listResponse([loc()]));
    await user.click(screen.getByRole("button", { name: /Nöbet Yeri Ekle/ }));

    expect(await screen.findByText("Nöbet yeri başarıyla eklendi.")).toBeInTheDocument();
    expect(nameInput.value).toBe("");
    expect(await screen.findByText("Ön Bahçe")).toBeInTheDocument();
  });

  it("34) duplicate alan hatası: sunucudan gelen DUPLICATE_SHORT_CODE ilgili input altında gösterilir", async () => {
    vi.mocked(api.fetchDutyLocations).mockResolvedValue(listResponse([]));
    vi.mocked(api.createDutyLocation).mockRejectedValue(
      new DutyLocationApiFieldError({ code: "DUPLICATE_SHORT_CODE", message: "Bu kısa kod başka bir nöbet yerinde kullanılıyor.", field: "shortCode" }),
    );
    const user = userEvent.setup();
    render(<DutyLocationsPage />);
    await screen.findByText("Henüz nöbet yeri tanımlanmadı.");

    await user.type(screen.getByLabelText("Nöbet Yeri Adı"), "Ön Bahçe");
    await user.type(screen.getByLabelText("Kısa Kod"), "ON-BAH");
    await user.click(screen.getByRole("button", { name: /Nöbet Yeri Ekle/ }));

    expect(await screen.findByText("Bu kısa kod başka bir nöbet yerinde kullanılıyor.")).toBeInTheDocument();
  });

  it("35) gönderim sırasında buton disabled olur (çift gönderim engeli)", async () => {
    let resolveCreate!: (v: DutyLocation) => void;
    vi.mocked(api.fetchDutyLocations).mockResolvedValue(listResponse([]));
    vi.mocked(api.createDutyLocation).mockReturnValue(new Promise((resolve) => (resolveCreate = resolve)));
    const user = userEvent.setup();
    render(<DutyLocationsPage />);
    await screen.findByText("Henüz nöbet yeri tanımlanmadı.");

    await user.type(screen.getByLabelText("Nöbet Yeri Adı"), "Ön Bahçe");
    await user.type(screen.getByLabelText("Kısa Kod"), "ON-BAH");
    const submitBtn = screen.getByRole("button", { name: /Nöbet Yeri Ekle/ });
    await user.click(submitBtn);

    expect(screen.getByRole("button", { name: /Ekleniyor/ })).toBeDisabled();
    resolveCreate(loc());
  });

  it("üçlü paket politikasını yeni nöbet yeriyle birlikte gönderir", async () => {
    vi.mocked(api.fetchDutyLocations).mockResolvedValue(listResponse([]));
    vi.mocked(api.createDutyLocation).mockResolvedValue(loc());
    const user = userEvent.setup();
    render(<DutyLocationsPage />);
    await screen.findByText("Henüz nöbet yeri tanımlanmadı.");

    await user.type(screen.getByLabelText("Nöbet Yeri Adı"), "Yeni Alan");
    await user.type(screen.getByLabelText("Kısa Kod"), "YENI-ALAN");
    await user.selectOptions(screen.getByLabelText("Teneffüs blok politikası"), "fixed_only");
    await user.selectOptions(screen.getByLabelText("Öğle Arası-1 blok politikası"), "off");
    await user.selectOptions(screen.getByLabelText("Öğle Arası-2 blok politikası"), "normal");
    await user.click(screen.getByRole("button", { name: /Nöbet Yeri Ekle/ }));

    await waitFor(() => expect(api.createDutyLocation).toHaveBeenCalled());
    const input = vi.mocked(api.createDutyLocation).mock.calls[0][0];
    expect(input.blockPolicies).toEqual([
      { dutyBlockId: BLK_MORNING, assignmentMode: "fixed_only" },
      { dutyBlockId: BLK_LONG1, assignmentMode: "off" },
      { dutyBlockId: BLK_LONG2, assignmentMode: "normal" },
      { dutyBlockId: BLK_AFTERNOON, assignmentMode: "fixed_only" },
    ]);
  });

  it("düzenlemede Teneffüs çiftini atomik tutar ve optimistic timestamp gönderir", async () => {
    vi.mocked(api.fetchDutyLocations).mockResolvedValue(listResponse([loc()]));
    vi.mocked(api.updateDutyLocation).mockResolvedValue(loc());
    const user = userEvent.setup();
    render(<DutyLocationsPage />);
    await screen.findByText("Ön Bahçe");
    await user.click(screen.getByRole("button", { name: "Ön Bahçe düzenle" }));
    const dialog = await screen.findByRole("dialog");

    await user.selectOptions(within(dialog).getByLabelText("Teneffüs blok politikası"), "off");
    await user.click(within(dialog).getByRole("button", { name: "Değişiklikleri Kaydet" }));

    await waitFor(() => expect(api.updateDutyLocation).toHaveBeenCalled());
    expect(api.updateDutyLocation).toHaveBeenCalledWith(
      "22222222-2222-2222-2222-222222222222",
      expect.objectContaining({
        expectedUpdatedAt: "2026-09-01T10:00:00.000Z",
        blockPolicies: expect.arrayContaining([
          { dutyBlockId: BLK_MORNING, assignmentMode: "off" },
          { dutyBlockId: BLK_AFTERNOON, assignmentMode: "off" },
        ]),
      }),
    );
  });

  it("36) arama debounce edilir: hızlı yazımda tek bir istek gönderilir", async () => {
    vi.mocked(api.fetchDutyLocations).mockResolvedValue(listResponse([loc()]));
    const user = userEvent.setup();
    render(<DutyLocationsPage />);
    await screen.findByText("Ön Bahçe");

    const initialCalls = vi.mocked(api.fetchDutyLocations).mock.calls.length;
    await user.type(screen.getByLabelText("Nöbet yeri ara"), "bah");

    await waitFor(() => {
      const lastCall = vi.mocked(api.fetchDutyLocations).mock.calls.at(-1)?.[0];
      expect(lastCall?.search).toBe("bah");
    });

    const callsAfterSearch = vi.mocked(api.fetchDutyLocations).mock.calls.length;
    // "bah" tuşlanırken en fazla 1 yeni istek (debounce sonu) beklenir — 3 değil.
    expect(callsAfterSearch - initialCalls).toBeLessThanOrEqual(1);
  });

  it("37) kategori filtresi seçilince doğru parametreyle istek atar ve sayfayı 1'e döner", async () => {
    vi.mocked(api.fetchDutyLocations).mockResolvedValue(listResponse([loc()]));
    const user = userEvent.setup();
    render(<DutyLocationsPage />);
    await screen.findByText("Ön Bahçe");

    await user.selectOptions(screen.getByLabelText("Kategori filtresi"), "cafeteria");

    await waitFor(() => {
      const lastCall = vi.mocked(api.fetchDutyLocations).mock.calls.at(-1)?.[0];
      expect(lastCall).toMatchObject({ category: "cafeteria", page: 1 });
    });
  });

  it("40) sayfalama: sonraki sayfaya geçince doğru page parametresiyle istek atar", async () => {
    vi.mocked(api.fetchDutyLocations).mockResolvedValue(
      listResponse([loc()], { pagination: { page: 1, pageSize: 10, totalItems: 25, totalPages: 3 } }),
    );
    const user = userEvent.setup();
    render(<DutyLocationsPage />);
    await screen.findByText("Sayfa 1 / 3");

    await user.click(screen.getByRole("button", { name: "Sonraki" }));

    await waitFor(() => {
      const lastCall = vi.mocked(api.fetchDutyLocations).mock.calls.at(-1)?.[0];
      expect(lastCall?.page).toBe(2);
    });
  });

  it("41/42/50) düzenleme drawer'ı açılır, Escape ile kapanır, başarılı güncelleme listeyi yeniler", async () => {
    vi.mocked(api.fetchDutyLocations).mockResolvedValue(listResponse([loc()]));
    const user = userEvent.setup();
    render(<DutyLocationsPage />);
    await screen.findByText("Ön Bahçe");

    await user.click(screen.getByRole("button", { name: "Ön Bahçe düzenle" }));
    expect(await screen.findByText("Nöbet Yerini Düzenle")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Nöbet Yerini Düzenle")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Ön Bahçe düzenle" }));
    const dialog = await screen.findByRole("dialog");
    const capacityInput = within(dialog).getByLabelText("Kapasite");
    await user.clear(capacityInput);
    await user.type(capacityInput, "5");

    vi.mocked(api.updateDutyLocation).mockResolvedValue(loc({ capacity: 5 }));
    vi.mocked(api.fetchDutyLocations).mockResolvedValue(listResponse([loc({ capacity: 5 })]));
    await user.click(within(dialog).getByRole("button", { name: "Değişiklikleri Kaydet" }));

    await waitFor(() => expect(screen.queryByText("Nöbet Yerini Düzenle")).not.toBeInTheDocument());
    expect(api.updateDutyLocation).toHaveBeenCalledWith("22222222-2222-2222-2222-222222222222", expect.objectContaining({ capacity: 5 }));
  });

  it("değişiklik yoksa Kaydet devre dışı kalır", async () => {
    vi.mocked(api.fetchDutyLocations).mockResolvedValue(listResponse([loc()]));
    const user = userEvent.setup();
    render(<DutyLocationsPage />);
    await screen.findByText("Ön Bahçe");

    await user.click(screen.getByRole("button", { name: "Ön Bahçe düzenle" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Değişiklikleri Kaydet" })).toBeDisabled();
  });

  it("43) aktif/pasif değiştirme başarılı olunca listeyi yeniler", async () => {
    vi.mocked(api.fetchDutyLocations).mockResolvedValue(listResponse([loc()]));
    vi.mocked(api.updateDutyLocation).mockResolvedValue(loc({ isActive: false }));
    const user = userEvent.setup();
    render(<DutyLocationsPage />);
    await screen.findByText("Ön Bahçe");

    vi.mocked(api.fetchDutyLocations).mockResolvedValue(listResponse([loc({ isActive: false })]));
    await user.click(screen.getByRole("button", { name: "Ön Bahçe pasif yap" }));

    await waitFor(() => expect(api.updateDutyLocation).toHaveBeenCalledWith("22222222-2222-2222-2222-222222222222", { isActive: false }));
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Pasif")).toBeInTheDocument();
  });

  it("44) aktif/pasif hata verirse hata mesajı gösterir", async () => {
    vi.mocked(api.fetchDutyLocations).mockResolvedValue(listResponse([loc()]));
    vi.mocked(api.updateDutyLocation).mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<DutyLocationsPage />);
    await screen.findByText("Ön Bahçe");

    await user.click(screen.getByRole("button", { name: "Ön Bahçe pasif yap" }));

    expect(await screen.findByText("Ön Bahçe için durum güncellenemedi.")).toBeInTheDocument();
  });

  it("45/46) silme onayı gösterir, onaylanınca silinir ve liste yenilenir", async () => {
    vi.mocked(api.fetchDutyLocations).mockResolvedValue(listResponse([loc()]));
    const user = userEvent.setup();
    render(<DutyLocationsPage />);
    await screen.findByText("Ön Bahçe");

    await user.click(screen.getByRole("button", { name: "Ön Bahçe sil" }));
    expect(await screen.findByText("Nöbet yeri silinsin mi?")).toBeInTheDocument();

    vi.mocked(api.deleteDutyLocation).mockResolvedValue();
    vi.mocked(api.fetchDutyLocations).mockResolvedValue(listResponse([]));
    await user.click(screen.getByRole("button", { name: "Nöbet Yerini Sil" }));

    await waitFor(() => expect(screen.queryByText("Nöbet yeri silinsin mi?")).not.toBeInTheDocument());
    expect(await screen.findByText("Henüz nöbet yeri tanımlanmadı.")).toBeInTheDocument();
  });

  it("47/48) arama sonucu boşsa uygun mesaj gösterir, filtreleri temizle listeyi geri getirir", async () => {
    vi.mocked(api.fetchDutyLocations).mockResolvedValue(listResponse([loc()], { summary: { total: 3, active: 3, inactive: 0 } }));
    const user = userEvent.setup();
    render(<DutyLocationsPage />);
    await screen.findByText("Ön Bahçe");

    vi.mocked(api.fetchDutyLocations).mockResolvedValue(listResponse([], { summary: { total: 3, active: 3, inactive: 0 } }));
    await user.type(screen.getByLabelText("Nöbet yeri ara"), "xyz");

    expect(await screen.findByText("Aramanızla eşleşen nöbet yeri bulunamadı.")).toBeInTheDocument();

    vi.mocked(api.fetchDutyLocations).mockResolvedValue(listResponse([loc()], { summary: { total: 3, active: 3, inactive: 0 } }));
    await user.click(screen.getByRole("button", { name: "Filtreleri Temizle" }));

    expect(await screen.findByText("Ön Bahçe")).toBeInTheDocument();
  });

  it("38/39) eski (geride kalan) sayfa isteği geç çözülürse güncel sayfayı ezmez, hata da göstermez", async () => {
    vi.mocked(api.fetchDutyLocations).mockResolvedValueOnce(
      listResponse([loc()], { pagination: { page: 1, pageSize: 10, totalItems: 30, totalPages: 3 } }),
    );
    const user = userEvent.setup();
    render(<DutyLocationsPage />);
    await screen.findByText("Sayfa 1 / 3");

    let resolveStalePage2!: (v: DutyLocationListResponse) => void;
    vi.mocked(api.fetchDutyLocations)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveStalePage2 = resolve)))
      .mockResolvedValueOnce(
        listResponse([loc({ name: "Bahçe 3" })], { pagination: { page: 3, pageSize: 10, totalItems: 30, totalPages: 3 } }),
      );

    await user.click(screen.getByRole("button", { name: "Sonraki" })); // page 2 isteği (geciken)
    await user.click(screen.getByRole("button", { name: "Sonraki" })); // page 3 isteği (güncel)
    await screen.findByText("Bahçe 3");

    // Geciken page 2 cevabı şimdi gelirse güncel (page 3) görünümü EZMEMELİ.
    resolveStalePage2(listResponse([loc({ name: "Bahçe 2 (bayat)" })], { pagination: { page: 2, pageSize: 10, totalItems: 30, totalPages: 3 } }));
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByText("Bahçe 3")).toBeInTheDocument();
    expect(screen.queryByText("Bahçe 2 (bayat)")).not.toBeInTheDocument();
    expect(screen.queryByText("Nöbet yerleri alınamadı.")).not.toBeInTheDocument();
  });
});
