import { randomInt } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { serverDb } from "@/lib/supabase";
import { createAccessToken } from "@/lib/security/tokens";
import { checkRoomCreateLimit } from "@/lib/security/rate-limit";

type CreatedRoom = {
  code: string;
  prompt_a: string;
  prompt_b: string;
  system_prompt: string;
  test_input: string;
  temperature: number;
  result_a: unknown | null;
  result_b: unknown | null;
  updated_at: string;
  created_at: string;
};

export async function POST(request: NextRequest) {
  try {
    const db = serverDb();

    const allowed = await checkRoomCreateLimit(db, request);

    if (!allowed) {
      return NextResponse.json(
        { error: "Too many rooms created from this address. Try again later." },
        { status: 429 }
      );
    }

    const authJwt = request.headers.get("x-supabase-auth");

    if (!authJwt) {
      return NextResponse.json(
        { error: "Sign in to create a room" },
        { status: 401 }
      );
    }

    const { data: userData, error: userError } = await db.auth.getUser(
      authJwt
    );

    if (userError || !userData?.user) {
      return NextResponse.json(
        { error: "Invalid client session" },
        { status: 401 }
      );
    }

    for (let attempt = 0; attempt < 20; attempt++) {
      const code = String(randomInt(1000, 10000));
      const { token, tokenHash } = createAccessToken();

      const { data, error } = await db
        .from("studio_rooms")
        .insert({
          code,
          prompt_a: "Explain the topic simply.",
          prompt_b: "Explain the topic using examples.",
          system_prompt: "You are a helpful AI assistant.",
          test_input: "What is machine learning?",
          temperature: 0.7,
          access_token_hash: tokenHash,
          access_token_issued_at: new Date().toISOString(),
        })
        .select(
          "code, prompt_a, prompt_b, system_prompt, test_input, temperature, result_a, result_b, updated_at, created_at"
        )
        .single()
        .returns<CreatedRoom>();

      if (!error && data) {
        const { data: membership, error: memberError } = await db
          .from("room_memberships")
          .insert({
            room_code: code,
            auth_user_id: userData.user.id,
            role: "owner",
          })
          .select("id")
          .single();

        if (memberError || !membership) throw memberError;

        await db
          .from("studio_rooms")
          .update({ owner_member_id: membership.id })
          .eq("code", code);

        return NextResponse.json(
          { room: data, accessToken: token },
          { status: 201 }
        );
      }

      if (error?.code !== "23505") {
        console.error("Room creation failed:", error?.message);
        return NextResponse.json(
          { error: "Database error" },
          { status: 500 }
        );
      }
    }

    return NextResponse.json(
      { error: "Unable to allocate room code" },
      { status: 503 }
    );
  } catch (error) {
    console.error("Create room:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
