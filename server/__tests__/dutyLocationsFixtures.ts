import { vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface FakeResult {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
}

/** Dört nöbet bloğu — duty_blocks referans tablosunun sahte karşılığı. */
export const FAKE_BLOCKS = [
  { id: "aaaaaaaa-0000-0000-0000-000000000001", code: "MORNING_BREAKS", name: "Sabah Teneffüs Bloğu", block_order: 1, conflict_period_name: null },
  { id: "aaaaaaaa-0000-0000-0000-000000000002", code: "LONG_BREAK_1", name: "Uzun Nöbet 1", block_order: 2, conflict_period_name: "5-OO" },
  { id: "aaaaaaaa-0000-0000-0000-000000000003", code: "LONG_BREAK_2", name: "Uzun Nöbet 2", block_order: 3, conflict_period_name: "5-IO" },
  { id: "aaaaaaaa-0000-0000-0000-000000000004", code: "AFTERNOON_BREAKS", name: "Öğleden Sonra Teneffüs Bloğu", block_order: 4, conflict_period_name: null },
];

export const FAKE_BLOCK_IDS = FAKE_BLOCKS.map((b) => b.id);

export const FAKE_BLOCKS_DTO = FAKE_BLOCKS.map((b) => ({
  id: b.id,
  code: b.code,
  name: b.name,
  blockOrder: b.block_order,
  conflictPeriodName: b.conflict_period_name,
}));

/**
 * duty_locations servisinin kullandığı zincirleme metotları (select/eq/is/or/
 * in/order/range/insert/update/maybeSingle/single) taklit eden minimal, sıra
 * bağımlı (queue tabanlı) sahte sorgu oluşturucu. Her `.from(...)` çağrısı,
 * kuyruktaki BİR SONRAKİ sonucu tüketen yeni bir zincir döner — servis
 * kodunun gerçek istek sırasına göre kuyruk hazırlanmalıdır (bkz. testlerdeki
 * yorumlar).
 *
 * İSTİSNA — blok tabloları: `duty_blocks` ve `duty_location_blocks` sorguları
 * kuyruğu TÜKETMEZ; sabit bir referans cevabı dönerler. Böylece dört bloklu
 * modele geçişte mevcut testlerdeki kuyruk sıraları (kampüs → sayımlar →
 * liste) olduğu gibi geçerli kalır ve her test dosyasına iki ekstra "gürültü"
 * satırı eklemek gerekmez. Varsayılan olarak istenen HER nöbet yeri dört
 * bloğa da bağlıdır.
 */
export function createFakeSupabase(
  queue: FakeResult[],
  rpcImpl?: (fn: string, args: unknown) => Promise<FakeResult>,
): SupabaseClient {
  let cursor = 0;

  function nextResult(): FakeResult {
    const result = queue[cursor];
    cursor += 1;
    if (!result) {
      throw new Error(`createFakeSupabase: kuyrukta yeterli sonuç yok (index ${cursor - 1}).`);
    }
    return result;
  }

  function makeChain(table: string) {
    const chain: Record<string, unknown> = {};
    // Blok tabloları için `in(...)` ile istenen nöbet yeri kimlikleri.
    let requestedIds: string[] = [];

    const chainMethods = ["select", "eq", "is", "or", "order", "range", "insert", "update"];
    for (const method of chainMethods) {
      chain[method] = vi.fn(() => chain);
    }
    chain.in = vi.fn((_column: string, values: string[]) => {
      requestedIds = values;
      return chain;
    });

    function resultFor(): FakeResult {
      if (table === "duty_blocks") return { data: FAKE_BLOCKS, error: null };
      if (table === "duty_location_blocks") {
        return {
          data: requestedIds.flatMap((locationId) =>
            FAKE_BLOCK_IDS.map((blockId) => ({ duty_location_id: locationId, duty_block_id: blockId, assignment_mode: "normal" })),
          ),
          error: null,
        };
      }
      return nextResult();
    }

    chain.maybeSingle = vi.fn(() => Promise.resolve(resultFor()));
    chain.single = vi.fn(() => Promise.resolve(resultFor()));
    // range()/select() sonrası doğrudan await edilen (single/maybeSingle
    // çağrılmayan) durumlar için thenable.
    chain.then = (onFulfilled: (result: FakeResult) => unknown, onRejected?: (err: unknown) => unknown) =>
      Promise.resolve(resultFor()).then(onFulfilled, onRejected);
    return chain;
  }

  return {
    from: vi.fn((table: string) => makeChain(table)),
    rpc: vi.fn((fn: string, args: unknown) => (rpcImpl ? rpcImpl(fn, args) : Promise.resolve(nextResult()))),
  } as unknown as SupabaseClient;
}

export function testConfig() {
  return {
    supabaseUrl: "https://example.supabase.co",
    supabaseSecretKey: "sb_secret_TEST_VALUE_MUST_NEVER_LEAK_9f8a7c",
    port: 3001,
    allowedOrigin: "http://localhost:5173",
    campusName: "Test Kampüs",
    academicYearName: "2026-2027",
  };
}

export const FAKE_CAMPUS_ID = "11111111-1111-1111-1111-111111111111";

export function campusFoundResult(): FakeResult {
  return { data: { id: FAKE_CAMPUS_ID }, error: null };
}

export function dutyLocationRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    campus_id: FAKE_CAMPUS_ID,
    name: "Ön Bahçe",
    short_code: "ON-BAH",
    category: "garden",
    capacity: 2,
    description: null,
    is_active: true,
    sort_order: 1,
    allows_fixed_assignment: false,
    created_at: "2026-09-01T10:00:00.000Z",
    updated_at: "2026-09-01T10:00:00.000Z",
    deleted_at: null,
    ...overrides,
  };
}
