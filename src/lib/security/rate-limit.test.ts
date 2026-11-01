import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { consumeRateLimit } from "@/lib/security/rate-limit";

function dbWithRpc(
  result: { data: unknown; error: unknown }
): SupabaseClient {
  return {
    rpc: vi.fn().mockResolvedValue(result),
  } as unknown as SupabaseClient;
}

describe("consumeRateLimit", () => {
  it("allows when the counter returns true", async () => {
    const db = dbWithRpc({ data: true, error: null });

    await expect(
      consumeRateLimit(db, "key", 60, 10)
    ).resolves.toBe(true);
  });

  it("denies when the counter returns false", async () => {
    const db = dbWithRpc({ data: false, error: null });

    await expect(
      consumeRateLimit(db, "key", 60, 10)
    ).resolves.toBe(false);
  });

  it("denies anything other than an explicit true", async () => {
    const db = dbWithRpc({ data: null, error: null });

    await expect(
      consumeRateLimit(db, "key", 60, 10)
    ).resolves.toBe(false);
  });

  it("fails open when the counter is unavailable", async () => {
    const db = dbWithRpc({ data: null, error: { message: "boom" } });
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await expect(
      consumeRateLimit(db, "key", 60, 10)
    ).resolves.toBe(true);

    expect(errorSpy).toHaveBeenCalledWith(
      "Rate limit counter unavailable"
    );
    errorSpy.mockRestore();
  });
});
