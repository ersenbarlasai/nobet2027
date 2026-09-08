// Yerel backend yapılandırması. Yalnızca server-side ortam değişkenlerinden
// okunur; hiçbir değer frontend'e (Vite bundle) sızmaz çünkü bu dosya
// `src/` altında değildir ve Vite build grafiğine hiç dahil olmaz.
//
// ÜRETİM UYARISI: Bu backend yalnızca yerel, tek kullanıcılı geliştirme
// içindir. Auth/RLS üyelik politikaları eklenmeden internete açılmamalıdır
// (bkz. server/README.md).

export interface AppConfig {
  supabaseUrl: string;
  supabaseSecretKey: string;
  port: number;
  allowedOrigin: string;
  /** Tek-kampüs aşaması: kampüs/eğitim yılı adı burada merkezi olarak tanımlıdır. */
  campusName: string;
  academicYearName: string;
}

export class MissingEnvError extends Error {
  constructor(varName: string) {
    super(`Ortam değişkeni eksik: ${varName}. server/.env.example dosyasına bakıp yerel .env.local dosyanızı oluşturun.`);
    this.name = "MissingEnvError";
  }
}

/**
 * Ortam değişkenlerini okur ve doğrular. Saf fonksiyondur (process.env
 * dışında bir yan etkisi yok) — testlerde sahte bir env nesnesiyle çağrılabilir.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const supabaseUrl = env.SUPABASE_URL?.trim();
  const supabaseSecretKey = env.SUPABASE_SECRET_KEY?.trim();

  if (!supabaseUrl) throw new MissingEnvError("SUPABASE_URL");
  if (!supabaseSecretKey) throw new MissingEnvError("SUPABASE_SECRET_KEY");

  const port = Number(env.LOCAL_API_PORT ?? 3001);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("LOCAL_API_PORT geçerli bir pozitif tam sayı olmalı.");
  }

  return {
    supabaseUrl,
    supabaseSecretKey,
    port,
    allowedOrigin: env.ALLOWED_ORIGIN?.trim() || "http://localhost:5173",
    campusName: "Kaplan Okulları · Üçevler Kampüsü",
    academicYearName: "2026-2027",
  };
}
