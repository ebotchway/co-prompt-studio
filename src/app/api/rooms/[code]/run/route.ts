import { NextRequest, NextResponse } from "next/server";
import { performance } from "node:perf_hooks";
import { serverDb } from "@/lib/supabase";
import type {
  ComparisonResult,
} from "@/lib/comparison-types";

type Context = {
  params: Promise<{ code: string }>;
};

type Snapshot = {
  prompt_a: string;
  prompt_b: string;
  system_prompt: string;
  test_input: string;
  temperature: number;
};

const LIMIT = 12000;

function validSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const v = value as Record<string, unknown>;

  const textFields = [
    "prompt_a", "prompt_b", "system_prompt", "test_input",
  ];

  return (
    textFields.every(
      (field) =>
        typeof v[field] === "string" &&
        (v[field] as string).length <= LIMIT
    ) &&
    typeof v.temperature === "number" &&
    Number.isFinite(v.temperature) &&
    v.temperature >= 0 &&
    v.temperature <= 2 &&
    (v.test_input as string).trim().length > 0
  );
}

async function executeVariant(
  instructions: string,
  variant: string,
  input: string,
  temperature: number,
  model: string,
  apiKey: string
): Promise<ComparisonResult> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: [instructions, variant]
                  .filter(Boolean)
                  .join("\n\n"),
              },
            ],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: input }],
            },
          ],
          generationConfig: {
            temperature,
            maxOutputTokens: 1536,
          },
        }),
        signal: controller.signal,
        cache: "no-store",
      }
    );

    const json = await response.json();

    if (!response.ok) {
      const message =
        json.error?.message || `Gemini HTTP ${response.status}`;
      throw new Error(String(message).slice(0, 300));
    }

    const output = (
      json.candidates?.[0]?.content?.parts || []
    )
      .filter((part: { text?: unknown }) => typeof part.text === "string")
      .map((part: { text: string }) => part.text)
      .join("");

    const usage = json.usageMetadata || {};

    return {
      text: output || "(No text returned by the model)",
      latencyMs: Math.round(performance.now() - started),
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      totalTokens: usage.totalTokenCount ?? 0,
      model,
    };
  } catch (error) {
    console.error("Gemini execution failed:", {
      model,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    return {
      text: "",
      latencyMs: Math.round(performance.now() - started),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      model,
      error: error instanceof Error
        ? error.name === "AbortError"
          ? "Gemini request timed out"
          : "Gemini request failed. Check server logs and model access."
        : "Unknown execution error",
    };
  } finally {
    clearTimeout(timer);
  }
}

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

  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

  if (!apiKey || apiKey.startsWith("YOUR_")) {
    return NextResponse.json(
      { error: "Gemini API key is not configured" },
      { status: 503 }
    );
  }

  const raw = await request.text();

  if (raw.length > 50000) {
    return NextResponse.json(
      { error: "Request too large" },
      { status: 413 }
    );
  }

  let snapshot: unknown;

  try {
    snapshot = JSON.parse(raw);
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON" },
      { status: 400 }
    );
  }

  if (!validSnapshot(snapshot)) {
    return NextResponse.json(
      { error: "Invalid prompt comparison inputs" },
      { status: 400 }
    );
  }

  try {
    const db = serverDb();

    const { data: existing, error: readError } = await db
      .from("studio_rooms")
      .select("code")
      .eq("code", code)
      .maybeSingle();

    if (readError) throw readError;

    if (!existing) {
      return NextResponse.json(
        { error: "Room not found" },
        { status: 404 }
      );
    }

    const [result_a, result_b] = await Promise.all([
      executeVariant(
        snapshot.system_prompt,
        snapshot.prompt_a,
        snapshot.test_input,
        snapshot.temperature,
        model,
        apiKey
      ),
      executeVariant(
        snapshot.system_prompt,
        snapshot.prompt_b,
        snapshot.test_input,
        snapshot.temperature,
        model,
        apiKey
      ),
    ]);

    const executedAt = new Date().toISOString();

    const { error: saveError } = await db
      .from("studio_rooms")
      .update({
        result_a,
        result_b,
        updated_at: executedAt,
      })
      .eq("code", code);

    if (saveError) throw saveError;

    return NextResponse.json(
      { result_a, result_b, executedAt },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Comparison endpoint:", error);

    return NextResponse.json(
      { error: "Unable to complete comparison" },
      { status: 500 }
    );
  }
}
