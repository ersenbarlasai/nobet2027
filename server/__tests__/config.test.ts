import { describe, expect, it } from "vitest";
import { loadConfig, MissingEnvError } from "../config";

describe("loadConfig", () => {
  it("1) SUPABASE_SECRET_KEY eksikse MissingEnvError fırlatır", () => {
    expect(() =>
      loadConfig({ SUPABASE_URL: "https://example.supabase.co" } as NodeJS.ProcessEnv),
    ).toThrow(MissingEnvError);
  });

  it("SUPABASE_URL eksikse MissingEnvError fırlatır", () => {
    expect(() => loadConfig({ SUPABASE_SECRET_KEY: "sb_secret_x" } as NodeJS.ProcessEnv)).toThrow(MissingEnvError);
  });

  it("geçerli env ile kampüs/eğitim yılını merkezi olarak döner", () => {
    const config = loadConfig({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_x",
    } as NodeJS.ProcessEnv);
    expect(config.campusName).toBe("Kaplan Okulları · Üçevler Kampüsü");
    expect(config.academicYearName).toBe("2026-2027");
    expect(config.port).toBe(3001);
    expect(config.allowedOrigin).toBe("http://localhost:5173");
  });

  it("hata mesajı secret değerini içermez", () => {
    try {
      loadConfig({ SUPABASE_URL: "https://example.supabase.co" } as NodeJS.ProcessEnv);
      throw new Error("beklenen hata fırlatılmadı");
    } catch (err) {
      expect((err as Error).message).not.toContain("sb_secret_");
    }
  });
});
