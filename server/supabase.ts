import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "./config";

/**
 * Sunucu tarafı Supabase istemcisi. `sb_secret_...` anahtarıyla oluşturulur
 * (Supabase'de bu, service_role rolüne karşılık gelir ve RLS'yi bypass eder).
 * Bu dosya YALNIZCA server/ altında import edilir; src/ (frontend) hiçbir
 * zaman bu modülü veya secret anahtarı içermez.
 */
export function createServerSupabaseClient(config: AppConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
