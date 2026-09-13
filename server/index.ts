import express, { type NextFunction, type Request, type Response } from "express";
import { pathToFileURL } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadConfig, MissingEnvError, type AppConfig } from "./config";
import { createServerSupabaseClient } from "./supabase";
import { createTimetableImportsRouter } from "./routes/timetableImports";
import { createCurrentImportRouter } from "./routes/currentImport";
import { createClassTimetablesRouter } from "./routes/classTimetables";
import { createTeacherTimetablesRouter } from "./routes/teacherTimetables";
import { createDutyLocationsRouter } from "./routes/dutyLocations";
import { createFixedDutyAssignmentsRouter } from "./routes/fixedDutyAssignments";
import { createDutyPlanRouter } from "./routes/dutyPlan";
import { createDutyPlanDraftsRouter } from "./routes/dutyPlanDrafts";
import { createExamInvigilationRouter } from "./routes/examInvigilation";
import { createSubstitutionRouter } from "./routes/substitutions";
import { createSystemDataRouter } from "./routes/systemData";

const MAX_BODY_SIZE = "2mb";
const VITE_DEV_PORT_MIN = 5173;
const VITE_DEV_PORT_MAX = 5199;

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Yapılandırılmış origin her zaman kabul edilir. Backend yalnızca loopback'e
 * bağlıyken ve yapılandırılan origin de yerel geliştirme adresiyken, Vite'ın
 * 5173 dolu olduğunda seçebildiği sınırlı yedek portlara da izin verilir.
 * Üretim/uzak origin yapılandırması bu istisnayı etkinleştirmez.
 */
export function isAllowedBrowserOrigin(origin: string, configuredOrigin: string): boolean {
  if (origin === configuredOrigin) return true;

  try {
    const configured = new URL(configuredOrigin);
    const candidate = new URL(origin);
    const candidatePort = Number(candidate.port);

    return (
      configured.protocol === "http:" &&
      candidate.protocol === "http:" &&
      isLoopbackHostname(configured.hostname) &&
      isLoopbackHostname(candidate.hostname) &&
      Number.isInteger(candidatePort) &&
      candidatePort >= VITE_DEV_PORT_MIN &&
      candidatePort <= VITE_DEV_PORT_MAX &&
      candidate.origin === origin
    );
  } catch {
    return false;
  }
}

/**
 * Express app'i kurar. `supabase` testlerde sahte bir istemci ile
 * değiştirilebilir (dependency injection) — böylece gerçek ağ isteği
 * yapmadan route/middleware davranışı test edilebilir.
 */
export function createApp(config: AppConfig, supabase: SupabaseClient = createServerSupabaseClient(config)) {
  const app = express();

  app.disable("x-powered-by");

  // === Origin allowlist (tarayıcı CORS'una ek, sunucu tarafı savunma) ===
  // Yapılandırılan origin'e ve yalnız yerel geliştirmede Vite'ın sınırlı
  // yedek portlarına izin verilir. Origin header'ı hiç yoksa — ör.
  // curl/sunucu-sunucu — izin verilir; CORS bir tarayıcı mekanizmasıdır.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && !isAllowedBrowserOrigin(origin, config.allowedOrigin)) {
      res.status(403).json({ error: "origin_not_allowed" });
      return;
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // === Yalnız JSON gövde kabul edilir; boyut sınırı uygulanır ===
  app.use((req: Request, res: Response, next: NextFunction) => {
    if ((req.method === "POST" || req.method === "PATCH" || req.method === "PUT") && !req.is("application/json")) {
      res.status(415).json({ error: "unsupported_media_type", message: "Yalnızca application/json kabul edilir." });
      return;
    }
    next();
  });
  app.use(express.json({ limit: MAX_BODY_SIZE }));

  app.use("/api/timetable-imports", createTimetableImportsRouter(supabase, config));
  app.use("/api/timetable-imports", createCurrentImportRouter(supabase, config));
  app.use("/api/class-timetables", createClassTimetablesRouter(supabase, config));
  app.use("/api/teacher-timetables", createTeacherTimetablesRouter(supabase, config));
  app.use("/api/duty-locations", createDutyLocationsRouter(supabase, config));
  app.use("/api/fixed-duty-assignments", createFixedDutyAssignmentsRouter(supabase, config));
  app.use("/api/duty-plan", createDutyPlanRouter(supabase, config));
  app.use("/api/duty-plans", createDutyPlanDraftsRouter(supabase, config));
  app.use("/api/exam-invigilation", createExamInvigilationRouter(supabase, config));
  app.use("/api/substitutions", createSubstitutionRouter(supabase, config));
  app.use("/api/system-data", createSystemDataRouter(supabase, config));

  // === Hata yakalayıcı: hiçbir zaman stack trace, secret veya bağlantı
  //     bilgisi döndürmez (ör. bozuk JSON, aşırı büyük gövde) ===
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const asRecord = err as { type?: string; status?: number } | undefined;
    if (asRecord?.type === "entity.too.large") {
      res.status(413).json({ error: "payload_too_large", message: `İstek gövdesi ${MAX_BODY_SIZE} sınırını aşıyor.` });
      return;
    }
    if (asRecord?.type === "entity.parse.failed") {
      res.status(400).json({ error: "invalid_json", message: "İstek gövdesi geçerli bir JSON değil." });
      return;
    }
    res.status(500).json({ error: "internal_error", message: "Beklenmeyen bir sunucu hatası oluştu." });
  });

  return app;
}

function main() {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof MissingEnvError) {
      // eslint-disable-next-line no-console
      console.error(`[server] Başlatılamadı: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const app = createApp(config);
  // BİLEREK yalnızca 127.0.0.1: bu backend LAN/internet'e açılmamalıdır.
  app.listen(config.port, "127.0.0.1", () => {
    // eslint-disable-next-line no-console
    console.log(`[server] http://127.0.0.1:${config.port} üzerinde dinliyor (yalnız yerel, tek kullanıcı).`);
  });
}

// Doğrudan çalıştırıldığında (tsx server/index.ts) sunucuyu başlat;
// testlerde import edildiğinde başlatma.
const invokedEntryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;

if (process.env.VITEST !== "true" && invokedEntryPoint) {
  main();
}
