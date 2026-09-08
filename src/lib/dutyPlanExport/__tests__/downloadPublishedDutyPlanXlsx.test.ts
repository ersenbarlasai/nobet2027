import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workbook } from "exceljs";
import { XLSX_MIME_TYPE, buildPublishedDutyPlanFileName, downloadPublishedDutyPlanXlsx } from "../downloadPublishedDutyPlanXlsx";
import { DUTY_PLAN_SHEET_NAMES } from "../buildPublishedDutyPlanWorkbook";
import { fullPublishedPlan, publishedPlan } from "./fixtures";

let createdBlobs: Blob[];
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let clicks: HTMLAnchorElement[];

beforeEach(() => {
  createdBlobs = [];
  clicks = [];
  createObjectURL = vi.fn((blob: Blob) => {
    createdBlobs.push(blob);
    return `blob:mock/${createdBlobs.length}`;
  });
  revokeObjectURL = vi.fn();
  // jsdom bu ikisini uygulamaz — testte açıkça sahteleriz.
  Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true, writable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true, writable: true });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function mockClick(this: HTMLAnchorElement) {
    clicks.push(this);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildPublishedDutyPlanFileName", () => {
  it("20) dosya adı doğru ve güvenlidir", () => {
    expect(buildPublishedDutyPlanFileName("2026-09-11T10:30:00.000Z")).toMatch(/^haftalik-nobet-plani-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(buildPublishedDutyPlanFileName("2026-09-11T10:30:00.000Z")).toBe(`haftalik-nobet-plani-${localStamp("2026-09-11T10:30:00.000Z")}.xlsx`);
  });

  it("dosya sisteminde geçersiz karakterler ada giremez", () => {
    for (const updatedAt of ["2026-09-11T10:30:00.000Z", "not-a-date", "", "../../etc/passwd", '2026:09*11?"<>|']) {
      const name = buildPublishedDutyPlanFileName(updatedAt);
      expect(name).toMatch(/^haftalik-nobet-plani-\d{4}-\d{2}-\d{2}\.xlsx$/);
      for (const forbidden of ["\\", "/", ":", "*", "?", '"', "<", ">", "|", " "]) expect(name).not.toContain(forbidden);
    }
  });
});

function localStamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("downloadPublishedDutyPlanXlsx", () => {
  it("19) blob doğru XLSX MIME type ile üretilir ve gerçekten okunabilir bir workbook içerir", async () => {
    const plan = fullPublishedPlan();
    await downloadPublishedDutyPlanXlsx(plan);

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createdBlobs).toHaveLength(1);
    expect(createdBlobs[0].type).toBe(XLSX_MIME_TYPE);
    expect(createdBlobs[0].size).toBeGreaterThan(0);

    const reloaded = new Workbook();
    await reloaded.xlsx.load(await createdBlobs[0].arrayBuffer());
    expect(reloaded.worksheets.map((s) => s.name)).toEqual([DUTY_PLAN_SHEET_NAMES.weekly, DUTY_PLAN_SHEET_NAMES.teacherDuties, DUTY_PLAN_SHEET_NAMES.loadSummary]);
  });

  it("geçici anchor doğru dosya adıyla tıklanır ve DOM'da bırakılmaz", async () => {
    const plan = fullPublishedPlan();
    await downloadPublishedDutyPlanXlsx(plan);

    expect(clicks).toHaveLength(1);
    expect(clicks[0].download).toBe(buildPublishedDutyPlanFileName(plan.updatedAt));
    expect(clicks[0].href).toBe("blob:mock/1");
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
  });

  it("21) URL.revokeObjectURL çağrılır", async () => {
    await downloadPublishedDutyPlanXlsx(fullPublishedPlan());
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock/1");
  });

  it("üretim hata verirse hata yayılır ve sızdıran object URL kalmaz", async () => {
    // Bozuk plan: assignments/packages dizi değil → builder içinde TypeError.
    const broken = { ...publishedPlan(), assignments: null } as unknown as ReturnType<typeof publishedPlan>;
    await expect(downloadPublishedDutyPlanXlsx(broken)).rejects.toBeInstanceOf(Error);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("24) yalnız verilen plan nesnesini kullanır — ağ isteği yapmaz", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await downloadPublishedDutyPlanXlsx(fullPublishedPlan());
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
