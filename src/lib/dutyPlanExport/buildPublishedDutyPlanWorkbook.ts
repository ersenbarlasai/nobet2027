import { Workbook, type Alignment, type Borders, type Fill, type Worksheet } from "exceljs";
import {
  PACKAGE_COVERAGE_MODE_LABELS,
  WEEKDAY_NAMES,
  type DutyPlanPackageCoverageMode,
  type PublishedDutyPlanAssignmentDto,
  type PublishedDutyPlanDto,
  type SolverTeacherLoad,
} from "../dutyPlanDrafts/types";
import { BLOCK_SHORT_LABELS, DUTY_BLOCK_CODES, type DutyBlockCode } from "../dutyLocations/types";

/**
 * YAYIMLANMIŞ nöbet planının XLSX çıktısı.
 *
 * Bu modül YALNIZ eldeki `PublishedDutyPlanDto` nesnesini kullanır: plan
 * yeniden hesaplanmaz, API'den ikinci kez çekilmez, canlı öğretmen/nöbet yeri
 * tablolarıyla birleştirilmez. Yazılan bütün isimler planın TARİHSEL SNAPSHOT
 * alanlarıdır (`dutyLocationName`, `teacherName`), bu yüzden sonraki bir XML
 * importu daha önce yayımlanmış bir planın Excel çıktısını DEĞİŞTİRMEZ.
 */
export type FoundPublishedDutyPlan = Omit<Extract<PublishedDutyPlanDto, { found: true }>, "status"> & {
  /** Geçmiş ekranından seçilen arşiv/taslak da aynı tarihsel snapshot biçiminde dışa aktarılabilir. */
  status: "draft" | "published" | "archived";
};

export const DUTY_PLAN_SHEET_NAMES = {
  weekly: "Haftalık Plan",
  teacherDuties: "Öğretmen Görevleri",
  loadSummary: "Yük Özeti",
} as const;

/** Bloklar gün içi DOMAIN sırasıyla gösterilir — alfabetik DEĞİL. */
const DOMAIN_BLOCK_ORDER: readonly DutyBlockCode[] = DUTY_BLOCK_CODES;

/**
 * Excel hücresi dar değildir; bu yüzden sabit paketin kapsamı kısaltılmadan
 * yazılır. Diğer bütün etiketler mevcut `PACKAGE_COVERAGE_MODE_LABELS`
 * kaynağından gelir (tek doğruluk kaynağı korunur).
 */
const COVERAGE_MODE_LABELS: Record<DutyPlanPackageCoverageMode, string> = {
  ...PACKAGE_COVERAGE_MODE_LABELS,
  FIXED_SHORT_BREAKS: "Sabit Sabah + Öğleden Sonra",
};

const ASSIGNMENT_KIND_LABELS: Record<"fixed" | "generated" | "manual", string> = {
  fixed: "Sabit",
  generated: "Otomatik",
  manual: "Manuel",
};

/** Paket kapsamı sıralaması — geniş kapsamdan dara. */
const COVERAGE_MODE_RANK: Record<DutyPlanPackageCoverageMode, number> = {
  FULL_DAY: 0,
  SHORT_BREAKS: 1,
  FIXED_SHORT_BREAKS: 2,
  SINGLE_BLOCK: 3,
};

const COLORS = {
  title: "FF1F4E3D",
  locationHeader: "FF0F6B5B",
  fixed: "FFFFC000",
  generated: "FFE2EFDA",
  manual: "FFFFF2CC",
  unassigned: "FFFFC7CE",
  notRequired: "FFE7E6E6",
  headerText: "FFFFFFFF",
  bodyText: "FF1F1F1F",
} as const;

const WEEKLY_DAY_COLORS = [
  { header: "FF87927A", subheader: "FFB8B8A8", body: "FFE4E2D6" },
  { header: "FF7F8E9A", subheader: "FFAAB5BF", body: "FFDDE4EA" },
  { header: "FF7E8F7B", subheader: "FFAAB6A7", body: "FFDDE5DB" },
  { header: "FF898391", subheader: "FFB4AFB8", body: "FFE4E0E6" },
  { header: "FF9A877A", subheader: "FFC0B1A6", body: "FFE9E0DA" },
] as const;

