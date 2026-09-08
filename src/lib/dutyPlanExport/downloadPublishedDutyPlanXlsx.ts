import { buildPublishedDutyPlanWorkbook, type FoundPublishedDutyPlan } from "./buildPublishedDutyPlanWorkbook";

export const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const FILE_NAME_PREFIX = "haftalik-nobet-plani";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * `haftalik-nobet-plani-YYYY-MM-DD.xlsx`. Tarih planın `updatedAt` alanından
 * gelir; geçersizse bugünün tarihi kullanılır. Ad yalnız rakam ve tireden
 * kurulur, ayrıca son bir süzgeçten geçirilir — dosya sisteminde geçersiz
 * olabilecek karakterler (`\\ / : * ? " < > |`, kontrol karakterleri) ada
 * ASLA giremez.
 */
export function buildPublishedDutyPlanFileName(updatedAt: string): string {
  const parsed = new Date(updatedAt);
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const stamp = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  const safeStamp = stamp.replace(/[^0-9-]/g, "");
  return `${FILE_NAME_PREFIX}-${safeStamp}.xlsx`;
}

/**
 * Yayımlanmış planı XLSX olarak indirir. Ek bir file-saver paketi KULLANMAZ:
 * Blob + `URL.createObjectURL` + geçici anchor, ardından `revokeObjectURL`.
 * Plan nesnesi çağırandan gelir — burada API'ye ikinci bir istek YAPILMAZ.
 */
export async function downloadPublishedDutyPlanXlsx(plan: FoundPublishedDutyPlan): Promise<void> {
  const workbook = await buildPublishedDutyPlanWorkbook(plan);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer as ArrayBuffer], { type: XLSX_MIME_TYPE });

  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = buildPublishedDutyPlanFileName(plan.updatedAt);
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Tarayıcı indirmeyi kuyruğa alsın diye bir makro-görev bekle, sonra bırak.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
