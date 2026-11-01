import { NextRequest, NextResponse } from "next/server";
import { serverDb } from "@/lib/supabase";
import { authenticateRoom, bearerToken } from "@/lib/security/auth";

type Context = {
  params: Promise<{ code: string }>;
};

const CODE_PATTERN = /^[0-9]{4}$/;

type MembershipRow = { id: string; role: string };

export async function POST(
  request: NextRequest,
  context: Context
) {
  const { code } = await context.params;

  if (!CODE_PATTERN.test(code)) {
    return NextResponse.json(
      { error: "Invalid room code" },
      { status: 400 }
    );
  }

  const token = bearerToken(request);

  if (!token) {
    return NextResponse.json(
      { error: "This room requires an invite token" },
      { status: 401 }
    );
  }

  const authJwt = request.headers.get("x-supabase-auth");

  if (!authJwt) {
    return NextResponse.json(
      { error: "Missing client session" },
      { status: 401 }
    );
  }

  try {
    const db = serverDb();

    const auth = await authenticateRoom(db, code, request);

    if (!auth.ok) return auth.response;

    const { data: userData, error: userError } = await db.auth.getUser(
      authJwt
    );

    if (userError || !userData?.user) {
      return NextResponse.json(
        { error: "Invalid client session" },
        { status: 401 }
      );
    }

    const { data: roomRow, error: roomError } = await db
      .from("studio_rooms")
      .select("code, owner_member_id")
      .eq("code", code)
      .maybeSingle();

    if (roomError) throw roomError;

    if (!roomRow) {
      return NextResponse.json(
        { error: "Room not found" },
        { status: 404 }
      );
    }

    const userId = userData.user.id;
    let role = roomRow.owner_member_id ? "member" : "owner";

    let inserted = await db
      .from("room_memberships")
      .insert({ room_code: code, auth_user_id: userId, role })
      .select("id, role")
      .single()
      .returns<MembershipRow>();

    if (
      inserted.error?.code === "23505" &&
      role === "owner"
    ) {
      role = "member";

      inserted = await db
        .from("room_memberships")
        .insert({ room_code: code, auth_user_id: userId, role })
        .select("id, role")
        .single()
        .returns<MembershipRow>();
    }

    if (inserted.error) {
      if (inserted.error.code === "23505") {
        const { data: existing } = await db
          .from("room_memberships")
          .select("id, role")
          .eq("room_code", code)
          .eq("auth_user_id", userId)
          .maybeSingle()
          .returns<MembershipRow>();

        return NextResponse.json({
          joined: true,
          role: existing?.role ?? "member",
        });
      }

      throw inserted.error;
    }

    if (role === "owner" && inserted.data) {
      await db
        .from("studio_rooms")
        .update({ owner_member_id: inserted.data.id })
        .eq("code", code)
        .is("owner_member_id", null);
    }

    return NextResponse.json({
      joined: true,
      role: inserted.data?.role ?? role,
    });
  } catch (error) {
    console.error("Join room:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