const WEEKLY_PACKAGE_HEADERS = ["Sabah + Öğleden Sonra", "ÖĞLE ARASI-1", "ÖĞLE ARASI-2"] as const;

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
 * olarak yazmak için tek geçiş noktası. ExcelJS bir formül ancak `{ formula }`
 * nesnesi verildiğinde üretir; buradan asla öyle bir nesne geçmez, bu yüzden
 * "=", "+", "-" veya "@" ile başlayan bir öğretmen/yer adı formüle DÖNÜŞEMEZ.
 */
function safeText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function compareTr(a: string, b: string): number {
  return a.localeCompare(b, "tr");
}

const TR_LOWER_MAP: Record<string, string> = { İ: "i", I: "ı", Ş: "ş", Ğ: "ğ", Ü: "ü", Ö: "ö", Ç: "ç" };

function trLower(value: string): string {
  return value.replace(/[İIŞĞÜÖÇ]/g, (ch) => TR_LOWER_MAP[ch] ?? ch).toLowerCase();
}

function isDutyBlockCode(value: string): value is DutyBlockCode {
  return (DUTY_BLOCK_CODES as readonly string[]).includes(value);
}

/** Blok ADINDAN domain koduna güvenli tahmin — eşleşme yoksa null (blok kaybolmaz, "bilinmeyen" olur). */
function guessBlockCodeFromName(name: string): DutyBlockCode | null {
  if (isDutyBlockCode(name)) return name;
  const lower = trLower(name);
  if (lower.includes("öğleden")) return "AFTERNOON_BREAKS";
  if (lower.includes("sabah")) return "MORNING_BREAKS";
  if (lower.includes("uzun")) {
    if (lower.includes("1")) return "LONG_BREAK_1";
    if (lower.includes("2")) return "LONG_BREAK_2";
  }
  return null;
}

/**
 * `dutyBlockId` → domain blok kodu eşlemesi. Önce KESİN kaynak kullanılır:
 * tek bloklu (SINGLE_BLOCK) paketlerin kapsadığı hücreler blok kodunu doğrudan
 * verir. Kalanlar için blok ADI üzerinden tahmin yapılır. Hiçbiri tutmazsa blok
 * "bilinmeyen" sayılır ve KAYBOLMAZ — bilinen dört bloktan sonra ilk görülme
 * sırasıyla eklenir.
 */
function buildBlockCodeById(plan: FoundPublishedDutyPlan): Map<string, DutyBlockCode> {
  const codeById = new Map<string, DutyBlockCode>();

  const singleBlockPackageCode = new Map<string, DutyBlockCode>();
  for (const pkg of plan.packages) {
    if (pkg.coverageMode !== "SINGLE_BLOCK") continue;
    const [code] = pkg.coveredBlockCodes;
    if (code && isDutyBlockCode(code)) singleBlockPackageCode.set(pkg.id, code);
  }
  for (const assignment of plan.assignments) {
    if (!assignment.packageId) continue;
    const code = singleBlockPackageCode.get(assignment.packageId);
    if (code) codeById.set(assignment.dutyBlockId, code);
  }

  for (const assignment of plan.assignments) {
    if (codeById.has(assignment.dutyBlockId)) continue;
    const guessed = guessBlockCodeFromName(safeText(assignment.dutyBlockName));
    if (guessed) codeById.set(assignment.dutyBlockId, guessed);
  }

  return codeById;
}

export interface BlockColumn {
  dutyBlockId: string;
  /** Bilinen blok ise domain kodu, değilse null. */
  code: DutyBlockCode | null;
  label: string;
}

/** Sütunlar: bilinen dört blok domain sırasında, ardından bilinmeyenler kararlı ilk-görülme sırasıyla. */
export function resolveBlockColumns(plan: FoundPublishedDutyPlan): BlockColumn[] {
  const codeById = buildBlockCodeById(plan);
  const seen = new Map<string, BlockColumn>();

  for (const assignment of plan.assignments) {
    if (seen.has(assignment.dutyBlockId)) continue;
    const code = codeById.get(assignment.dutyBlockId) ?? null;
    seen.set(assignment.dutyBlockId, {
      dutyBlockId: assignment.dutyBlockId,
      code,
      label: code ? BLOCK_SHORT_LABELS[code] : safeText(assignment.dutyBlockName) || assignment.dutyBlockId,
    });
  }

  const rank = (column: BlockColumn) => (column.code ? DOMAIN_BLOCK_ORDER.indexOf(column.code) : Number.MAX_SAFE_INTEGER);

  return Array.from(seen.values())
    .map((column, index) => ({ column, index }))
    .sort((a, b) => rank(a.column) - rank(b.column) || a.index - b.index)
    .map((entry) => entry.column);
}

