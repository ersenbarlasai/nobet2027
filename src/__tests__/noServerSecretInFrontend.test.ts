import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Statik grep: `src/` (Vite'ın frontend bundle grafiğine dahil ettiği tek
// dizin) hiçbir zaman server-only secret/config referansı İÇERMEMELİDİR.
// Bu, "sb_secret_..." anahtarının yanlışlıkla React koduna, bir VITE_
// önekli değişkene veya bundle'a sızmasına karşı hızlı bir tripwire'dır.
// Gerçek build-çıktısı taraması (dist/ grep) ayrıca elle/rapor adımında
// yapılır — bu test yalnızca kaynak koduna karşı çalışır.
const __dirname = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(__dirname, "..");

const FORBIDDEN_PATTERNS = [/SUPABASE_SECRET_KEY/, /sb_secret_/, /service_role/i, /from ["']@supabase\/supabase-js["']/];

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === "__tests__") continue; // bu test dosyasının kendisi dahil — üretim bundle'ına girmez.
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

describe("frontend (src/) hiçbir server-only secret/config referansı içermemeli", () => {
  it("13) src/ altındaki hiçbir dosya secret anahtarı adını veya @supabase/supabase-js import'unu içermiyor", () => {
    const files = walk(srcRoot);
    const offenders: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(content)) {
          offenders.push(`${file}: ${pattern}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
