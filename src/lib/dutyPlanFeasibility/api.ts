import { DUTY_PLAN_FEASIBILITY_URL } from "../localApi";
import type { DutyPlanFeasibilityResponse } from "./types";

/** HTTP/RPC hatası — analiz alınamadı. AbortError bu tipe ait DEĞİLDİR. */
export class DutyPlanFeasibilityFetchError extends Error {}

/**
 * Planlanabilirlik analizini çeker. SALT OKUNUR uç nokta — bu modülde
 * bilinçli olarak hiçbir yazma fonksiyonu yoktur.
 */
export async function fetchDutyPlanFeasibility(signal?: AbortSignal): Promise<DutyPlanFeasibilityResponse> {
  const response = await fetch(DUTY_PLAN_FEASIBILITY_URL, { signal });
  if (!response.ok) {
    throw new DutyPlanFeasibilityFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as DutyPlanFeasibilityResponse;
}
