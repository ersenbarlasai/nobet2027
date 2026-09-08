import { it } from "vitest";
import { writeFile } from "node:fs/promises";
import { buildPublishedDutyPlanWorkbook } from "../buildPublishedDutyPlanWorkbook";
import { fullPublishedPlan } from "./fixtures";

// Yalnız GÖRSEL doğrulama için örnek dosya üretir — gerçek kullanıcı verisi KULLANILMAZ.
it.skipIf(!process.env.EMIT_XLSX_SAMPLE)("örnek XLSX dosyası üretir", async () => {
  const wb = await buildPublishedDutyPlanWorkbook(fullPublishedPlan());
  const buf = await wb.xlsx.writeBuffer();
  await writeFile(process.env.EMIT_XLSX_SAMPLE as string, Buffer.from(buf as ArrayBuffer));
});
