import { DUTY_LOCATIONS_URL, dutyLocationUrl } from "../localApi";
import type {
  DutyLocation,
  DutyLocationApiError,
  DutyLocationCreateInput,
  DutyLocationListParams,
  DutyLocationListResponse,
  DutyLocationUpdateInput,
} from "./types";

/** HTTP/ağ hatası — sunucudan alan bazlı bir hata gövdesi gelmedi. AbortError bu tipe ait DEĞİLDİR. */
export class DutyLocationFetchError extends Error {}

/** Sunucunun döndürdüğü alan bazlı hata (ör. DUPLICATE_SHORT_CODE). */
export class DutyLocationApiFieldError extends Error {
  apiError: DutyLocationApiError;
  constructor(apiError: DutyLocationApiError) {
    super(apiError.message);
    this.apiError = apiError;
  }
}

async function readErrorBody(response: Response): Promise<DutyLocationApiError | null> {
  try {
    const body = (await response.json()) as { error?: DutyLocationApiError };
    return body.error ?? null;
  } catch {
    return null;
  }
}

export async function fetchDutyLocations(params: DutyLocationListParams, signal?: AbortSignal): Promise<DutyLocationListResponse> {
  const query = new URLSearchParams({
    search: params.search,
    category: params.category,
    status: params.status,
    sort: params.sort,
    page: String(params.page),
    pageSize: String(params.pageSize),
  });
  const response = await fetch(`${DUTY_LOCATIONS_URL}?${query.toString()}`, { signal });
  if (!response.ok) {
    throw new DutyLocationFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as DutyLocationListResponse;
}

export async function createDutyLocation(input: DutyLocationCreateInput): Promise<DutyLocation> {
  const response = await fetch(DUTY_LOCATIONS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const apiError = await readErrorBody(response);
    if (apiError) throw new DutyLocationApiFieldError(apiError);
    throw new DutyLocationFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as DutyLocation;
}

export async function updateDutyLocation(id: string, input: DutyLocationUpdateInput): Promise<DutyLocation> {
  const response = await fetch(dutyLocationUrl(id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const apiError = await readErrorBody(response);
    if (apiError) throw new DutyLocationApiFieldError(apiError);
    throw new DutyLocationFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as DutyLocation;
}

export async function deleteDutyLocation(id: string): Promise<void> {
  const response = await fetch(dutyLocationUrl(id), { method: "DELETE" });
  if (!response.ok) {
    const apiError = await readErrorBody(response);
    if (apiError) throw new DutyLocationApiFieldError(apiError);
    throw new DutyLocationFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
}
