import { NextRequest, NextResponse } from "next/server";
import { serverDb } from "@/lib/supabase";
import { createAccessToken } from "@/lib/security/tokens";
import { clientIp, consumeRateLimit } from "@/lib/security/rate-limit";
import { limits } from "@/lib/security/config";

type Context = {
  params: Promise<{ code: string }>;
};

export async function POST(
  request: NextRequest,
  context: Context
) {
  const { code } = await context.params;

  if (!/^[0-9]{4}$/.test(code)) {
    return NextResponse.json(
      { error: "Invalid room code" },
      { status: 400 }
    );
  }

  try {
    const db = serverDb();

    const allowed = await consumeRateLimit(
      db,
      `room-claim:${clientIp(request)}`,
      limits.roomCreate.windowSeconds,
      limits.roomCreate.max
    );

    if (!allowed) {
      return NextResponse.json(
        { error: "Too many claim attempts. Try again later." },
        { status: 429 }
      );
    }

    const { data: room, error: readError } = await db
      .from("studio_rooms")
      .select("code, access_token_hash")
      .eq("code", code)
      .maybeSingle();

    if (readError) throw readError;

    if (!room) {
      return NextResponse.json(
        { error: "Room not found" },
        { status: 404 }
      );
    }

    if (room.access_token_hash) {
      return NextResponse.json(
        { error: "This room has already been claimed" },
        { status: 409 }
      );
    }

    const { token, tokenHash } = createAccessToken();

    const { data: claimed, error: claimError } = await db
      .from("studio_rooms")
      .update({
        access_token_hash: tokenHash,
        access_token_issued_at: new Date().toISOString(),
      })
      .eq("code", code)
      .is("access_token_hash", null)
      .select("code");

    if (claimError) throw claimError;

    if (!Array.isArray(claimed) || claimed.length === 0) {
      return NextResponse.json(
        { error: "This room has already been claimed" },
        { status: 409 }
      );
    }

    const { error: memberError } = await db
      .from("room_memberships")
      .insert({ room_code: code, role: "owner" });

    if (memberError) throw memberError;

    return NextResponse.json(
      { accessToken: token },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Claim room:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
