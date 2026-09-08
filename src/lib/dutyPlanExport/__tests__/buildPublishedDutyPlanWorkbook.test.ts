import { describe, expect, it } from "vitest";
import { Workbook, ValueType, type Worksheet } from "exceljs";
import { DUTY_PLAN_SHEET_NAMES, buildPublishedDutyPlanWorkbook, resolveLoadStatus } from "../buildPublishedDutyPlanWorkbook";
import {
  BLK_AFTERNOON,
  BLK_LONG1,
  BLK_LONG2,
  BLK_MORNING,
  LOC_KORIDOR,
  SNAPSHOT_LOCATION_BAHCE,
  SNAPSHOT_LOCATION_KORIDOR,
  assignment,
  dutyPackage,
  fullPublishedPlan,
  publishedPlan,
} from "./fixtures";

/** Üretilen buffer'ı ExcelJS ile TEKRAR okur — "fonksiyon çağrıldı mı" değil, gerçek dosya içeriği doğrulanır. */
async function roundTrip(plan: Parameters<typeof buildPublishedDutyPlanWorkbook>[0]): Promise<Workbook> {
  const workbook = await buildPublishedDutyPlanWorkbook(plan);
  const buffer = await workbook.xlsx.writeBuffer();
  const reloaded = new Workbook();
  await reloaded.xlsx.load(buffer as ArrayBuffer);
  return reloaded;
}

function sheetOf(workbook: Workbook, name: string): Worksheet {
  const sheet = workbook.getWorksheet(name);
  if (!sheet) throw new Error(`Sheet bulunamadı: ${name}`);
  return sheet;
}

function textAt(sheet: Worksheet, row: number, column: number): string {
  const value = sheet.getCell(row, column).value;
  return value === null || value === undefined ? "" : String(value);
}

function rowTexts(sheet: Worksheet, row: number, columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, i) => textAt(sheet, row, i + 1));
}

/** Bir sheet'teki tüm satırları düz metin dizisi olarak döndürür. */
function allRows(sheet: Worksheet, columnCount: number): string[][] {
  const rows: string[][] = [];
  for (let r = 1; r <= sheet.rowCount; r += 1) rows.push(rowTexts(sheet, r, columnCount));
  return rows;
}

function fillArgb(sheet: Worksheet, row: number, column: number): string | undefined {
  const fill = sheet.getCell(row, column).fill;
  if (!fill || fill.type !== "pattern" || fill.pattern !== "solid") return undefined;
  return fill.fgColor?.argb;
}

