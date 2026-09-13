import { describe, expect, it } from "vitest";
import { networkImportFailure, readImportFailure } from "../importFailure";

describe("XML içe aktarma hata açıklaması", () => {
  it("açık çalışma engellerini kaybetmeden kullanıcıya taşır", async () => {
    const failure = await readImportFailure(new Response(JSON.stringify({
      error: "open_work_blocks_import",
      message: "XML'e bağlı açık çalışmalar tamamlanmadan veya silinmeden yeni XML yüklenemez.",
      items: [
        { type: "exam_plan", id: "plan-1", name: "Deneme Sınavı" },
        { type: "substitution_list", id: "list-1", name: "2026-09-15" },
        { type: "unknown", id: "ignored", name: "Güvensiz tür" },
      ],
    }), { status: 409, headers: { "Content-Type": "application/json" } }));

    expect(failure.message).toMatch(/açık çalışmalar/);
    expect(failure.blockers).toEqual([
      { type: "exam_plan", id: "plan-1", name: "Deneme Sınavı" },
      { type: "substitution_list", id: "list-1", name: "2026-09-15" },
    ]);
  });

  it("platform ve ağ hatalarını birbirinden ayırır", async () => {
    const platform = await readImportFailure(new Response("Gateway timeout", { status: 504 }));
    expect(platform.message).toMatch(/Veriler kaydedilemedi/);
    expect(networkImportFailure().message).toMatch(/Sunucuya ulaşılamadı/);
  });
});
