import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateDutyLocationInput, DutyLocationCategory, ListQuery, UpdateDutyLocationInput } from "../validation/dutyLocations";
import {
  DutyBlockQueryError,
  fetchDutyBlocks,
  fetchLocationBlockPolicyMap,
  type DutyBlockDto,
  type DutyLocationBlockPolicyDto,
} from "./dutyBlocks";

export type DutyLocationErrorCode = "VALIDATION_ERROR" | "DUPLICATE_NAME" | "DUPLICATE_SHORT_CODE" | "NOT_FOUND" | "CONFLICT" | "DATABASE_ERROR";

/** Alan bazlı, kullanıcıya güvenle gösterilebilir hata. Ham Postgres mesajı/stack ASLA taşımaz. */
export class DutyLocationError extends Error {
  code: DutyLocationErrorCode;
  field?: string;

  constructor(code: DutyLocationErrorCode, message: string, field?: string) {
    super(message);
    this.code = code;
    this.field = field;
  }
}

export interface DutyLocationDto {
  id: string;
  name: string;
  shortCode: string;
  category: DutyLocationCategory;
  capacity: number;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  /**
   * Sabit nöbet bu yere verilebilir mi (yalnız ILKOKUL1/ILKOKUL2). Okulun
   * doğrulanmış iş kuralıdır; arayüzden DEĞİŞTİRİLEMEZ — salt-okunur
   * gösterilir (bkz. 20260910090000_create_duty_block_model.sql).
   */
  allowsFixedAssignment: boolean;
  /**
   * Bu yerin görev istediği nöbet blokları (gün içi sırasında). Yine
   * arayüzden düzenlenemez; her blokta tam olarak 1 öğretmen gerekir.
   * Liste ayrı bir sorgudan doldurulur, bu yüzden yalnız listeleme
   * uçlarında anlamlıdır (create/update tekil cevaplarında da doldurulur).
   */
  blockIds: string[];
  blockPolicies: DutyLocationBlockPolicyDto[];
  createdAt: string;
  updatedAt: string;
}

interface DutyLocationRow {
  id: string;
  name: string;
  short_code: string;
  category: DutyLocationCategory;
  capacity: number;
  description: string | null;
  is_active: boolean;
  sort_order: number;
  allows_fixed_assignment?: boolean;
  created_at: string;
  updated_at: string;
}

