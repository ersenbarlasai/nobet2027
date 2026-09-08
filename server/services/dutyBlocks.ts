import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Dört nöbet bloğu, veritabanındaki `duty_blocks` referans tablosundan okunur
 * (bkz. supabase/migrations/20260910090000_create_duty_block_model.sql).
 * Kodlar backend'de SABİT bir liste olarak TEKRARLANMAZ — tek doğruluk
 * kaynağı veritabanıdır; burada yalnızca tip düzeyinde daraltılır.
 */
export const DUTY_BLOCK_CODES = ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"] as const;

export type DutyBlockCode = (typeof DUTY_BLOCK_CODES)[number];

export interface DutyBlockDto {
  id: string;
  code: DutyBlockCode;
  name: string;
  blockOrder: number;
  /** lesson_periods.name ile eşleşen çakışan ders saati; NULL ise bu blokta ders çakışması kuralı yoktur. */
  conflictPeriodName: string | null;
}

interface DutyBlockRow {
  id: string;
  code: DutyBlockCode;
  name: string;
  block_order: number;
  conflict_period_name: string | null;
}

interface DutyLocationBlockRow {
  duty_location_id: string;
  duty_block_id: string;
  assignment_mode: "normal" | "fixed_only";
}

export interface DutyLocationBlockPolicyDto {
  dutyBlockId: string;
  assignmentMode: "normal" | "fixed_only";
}

export class DutyBlockQueryError extends Error {}

/** Aktif nöbet bloklarını gün içi sırasına göre döner. */
export async function fetchDutyBlocks(supabase: SupabaseClient): Promise<DutyBlockDto[]> {
  const { data, error } = await supabase
    .from("duty_blocks")
    .select("id, code, name, block_order, conflict_period_name")
    .eq("is_active", true)
    .order("block_order", { ascending: true });

  if (error) {
    throw new DutyBlockQueryError("Nöbet blokları alınamadı.");
  }
  return (data as DutyBlockRow[]).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    blockOrder: row.block_order,
    conflictPeriodName: row.conflict_period_name,
  }));
}

/**
 * Verilen nöbet yerleri için blok eşlemesini `{ dutyLocationId: blockId[] }`
 * biçiminde döner. Blok sırası korunur (blockOrder'a göre), böylece çağıran
 * taraf ayrıca sıralamak zorunda kalmaz.
 *
 * Boş `locationIds` ile hiç sorgu atılmaz — PostgREST'e anlamsız bir
 * `in.()` isteği göndermemek için.
 */
export async function fetchLocationBlockMap(
  supabase: SupabaseClient,
  locationIds: string[],
  blocks: DutyBlockDto[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (locationIds.length === 0) return map;

  const { data, error } = await supabase
    .from("duty_location_blocks")
    .select("duty_location_id, duty_block_id")
    .in("duty_location_id", locationIds);

  if (error) {
    throw new DutyBlockQueryError("Nöbet yeri blok eşlemesi alınamadı.");
  }

  const orderOf = new Map(blocks.map((b, index) => [b.id, index]));
  for (const row of data as DutyLocationBlockRow[]) {
    // Pasifleştirilmiş bir bloğa ait eşleme dışarıda bırakılır: `blocks`
    // yalnız aktif blokları içerir ve UI o sütunu hiç çizmez.
    if (!orderOf.has(row.duty_block_id)) continue;
    const current = map.get(row.duty_location_id);
    if (current) current.push(row.duty_block_id);
    else map.set(row.duty_location_id, [row.duty_block_id]);
  }

  for (const ids of map.values()) {
    ids.sort((a, b) => (orderOf.get(a) ?? 0) - (orderOf.get(b) ?? 0));
  }
  return map;
}

/** Yer×blok kararını assignment_mode ile birlikte döndürür. Eşlemesi olmayan
 * blok arayüzde `off` olarak yorumlanır; burada sentetik satır üretilmez. */
export async function fetchLocationBlockPolicyMap(
  supabase: SupabaseClient,
  locationIds: string[],
  blocks: DutyBlockDto[],
): Promise<Map<string, DutyLocationBlockPolicyDto[]>> {
  const map = new Map<string, DutyLocationBlockPolicyDto[]>();
  if (locationIds.length === 0) return map;

  const { data, error } = await supabase
    .from("duty_location_blocks")
    .select("duty_location_id, duty_block_id, assignment_mode")
    .in("duty_location_id", locationIds);
  if (error) throw new DutyBlockQueryError("Nöbet yeri blok politikaları alınamadı.");

  const orderOf = new Map(blocks.map((block, index) => [block.id, index]));
  for (const row of data as DutyLocationBlockRow[]) {
    if (!orderOf.has(row.duty_block_id)) continue;
    const item = { dutyBlockId: row.duty_block_id, assignmentMode: row.assignment_mode ?? "normal" };
    const current = map.get(row.duty_location_id);
    if (current) current.push(item);
    else map.set(row.duty_location_id, [item]);
  }
  for (const policies of map.values()) {
    policies.sort((a, b) => (orderOf.get(a.dutyBlockId) ?? 0) - (orderOf.get(b.dutyBlockId) ?? 0));
  }
  return map;
}
