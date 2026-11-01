import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "./tokens";

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
      .select("code, access_token_hash")
      .eq("code", code)
      .maybeSingle();

    if (error) throw error;

    if (
      !room?.access_token_hash ||
      !verifyAccessToken(token, room.access_token_hash)
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