function formatPublishedAt(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return safeText(isoDate);
  return date.toLocaleString("tr-TR");
}

/** Bir hücrenin metni + dolgu rengi. Açık görevler GİZLENMEZ (bozuk/eski response savunması). */
function cellPresentation(assignment: PublishedDutyPlanAssignmentDto | undefined): { text: string; fill: string | null } {
  if (!assignment) return { text: "—", fill: COLORS.notRequired };
  if (assignment.assignmentKind === "unassigned" || !assignment.teacherName) {
    return { text: "AÇIK", fill: COLORS.unassigned };
  }
  const name = safeText(assignment.teacherName);
  switch (assignment.assignmentKind) {
    case "fixed":
      return { text: `${name}\nSabit`, fill: COLORS.fixed };
    case "manual":
      return { text: `${name}\nManuel`, fill: COLORS.manual };
    default:
      return { text: name, fill: null };
  }
}

function strongestFill(presentations: { fill: string | null }[]): string | null {
  for (const fill of [COLORS.unassigned, COLORS.fixed, COLORS.manual]) {
    if (presentations.some((p) => p.fill === fill)) return fill;
  }
  return presentations.find((p) => p.fill)?.fill ?? null;
}

/** Sabah + Öğleden Sonra iki hücresini tek TENEFFÜS sunumuna indirger. */
function breakPairPresentation(
  morning: PublishedDutyPlanAssignmentDto | undefined,
  afternoon: PublishedDutyPlanAssignmentDto | undefined,
): { text: string; fill: string | null } {
  const morningView = cellPresentation(morning);
  const afternoonView = cellPresentation(afternoon);

  if (!morning && !afternoon) return { text: "—", fill: COLORS.notRequired };
  if (
    morning &&
    afternoon &&
    morning.teacherSourceId === afternoon.teacherSourceId &&
    morning.assignmentKind === afternoon.assignmentKind
  ) {
    return morningView;
  }

  return {
    text: `Sabah: ${morningView.text.replaceAll("\n", " — ")}\nÖğleden Sonra: ${afternoonView.text.replaceAll("\n", " — ")}`,
    fill: strongestFill([morningView, afternoonView]),
  };
}

function applyPageSetup(sheet: Worksheet): void {
  sheet.pageSetup = {
    ...sheet.pageSetup,
    paperSize: 9, // A4
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    verticalCentered: false,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.25, footer: 0.25 },
  };
}

// ---------------------------------------------------------------------------
// 1) Haftalık Plan
// ---------------------------------------------------------------------------

