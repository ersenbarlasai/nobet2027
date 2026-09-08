import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Workbook } from "exceljs";
import { EXAM_SHEET_NAMES, buildExamInvigilationWorkbook } from "../buildExamInvigilationWorkbook";
import { buildExamInvigilationFileName } from "../downloadExamInvigilationXlsx";
import type { FoundExamPlan } from "../../examInvigilation/planView";

function plan(): FoundExamPlan {
  return {
    found: true,
    id: "plan-1",
    name: "Eylül Deneme Sınavı",
    weekStartDate: "2026-09-14",
    examDate: "2026-09-17",
    timetableImportId: "import-1",
    dutyPlanId: "duty-1",
    campusName: "Test Kampüs",
    academicYearName: "2026-2027",
    sourceFingerprint: "fingerprint",
    isStale: false,
    overallStatus: "completed",
    createdAt: "2026-09-10T10:00:00Z",
    updatedAt: "2026-09-19T10:00:00Z",
    scopes: [
      {
        id: "scope-middle", scopeCode: "MIDDLE_SCHOOL", status: "completed", listStatus: "completed",
        sessionCount: 3, version: 6, completedAt: "2026-09-19T08:00:00Z",
        sessions: [
          { id: "m1", examDate: "2026-09-17", schoolClassId: "c8a", schoolClassSourceId: "8a", schoolClassName: "8/A", periodOrder: 2, periodName: "2. Saat", startsAt: "09:20:00", endsAt: "10:00:00", requiredCount: 1, assignments: [{ id: "a1", slotNumber: 1, teacherSourceId: "t1", teacherName: "Hasan Yılmaz", dutyWarning: null, dutyCoverageAcknowledged: false, dutyCoverageNote: null }] },
          { id: "m2", examDate: "2026-09-17", schoolClassId: "c8a", schoolClassSourceId: "8a", schoolClassName: "8/A", periodOrder: 3, periodName: "3. Saat", startsAt: "10:10:00", endsAt: "10:50:00", requiredCount: 1, assignments: [{ id: "a2", slotNumber: 1, teacherSourceId: "t2", teacherName: "Selin Karaca", dutyWarning: [{ packageId: "pkg", locationName: "Alt Bahçe", coverageMode: "SHORT_BREAKS" }], dutyCoverageAcknowledged: true, dutyCoverageNote: "Rehber öğretmen devralacak." }] },
          { id: "m3", examDate: "2026-09-17", schoolClassId: "c7a", schoolClassSourceId: "7a", schoolClassName: "7/A", periodOrder: 2, periodName: "2. Saat", startsAt: "09:20:00", endsAt: "10:00:00", requiredCount: 1, assignments: [{ id: "a3", slotNumber: 1, teacherSourceId: "t1", teacherName: "Hasan Yılmaz", dutyWarning: null, dutyCoverageAcknowledged: false, dutyCoverageNote: null }] },
        ],
      },
      {
        id: "scope-high", scopeCode: "HIGH_SCHOOL", status: "completed", listStatus: "completed",
        sessionCount: 1, version: 3, completedAt: "2026-09-19T08:30:00Z",
        sessions: [
          { id: "h1", examDate: "2026-09-18", schoolClassId: "c11a", schoolClassSourceId: "11a", schoolClassName: "11/A", periodOrder: 2, periodName: "2. Saat", startsAt: "09:20:00", endsAt: "10:00:00", requiredCount: 1, assignments: [{ id: "a4", slotNumber: 1, teacherSourceId: "t3", teacherName: "Ada Demir", dutyWarning: null, dutyCoverageAcknowledged: false, dutyCoverageNote: null }] },
        ],
      },
    ],
  };
}

function sheetText(workbook: Workbook, name: string): string {
  const sheet = workbook.getWorksheet(name)!;
  const values: string[] = [];
  sheet.eachRow((row) => { row.eachCell((cell) => { values.push(String(cell.value ?? "")); }); });
  return values.join("\n");
}

