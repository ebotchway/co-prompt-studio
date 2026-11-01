import { describe, expect, it } from "vitest";
import {
  createAccessToken,
  hashAccessToken,
  verifyAccessToken,
} from "@/lib/security/tokens";

describe("access tokens", () => {
  it("creates a 256-bit url-safe token with matching hash", () => {
    const { token, tokenHash } = createAccessToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenHash).not.toContain(token);
  });

  it("verifies the correct token", () => {
    const { token, tokenHash } = createAccessToken();

    expect(verifyAccessToken(token, tokenHash)).toBe(true);
  });

  it("rejects a wrong token", () => {
    const { tokenHash } = createAccessToken();

    expect(verifyAccessToken("not-the-token", tokenHash)).toBe(false);
  });

  it("rejects when no hash is stored", () => {
    const { token } = createAccessToken();

    expect(verifyAccessToken(token, "")).toBe(false);
  });

  it("hashes deterministically and differs per token", () => {
    const a = hashAccessToken("token-a");
    const b = hashAccessToken("token-b");

    expect(a).toBe(hashAccessToken("token-a"));
    expect(a).not.toBe(b);
  });
});
