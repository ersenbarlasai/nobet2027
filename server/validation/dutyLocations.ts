import { z } from "zod";

// "Nöbet Yerleri" ekranı için istek şemaları. "Gelen veriye güvenme"
// ilkesiyle yazıldı: DB constraint'leri de AYRICA doğrular (savunma
// derinliği) — bkz. supabase/migrations/..._create_duty_locations.sql.

export const DUTY_LOCATION_CATEGORIES = [
  "garden",
  "entrance",
  "floor",
  "corridor",
  "cafeteria",
  "sports_area",
  "other",
] as const;

export type DutyLocationCategory = (typeof DUTY_LOCATION_CATEGORIES)[number];

const categoryEnum = z.enum(DUTY_LOCATION_CATEGORIES);

// Türkçe karakterleri kayıpsız ASCII'ye çevirmeye ÇALIŞMAZ — kullanıcı
// Türkçe karakter girerse (ör. "ÖN-BAH") normalize sonrası regex reddeder ve
// kullanıcıya VALIDATION_ERROR döner (spesifikasyon: "kayıplı biçimde
// dönüştürme").
const SHORT_CODE_PATTERN = /^[A-Z0-9]+(-[A-Z0-9]+)*$/;

const nameSchema = z
  .string()
  .trim()
  .min(2, "Nöbet yeri adı en az 2 karakter olmalı.")
  .max(80, "Nöbet yeri adı en fazla 80 karakter olabilir.");

const shortCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(
    z
      .string()
      .min(2, "Kısa kod en az 2 karakter olmalı.")
      .max(16, "Kısa kod en fazla 16 karakter olabilir.")
      .regex(SHORT_CODE_PATTERN, "Kısa kod yalnız büyük harf, rakam ve tek tirelerden oluşabilir (ör. ON-BAH)."),
  );

const capacitySchema = z.number().int().min(1, "Kapasite en az 1 olmalı.").max(20, "Kapasite en fazla 20 olabilir.");

const descriptionSchema = z
  .string()
  .trim()
  .max(300, "Açıklama en fazla 300 karakter olabilir.")
  .nullable()
  .optional()
  .transform((value) => (value === undefined || value === null || value === "" ? null : value));

const dutyLocationBlockPolicySchema = z.strictObject({
  dutyBlockId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Geçersiz nöbet bloğu kimliği."),
  assignmentMode: z.enum(["normal", "fixed_only", "off"]),
});

const blockPoliciesSchema = z.array(dutyLocationBlockPolicySchema).min(1, "Blok politikaları zorunludur.").max(8);

// Update şemasında description ANAHTARI hiç gönderilmemişse `undefined` olarak
// KALMALI (create'teki gibi otomatik null'a dönüşmemeli) — aksi halde her PATCH
// isteği description alanını içeriyormuş gibi görünür ve "en az bir alan
// gönderildi mi" kontrolü (aşağıdaki .refine) yanılır.
const updateDescriptionSchema = z
  .string()
  .trim()
  .max(300, "Açıklama en fazla 300 karakter olabilir.")
  .nullable()
  .optional()
  .transform((value) => (value === undefined ? undefined : value === null || value === "" ? null : value));

export const createDutyLocationSchema = z.object({
  name: nameSchema,
  shortCode: shortCodeSchema,
  category: categoryEnum,
  capacity: capacitySchema,
  description: descriptionSchema,
  isActive: z.boolean().optional().default(true),
  blockPolicies: blockPoliciesSchema,
});

export type CreateDutyLocationInput = z.infer<typeof createDutyLocationSchema>;

// shortCode KASITLI OLARAK yok — kararlı/değiştirilemez tanımlayıcıdır (bkz.
// 20260906090000 sütun yorumu, 20260914090000 DB tetikleyicisi). `.strict()`
// bu anahtar (veya başka bilinmeyen bir anahtar) gönderildiğinde 400
// VALIDATION_ERROR döner — sessizce yok saymak yerine isteği reddeder.
export const updateDutyLocationSchema = z
  .strictObject({
    name: nameSchema.optional(),
    category: categoryEnum.optional(),
    capacity: capacitySchema.optional(),
    description: updateDescriptionSchema,
    isActive: z.boolean().optional(),
    blockPolicies: blockPoliciesSchema.optional(),
    expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Güncellenecek en az bir alan gerekli.",
  });

export type UpdateDutyLocationInput = z.infer<typeof updateDutyLocationSchema>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const uuidSchema = z.string().regex(UUID_PATTERN, "Geçersiz kimlik.");

export const listQuerySchema = z.object({
  search: z.string().trim().max(200).optional().default(""),
  category: z.union([categoryEnum, z.literal("")]).optional().default(""),
  status: z.enum(["all", "active", "inactive"]).optional().default("all"),
  sort: z.enum(["order", "name", "category", "active"]).optional().default("order"),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(10),
});

export type ListQuery = z.infer<typeof listQuerySchema>;