function buildWeeklySheet(workbook: Workbook, plan: FoundPublishedDutyPlan, columns: BlockColumn[]): void {
  const sheet = workbook.addWorksheet(DUTY_PLAN_SHEET_NAMES.weekly);
  applyPageSetup(sheet);
  sheet.pageSetup.fitToHeight = 1;
  sheet.pageSetup.printTitlesRow = "4:5";

  const days = Array.from({ length: 5 }, (_, index) => ({ order: index + 1, name: WEEKDAY_NAMES[index + 1] ?? String(index + 1) }));
  const activeDayOrders = new Set(plan.activeDayOrders ?? [1, 2, 3, 4, 5]);
  const totalColumns = 1 + days.length * WEEKLY_PACKAGE_HEADERS.length;
  sheet.getColumn(1).width = 24;
  for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
    const start = 2 + dayIndex * 3;
    sheet.getColumn(start).width = 22;
    sheet.getColumn(start + 1).width = 17;
    sheet.getColumn(start + 2).width = 17;
  }

  sheet.mergeCells(1, 1, 1, totalColumns);
  const title = sheet.getCell(1, 1);
  title.value = "Haftalık Nöbet Planı";
  title.fill = solidFill(COLORS.title);
  title.font = { bold: true, size: 14, color: { argb: COLORS.headerText }, name: "Arial" };
  title.alignment = { vertical: "middle", horizontal: "left" };
  sheet.getRow(1).height = 25;

  sheet.mergeCells(2, 1, 2, totalColumns);
  const meta = sheet.getCell(2, 1);
  meta.value = `Hafta: ${safeText(plan.weekStartDate) || "Tarihsel plan"}   |   Yayımlanma: ${formatPublishedAt(plan.updatedAt)}   |   Plan sürümü: ${plan.version}   |   Algoritma: ${safeText(plan.algorithmVersion)}`;
  meta.font = { size: 9, italic: true, color: { argb: "FF595959" }, name: "Arial" };
  meta.alignment = WRAP_LEFT;

  sheet.mergeCells(4, 1, 5, 1);
  const locationHeader = sheet.getCell(4, 1);
  locationHeader.value = "NÖBET YERİ";
  locationHeader.fill = solidFill(COLORS.locationHeader);
  locationHeader.font = { bold: true, color: { argb: COLORS.headerText }, name: "Arial", size: 9 };
  locationHeader.alignment = WRAP_CENTER;
  locationHeader.border = THIN_BORDERS;

  days.forEach((day, dayIndex) => {
    const start = 2 + dayIndex * 3;
    const palette = WEEKLY_DAY_COLORS[dayIndex];
    sheet.mergeCells(4, start, 4, start + 2);
    const dayCell = sheet.getCell(4, start);
    dayCell.value = activeDayOrders.has(day.order) ? day.name.toLocaleUpperCase("tr-TR") : `${day.name.toLocaleUpperCase("tr-TR")} · TATİL`;
    dayCell.fill = solidFill(palette.header);
    dayCell.font = { bold: true, color: { argb: COLORS.headerText }, name: "Arial", size: 9 };
    dayCell.alignment = WRAP_CENTER;
    dayCell.border = THIN_BORDERS;

    WEEKLY_PACKAGE_HEADERS.forEach((label, offset) => {
      const cell = sheet.getCell(5, start + offset);
      cell.value = label;
      cell.fill = solidFill(palette.subheader);
      cell.font = { bold: true, color: { argb: COLORS.bodyText }, name: "Arial", size: 8 };
      cell.alignment = WRAP_CENTER;
      cell.border = THIN_BORDERS;
    });
  });
  sheet.getRow(4).height = 20;
  sheet.getRow(5).height = 28;

  const locations = new Map<string, string>();
  for (const assignment of plan.assignments) locations.set(assignment.dutyLocationId, safeText(assignment.dutyLocationName));
  for (const pkg of plan.packages) if (!locations.has(pkg.dutyLocationId)) locations.set(pkg.dutyLocationId, safeText(pkg.dutyLocationName));
  const sortedLocations = Array.from(locations.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => compareTr(a.name, b.name));

  const codeByBlockId = new Map(columns.map((column) => [column.dutyBlockId, column.code]));
  const assignmentByCell = new Map<string, PublishedDutyPlanAssignmentDto>();
  const unknownAssignments: PublishedDutyPlanAssignmentDto[] = [];
  for (const assignment of plan.assignments) {
    const code = codeByBlockId.get(assignment.dutyBlockId) ?? null;
    if (!code) {
      unknownAssignments.push(assignment);
      continue;
    }
    assignmentByCell.set(`${assignment.dayOrder}|${assignment.dutyLocationId}|${code}`, assignment);
  }

  const findAssignment = (dayOrder: number, locationId: string, code: DutyBlockCode) =>
    assignmentByCell.get(`${dayOrder}|${locationId}|${code}`);

  for (const location of sortedLocations) {
    const row = sheet.addRow([location.name]);
    row.height = 34;
    const locationCell = row.getCell(1);
    locationCell.font = { bold: true, color: { argb: COLORS.bodyText }, name: "Arial", size: 9 };
    locationCell.alignment = WRAP_LEFT;
    locationCell.border = THIN_BORDERS;

    days.forEach((day, dayIndex) => {
      const start = 2 + dayIndex * 3;
      const presentations = activeDayOrders.has(day.order) ? [
        breakPairPresentation(
          findAssignment(day.order, location.id, "MORNING_BREAKS"),
          findAssignment(day.order, location.id, "AFTERNOON_BREAKS"),
        ),
        cellPresentation(findAssignment(day.order, location.id, "LONG_BREAK_1")),
        cellPresentation(findAssignment(day.order, location.id, "LONG_BREAK_2")),
      ] : WEEKLY_PACKAGE_HEADERS.map(() => ({ text: "TATİL / PLAN DIŞI", fill: COLORS.notRequired }));
      presentations.forEach((presentation, offset) => {
        const cell = row.getCell(start + offset);
        cell.value = presentation.text;
        cell.fill = solidFill(presentation.fill ?? WEEKLY_DAY_COLORS[dayIndex].body);
        cell.font = { color: { argb: COLORS.bodyText }, name: "Arial", size: 8 };
        cell.alignment = WRAP_CENTER;
        cell.border = THIN_BORDERS;
      });
    });
  }

  const legendRowNumber = sheet.rowCount + 2;
  const legendItems = [
    { from: 2, to: 4, label: "Otomatik atama", fill: WEEKLY_DAY_COLORS[0].body },
    { from: 5, to: 7, label: "Sabit atama", fill: COLORS.fixed },
    { from: 8, to: 10, label: "Manuel atama", fill: COLORS.manual },
    { from: 11, to: 13, label: "Açık görev", fill: COLORS.unassigned },
    { from: 14, to: 16, label: "Bu blokta görev yok", fill: COLORS.notRequired },
  ];
  sheet.getCell(legendRowNumber, 1).value = "Açıklama";
  sheet.getCell(legendRowNumber, 1).font = { bold: true, name: "Arial", size: 8 };
  for (const item of legendItems) {
    sheet.mergeCells(legendRowNumber, item.from, legendRowNumber, item.to);
    const cell = sheet.getCell(legendRowNumber, item.from);
    cell.value = item.label;
    cell.fill = solidFill(item.fill);
    cell.font = { name: "Arial", size: 8 };
    cell.alignment = WRAP_CENTER;
    cell.border = THIN_BORDERS;
  }

  if (unknownAssignments.length > 0) {
    const sectionRow = sheet.rowCount + 2;
    sheet.mergeCells(sectionRow, 1, sectionRow, totalColumns);
    const section = sheet.getCell(sectionRow, 1);
    section.value = "Tanımsız tarihsel bloklar";
    section.fill = solidFill(COLORS.title);
    section.font = { bold: true, color: { argb: COLORS.headerText }, name: "Arial", size: 9 };
    section.alignment = WRAP_LEFT;
    const header = sheet.addRow(["Gün", "Nöbet Yeri", "Blok", "Atama"]);
    header.eachCell((cell) => {
      cell.font = { bold: true, name: "Arial", size: 8 };
      cell.fill = solidFill(COLORS.notRequired);
      cell.border = THIN_BORDERS;
      cell.alignment = WRAP_CENTER;
    });
    for (const assignment of unknownAssignments.sort((a, b) => a.dayOrder - b.dayOrder || compareTr(a.dutyLocationName, b.dutyLocationName))) {
      const row = sheet.addRow([
        WEEKDAY_NAMES[assignment.dayOrder] ?? String(assignment.dayOrder),
        safeText(assignment.dutyLocationName),
        safeText(assignment.dutyBlockName),
        cellPresentation(assignment).text,
      ]);
      row.eachCell((cell) => {
        cell.border = THIN_BORDERS;
        cell.alignment = WRAP_LEFT;
        cell.font = { name: "Arial", size: 8 };
      });
    }
  }

  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: 5, topLeftCell: "B6", activeCell: "B6", showGridLines: false }];
  sheet.pageSetup.printArea = `A1:P${sheet.rowCount}`;
}

