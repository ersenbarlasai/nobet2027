import { buildExamInvigilationWorkbook } from "./buildExamInvigilationWorkbook";
import { planExamDates, type FoundExamPlan } from "../examInvigilation/planView";

export const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const FILE_NAME_PREFIX = "deneme-sinavi-gozetmen-listesi";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * `deneme-sinavi-gozetmen-listesi_YYYY-AA-GG.xlsx`. Tarih planın ilk sınav
 * gününden gelir; geçersizse bugünün tarihi kullanılır. Ad yalnız rakam ve
 * tireden kurulur, ayrıca son bir süzgeçten geçirilir — dosya sisteminde
 * geçersiz olabilecek karakterler (`\ / : * ? " < > |`, kontrol karakterleri)
 * ada ASLA giremez.
 */
export function buildExamInvigilationFileName(plan: FoundExamPlan): string {
  const iso = planExamDates(plan)[0] ?? plan.examDate;
  const parsed = new Date(`${iso}T00:00:00`);
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const stamp = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return `${FILE_NAME_PREFIX}_${stamp.replace(/[^0-9-]/g, "")}.xlsx`;
}

/**
 * Tamamlanmış gözetmen listesini XLSX olarak indirir. Ek bir file-saver
 * paketi KULLANMAZ: Blob + `URL.createObjectURL` + geçici anchor, ardından
 * `revokeObjectURL`. Plan nesnesi çağırandan gelir — API'ye ikinci bir istek
 * yapılmaz.
 */
export async function downloadExamInvigilationXlsx(plan: FoundExamPlan): Promise<void> {
  const workbook = await buildExamInvigilationWorkbook(plan);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer as ArrayBuffer], { type: XLSX_MIME_TYPE });

  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = buildExamInvigilationFileName(plan);
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  } finally {
    URL.revokeObjectURL(url);
  }
}