describe("buildPublishedDutyPlanWorkbook — sheet yapısı", () => {
  it("1) tam plan üç beklenen sheet'i üretir", async () => {
    const workbook = await roundTrip(fullPublishedPlan());
    expect(workbook.worksheets.map((s) => s.name)).toEqual([DUTY_PLAN_SHEET_NAMES.weekly, DUTY_PLAN_SHEET_NAMES.teacherDuties, DUTY_PLAN_SHEET_NAMES.loadSummary]);
    // Excel'in 31 karakter sınırı.
    for (const sheet of workbook.worksheets) expect(sheet.name.length).toBeLessThanOrEqual(31);
  });

  it("üst bilgi yalnız DTO'da bulunan alanları yazar (kampüs/eğitim yılı uydurulmaz)", async () => {
    const workbook = await roundTrip(fullPublishedPlan());
    const sheet = sheetOf(workbook, DUTY_PLAN_SHEET_NAMES.weekly);
    expect(textAt(sheet, 1, 1)).toBe("Haftalık Nöbet Planı");
    expect(textAt(sheet, 2, 1)).toContain("Yayımlanma:");
    expect(textAt(sheet, 2, 1)).toContain("Plan sürümü: 3");
    expect(textAt(sheet, 2, 1)).toContain("Algoritma: duty-plan-solver-v1");
    const flat = allRows(sheet, 16).flat().join("\n");
    expect(flat).not.toMatch(/Kampüs|Eğitim Yılı/i);
    // Başlık satırı merge edilmiştir.
    expect(sheet.getCell(1, 2).isMerged).toBe(true);
  });

  it("2) beş gün tek tabloda Pazartesi → Cuma sırasındadır", async () => {
    const plan = fullPublishedPlan();
    // Kaynak dizisi ters olsa bile sabit iş haftası düzeni değişmez.
    plan.assignments = plan.assignments.slice().reverse();
    const workbook = await roundTrip(plan);
    const sheet = sheetOf(workbook, DUTY_PLAN_SHEET_NAMES.weekly);
    expect([2, 5, 8, 11, 14].map((column) => textAt(sheet, 4, column))).toEqual([
      "PAZARTESİ", "SALI", "ÇARŞAMBA", "PERŞEMBE", "CUMA",
    ]);
    for (const column of [2, 5, 8, 11, 14]) {
      expect(sheet.getCell(4, column + 1).isMerged).toBe(true);
      expect(sheet.getCell(4, column + 2).isMerged).toBe(true);
    }
  });

  it("3) her gün tam üç paket sütunu içerir", async () => {
    const workbook = await roundTrip(fullPublishedPlan());
    const sheet = sheetOf(workbook, DUTY_PLAN_SHEET_NAMES.weekly);
    expect(textAt(sheet, 4, 1)).toBe("NÖBET YERİ");
    for (const column of [2, 5, 8, 11, 14]) {
      expect(rowTexts(sheet, 5, 16).slice(column - 1, column + 2)).toEqual([
        "Sabah + Öğleden Sonra", "ÖĞLE ARASI-1", "ÖĞLE ARASI-2",
      ]);
    }
  });

  it("4) bilinmeyen tarihsel blok kaybolmaz, ana tablonun altında ayrıca listelenir", async () => {
    const plan = fullPublishedPlan();
    plan.assignments = [
      assignment({ id: "a-unknown", dutyBlockId: "blk-gece", dutyBlockName: "Gece Nöbeti Bloğu", teacherName: "Zehra Ak", teacherSourceId: "T9", packageId: null }),
      ...plan.assignments,
    ];
    const workbook = await roundTrip(plan);
    const sheet = sheetOf(workbook, DUTY_PLAN_SHEET_NAMES.weekly);
    const flat = allRows(sheet, 16).flat();
    expect(flat).toContain("Tanımsız tarihsel bloklar");
    expect(flat).toContain("Gece Nöbeti Bloğu");
    expect(flat).toContain("Zehra Ak");
  });

  it("5) tarihsel snapshot öğretmen ve nöbet yeri isimleri hücrelerde korunur", async () => {
    const workbook = await roundTrip(fullPublishedPlan());
    const flat = allRows(sheetOf(workbook, DUTY_PLAN_SHEET_NAMES.weekly), 16).flat().join("\n");
    expect(flat).toContain(SNAPSHOT_LOCATION_BAHCE);
    expect(flat).toContain(SNAPSHOT_LOCATION_KORIDOR);
    expect(flat).toContain("Ayşe Yılmaz");
    expect(flat).toContain("Deniz Kaya");
  });

  it("6) sabit, otomatik, manuel ve açık görevler farklı metin ve dolgu renkleriyle ayrışır", async () => {
    const plan = publishedPlan({
      assignments: [
        assignment({ id: "g", dutyBlockId: BLK_MORNING, dutyBlockName: "Sabah Teneffüs Bloğu", assignmentKind: "generated", teacherName: "Ayşe Yılmaz" }),
        assignment({ id: "ga", dutyBlockId: BLK_AFTERNOON, dutyBlockName: "Öğleden Sonra Teneffüs Bloğu", assignmentKind: "generated", teacherName: "Ayşe Yılmaz" }),
        assignment({ id: "f", dutyBlockId: BLK_LONG1, dutyBlockName: "Uzun Nöbet 1", assignmentKind: "fixed", teacherName: "Deniz Kaya", teacherSourceId: "T5" }),
        assignment({ id: "m", dutyBlockId: BLK_LONG2, dutyBlockName: "Uzun Nöbet 2", assignmentKind: "manual", teacherName: "Can Demir", teacherSourceId: "T2" }),
        // Yayımlanmış plan normalde AÇIK görev içermez; bozuk/eski response yine de gizlenmemeli.
        assignment({ id: "u", dayOrder: 2, dutyBlockId: BLK_LONG1, dutyBlockName: "Uzun Nöbet 1", assignmentKind: "unassigned", teacherName: null, teacherSourceId: null }),
      ],
    });
    const workbook = await roundTrip(plan);
    const sheet = sheetOf(workbook, DUTY_PLAN_SHEET_NAMES.weekly);
    const dataRow = 6;

    expect(rowTexts(sheet, dataRow, 7)).toEqual([
      SNAPSHOT_LOCATION_BAHCE,
      "Ayşe Yılmaz",
      "Deniz Kaya\nSabit",
      "Can Demir\nManuel",
      "—",
      "AÇIK",
      "—",
    ]);

    const fills = [2, 3, 4, 6].map((col) => fillArgb(sheet, dataRow, col));
    expect(new Set(fills).size).toBe(4);
    for (const argb of fills) expect(argb).toMatch(/^FF[0-9A-F]{6}$/);
    // Öğretmen adları iki satıra sığsın diye wrapText açık ve satır yüksekliği artırılmıştır.
    expect(sheet.getCell(dataRow, 2).alignment?.wrapText).toBe(true);
    expect(sheet.getRow(dataRow).height).toBeGreaterThanOrEqual(30);
  });

  it("nöbet yerleri Türkçe locale ile ada göre sıralanır", async () => {
    const plan = publishedPlan({
      assignments: [
        assignment({ id: "z", dutyLocationId: "loc-z", dutyLocationName: "Zemin Kat" }),
        assignment({ id: "i", dutyLocationId: "loc-i", dutyLocationName: "İlkokul Koridor" }),
        assignment({ id: "b", dutyLocationId: "loc-b", dutyLocationName: "Bahçe" }),
      ],
    });
    const workbook = await roundTrip(plan);
    const sheet = sheetOf(workbook, DUTY_PLAN_SHEET_NAMES.weekly);
    const first = 6;
    expect([textAt(sheet, first, 1), textAt(sheet, first + 1, 1), textAt(sheet, first + 2, 1)]).toEqual(["Bahçe", "İlkokul Koridor", "Zemin Kat"]);
  });

  it("TENEFFÜS paketi Sabah ve Öğleden Sonra'yı tek hücrede gösterir", async () => {
    const workbook = await roundTrip(fullPublishedPlan());
    const sheet = sheetOf(workbook, DUTY_PLAN_SHEET_NAMES.weekly);
    expect(textAt(sheet, 6, 2)).toBe("Ayşe Yılmaz");
    expect(textAt(sheet, 7, 2)).toBe("Deniz Kaya\nSabit");
    expect(textAt(sheet, 6, 2)).not.toMatch(/Sabah:|Öğleden Sonra:/);
  });

  it("tarihsel olarak TENEFFÜS çiftinde iki farklı öğretmen varsa ikisini de kaybetmeden gösterir", async () => {
    const plan = publishedPlan({
      assignments: [
        assignment({ id: "m", dutyBlockId: BLK_MORNING, teacherSourceId: "T1", teacherName: "Ayşe Yılmaz" }),
        assignment({ id: "a", dutyBlockId: BLK_AFTERNOON, dutyBlockName: "Öğleden Sonra", teacherSourceId: "T2", teacherName: "Can Demir" }),
      ],
    });
    const workbook = await roundTrip(plan);
    expect(textAt(sheetOf(workbook, DUTY_PLAN_SHEET_NAMES.weekly), 6, 2)).toBe("Sabah: Ayşe Yılmaz\nÖğleden Sonra: Can Demir");
  });
});