// ---------------------------------------------------------------------------
// 2) Öğretmen Görevleri
// ---------------------------------------------------------------------------

export interface TeacherDutyRow {
  teacherName: string;
  dayOrder: number;
  dayName: string;
  dutyLocationName: string;
  coverageMode: DutyPlanPackageCoverageMode;
  coverageLabel: string;
  blocksLabel: string;
  assignmentKindLabel: string;
}

function blocksLabelFromCodes(codes: readonly string[]): string {
  const rankOf = (code: string) => (isDutyBlockCode(code) ? DOMAIN_BLOCK_ORDER.indexOf(code) : Number.MAX_SAFE_INTEGER);
  return codes
    .map((code, index) => ({ code, index }))
    .sort((a, b) => rankOf(a.code) - rankOf(b.code) || a.index - b.index)
    .map((entry) => (isDutyBlockCode(entry.code) ? BLOCK_SHORT_LABELS[entry.code] : safeText(entry.code)))
    .join(", ");
}

/**
 * Öğretmen görev satırları. BİRİNCİL kaynak `plan.packages` — bir FULL_DAY
 * paketi dört hücreyi kapsasa bile TEK satır olur. Yalnız hiçbir pakete ait
 * OLMAYAN (eski/legacy) atamalar tek-blok fallback satırı olarak eklenir; bir
 * paketin `packageId` ile temsil ettiği atamalar tekrar EKLENMEZ, bu yüzden
 * duplicate satır oluşmaz.
 */
