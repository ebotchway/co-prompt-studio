import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { claimRun, releaseRunClaim } from "@/lib/security/run-claims";

function dbWithUpdate(rows: string[]) {
  const update = vi.fn().mockReturnThis();
  const or = vi.fn().mockReturnThis();
  const eq = vi.fn().mockReturnThis();
  const select = vi.fn().mockResolvedValue({ data: rows, error: null });

  return {
    builder: { update, or, eq, select },
    db: {
      from: vi.fn().mockReturnValue({ update, or, eq, select }),
    } as unknown as SupabaseClient,
  };
}

describe("claimRun", () => {
  it("claims when the conditional update affects a row", async () => {
    const { db, builder } = dbWithUpdate(["1234"]);

    const result = await claimRun(db, "1234", 90);

    expect(result.claimed).toBe(true);
    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({ run_status: "running" })
    );
    expect(builder.eq).toHaveBeenCalledWith("code", "1234");
  });

  it("does not claim when another run holds the room", async () => {
    const { db } = dbWithUpdate([]);

    const result = await claimRun(db, "1234", 90);

    expect(result.claimed).toBe(false);
  });

  it("propagates database errors", async () => {
    const db = {
      from: vi.fn().mockReturnValue({
        update: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        select: vi
          .fn()
          .mockResolvedValue({ data: null, error: { message: "boom" } }),
      }),
    } as unknown as SupabaseClient;

    await expect(claimRun(db, "1234", 90)).rejects.toThrow();
  });
});

describe("releaseRunClaim", () => {
  it("releases only its own claim", async () => {
    const update = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const db = {
      from: vi.fn().mockReturnValue({ update, eq }),
    } as unknown as SupabaseClient;

    await releaseRunClaim(db, "1234", "2026-01-01T00:00:00Z");

    expect(update).toHaveBeenCalledWith({
      run_status: "idle",
      run_claimed_at: null,
    });
    expect(eq).toHaveBeenCalledWith(
      "run_claimed_at",
      "2026-01-01T00:00:00Z"
    );
  });
});
