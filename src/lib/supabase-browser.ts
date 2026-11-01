import { createClient, type SupabaseClient } from "@supabase/supabase-js";

declare global {
  var __copromptSupabaseBrowserClient: SupabaseClient | undefined;
}

export function createBrowserClient(): SupabaseClient {
  if (typeof window === "undefined") {
    throw new Error("createBrowserClient is browser-only");
  }

  if (!globalThis.__copromptSupabaseBrowserClient) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!url || !key) {
      throw new Error("Missing Supabase browser configuration");
    }

    globalThis.__copromptSupabaseBrowserClient = createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }

  return globalThis.__copromptSupabaseBrowserClient;
}