function toDto(row: DutyLocationRow, blockPolicies: DutyLocationBlockPolicyDto[] = []): DutyLocationDto {
  return {
    id: row.id,
    name: row.name,
    shortCode: row.short_code,
    category: row.category,
    capacity: row.capacity,
    description: row.description,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    // Sütun her zaman NOT NULL DEFAULT false'tur; `?? false` yalnızca
    // sütunu seçmeyen eski bir sorgu yolunun sessizce `undefined`
    // sızdırmasına karşı savunmadır.
    allowsFixedAssignment: row.allows_fixed_assignment ?? false,
    blockIds: blockPolicies.map((policy) => policy.dutyBlockId),
    blockPolicies,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Verilen satırları blok eşlemesiyle birlikte DTO'ya çevirir. Blok sorgusu
 * başarısız olursa istek TAMAMEN başarısız olur — blokları sessizce boş
 * göstermek, kullanıcıya "bu yer hiçbir blokta görev istemiyor" gibi YANLIŞ
 * bir bilgi verirdi.
 */
async function toDtosWithBlocks(supabase: SupabaseClient, rows: DutyLocationRow[]): Promise<DutyLocationDto[]> {
  if (rows.length === 0) return [];
  let blocks: DutyBlockDto[];
  let policyMap: Map<string, DutyLocationBlockPolicyDto[]>;
  try {
    blocks = await fetchDutyBlocks(supabase);
    policyMap = await fetchLocationBlockPolicyMap(supabase, rows.map((r) => r.id), blocks);
  } catch (err) {
    throw new DutyLocationError(
      "DATABASE_ERROR",
      err instanceof DutyBlockQueryError ? err.message : "Nöbet blokları alınamadı.",
    );
  }
  return rows.map((row) => toDto(row, policyMap.get(row.id) ?? []));
}

/** ILIKE'a geçirilecek kullanıcı girdisindeki wildcard karakterlerini (\, %, _) kaçışlar — arama metnine doğrudan wildcard anlamı kazandırılmaz. */
function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Tek-kampüs mimarisi: kampüs adına göre bulur, yoksa oluşturur (mevcut
 * import_timetable_snapshot RPC'sindeki find-or-create deseniyle aynı
 * mantık). service_role RLS'yi bypass ettiği için düz tablo erişimi güvenli.
 */
export async function getOrCreateCampusId(supabase: SupabaseClient, campusName: string): Promise<string> {
  const { data: existing, error: selectError } = await supabase
    .from("campuses")
    .select("id")
    .eq("name", campusName)
    .maybeSingle();
  if (selectError) {
    throw new DutyLocationError("DATABASE_ERROR", "Kampüs bilgisi alınamadı.");
  }
  if (existing) return (existing as { id: string }).id;

  const { data: created, error: insertError } = await supabase
    .from("campuses")
    .insert({ name: campusName })
    .select("id")
    .single();
  if (insertError || !created) {
    throw new DutyLocationError("DATABASE_ERROR", "Kampüs oluşturulamadı.");
  }
  return (created as { id: string }).id;
}

function mapWriteError(error: { message?: string } | null): DutyLocationError {
  const message = error?.message ?? "";
  if (message.includes("duty_locations_campus_short_code_unique_idx")) {
    return new DutyLocationError("DUPLICATE_SHORT_CODE", "Bu kısa kod başka bir nöbet yerinde kullanılıyor.", "shortCode");
  }
  if (message.includes("duty_locations_campus_name_unique_idx")) {
    return new DutyLocationError("DUPLICATE_NAME", "Bu nöbet yeri adı başka bir kayıtta kullanılıyor.", "name");
  }
  if (message.includes("duty_location_version_conflict")) {
    return new DutyLocationError("CONFLICT", "Nöbet yeri başka bir oturumda değiştirildi. Güncel veriyi yükleyip tekrar deneyin.");
  }
  if (message.includes("block_policy") || message.includes("morning_afternoon") || message.includes("lunch_blocks")) {
    return new DutyLocationError("VALIDATION_ERROR", "Nöbet bloğu seçimi geçersiz. Sabah ve Öğleden Sonra aynı türde olmalı; öğle blokları sabit olamaz.", "blockPolicies");
  }
  return new DutyLocationError("DATABASE_ERROR", "Beklenmeyen bir veritabanı hatası oluştu.");
}

export async function createDutyLocation(
  supabase: SupabaseClient,
  campusId: string,
  input: CreateDutyLocationInput,
): Promise<DutyLocationDto> {
  const { data, error } = await supabase.rpc("create_duty_location_with_block_policies", {
    p_campus_id: campusId,
    p_name: input.name,
    p_short_code: input.shortCode,
    p_category: input.category,
    p_capacity: input.capacity,
    p_description: input.description,
    p_is_active: input.isActive,
    p_policies: input.blockPolicies.map((policy) => ({ duty_block_id: policy.dutyBlockId, assignment_mode: policy.assignmentMode })),
  });
  if (error || !data) {
    throw mapWriteError(error);
  }
  return (await toDtosWithBlocks(supabase, [data as DutyLocationRow]))[0];
}

export interface DutyLocationListResult {
  items: DutyLocationDto[];
  /**
   * Blok kataloğu (gün içi sırasında). Listeyle birlikte döner ki frontend
   * `item.blockIds` değerlerini ayrı bir istek atmadan ada/koda çevirebilsin.
   */
  blocks: DutyBlockDto[];
  summary: { total: number; active: number; inactive: number };
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
}

const SORT_COLUMNS: Record<ListQuery["sort"], { column: string; ascending: boolean }> = {
  order: { column: "sort_order", ascending: true },
  name: { column: "name", ascending: true },
  category: { column: "category", ascending: true },
  active: { column: "is_active", ascending: false },
};

export async function listDutyLocations(
  supabase: SupabaseClient,
  campusId: string,
  query: ListQuery,
): Promise<DutyLocationListResult> {
  const [activeCountResult, inactiveCountResult] = await Promise.all([
    supabase
      .from("duty_locations")
      .select("id", { count: "exact", head: true })
      .eq("campus_id", campusId)
      .is("deleted_at", null)
      .eq("is_active", true),
    supabase
      .from("duty_locations")
      .select("id", { count: "exact", head: true })
      .eq("campus_id", campusId)
      .is("deleted_at", null)
      .eq("is_active", false),
  ]);
  if (activeCountResult.error || inactiveCountResult.error) {
    throw new DutyLocationError("DATABASE_ERROR", "Nöbet yerleri alınamadı.");
  }
  const active = activeCountResult.count ?? 0;
  const inactive = inactiveCountResult.count ?? 0;

  let listQuery = supabase
    .from("duty_locations")
    .select("*", { count: "exact" })
    .eq("campus_id", campusId)
    .is("deleted_at", null);

  if (query.status === "active") listQuery = listQuery.eq("is_active", true);
  if (query.status === "inactive") listQuery = listQuery.eq("is_active", false);
  if (query.category) listQuery = listQuery.eq("category", query.category);
  if (query.search.trim() !== "") {
    const pattern = `%${escapeLikePattern(query.search.trim())}%`;
    listQuery = listQuery.or(`name.ilike.${pattern},short_code.ilike.${pattern}`);
  }

  const sort = SORT_COLUMNS[query.sort];
  listQuery = listQuery.order(sort.column, { ascending: sort.ascending });
  if (query.sort !== "order") listQuery = listQuery.order("sort_order", { ascending: true });

  const from = (query.page - 1) * query.pageSize;
  const to = from + query.pageSize - 1;
  listQuery = listQuery.range(from, to);

  const { data, error, count } = await listQuery;
  if (error) {
    throw new DutyLocationError("DATABASE_ERROR", "Nöbet yerleri alınamadı.");
  }

  const totalItems = count ?? 0;
  let blocks: DutyBlockDto[];
  try {
    blocks = await fetchDutyBlocks(supabase);
  } catch {
    throw new DutyLocationError("DATABASE_ERROR", "Nöbet blokları alınamadı.");
  }

  return {
    items: await toDtosWithBlocks(supabase, data as DutyLocationRow[]),
    blocks,
    summary: { total: active + inactive, active, inactive },
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      totalItems,
      totalPages: Math.max(1, Math.ceil(totalItems / query.pageSize)),
    },
  };
}

export async function updateDutyLocation(
  supabase: SupabaseClient,
  campusId: string,
  id: string,
  input: UpdateDutyLocationInput,
): Promise<DutyLocationDto> {
  if (input.blockPolicies !== undefined) {
    if (
      input.name === undefined || input.category === undefined || input.capacity === undefined ||
      input.isActive === undefined || input.expectedUpdatedAt === undefined
    ) {
      throw new DutyLocationError("VALIDATION_ERROR", "Blok politikalarıyla birlikte nöbet yerinin güncel tüm alanları gönderilmelidir.");
    }
    const { data, error } = await supabase.rpc("update_duty_location_with_block_policies", {
      p_campus_id: campusId,
      p_duty_location_id: id,
      p_name: input.name,
      p_category: input.category,
      p_capacity: input.capacity,
      p_description: input.description ?? null,
      p_is_active: input.isActive,
      p_policies: input.blockPolicies.map((policy) => ({ duty_block_id: policy.dutyBlockId, assignment_mode: policy.assignmentMode })),
      p_expected_updated_at: input.expectedUpdatedAt,
    });
    if (error || !data) throw mapWriteError(error);
    return (await toDtosWithBlocks(supabase, [data as DutyLocationRow]))[0];
  }

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.category !== undefined) patch.category = input.category;
  if (input.capacity !== undefined) patch.capacity = input.capacity;
  if (input.description !== undefined) patch.description = input.description;
  if (input.isActive !== undefined) patch.is_active = input.isActive;

  const { data, error } = await supabase
    .from("duty_locations")
    .update(patch)
    .eq("id", id)
    .eq("campus_id", campusId)
    .is("deleted_at", null)
    .select("*")
    .maybeSingle();

  if (error) {
    throw mapWriteError(error);
  }
  if (!data) {
    throw new DutyLocationError("NOT_FOUND", "Nöbet yeri bulunamadı.");
  }
  return (await toDtosWithBlocks(supabase, [data as DutyLocationRow]))[0];
}

export async function softDeleteDutyLocation(supabase: SupabaseClient, campusId: string, id: string): Promise<void> {
  const { data, error } = await supabase
    .from("duty_locations")
    .update({ deleted_at: new Date().toISOString(), is_active: false })
    .eq("id", id)
    .eq("campus_id", campusId)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new DutyLocationError("DATABASE_ERROR", "Nöbet yeri silinemedi.");
  }
  if (!data) {
    throw new DutyLocationError("NOT_FOUND", "Nöbet yeri bulunamadı.");
  }
}
