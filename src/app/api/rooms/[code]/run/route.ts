import { NextRequest, NextResponse } from "next/server";
import { performance } from "node:perf_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serverDb } from "@/lib/supabase";
import type {
  ComparisonResult,
} from "@/lib/comparison-types";
import { authenticateRoom } from "@/lib/security/auth";
import {
  checkRunQuota,
  RateLimitUnavailableError,
} from "@/lib/security/rate-limit";
import { limits } from "@/lib/security/config";
import { validSnapshot, snapshotHash, validComparisonResult, type Snapshot } from "@/lib/security/validation";
import { claimRun, releaseRunClaim } from "@/lib/security/run-claims";
import { notifyRunCompleted } from "@/lib/security/broadcast";

type Context = {
  params: Promise<{ code: string }>;
};

function geminiFailed(model: string, latencyMs: number): ComparisonResult {
  return {
    text: "",
    latencyMs: Math.round(latencyMs),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    model,
    error: "Gemini request failed. Check server logs and model access.",
  };
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

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Gemini HTTP ${response.status}`);
    }

    const json = await response.json();

    const output = (
      json.candidates?.[0]?.content?.parts || []
    )
      .filter((part: { text?: unknown }) => typeof part.text === "string")
      .map((part: { text: string }) => part.text)
      .join("");

    const usage = json.usageMetadata || {};

    const result: ComparisonResult = {
      text: output || "(No text returned by the model)",
      latencyMs: Math.round(performance.now() - started),
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      totalTokens: usage.totalTokenCount ?? 0,
      model,
    };

    if (!validComparisonResult(result)) {
      throw new Error("Gemini returned an unexpected result shape");
    }

    return result;
  } catch (error) {
    console.error("Gemini execution failed:", {
      model,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    if (error instanceof Error && error.name === "AbortError") {
      return {
        text: "",
        latencyMs: Math.round(performance.now() - started),
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model,
        error: "Gemini request timed out",
      };
    }

    return geminiFailed(model, performance.now() - started);
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

  if (process.env.GEMINI_RUNS_ENABLED !== "true") {
    return NextResponse.json(
      { error: "AI comparisons are temporarily disabled" },
      { status: 503 }
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

  let db: SupabaseClient;

  try {
    db = serverDb();

    const auth = await authenticateRoom(db, code, request);

    if (!auth.ok) return auth.response;

    const allowed = await checkRunQuota(db, code);

    if (!allowed) {
      return NextResponse.json(
        { error: "Comparison quota reached for now. Try again later." },
        { status: 429 }
      );
    }
  } catch (error) {
    if (error instanceof RateLimitUnavailableError) {
      console.error("Run quota store unavailable");
      return NextResponse.json(
        { error: "Comparison temporarily unavailable" },
        { status: 503 }
      );
    }

    console.error("Comparison setup failed:", error);
    return NextResponse.json(
      { error: "Database error" },
      { status: 500 }
    );
  }

  const raw = await request.text();

  if (raw.length > limits.bodyMaxChars) {
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

  const snapshotValue = snapshot as Snapshot;
  const hash = snapshotHash(snapshotValue);

  let claimedAt: string | null = null;
  let runId: string | null = null;

  try {
    const claim = await claimRun(db, code, limits.runClaimTtlSeconds);

    if (!claim.claimed) {
      return NextResponse.json(
        { error: "A comparison is already running in this room" },
        { status: 409 }
      );
    }

    claimedAt = claim.claimedAt;

    const { data: runRow, error: runError } = await db
      .from("room_runs")
      .insert({
        room_code: code,
        snapshot_hash: hash,
        model,
        temperature: snapshotValue.temperature,
        status: "running",
      })
      .select("id")
      .single();

    if (runError) throw runError;

    runId = runRow.id;

    const [result_a, result_b] = await Promise.all([
      executeVariant(
        snapshotValue.system_prompt,
        snapshotValue.prompt_a,
        snapshotValue.test_input,
        snapshotValue.temperature,
        model,
        apiKey
      ),
      executeVariant(
        snapshotValue.system_prompt,
        snapshotValue.prompt_b,
        snapshotValue.test_input,
        snapshotValue.temperature,
        model,
        apiKey
      ),
    ]);

    const executedAt = new Date().toISOString();

    if (!validComparisonResult(result_a) || !validComparisonResult(result_b)) {
      throw new Error("Comparison results failed validation");
    }

    const { error: recordError } = await db
      .from("room_runs")
      .update({
        result_a,
        result_b,
        status: "completed",
        executed_at: executedAt,
      })
      .eq("id", runId);

    if (recordError) throw recordError;

    const { error: saveError } = await db
      .from("studio_rooms")
      .update({
        result_a,
        result_b,
        updated_at: executedAt,
      })
      .eq("code", code);

    if (saveError) throw saveError;

    await releaseRunClaim(db, code, claimedAt);
    claimedAt = null;

    void notifyRunCompleted(db, code);

    return NextResponse.json(
      { result_a, result_b, executedAt, runId, snapshotHash: hash },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Comparison endpoint:", error);

    if (runId) {
      await db
        .from("room_runs")
        .update({ status: "failed", error: "Run failed" })
        .eq("id", runId);
    }

    if (claimedAt) {
      await releaseRunClaim(db, code, claimedAt);
    }

    return NextResponse.json(
      { error: "Unable to complete comparison" },
      { status: 500 }
    );
  }
}
