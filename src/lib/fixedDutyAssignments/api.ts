import { FIXED_DUTY_ASSIGNMENTS_URL } from "../localApi";
import type { FixedDutySnapshot } from "./types";

export class FixedDutyApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return body?.message ?? "İşlem tamamlanamadı.";
}

export async function fetchFixedDuties(signal?: AbortSignal): Promise<FixedDutySnapshot> {
  const response = await fetch(FIXED_DUTY_ASSIGNMENTS_URL, { signal });
  if (!response.ok) throw new FixedDutyApiError(response.status, await readError(response));
  return response.json() as Promise<FixedDutySnapshot>;
}

export async function createFixedDuty(input: { teacherId: string; dayOrder: number; dutyLocationId: string }): Promise<void> {
  const response = await fetch(FIXED_DUTY_ASSIGNMENTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new FixedDutyApiError(response.status, await readError(response));
}

export async function removeFixedDuty(id: string): Promise<void> {
  const response = await fetch(`${FIXED_DUTY_ASSIGNMENTS_URL}/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new FixedDutyApiError(response.status, await readError(response));
}
