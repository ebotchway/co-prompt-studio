import { NextRequest, NextResponse } from "next/server";
import { serverDb } from "@/lib/supabase";
import { authenticateRoom, bearerToken } from "@/lib/security/auth";

type Context = {
  params: Promise<{ code: string }>;
};

const CODE_PATTERN = /^[0-9]{4}$/;

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

    const { error: memberError } = await db
      .from("room_memberships")
      .upsert(
        {
          room_code: code,
          auth_user_id: userData.user.id,
          role: "member",
        },
        { onConflict: "room_code,auth_user_id", ignoreDuplicates: true }
      );

    if (memberError) throw memberError;

    return NextResponse.json({ joined: true });
  } catch (error) {
    console.error("Join room:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
