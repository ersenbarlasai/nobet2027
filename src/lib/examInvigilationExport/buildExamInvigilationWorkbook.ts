import { Workbook, type Alignment, type Borders, type Fill, type Worksheet } from "exceljs";
import { EXAM_SCOPE_LABELS, EXAM_SCOPE_ORDER, type ExamScope } from "../examInvigilation/types";
import {
  EMPTY_CELL,
  buildScopeDayMatrix,
  cellTeacherName,
  planExamDates,
  scopeExamDates,
  teacherDutyRows,
  teacherSummaryRows,
  type FoundExamPlan,
} from "../examInvigilation/planView";

/**
 * Tamamlanmış deneme sınavı gözetmen listesinin XLSX çıktısı.
 *
 * Bu modül YALNIZ eldeki plan detayını kullanır: liste yeniden hesaplanmaz,
 * API'ye ikinci istek atılmaz, canlı `teachers`/`school_classes`/`periods`
 * tablolarıyla birleştirilmez. Yazılan bütün adlar planın TARİHSEL SNAPSHOT
 * alanlarıdır, bu yüzden sonraki bir XML importu eski çıktıyı DEĞİŞTİRMEZ.
 */
export const EXAM_SHEET_NAMES = {
  matrix: "Gözetmen Matrisi",
  teacherDuties: "Öğretmen Görevleri",
} as const;

const COLORS = {
  scopeHeader: "FF1F4E3D",
  dayHeader: "FF0F6B5B",
  columnHeader: "FFDDE4EA",
  classHeader: "FFEFEFE7",
  filled: "FFE2EFDA",
  warning: "FFFFF2CC",
  empty: "FFF3F3F3",
  headerText: "FFFFFFFF",
} as const;

const THIN_BORDERS: Partial<Borders> = {
  top: { style: "thin", color: { argb: "FFB4C6E7" } },
  left: { style: "thin", color: { argb: "FFB4C6E7" } },
  bottom: { style: "thin", color: { argb: "FFB4C6E7" } },
  right: { style: "thin", color: { argb: "FFB4C6E7" } },
};

const WRAP_CENTER: Partial<Alignment> = { vertical: "middle", horizontal: "center", wrapText: true };
const WRAP_LEFT: Partial<Alignment> = { vertical: "middle", horizontal: "left", wrapText: true };

function solidFill(argb: string): Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

/**
 * Harici (veritabanı/XML kaynaklı) metinleri Excel'e HER ZAMAN düz metin
 * olarak yazmak için tek geçiş noktası. ExcelJS bir formülü ancak
 * `{ formula }` nesnesiyle üretir; buradan öyle bir nesne asla geçmez.
 */
function safeText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function formatDate(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return safeText(iso);
  return parsed.toLocaleDateString("tr-TR", { day: "2-digit", month: "long", year: "numeric", weekday: "long" });
}

function periodLabel(periodName: string, startsAt: string | null, endsAt: string | null): string {
  const start = startsAt?.slice(0, 5);
  const end = endsAt?.slice(0, 5);
  if (!start && !end) return safeText(periodName);
  return `${safeText(periodName)}\n${start ?? ""}${end ? `–${end}` : ""}`;
}

function titleRow(sheet: Worksheet, text: string, width: number, argb: string, height = 22): void {
  const row = sheet.addRow([safeText(text)]);
  row.height = height;
  sheet.mergeCells(row.number, 1, row.number, Math.max(width, 1));
  const cell = row.getCell(1);
  cell.fill = solidFill(argb);
  cell.font = { bold: true, size: 12, color: { argb: COLORS.headerText } };
  cell.alignment = WRAP_LEFT;
}

function writeScopeMatrix(sheet: Worksheet, plan: FoundExamPlan, scope: ExamScope): void {
  const scopeLabel = EXAM_SCOPE_LABELS[scope.scopeCode];
  const dates = scopeExamDates(scope, plan.examDate);
  const widestPeriodCount = Math.max(1, ...dates.map((date) => buildScopeDayMatrix(scope, date, plan.examDate).periods.length));

  titleRow(sheet, `${scopeLabel} — Gözetmen Matrisi`, widestPeriodCount + 1, COLORS.scopeHeader);
  if (dates.length === 0) {
    const row = sheet.addRow(["Bu okul grubu için sınav oturumu planlanmadı."]);
    row.getCell(1).alignment = WRAP_LEFT;
    sheet.addRow([]);
    return;
  }

  for (const date of dates) {
    const matrix = buildScopeDayMatrix(scope, date, plan.examDate);
    titleRow(sheet, `${scopeLabel} · ${formatDate(date)}`, matrix.periods.length + 1, COLORS.dayHeader, 18);

    const header = sheet.addRow(["Sınıf", ...matrix.periods.map((period) => periodLabel(period.periodName, period.startsAt, period.endsAt))]);
    header.height = 30;
    header.eachCell((cell) => {
      cell.fill = solidFill(COLORS.columnHeader);
      cell.font = { bold: true };
      cell.alignment = WRAP_CENTER;
      cell.border = THIN_BORDERS;
    });

    for (const matrixRow of matrix.rows) {
      const values = [safeText(matrixRow.label), ...matrixRow.cells.map((session) => safeText(cellTeacherName(session)))];
      const row = sheet.addRow(values);
      row.height = 20;
      row.eachCell((cell, columnNumber) => {
        cell.border = THIN_BORDERS;
        if (columnNumber === 1) {
          cell.fill = solidFill(COLORS.classHeader);
          cell.font = { bold: true };
          cell.alignment = WRAP_LEFT;
          return;
        }
        const session = matrixRow.cells[columnNumber - 2] ?? null;
        const assignment = session?.assignments.find((item) => item.slotNumber === 1) ?? session?.assignments[0];
        cell.alignment = WRAP_CENTER;
        cell.fill = solidFill(!session ? COLORS.empty : assignment?.dutyWarning?.length ? COLORS.warning : COLORS.filled);
      });
    }
    sheet.addRow([]);
  }
}

