import { NextRequest, NextResponse } from "next/server";
import { serverDb } from "@/lib/supabase";

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
    const { data, error } = await serverDb()
      .from("studio_rooms")
      .select("*")
      .eq("code", code)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return NextResponse.json(
        { error: "Room not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { room: data },
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

  for (const [field, value] of Object.entries(input)) {
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
      if (typeof value !== "string" || value.length > 12000) {
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
    const { data, error } = await serverDb()
      .from("studio_rooms")
      .update({
        ...changes,
        updated_at: new Date().toISOString(),
      })
      .eq("code", code)
      .select()
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