export function buildTeacherDutyRows(plan: FoundPublishedDutyPlan, columns: BlockColumn[]): TeacherDutyRow[] {
  const dayName = (order: number) => WEEKDAY_NAMES[order] ?? String(order);
  const rows: TeacherDutyRow[] = [];

  const packageIds = new Set<string>(plan.packages.map((p) => p.id));

  for (const pkg of plan.packages) {
    rows.push({
      teacherName: safeText(pkg.teacherName) || safeText(pkg.teacherSourceId),
      dayOrder: pkg.dayOrder,
      dayName: dayName(pkg.dayOrder),
      dutyLocationName: safeText(pkg.dutyLocationName),
      coverageMode: pkg.coverageMode,
      coverageLabel: COVERAGE_MODE_LABELS[pkg.coverageMode] ?? safeText(pkg.coverageMode),
      blocksLabel: blocksLabelFromCodes(pkg.coveredBlockCodes),
      assignmentKindLabel: ASSIGNMENT_KIND_LABELS[pkg.assignmentKind] ?? safeText(pkg.assignmentKind),
    });
  }

  const labelByBlockId = new Map(columns.map((c) => [c.dutyBlockId, c.label]));
  for (const assignment of plan.assignments) {
    if (assignment.assignmentKind === "unassigned" || !assignment.teacherName) continue;
    if (assignment.packageId && packageIds.has(assignment.packageId)) continue;
    rows.push({
      teacherName: safeText(assignment.teacherName),
      dayOrder: assignment.dayOrder,
      dayName: dayName(assignment.dayOrder),
      dutyLocationName: safeText(assignment.dutyLocationName),
      coverageMode: "SINGLE_BLOCK",
      coverageLabel: COVERAGE_MODE_LABELS.SINGLE_BLOCK,
      blocksLabel: labelByBlockId.get(assignment.dutyBlockId) ?? safeText(assignment.dutyBlockName),
      assignmentKindLabel: ASSIGNMENT_KIND_LABELS[assignment.assignmentKind] ?? safeText(assignment.assignmentKind),
    });
  }

  return rows.sort(
    (a, b) =>
      compareTr(a.teacherName, b.teacherName) ||
      a.dayOrder - b.dayOrder ||
      compareTr(a.dutyLocationName, b.dutyLocationName) ||
      COVERAGE_MODE_RANK[a.coverageMode] - COVERAGE_MODE_RANK[b.coverageMode],
  );
}

function buildTeacherDutiesSheet(workbook: Workbook, plan: FoundPublishedDutyPlan, columns: BlockColumn[]): void {
  const sheet = workbook.addWorksheet(DUTY_PLAN_SHEET_NAMES.teacherDuties);
  applyPageSetup(sheet);

  sheet.columns = [
    { header: "Öğretmen", key: "teacher", width: 30 },
    { header: "Gün", key: "day", width: 14 },
    { header: "Nöbet Yeri", key: "location", width: 32 },
    { header: "Görev Kapsamı", key: "coverage", width: 26 },
    { header: "Bloklar", key: "blocks", width: 38 },
    { header: "Atama Türü", key: "kind", width: 14 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.height = 22;
  headerRow.eachCell((cell) => {
    cell.fill = solidFill(COLORS.title);
    cell.font = { bold: true, color: { argb: COLORS.headerText } };
    cell.alignment = WRAP_CENTER;
    cell.border = THIN_BORDERS;
  });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } };

  for (const row of buildTeacherDutyRows(plan, columns)) {
    const added = sheet.addRow([row.teacherName, row.dayName, row.dutyLocationName, row.coverageLabel, row.blocksLabel, row.assignmentKindLabel]);
    added.eachCell((cell) => {
      cell.alignment = WRAP_LEFT;
      cell.border = THIN_BORDERS;
    });
  }
}

// ---------------------------------------------------------------------------
// 3) Yük Özeti
// ---------------------------------------------------------------------------

export type TeacherLoadStatus = "Minimumun altında" | "Hedefin altında" | "Dengeli" | "Hedefin üzerinde" | "Maksimum aşıldı" | "Hesaplanamadı";

