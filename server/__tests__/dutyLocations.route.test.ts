import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../index";
import {
  campusFoundResult,
  createFakeSupabase,
  dutyLocationRow,
  FAKE_BLOCK_IDS,
  FAKE_CAMPUS_ID,
  testConfig,
} from "./dutyLocationsFixtures";

const ORIGIN = "http://localhost:5173";

describe("GET /api/duty-locations", () => {
  it("3) tablo boşsa boş liste ve sıfır özet döner", async () => {
    const supabase = createFakeSupabase([
      campusFoundResult(),
      { data: null, error: null, count: 0 },
      { data: null, error: null, count: 0 },
      { data: [], error: null, count: 0 },
    ]);
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/duty-locations").set("Origin", ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.summary).toEqual({ total: 0, active: 0, inactive: 0 });
  });

  it("11) listeleme: satırları camelCase DTO'ya çevirir", async () => {
    const supabase = createFakeSupabase([
      campusFoundResult(),
      { data: null, error: null, count: 1 },
      { data: null, error: null, count: 0 },
      { data: [dutyLocationRow()], error: null, count: 1 },
    ]);
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/duty-locations").set("Origin", ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body.items[0]).toEqual({
      id: "22222222-2222-2222-2222-222222222222",
      name: "Ön Bahçe",
      shortCode: "ON-BAH",
      category: "garden",
      capacity: 2,
      description: null,
      isActive: true,
      sortOrder: 1,
      allowsFixedAssignment: false,
      blockIds: FAKE_BLOCK_IDS,
      blockPolicies: FAKE_BLOCK_IDS.map((dutyBlockId) => ({ dutyBlockId, assignmentMode: "normal" as const })),
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
    });
  });

  it("17) özet sayıları filtre sonucundan bağımsız, kampüsteki tüm silinmemiş kayıtlara göre hesaplanır", async () => {
    const supabase = createFakeSupabase([
      campusFoundResult(),
      { data: null, error: null, count: 7 },
      { data: null, error: null, count: 1 },
      { data: [dutyLocationRow()], error: null, count: 1 },
    ]);
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .get("/api/duty-locations?search=bahce&category=garden&status=active")
      .set("Origin", ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ total: 8, active: 7, inactive: 1 });
  });

  it("16) sayfalama parametrelerini ve toplam sayfa sayısını döner", async () => {
    const supabase = createFakeSupabase([
      campusFoundResult(),
      { data: null, error: null, count: 25 },
      { data: null, error: null, count: 0 },
      { data: [dutyLocationRow()], error: null, count: 25 },
    ]);
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/duty-locations?page=2&pageSize=10").set("Origin", ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({ page: 2, pageSize: 10, totalItems: 25, totalPages: 3 });
  });

  it("24) geçersiz sorgu parametresi VALIDATION_ERROR ile 400 döner", async () => {
    const supabase = createFakeSupabase([]);
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/duty-locations?status=unknown").set("Origin", ORIGIN);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("25/26) sorgu hatasında güvenli 500 döner, secret/stack sızmaz", async () => {
    const FAKE_SECRET = "sb_secret_TEST_VALUE_MUST_NEVER_LEAK_9f8a7c";
    const supabase = createFakeSupabase([
      campusFoundResult(),
      { data: null, error: { message: "connection refused at foo.js:1:1" }, count: null },
    ]);
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/duty-locations").set("Origin", ORIGIN);

    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(FAKE_SECRET);
    expect(body).not.toContain("foo.js");
  });

  it("27) izin verilmeyen Origin 403 ile reddedilir", async () => {
    const supabase = createFakeSupabase([]);
    const app = createApp(testConfig(), supabase);

    const res = await request(app).get("/api/duty-locations").set("Origin", "http://evil.example.com");

    expect(res.status).toBe(403);
  });
});

