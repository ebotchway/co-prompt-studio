import { afterEach, describe, expect, it, vi } from "vitest";

describe("supabase browser singleton", () => {
  const originalWindow = globalThis.window;
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      globalThis.window = originalWindow;
    }

    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;

    if (originalKey === undefined)
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;

    delete (globalThis as { __copromptSupabaseBrowserClient?: unknown })
      .__copromptSupabaseBrowserClient;
  });

  it("returns the same client instance to every caller", async () => {
    (globalThis as { window?: unknown }).window = {};
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";

    const { createBrowserClient } = await import("@/lib/supabase-browser");

    const first = createBrowserClient();
    const second = createBrowserClient();

    expect(second).toBe(first);
  });

  it("keeps the singleton across simulated hot reloads (module re-import)", async () => {
    (globalThis as { window?: unknown }).window = {};
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";

    const { createBrowserClient: firstLoad } = await import(
      "@/lib/supabase-browser"
    );

    const before = firstLoad();

    vi.resetModules();

    const { createBrowserClient: reloaded } = await import(
      "@/lib/supabase-browser"
    );

    expect(reloaded()).toBe(before);
  });

  it("throws when browser configuration is missing", async () => {
    (globalThis as { window?: unknown }).window = {};
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;

    vi.resetModules();

    const { createBrowserClient } = await import("@/lib/supabase-browser");

    expect(() => createBrowserClient()).toThrow(
      /Missing Supabase browser configuration/
    );
  });

  it("refuses to create a client outside the browser", async () => {
    delete (globalThis as { window?: unknown }).window;

    vi.resetModules();

    const { createBrowserClient } = await import("@/lib/supabase-browser");

    expect(() => createBrowserClient()).toThrow(/browser-only/);
  });
});
