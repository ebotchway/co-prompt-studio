import { NextRequest, NextResponse } from "next/server";
import { serverDb } from "@/lib/supabase";
import { authenticateMember } from "@/lib/security/auth";
import { checkRoomPatchLimit } from "@/lib/security/rate-limit";

type Context = {
  params: Promise<{ code: string }>;
};

const allowedFields = new Set([
  "prompt_a",
  "prompt_b",
  "system_prompt",
  "test_input",
  "temperature",
]);

const roomColumns =
  "code, prompt_a, prompt_b, system_prompt, test_input, temperature, result_a, result_b, updated_at, created_at";

export async function GET(
  _request: NextRequest,
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

    const auth = await authenticateMember(db, code, _request);

    if (!auth.ok) return auth.response;

    const { data, error } = await db
      .from("studio_rooms")
      .select(roomColumns)
      .eq("code", code)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return NextResponse.json(
        { error: "Room not found" },
        { status: 404 }
      );
    }

    const { data: latestRun } = await db
      .from("room_runs")
      .select(
        "id, snapshot_hash, model, temperature, status, error, executed_at"
      )
      .eq("room_code", code)
      .order("executed_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return NextResponse.json(
      { room: data, latestRun: latestRun ?? null },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Get room:", error);
    return NextResponse.json(
      { error: "Database error" },
      { status: 500 }
    );
  }
}

export async function PATCH(
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

    const auth = await authenticateMember(db, code, request);

    if (!auth.ok) return auth.response;

    const allowed = await checkRoomPatchLimit(db, code);

    if (!allowed) {
      return NextResponse.json(
        { error: "Too many edits. Slow down and try again." },
        { status: 429 }
      );
    }
  } catch (error) {
    console.error("Update room:", error);
    return NextResponse.json(
      { error: "Database error" },
      { status: 500 }
    );
  }

  let input: unknown;

  try {
    input = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON" },
      { status: 400 }
    );
  }

  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return NextResponse.json(
      { error: "Expected an object" },
      { status: 400 }
    );
  }

  const changes: Record<string, string | number> = {};
  let expectedUpdatedAt: string | null = null;

  for (const [field, value] of Object.entries(input)) {
    if (field === "expected_updated_at") {
      if (typeof value !== "string" || value.length > 64) {
        return NextResponse.json(
          { error: "Invalid version precondition" },
          { status: 400 }
        );
      }
      expectedUpdatedAt = value;
      continue;
    }

    if (!allowedFields.has(field)) {
      return NextResponse.json(
        { error: `Field ${field} cannot be modified` },
        { status: 400 }
      );
    }

    if (field === "temperature") {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 2
      ) {
        return NextResponse.json(
          { error: "Temperature must be between 0 and 2" },
          { status: 400 }
        );
      }
      changes[field] = value;
    } else {
      const max = field === "test_input" ? 8000 : 12000;
      if (typeof value !== "string" || value.length > max) {
        return NextResponse.json(
          { error: `Invalid ${field}` },
          { status: 400 }
        );
      }
      changes[field] = value;
    }
  }

  if (!Object.keys(changes).length) {
    return NextResponse.json(
      { error: "No changes provided" },
      { status: 400 }
    );
  }

  try {
    const db = serverDb();

    const { data: current, error: readError } = await db
      .from("studio_rooms")
      .select("code, updated_at")
      .eq("code", code)
      .maybeSingle();

    if (readError) throw readError;

    if (!current) {
      return NextResponse.json(
        { error: "Room not found" },
        { status: 404 }
      );
    }

    if (
      expectedUpdatedAt &&
      current.updated_at !== expectedUpdatedAt
    ) {
      return NextResponse.json(
        {
          error: "Room changed since you loaded it. Refreshing your copy.",
          current_updated_at: current.updated_at,
        },
        { status: 409, headers: { "Cache-Control": "no-store" } }
      );
    }

    const { data, error } = await db
      .from("studio_rooms")
      .update({
        ...changes,
        updated_at: new Date().toISOString(),
      })
      .eq("code", code)
      .select(roomColumns)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return NextResponse.json(
        { error: "Room not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ room: data });
  } catch (error) {
    console.error("Update room:", error);
    return NextResponse.json(
      { error: "Database error" },
      { status: 500 }
    );
  }
}