export function resolveLoadStatus(total: number, thresholds: { min?: number; target?: number; max?: number }): TeacherLoadStatus {
  const { min, target, max } = thresholds;
  if (min === undefined && target === undefined && max === undefined) return "Hesaplanamadı";
  if (min !== undefined && total < min) return "Minimumun altında";
  if (target === undefined) return "Hesaplanamadı";
  if (total < target) return "Hedefin altında";
  if (total === target) return "Dengeli";
  if (max === undefined) return "Hesaplanamadı";
  return total <= max ? "Hedefin üzerinde" : "Maksimum aşıldı";
}

/** Öğretmen adını YALNIZ tarihsel snapshot kaynaklarından çözer; canlı tabloya BAKMAZ. */
function buildTeacherNameById(plan: FoundPublishedDutyPlan): Map<string, string> {
  const map = new Map<string, string>();
  // Öncelik: paketler, sonra atamalar. Atamalar yalnız pakette olmayanı doldurur.
  for (const assignment of plan.assignments) {
    if (assignment.teacherSourceId && assignment.teacherName && !map.has(assignment.teacherSourceId)) {
      map.set(assignment.teacherSourceId, safeText(assignment.teacherName));
    }
  }
  for (const pkg of plan.packages) {
    if (pkg.teacherSourceId && pkg.teacherName) map.set(pkg.teacherSourceId, safeText(pkg.teacherName));
  }
  return map;
}

function buildLoadSummarySheet(workbook: Workbook, plan: FoundPublishedDutyPlan): void {
  const sheet = workbook.addWorksheet(DUTY_PLAN_SHEET_NAMES.loadSummary);
  applyPageSetup(sheet);

  sheet.columns = [
    { header: "Öğretmen", key: "teacher", width: 30 },
    { header: "Normal Görev", key: "normal", width: 15 },
    { header: "Sabit Görev Günü", key: "fixed", width: 18 },
    { header: "Toplam Görev", key: "total", width: 15 },
    { header: "Minimum", key: "min", width: 11 },
    { header: "Hedef", key: "target", width: 11 },
    { header: "Maksimum", key: "max", width: 12 },
    { header: "Durum", key: "status", width: 22 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.height = 22;
  headerRow.eachCell((cell) => {
    cell.fill = solidFill(COLORS.title);
    cell.font = { bold: true, color: { argb: COLORS.headerText } };
    cell.alignment = WRAP_CENTER;
    cell.border = THIN_BORDERS;
  });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 8 } };

  const nameById = buildTeacherNameById(plan);
  const options = plan.generationOptions ?? {};
  const thresholds = {
    min: typeof options.minWeeklyDuties === "number" ? options.minWeeklyDuties : undefined,
    target: typeof options.targetWeeklyDuties === "number" ? options.targetWeeklyDuties : undefined,
    max: typeof options.maxWeeklyDuties === "number" ? options.maxWeeklyDuties : undefined,
  };
  const dash = "—";

  const loads: SolverTeacherLoad[] = plan.summary?.teacherLoads ?? [];
  const sorted = loads
    .slice()
    .sort((a, b) => compareTr(nameById.get(a.teacherSourceId) ?? a.teacherSourceId, nameById.get(b.teacherSourceId) ?? b.teacherSourceId));

  for (const load of sorted) {
    const row = sheet.addRow([
      nameById.get(load.teacherSourceId) ?? safeText(load.teacherSourceId),
      load.normalDutyCount,
      load.fixedDutyDayCount,
      load.totalDutyCount,
      thresholds.min ?? dash,
      thresholds.target ?? dash,
      thresholds.max ?? dash,
      resolveLoadStatus(load.totalDutyCount, thresholds),
    ]);
    row.eachCell((cell, colNumber) => {
      cell.alignment = colNumber === 1 || colNumber === 8 ? WRAP_LEFT : WRAP_CENTER;
      cell.border = THIN_BORDERS;
    });
  }
}

// ---------------------------------------------------------------------------

export async function buildPublishedDutyPlanWorkbook(plan: FoundPublishedDutyPlan): Promise<Workbook> {
  const workbook = new Workbook();
  workbook.creator = "Nöbet Planı";
  workbook.created = new Date();

  const columns = resolveBlockColumns(plan);
  buildWeeklySheet(workbook, plan, columns);
  buildTeacherDutiesSheet(workbook, plan, columns);
  buildLoadSummarySheet(workbook, plan);

  return workbook;
}