describe("deneme sınavı gözetmen XLSX çıktısı", () => {
  it("iki sayfayı sabit adlarla üretir", async () => {
    const workbook = await buildExamInvigilationWorkbook(plan());
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([EXAM_SHEET_NAMES.matrix, EXAM_SHEET_NAMES.teacherDuties]);
    expect(EXAM_SHEET_NAMES.matrix).toBe("Gözetmen Matrisi");
    expect(EXAM_SHEET_NAMES.teacherDuties).toBe("Öğretmen Görevleri");
  });

  it("matris sayfasında satırları sınıf, sütunları ders saati yapar ve sınavsız kesişimi — yazar", async () => {
    const workbook = await buildExamInvigilationWorkbook(plan());
    const sheet = workbook.getWorksheet(EXAM_SHEET_NAMES.matrix)!;
    const rows: string[][] = [];
    sheet.eachRow((row) => { rows.push((row.values as unknown[]).slice(1).map((value) => String(value ?? ""))); });
    const header = rows.find((row) => row[0] === "Sınıf")!;
    expect(header[1]).toContain("2. Saat");
    expect(header[2]).toContain("3. Saat");
    const row8 = rows.find((row) => row[0] === "8/A")!;
    expect(row8).toEqual(["8/A", "Hasan Yılmaz", "Selin Karaca"]);
    const row7 = rows.find((row) => row[0] === "7/A")!;
    expect(row7).toEqual(["7/A", "Hasan Yılmaz", "—"]);
  });

  it("Ortaokul ve Lise bölümlerini açıkça ayırır", async () => {
    const text = sheetText(await buildExamInvigilationWorkbook(plan()), EXAM_SHEET_NAMES.matrix);
    expect(text).toContain("Ortaokul — Gözetmen Matrisi");
    expect(text).toContain("Lise — Gözetmen Matrisi");
    expect(text).toContain("Ada Demir");
  });

  it("öğretmen görevleri sayfasında istenen sütunları, nöbet uyarısını ve notu yazar", async () => {
    const workbook = await buildExamInvigilationWorkbook(plan());
    const sheet = workbook.getWorksheet(EXAM_SHEET_NAMES.teacherDuties)!;
    const rows: string[][] = [];
    sheet.eachRow((row) => { rows.push((row.values as unknown[]).slice(1).map((value) => String(value ?? ""))); });
    expect(rows.find((row) => row[0] === "Öğretmen" && row[1] === "Okul grubu")).toEqual([
      "Öğretmen", "Okul grubu", "Sınıf", "Tarih", "Ders saati", "Nöbet uyarısı", "Düzenleme notu",
    ]);
    const selin = rows.find((row) => row[0] === "Selin Karaca")!;
    expect(selin[1]).toBe("Ortaokul");
    expect(selin[2]).toBe("8/A");
    expect(selin[4]).toContain("3. Saat");
    expect(selin[5]).toContain("Alt Bahçe");
    expect(selin[6]).toBe("Rehber öğretmen devralacak.");
    const summary = rows.find((row) => row[0] === "Hasan Yılmaz" && row[1] === "2");
    expect(summary).toBeDefined();
  });

  it("dosya adını güvenli ve öngörülebilir biçimde kurar", () => {
    expect(buildExamInvigilationFileName(plan())).toBe("deneme-sinavi-gozetmen-listesi_2026-09-17.xlsx");
    const broken = { ...plan(), examDate: "bozuk", scopes: [] } as FoundExamPlan;
    expect(buildExamInvigilationFileName(broken)).toMatch(/^deneme-sinavi-gozetmen-listesi_\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("A4 yatay yazdırma kurallarını sayfa CSS'inde tutar", () => {
    const css = readFileSync(join(__dirname, "../../../pages/DenemeSinaviGozetmenPage.css"), "utf-8");
    const printBlock = css.slice(css.indexOf("@media print"));
    expect(printBlock).toContain("size:A4 landscape");
    expect(printBlock).toContain(".sidebar");
    expect(printBlock).toContain(".topbar");
    expect(printBlock).toContain(".eig-candidates");
    expect(printBlock).toContain(".eig-print-header{display:block");
  });
});
