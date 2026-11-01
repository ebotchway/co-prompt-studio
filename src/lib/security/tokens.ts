import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function createAccessToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashAccessToken(token) };
}

export function hashAccessToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function verifyAccessToken(
  token: string,
  expectedHash: string
): boolean {
  const actual = Buffer.from(hashAccessToken(token));
  const expected = Buffer.from(expectedHash);

  return (
    actual.length === expected.length && timingSafeEqual(actual, expected)
  );
}
