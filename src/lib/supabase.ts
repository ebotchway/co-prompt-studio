import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import type { SupabaseClientOptions } from "@supabase/supabase-js";

export function serverDb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Supabase server configuration missing");
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      transport: WebSocket as unknown as NonNullable<NonNullable<SupabaseClientOptions<"public">["realtime"]>["transport"]>,
    },
  });
}
