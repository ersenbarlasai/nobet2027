import { SYSTEM_DATA_TRIAL_CLEAR_URL, SYSTEM_DATA_TRIAL_COUNTS_URL } from "../localApi";
import type { SystemDataApiError, TrialDataCounts } from "./types";

export const CLEAR_TRIAL_RECORDS_CONFIRMATION = "KAYITLARI TEMİZLE";

export class SystemDataFetchError extends Error {}

export class SystemDataApiFieldError extends Error {
  apiError: SystemDataApiError;
  constructor(apiError: SystemDataApiError) {
    super(apiError.message);
    this.apiError = apiError;
  }
}

async function readErrorBody(response: Response): Promise<SystemDataApiError | null> {
  try {
    const body = (await response.json()) as { error?: SystemDataApiError };
    return body.error ?? null;
  } catch {
    return null;
  }
}

export async function fetchTrialDataCounts(signal?: AbortSignal): Promise<TrialDataCounts> {
  const response = await fetch(SYSTEM_DATA_TRIAL_COUNTS_URL, { signal });
  if (!response.ok) {
    const apiError = await readErrorBody(response);
    if (apiError) throw new SystemDataApiFieldError(apiError);
    throw new SystemDataFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  return (await response.json()) as TrialDataCounts;
}

export async function clearTrialRecords(): Promise<TrialDataCounts> {
  const response = await fetch(SYSTEM_DATA_TRIAL_CLEAR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmationText: CLEAR_TRIAL_RECORDS_CONFIRMATION }),
  });
  if (!response.ok) {
    const apiError = await readErrorBody(response);
    if (apiError) throw new SystemDataApiFieldError(apiError);
    throw new SystemDataFetchError(`Beklenmeyen HTTP durumu: ${response.status}`);
  }
  const body = (await response.json()) as { deleted: TrialDataCounts };
  return body.deleted;
}
