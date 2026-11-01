import { randomInt } from "node:crypto";
import { NextResponse } from "next/server";
import { serverDb } from "@/lib/supabase";



export async function POST() {
  try {
    const db = serverDb();

    for (let attempt = 0; attempt < 20; attempt++) {
      const code = String(randomInt(1000, 10000));

      const { data, error } = await db
        .from("studio_rooms")
        .insert({
          code,
          prompt_a: "Explain the topic simply.",
          prompt_b: "Explain the topic using examples.",
          system_prompt: "You are a helpful AI assistant.",
          test_input: "What is machine learning?",
          temperature: 0.7,
        })
        .select()
        .single();

      if (!error && data) {
        return NextResponse.json(
          { room: data },
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