describe("buildPublishedDutyPlanWorkbook — Öğretmen Görevleri sayfası", () => {
  async function teacherRows() {
    const workbook = await roundTrip(fullPublishedPlan());
    const sheet = sheetOf(workbook, DUTY_PLAN_SHEET_NAMES.teacherDuties);
    return { sheet, rows: allRows(sheet, 6).slice(1) };
  }

  it("başlık satırı, dondurulmuş ilk satır ve filtre kurulur", async () => {
    const { sheet } = await teacherRows();
    expect(rowTexts(sheet, 1, 6)).toEqual(["Öğretmen", "Gün", "Nöbet Yeri", "Görev Kapsamı", "Bloklar", "Atama Türü"]);
    expect(sheet.autoFilter).toBeTruthy();
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet.getColumn(1).width).toBeGreaterThan(10);
  });

  it("7) FULL_DAY paketi TEK satırdır (dört hücreye çoğaltılmaz)", async () => {
    const { rows } = await teacherRows();
    const fullDay = rows.filter((r) => r[3] === "Tüm Gün");
    expect(fullDay).toHaveLength(1);
    expect(fullDay[0]).toEqual(["Ayşe Yılmaz", "Pazartesi", SNAPSHOT_LOCATION_BAHCE, "Tüm Gün", "Sabah, Uzun 1, Uzun 2, Öğleden Sonra", "Otomatik"]);
  });

  it("8) SHORT_BREAKS paketi TEK satırdır", async () => {
    const { rows } = await teacherRows();
    const shortBreaks = rows.filter((r) => r[3] === "Teneffüs (Sabah + Öğleden Sonra)");
    expect(shortBreaks).toHaveLength(1);
    expect(shortBreaks[0]).toEqual(["Deniz Kaya", "Salı", SNAPSHOT_LOCATION_BAHCE, "Teneffüs (Sabah + Öğleden Sonra)", "Sabah, Öğleden Sonra", "Manuel"]);
  });

  it("FIXED_SHORT_BREAKS paketi tek satır ve tam kapsam etiketiyle yazılır", async () => {
    const { rows } = await teacherRows();
    const fixed = rows.filter((r) => r[3] === "Sabit Sabah + Öğleden Sonra");
    expect(fixed).toHaveLength(1);
    expect(fixed[0]).toEqual(["Deniz Kaya", "Pazartesi", SNAPSHOT_LOCATION_KORIDOR, "Sabit Sabah + Öğleden Sonra", "Sabah, Öğleden Sonra", "Sabit"]);
  });

  it("9) SINGLE_BLOCK yalnız ilgili bloğu gösterir", async () => {
    const { rows } = await teacherRows();
    const single = rows.filter((r) => r[0] === "Can Demir");
    expect(single).toHaveLength(1);
    expect(single[0]).toEqual(["Can Demir", "Salı", SNAPSHOT_LOCATION_KORIDOR, "Tek Blok", "Uzun 1", "Otomatik"]);
  });

  it("satırlar öğretmen adı (tr), gün, nöbet yeri sırasındadır", async () => {
    const { rows } = await teacherRows();
    expect(rows.map((r) => `${r[0]}|${r[1]}`)).toEqual(["Ayşe Yılmaz|Pazartesi", "Can Demir|Salı", "Deniz Kaya|Pazartesi", "Deniz Kaya|Salı"]);
  });

  it("10) paketlenmemiş legacy assignment fallback satırı olarak KAYBOLMADAN görünür", async () => {
    const plan = fullPublishedPlan();
    plan.assignments = [
      ...plan.assignments,
      assignment({
        id: "legacy",
        dayOrder: 3,
        dutyLocationId: LOC_KORIDOR,
        dutyLocationName: SNAPSHOT_LOCATION_KORIDOR,
        dutyBlockId: BLK_LONG2,
        dutyBlockName: "Uzun Nöbet 2",
        teacherSourceId: "T7",
        teacherName: "Elif Öz",
        assignmentKind: "manual",
        packageId: null,
      }),
    ];
    const workbook = await roundTrip(plan);
    const rows = allRows(sheetOf(workbook, DUTY_PLAN_SHEET_NAMES.teacherDuties), 6).slice(1);
    const legacy = rows.filter((r) => r[0] === "Elif Öz");
    expect(legacy).toEqual([["Elif Öz", "Çarşamba", SNAPSHOT_LOCATION_KORIDOR, "Tek Blok", "Uzun 2", "Manuel"]]);
  });

  it("11) aynı assignment hem package hem fallback üzerinden DUPLICATE olmaz", async () => {
    const { rows } = await teacherRows();
    // FULL_DAY paketi dört assignment'ı temsil eder; toplam satır sayısı paket sayısı kadardır.
    expect(rows).toHaveLength(4);
    const keys = rows.map((r) => r.join("|"));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("packageId dolu ama plan.packages'ta olmayan atama fallback olarak eklenir", async () => {
    const plan = publishedPlan({
      assignments: [assignment({ id: "orphan", packageId: "pkg-missing", teacherName: "Ayşe Yılmaz", assignmentKind: "generated" })],
      packages: [],
    });
    const workbook = await roundTrip(plan);
    const rows = allRows(sheetOf(workbook, DUTY_PLAN_SHEET_NAMES.teacherDuties), 6).slice(1);
    expect(rows).toEqual([["Ayşe Yılmaz", "Pazartesi", SNAPSHOT_LOCATION_BAHCE, "Tek Blok", "Sabah", "Otomatik"]]);
  });

  it("açık (unassigned) atama öğretmen görev satırı üretmez", async () => {
    const plan = publishedPlan({
      assignments: [assignment({ id: "u", assignmentKind: "unassigned", teacherName: null, teacherSourceId: null })],
      packages: [],
    });
    const workbook = await roundTrip(plan);
    expect(allRows(sheetOf(workbook, DUTY_PLAN_SHEET_NAMES.teacherDuties), 6).slice(1)).toEqual([]);
  });
});

describe("buildPublishedDutyPlanWorkbook — Yük Özeti sayfası", () => {
  it("12) sayısal hücreler ve doğru durum etiketleri üretir", async () => {
    const workbook = await roundTrip(fullPublishedPlan());
    const sheet = sheetOf(workbook, DUTY_PLAN_SHEET_NAMES.loadSummary);
    expect(rowTexts(sheet, 1, 8)).toEqual(["Öğretmen", "Normal Görev", "Sabit Görev Günü", "Toplam Görev", "Minimum", "Hedef", "Maksimum", "Durum"]);

    // Öğretmen adı tarihsel snapshot kaynaklarından çözülür (UUID/ham id yazılmaz).
    expect(textAt(sheet, 2, 1)).toBe("Ayşe Yılmaz");
    expect(textAt(sheet, 3, 1)).toBe("Deniz Kaya");

    // Görev adetleri SAYI olarak yazılır — önceden biçimlendirilmiş metin DEĞİL.
    for (const column of [2, 3, 4, 5, 6, 7]) {
      expect(sheet.getCell(2, column).type).toBe(ValueType.Number);
      expect(typeof sheet.getCell(2, column).value).toBe("number");
    }
    expect(sheet.getCell(2, 4).value).toBe(4);
    expect(sheet.getCell(3, 4).value).toBe(2);

    // min=1, hedef=2, max=3 → T1 toplam 4 (max aşıldı), T5 toplam 2 (dengeli).
    expect(textAt(sheet, 2, 8)).toBe("Maksimum aşıldı");
    expect(textAt(sheet, 3, 8)).toBe("Dengeli");
  });

  it("eşik yoksa değer uydurulmaz — tire ve 'Hesaplanamadı' yazılır", async () => {
    const plan = publishedPlan({
      generationOptions: {},
      summary: { teacherLoads: [{ teacherSourceId: "T1", normalDutyCount: 1, fixedDutyDayCount: 0, totalDutyCount: 1 }] },
      assignments: [assignment({ id: "a1" })],
    });
    const workbook = await roundTrip(plan);
    const sheet = sheetOf(workbook, DUTY_PLAN_SHEET_NAMES.loadSummary);
    expect(rowTexts(sheet, 2, 8)).toEqual(["Ayşe Yılmaz", "1", "0", "1", "—", "—", "—", "Hesaplanamadı"]);
    expect(sheet.getCell(2, 4).type).toBe(ValueType.Number);
  });

  it("öğretmen adı çözülemezse teacherSourceId'ye düşer", async () => {
    const plan = publishedPlan({
      summary: { teacherLoads: [{ teacherSourceId: "T-BILINMEYEN", normalDutyCount: 0, fixedDutyDayCount: 0, totalDutyCount: 0 }] },
      assignments: [],
      packages: [],
    });
    const workbook = await roundTrip(plan);
    expect(textAt(sheetOf(workbook, DUTY_PLAN_SHEET_NAMES.loadSummary), 2, 1)).toBe("T-BILINMEYEN");
  });

  it("durum eşikleri tam sınırlarda doğru etiketlenir", () => {
    const thresholds = { min: 1, target: 2, max: 3 };
    expect(resolveLoadStatus(0, thresholds)).toBe("Minimumun altında");
    expect(resolveLoadStatus(1, thresholds)).toBe("Hedefin altında");
    expect(resolveLoadStatus(2, thresholds)).toBe("Dengeli");
    expect(resolveLoadStatus(3, thresholds)).toBe("Hedefin üzerinde");
    expect(resolveLoadStatus(4, thresholds)).toBe("Maksimum aşıldı");
    expect(resolveLoadStatus(4, {})).toBe("Hesaplanamadı");
    expect(resolveLoadStatus(4, { min: 1 })).toBe("Hesaplanamadı");
  });
});

describe("buildPublishedDutyPlanWorkbook — baskı, kodlama ve güvenlik", () => {
  it("13) A4 landscape ve fitToWidth ayarları workbook yeniden okununca korunur", async () => {
    const workbook = await roundTrip(fullPublishedPlan());
    for (const sheet of workbook.worksheets) {
      expect(sheet.pageSetup.paperSize).toBe(9);
      expect(sheet.pageSetup.orientation).toBe("landscape");
      expect(sheet.pageSetup.fitToPage).toBe(true);
      expect(sheet.pageSetup.fitToWidth).toBe(1);
      expect(sheet.pageSetup.margins?.left).toBeGreaterThan(0);
    }
  });

  it("haftalık görünüm tek geniş tablo, dondurulmuş başlık ve tek sayfa yüksekliğindedir", async () => {
    const workbook = await buildPublishedDutyPlanWorkbook(fullPublishedPlan());
    const sheet = sheetOf(workbook, DUTY_PLAN_SHEET_NAMES.weekly);
    expect(sheet.pageSetup.fitToWidth).toBe(1);
    expect(sheet.pageSetup.fitToHeight).toBe(1);
    expect(sheet.pageSetup.printTitlesRow).toBe("4:5");
    expect(sheet.views[0]).toMatchObject({ state: "frozen", xSplit: 1, ySplit: 5, showGridLines: false });
    expect(textAt(sheet, 4, 14)).toBe("CUMA");
    expect(textAt(sheet, 5, 16)).toBe("ÖĞLE ARASI-2");
    await expect(workbook.xlsx.writeBuffer()).resolves.toBeTruthy();
  });

  it("14) Türkçe karakterler XLSX buffer round-trip sonrasında bozulmaz", async () => {
    const plan = publishedPlan({
      assignments: [assignment({ id: "tr", dutyLocationName: "Şişli Çağdaş Öğrenci Bahçesi", teacherName: "Gülşah İnanç-Öztürk" })],
      packages: [dutyPackage({ id: "pkg-tr", dutyLocationName: "Şişli Çağdaş Öğrenci Bahçesi", teacherName: "Gülşah İnanç-Öztürk", coverageMode: "SINGLE_BLOCK", coveredBlockCodes: ["MORNING_BREAKS"] })],
    });
    const workbook = await roundTrip(plan);
    const weekly = allRows(sheetOf(workbook, DUTY_PLAN_SHEET_NAMES.weekly), 16).flat().join("\n");
    expect(weekly).toContain("Şişli Çağdaş Öğrenci Bahçesi");
    expect(weekly).toContain("Gülşah İnanç-Öztürk");
    const teacher = allRows(sheetOf(workbook, DUTY_PLAN_SHEET_NAMES.teacherDuties), 6).flat().join("\n");
    expect(teacher).toContain("Gülşah İnanç-Öztürk");
  });

  it("15) dış metin '=', '+', '-' veya '@' ile başlasa bile formüle DÖNÜŞMEZ", async () => {
    const hostileLocation = "=HYPERLINK(\"http://evil.example\",\"tikla\")";
    const hostileTeacher = "@SUM(A1:A9)";
    const plan = publishedPlan({
      assignments: [
        assignment({ id: "h1", dutyLocationId: "loc-h", dutyLocationName: hostileLocation, teacherName: hostileTeacher, teacherSourceId: "T-H" }),
        assignment({ id: "h2", dutyLocationId: "loc-h2", dutyLocationName: "+1+1", dutyBlockId: BLK_LONG1, dutyBlockName: "Uzun Nöbet 1", teacherName: "-2-2", teacherSourceId: "T-H2" }),
      ],
      packages: [dutyPackage({ id: "pkg-h", dutyLocationName: hostileLocation, teacherName: hostileTeacher, teacherSourceId: "T-H", coverageMode: "SINGLE_BLOCK", coveredBlockCodes: ["MORNING_BREAKS"] })],
    });
    const workbook = await roundTrip(plan);

    for (const sheetName of Object.values(DUTY_PLAN_SHEET_NAMES)) {
      const sheet = sheetOf(workbook, sheetName);
      for (let r = 1; r <= sheet.rowCount; r += 1) {
        for (let c = 1; c <= 8; c += 1) {
          const cell = sheet.getCell(r, c);
          expect(cell.type).not.toBe(ValueType.Formula);
          expect((cell.value as { formula?: string } | null)?.formula).toBeUndefined();
        }
      }
    }

    const weekly = sheetOf(workbook, DUTY_PLAN_SHEET_NAMES.weekly);
    const flat = allRows(weekly, 16).flat();
    expect(flat).toContain(hostileLocation);
    expect(flat.some((text) => text.includes(hostileTeacher))).toBe(true);
    expect(flat.some((text) => text.includes("-2-2"))).toBe(true);
  });

  it("makro veya harici bağlantı içermez, UUID benzeri iç kimlikler yazılmaz", async () => {
    const plan = fullPublishedPlan();
    plan.assignments = plan.assignments.map((a) => ({ ...a, id: "8f14e45f-ceea-467a-9e3f-1b0a2c3d4e5f" }));
    const workbook = await roundTrip(plan);
    for (const sheetName of Object.values(DUTY_PLAN_SHEET_NAMES)) {
      const sheet = sheetOf(workbook, sheetName);
      const flat = allRows(sheet, 8).flat().join("\n");
      expect(flat).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(flat).not.toContain("loc-bahce");
      expect(flat).not.toContain("pkg-full");
      expect(flat).not.toContain(BLK_MORNING);
    }
  });
});
