import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CurrentImportStatus from "../CurrentImportStatus";
import * as fetchModule from "../../lib/currentImport/fetchCurrentImport";
import type { CurrentImportSnapshot } from "../../lib/currentImport/types";

const SUCCESS_SNAPSHOT: CurrentImportSnapshot = {
  hasImport: true,
  import: {
    sourceFilename: "asc.xml",
    status: "imported",
    campusName: "Kaplan Okulları · Üçevler Kampüsü",
    academicYearName: "2026-2027",
    importedAt: "2026-08-31T20:15:00Z",
    teacherCount: 55,
    classCount: 26,
    dayCount: 5,
    periodCount: 10,
    sourceCardCount: 1140,
    normalizedAssignmentCount: 1341,
    hasCountMismatch: false,
  },
};
const EMPTY_SNAPSHOT: CurrentImportSnapshot = { hasImport: false, import: null };

describe("CurrentImportStatus", () => {
  beforeEach(() => {
    vi.spyOn(fetchModule, "fetchCurrentImport");
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("13) yükleniyor durumunda skeleton (aria-busy) gösterir", () => {
    let resolvePromise: (v: CurrentImportSnapshot) => void = () => {};
    vi.mocked(fetchModule.fetchCurrentImport).mockReturnValue(
      new Promise((resolve) => {
        resolvePromise = resolve;
      }),
    );

    const { container } = render(<CurrentImportStatus refreshKey={0} />);
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();

    resolvePromise(EMPTY_SNAPSHOT);
  });

  it("14) import yokken nötr 'Henüz bir XML dosyası yüklenmedi' kartı gösterir", async () => {
    vi.mocked(fetchModule.fetchCurrentImport).mockResolvedValue(EMPTY_SNAPSHOT);
    render(<CurrentImportStatus refreshKey={0} />);

    expect(await screen.findByText("Henüz bir XML dosyası yüklenmedi")).toBeInTheDocument();
    expect(
      screen.getByText("Ders programını kullanmaya başlamak için aşağıdaki alandan bir XML dosyası seçin."),
    ).toBeInTheDocument();
  });

  it("15) kayıtlı import varken gerçek sayıları ve dosya/yıl bilgisini gösterir", async () => {
    vi.mocked(fetchModule.fetchCurrentImport).mockResolvedValue(SUCCESS_SNAPSHOT);
    render(<CurrentImportStatus refreshKey={0} />);

    expect(await screen.findByText("Mevcut ders programı")).toBeInTheDocument();
    expect(screen.getByText("Yüklendi")).toBeInTheDocument();
    expect(screen.getByText("asc.xml")).toBeInTheDocument();
    expect(screen.getByText("2026-2027")).toBeInTheDocument();
    expect(screen.getByText("55")).toBeInTheDocument();
    expect(screen.getByText("26")).toBeInTheDocument();
    expect(screen.getByText("1140")).toBeInTheDocument();
    expect(screen.getByText("1341")).toBeInTheDocument();
  });

  it("16) tarihi tr-TR/Europe-Istanbul <time> elemanıyla gösterir", async () => {
    vi.mocked(fetchModule.fetchCurrentImport).mockResolvedValue(SUCCESS_SNAPSHOT);
    render(<CurrentImportStatus refreshKey={0} />);

    const timeEl = await screen.findByText("31 Ağustos 2026, 23:15");
    expect(timeEl.tagName).toBe("TIME");
    expect(timeEl).toHaveAttribute("datetime", "2026-08-31T20:15:00Z");
  });

  it("17) API hatasında 'Henüz XML yok' YERİNE hata kartı gösterir", async () => {
    vi.mocked(fetchModule.fetchCurrentImport).mockRejectedValue(new Error("network down"));
    render(<CurrentImportStatus refreshKey={0} />);

    expect(await screen.findByText("Mevcut ders programı bilgisi alınamadı.")).toBeInTheDocument();
    expect(screen.getByText("Yerel API bağlantısını kontrol edip tekrar deneyin.")).toBeInTheDocument();
    expect(screen.queryByText("Henüz bir XML dosyası yüklenmedi")).not.toBeInTheDocument();
  });

  it("18) 'Tekrar Dene' tıklanınca yeniden sorgular ve başarıyla iyileşir", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchModule.fetchCurrentImport).mockRejectedValueOnce(new Error("network down"));
    render(<CurrentImportStatus refreshKey={0} />);

    const retryButton = await screen.findByRole("button", { name: /tekrar dene/i });
    vi.mocked(fetchModule.fetchCurrentImport).mockResolvedValueOnce(SUCCESS_SNAPSHOT);
    await user.click(retryButton);

    expect(await screen.findByText("Mevcut ders programı")).toBeInTheDocument();
    expect(fetchModule.fetchCurrentImport).toHaveBeenCalledTimes(2);
  });

  it("19) refreshKey değiştiğinde yeniden sorgular ve kart günceller (yeni import sonrası)", async () => {
    vi.mocked(fetchModule.fetchCurrentImport).mockResolvedValueOnce(EMPTY_SNAPSHOT);
    const { rerender } = render(<CurrentImportStatus refreshKey={0} />);
    expect(await screen.findByText("Henüz bir XML dosyası yüklenmedi")).toBeInTheDocument();

    vi.mocked(fetchModule.fetchCurrentImport).mockResolvedValueOnce(SUCCESS_SNAPSHOT);
    rerender(<CurrentImportStatus refreshKey={1} />);

    await waitFor(() => expect(fetchModule.fetchCurrentImport).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Mevcut ders programı")).toBeInTheDocument();
    expect(screen.getByText("1341")).toBeInTheDocument();
  });

  it("20) refreshKey aynı kaldığı sürece (ör. import başarısız olduğunda) yeniden sorgulamaz — eski veri korunur", async () => {
    vi.mocked(fetchModule.fetchCurrentImport).mockResolvedValue(SUCCESS_SNAPSHOT);
    const { rerender } = render(<CurrentImportStatus refreshKey={0} />);
    expect(await screen.findByText("Mevcut ders programı")).toBeInTheDocument();
    expect(fetchModule.fetchCurrentImport).toHaveBeenCalledTimes(1);

    // DataXmlPage, import başarısız olduğunda refreshKey'i ARTIRMAZ (bkz.
    // handleImport — setCurrentImportRefreshKey yalnız başarı/duplicate
    // dalında çağrılır). Aynı refreshKey ile yeniden render, bu davranışı
    // component sınırında doğrular: yeniden sorgu YOK, gösterilen veri aynı kalır.
    rerender(<CurrentImportStatus refreshKey={0} />);

    expect(fetchModule.fetchCurrentImport).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Mevcut ders programı")).toBeInTheDocument();
    expect(screen.getByText("1341")).toBeInTheDocument();
  });

  it("21) ikinci istek birinciden ÖNCE tamamlanırsa, birinci geç dönse bile ekranda ikinci isteğin sonucu kalır (stale-response koruması)", async () => {
    let resolveFirst: (v: CurrentImportSnapshot) => void = () => {};
    const firstPromise = new Promise<CurrentImportSnapshot>((resolve) => {
      resolveFirst = resolve;
    });
    vi.mocked(fetchModule.fetchCurrentImport).mockReturnValueOnce(firstPromise);

    const { rerender } = render(<CurrentImportStatus refreshKey={0} />);

    // refreshKey değişir → yeni bir istek (ikinci) başlar, birincinin effect
    // cleanup'ı (ignore=true + abort) tetiklenir.
    vi.mocked(fetchModule.fetchCurrentImport).mockResolvedValueOnce(EMPTY_SNAPSHOT);
    rerender(<CurrentImportStatus refreshKey={1} />);

    expect(await screen.findByText("Henüz bir XML dosyası yüklenmedi")).toBeInTheDocument();

    // Birinci (eski) istek şimdi ANCAK çözülüyor — ekranı EZMEMELİ.
    resolveFirst(SUCCESS_SNAPSHOT);
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByText("Henüz bir XML dosyası yüklenmedi")).toBeInTheDocument();
    expect(screen.queryByText("Mevcut ders programı")).not.toBeInTheDocument();
  });

  it("22) unmount sonrası geç dönen cevap state güncellemesi/hata oluşturmaz", async () => {
    let resolveFirst: (v: CurrentImportSnapshot) => void = () => {};
    vi.mocked(fetchModule.fetchCurrentImport).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = render(<CurrentImportStatus refreshKey={0} />);
    unmount();

    // Unmount sonrası promise çözülür — React'in "unmounted component'te
    // state güncelleme" uyarısı dahil hiçbir konsol hatası oluşmamalı.
    resolveFirst(SUCCESS_SNAPSHOT);
    await new Promise((r) => setTimeout(r, 0));

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("23) iptal edilen (AbortError) istek hata kartı oluşturmaz", async () => {
    let rejectFirst: (err: unknown) => void = () => {};
    vi.mocked(fetchModule.fetchCurrentImport).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }),
    );

    const { rerender } = render(<CurrentImportStatus refreshKey={0} />);

    vi.mocked(fetchModule.fetchCurrentImport).mockResolvedValueOnce(SUCCESS_SNAPSHOT);
    rerender(<CurrentImportStatus refreshKey={1} />);
    expect(await screen.findByText("Mevcut ders programı")).toBeInTheDocument();

    // Gerçek fetch, abort() çağrıldığında AbortError ile reddeder — bunu simüle ediyoruz.
    rejectFirst(new DOMException("The operation was aborted.", "AbortError"));
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByText("Mevcut ders programı bilgisi alınamadı.")).not.toBeInTheDocument();
    expect(screen.getByText("Mevcut ders programı")).toBeInTheDocument();
  });
});