describe("POST /api/duty-locations", () => {
  function validBody(overrides: Record<string, unknown> = {}) {
    return {
      name: "Ön Bahçe",
      shortCode: "on-bah",
      category: "garden",
      capacity: 2,
      description: null,
      isActive: true,
      blockPolicies: FAKE_BLOCK_IDS.map((dutyBlockId) => ({ dutyBlockId, assignmentMode: "normal" })),
      ...overrides,
    };
  }

  it("4) geçerli istekte 201 ve oluşturulan kaydı döner", async () => {
    const supabase = createFakeSupabase([campusFoundResult(), { data: dutyLocationRow(), error: null }]);
    const app = createApp(testConfig(), supabase);

    const res = await request(app).post("/api/duty-locations").set("Origin", ORIGIN).send(validBody());

    expect(res.status).toBe(201);
    expect(res.body.shortCode).toBe("ON-BAH");
    expect(supabase.rpc).toHaveBeenCalledWith(
      "create_duty_location_with_block_policies",
      expect.objectContaining({ p_campus_id: FAKE_CAMPUS_ID, p_short_code: "ON-BAH" }),
    );
  });

  it("5) shortCode küçük harfle gönderilse de büyük harfe normalize edilir", async () => {
    const supabase = createFakeSupabase([campusFoundResult(), { data: dutyLocationRow(), error: null }]);
    const app = createApp(testConfig(), supabase);

    await request(app).post("/api/duty-locations").set("Origin", ORIGIN).send(validBody({ shortCode: "on-bah" }));

    expect(supabase.rpc).toHaveBeenCalledWith("create_duty_location_with_block_policies", expect.objectContaining({ p_short_code: "ON-BAH" }));
  });

  it("6) yinelenen ad → DUPLICATE_NAME alan hatası", async () => {
    const supabase = createFakeSupabase([
      campusFoundResult(),
      { data: null, error: { message: 'duplicate key value violates unique constraint "duty_locations_campus_name_unique_idx"' } },
    ]);
    const app = createApp(testConfig(), supabase);

    const res = await request(app).post("/api/duty-locations").set("Origin", ORIGIN).send(validBody());

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: "DUPLICATE_NAME", message: expect.any(String), field: "name" });
  });

  it("7) yinelenen kısa kod → DUPLICATE_SHORT_CODE alan hatası", async () => {
    const supabase = createFakeSupabase([
      campusFoundResult(),
      {
        data: null,
        error: { message: 'duplicate key value violates unique constraint "duty_locations_campus_short_code_unique_idx"' },
      },
    ]);
    const app = createApp(testConfig(), supabase);

    const res = await request(app).post("/api/duty-locations").set("Origin", ORIGIN).send(validBody());

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: "DUPLICATE_SHORT_CODE", message: expect.any(String), field: "shortCode" });
  });

  it("9) capacity sınır dışı → VALIDATION_ERROR (RPC hiç çağrılmaz)", async () => {
    const supabase = createFakeSupabase([campusFoundResult()]);
    const app = createApp(testConfig(), supabase);

    const res = await request(app).post("/api/duty-locations").set("Origin", ORIGIN).send(validBody({ capacity: 21 }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("10) boş açıklama null olarak RPC'ye gönderilir", async () => {
    const supabase = createFakeSupabase([campusFoundResult(), { data: dutyLocationRow(), error: null }]);
    const app = createApp(testConfig(), supabase);

    await request(app).post("/api/duty-locations").set("Origin", ORIGIN).send(validBody({ description: "   " }));

    expect(supabase.rpc).toHaveBeenCalledWith("create_duty_location_with_block_policies", expect.objectContaining({ p_description: null }));
  });

  it("VALIDATION_ERROR: geçersiz kategori", async () => {
    const supabase = createFakeSupabase([]);
    const app = createApp(testConfig(), supabase);

    const res = await request(app).post("/api/duty-locations").set("Origin", ORIGIN).send(validBody({ category: "hangar" }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("28) eşzamanlı iki create isteği farklı sonuç alabilir (RPC her çağrıda ayrıca çağrılır)", async () => {
    const supabase = createFakeSupabase([
      campusFoundResult(),
      { data: dutyLocationRow({ sort_order: 1 }), error: null },
      campusFoundResult(),
      { data: dutyLocationRow({ id: "33333333-3333-3333-3333-333333333333", sort_order: 2 }), error: null },
    ]);
    const app = createApp(testConfig(), supabase);

    const res1 = await request(app).post("/api/duty-locations").set("Origin", ORIGIN).send(validBody());
    const res2 = await request(app).post("/api/duty-locations").set("Origin", ORIGIN).send(validBody({ name: "Arka Bahçe" }));

    expect(res1.body.sortOrder).toBe(1);
    expect(res2.body.sortOrder).toBe(2);
  });
});

describe("PATCH /api/duty-locations/:id", () => {
  const VALID_ID = "22222222-2222-2222-2222-222222222222";

  it("18) geçerli güncelleme 200 ve güncellenmiş kaydı döner", async () => {
    const supabase = createFakeSupabase([campusFoundResult(), { data: dutyLocationRow({ capacity: 4 }), error: null }]);
    const app = createApp(testConfig(), supabase);

    const res = await request(app).patch(`/api/duty-locations/${VALID_ID}`).set("Origin", ORIGIN).send({ capacity: 4 });

    expect(res.status).toBe(200);
    expect(res.body.capacity).toBe(4);
  });

  it("blok politikalarını metadata ile tek atomik RPC'de ve expectedUpdatedAt ile günceller", async () => {
    const supabase = createFakeSupabase(
      [campusFoundResult()],
      async (fn, args) => {
        expect(fn).toBe("update_duty_location_with_block_policies");
        expect(args).toMatchObject({
          p_duty_location_id: VALID_ID,
          p_expected_updated_at: "2026-09-01T10:00:00.000Z",
          p_policies: expect.arrayContaining([
            { duty_block_id: FAKE_BLOCK_IDS[0], assignment_mode: "fixed_only" },
            { duty_block_id: FAKE_BLOCK_IDS[3], assignment_mode: "fixed_only" },
          ]),
        });
        return { data: dutyLocationRow({ allows_fixed_assignment: true }), error: null };
      },
    );
    const app = createApp(testConfig(), supabase);
    const blockPolicies = FAKE_BLOCK_IDS.map((dutyBlockId, index) => ({
      dutyBlockId,
      assignmentMode: index === 0 || index === 3 ? "fixed_only" : "normal",
    }));
    const res = await request(app).patch(`/api/duty-locations/${VALID_ID}`).set("Origin", ORIGIN).send({
      name: "Ön Bahçe", category: "garden", capacity: 2, description: null, isActive: true,
      blockPolicies, expectedUpdatedAt: "2026-09-01T10:00:00.000Z",
    });
    expect(res.status).toBe(200);
  });

  it("19) silinmiş/mevcut olmayan kayıt için 404 NOT_FOUND döner", async () => {
    const supabase = createFakeSupabase([campusFoundResult(), { data: null, error: null }]);
    const app = createApp(testConfig(), supabase);

    const res = await request(app).patch(`/api/duty-locations/${VALID_ID}`).set("Origin", ORIGIN).send({ capacity: 4 });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("24) geçersiz UUID için VALIDATION_ERROR ile 400 döner", async () => {
    const supabase = createFakeSupabase([]);
    const app = createApp(testConfig(), supabase);

    const res = await request(app).patch("/api/duty-locations/not-a-uuid").set("Origin", ORIGIN).send({ capacity: 4 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("boş gövde (güncellenecek alan yok) VALIDATION_ERROR döner", async () => {
    const supabase = createFakeSupabase([]);
    const app = createApp(testConfig(), supabase);

    const res = await request(app).patch(`/api/duty-locations/${VALID_ID}`).set("Origin", ORIGIN).send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("shortCode alanı gönderilirse 400 VALIDATION_ERROR döner ve DB'ye hiç yazılmaz (short_code kararlı/değiştirilemez)", async () => {
    const supabase = createFakeSupabase([]);
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .patch(`/api/duty-locations/${VALID_ID}`)
      .set("Origin", ORIGIN)
      .send({ shortCode: "YENI-KOD" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("shortCode başka geçerli alanlarla birlikte gönderilse de 400 döner", async () => {
    const supabase = createFakeSupabase([]);
    const app = createApp(testConfig(), supabase);

    const res = await request(app)
      .patch(`/api/duty-locations/${VALID_ID}`)
      .set("Origin", ORIGIN)
      .send({ capacity: 4, shortCode: "YENI-KOD" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("DELETE /api/duty-locations/:id (soft-delete)", () => {
  const VALID_ID = "22222222-2222-2222-2222-222222222222";

  it("20/21/22) başarılı silme 204 döner (soft-delete)", async () => {
    const supabase = createFakeSupabase([campusFoundResult(), { data: { id: VALID_ID }, error: null }]);
    const app = createApp(testConfig(), supabase);

    const res = await request(app).delete(`/api/duty-locations/${VALID_ID}`).set("Origin", ORIGIN);

    expect(res.status).toBe(204);
  });

  it("tekrar silme (zaten silinmiş) güvenli 404 döner", async () => {
    const supabase = createFakeSupabase([campusFoundResult(), { data: null, error: null }]);
    const app = createApp(testConfig(), supabase);

    const res = await request(app).delete(`/api/duty-locations/${VALID_ID}`).set("Origin", ORIGIN);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
