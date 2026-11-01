import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "./tokens";
import { accessTokenTtlSeconds } from "./config";

export type RoomAuth =
  | { ok: true }
  | { ok: false; response: NextResponse };

export function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization");

  if (!header?.startsWith("Bearer ")) {
    return null;
  }

  const token = header.slice(7).trim();

  return token.length > 0 && token.length <= 512 ? token : null;
}

function unauthorized(message: string): NextResponse {
  return NextResponse.json(
    { error: message },
    { status: 401, headers: { "Cache-Control": "no-store" } }
  );
}

function tokenExpired(issuedAt: string | null): boolean {
  const ttl = accessTokenTtlSeconds();

  if (ttl === 0 || !issuedAt) {
    return false;
  }

  return Date.now() - Date.parse(issuedAt) > ttl * 1000;
}

export async function authenticateRoom(
  db: SupabaseClient,
  code: string,
  request: NextRequest
): Promise<RoomAuth> {
  const token = bearerToken(request);

  if (!token) {
    return {
      ok: false,
      response: unauthorized("This room requires an invite token"),
    };
  }

  try {
    const { data: room, error } = await db
      .from("studio_rooms")
      .select(
        "code, access_token_hash, access_token_issued_at"
      )
      .eq("code", code)
      .maybeSingle();

    if (error) throw error;

    if (!room) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Room not found" },
          { status: 404, headers: { "Cache-Control": "no-store" } }
        ),
      };
    }

    if (!room.access_token_hash) {
      return {
        ok: false,
        response: unauthorized(
          "This room has not been claimed by its owner yet"
        ),
      };
    }

    if (
      !token ||
      !verifyAccessToken(token, room.access_token_hash) ||
      tokenExpired(room.access_token_issued_at)
    ) {
      return {
        ok: false,
        response: unauthorized("Invalid or expired invite token"),
      };
    }

    return { ok: true };
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Database error" },
        { status: 500 }
      ),
    };
  }
}