function buildMatrixSheet(workbook: Workbook, plan: FoundExamPlan): void {
  const sheet = workbook.addWorksheet(EXAM_SHEET_NAMES.matrix, {
    pageSetup: { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  sheet.getColumn(1).width = 22;
  for (let index = 2; index <= 20; index += 1) sheet.getColumn(index).width = 20;

  titleRow(sheet, safeText(plan.name), 8, COLORS.scopeHeader, 26);
  const dates = planExamDates(plan);
  const subtitle = sheet.addRow([`Sınav tarihleri: ${dates.map(formatDate).join(" · ") || EMPTY_CELL}`]);
  subtitle.getCell(1).alignment = WRAP_LEFT;
  sheet.addRow([`Nöbet planı haftası: ${formatDate(plan.weekStartDate)}`]).getCell(1).alignment = WRAP_LEFT;
  sheet.addRow([]);

  // XML'den türeyen kademeler okul sırasıyla ayrı bölümlerde yazılır.
  for (const scope of [...plan.scopes].sort((a, b) => EXAM_SCOPE_ORDER.indexOf(a.scopeCode) - EXAM_SCOPE_ORDER.indexOf(b.scopeCode))) {
    writeScopeMatrix(sheet, plan, scope);
  }
}

function buildTeacherDutiesSheet(workbook: Workbook, plan: FoundExamPlan): void {
  const sheet = workbook.addWorksheet(EXAM_SHEET_NAMES.teacherDuties, {
    pageSetup: { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const headers = ["Öğretmen", "Okul grubu", "Sınıf", "Tarih", "Ders saati", "Nöbet uyarısı", "Düzenleme notu"];
  const widths = [26, 14, 16, 26, 18, 34, 40];
  headers.forEach((_, index) => { sheet.getColumn(index + 1).width = widths[index]; });

  titleRow(sheet, `${safeText(plan.name)} — Öğretmen Görevleri`, headers.length, COLORS.scopeHeader, 24);
  const headerRow = sheet.addRow(headers);
  headerRow.eachCell((cell) => {
    cell.fill = solidFill(COLORS.columnHeader);
    cell.font = { bold: true };
    cell.alignment = WRAP_CENTER;
    cell.border = THIN_BORDERS;
  });

  const rows = teacherDutyRows(plan);
  for (const row of rows) {
    const written = sheet.addRow([
      safeText(row.teacherName), safeText(row.scopeLabel), safeText(row.className),
      formatDate(row.examDate), safeText(`${row.periodName} · ${row.periodTime}`),
      safeText(row.dutyWarningText), safeText(row.dutyCoverageNote),
    ]);
    written.eachCell((cell) => { cell.border = THIN_BORDERS; cell.alignment = WRAP_LEFT; });
    if (row.assignment.dutyWarning?.length) written.getCell(6).fill = solidFill(COLORS.warning);
  }
  if (rows.length === 0) sheet.addRow(["Bu planda gözetmen ataması yok."]);

  sheet.addRow([]);
  titleRow(sheet, "Öğretmen Bazlı Gözetmenlik Özeti", headers.length, COLORS.dayHeader, 20);
  const scopes=EXAM_SCOPE_ORDER.filter(code=>plan.scopes.some(scope=>scope.scopeCode===code&&scope.sessions.length>0));
  const summaryHeader = sheet.addRow(["Öğretmen", "Toplam görev", ...scopes.map(code=>EXAM_SCOPE_LABELS[code]), "Nöbet devri", "Görev günleri"]);
  summaryHeader.eachCell((cell) => {
    cell.fill = solidFill(COLORS.columnHeader);
    cell.font = { bold: true };
    cell.alignment = WRAP_CENTER;
    cell.border = THIN_BORDERS;
  });
  for (const summary of teacherSummaryRows(plan)) {
    const written = sheet.addRow([
      safeText(summary.teacherName), summary.totalCount, ...scopes.map(code=>summary.scopeCounts[code]??0),
      summary.warningCount, summary.dates.map(formatDate).join(" · "),
    ]);
    written.eachCell((cell) => { cell.border = THIN_BORDERS; cell.alignment = WRAP_LEFT; });
  }
}

export async function buildExamInvigilationWorkbook(plan: FoundExamPlan): Promise<Workbook> {
  const workbook = new Workbook();
  workbook.creator = "Nöbet2027";
  buildMatrixSheet(workbook, plan);
  buildTeacherDutiesSheet(workbook, plan);
  return workbook;
}
