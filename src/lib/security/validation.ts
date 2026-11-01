import { createHash } from "node:crypto";
import { limits } from "./config";

export type Snapshot = {
  prompt_a: string;
  prompt_b: string;
  system_prompt: string;
  test_input: string;
  temperature: number;
};

const SNAPSHOT_KEYS = new Set([
  "prompt_a",
  "prompt_b",
  "system_prompt",
  "test_input",
  "temperature",
]);

const PROMPT_FIELD_MAX = limits.textFieldMax;

function validTextField(
  value: unknown,
  max: number
): value is string {
  return typeof value === "string" && value.length <= max;
}

export function validSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const v = value as Record<string, unknown>;

  for (const key of Object.keys(v)) {
    if (!SNAPSHOT_KEYS.has(key)) {
      return false;
    }
  }

  const promptsValid =
    validTextField(v.prompt_a, PROMPT_FIELD_MAX) &&
    validTextField(v.prompt_b, PROMPT_FIELD_MAX) &&
    validTextField(v.system_prompt, PROMPT_FIELD_MAX);

  const inputValid = validTextField(
    v.test_input,
    limits.testInputMax
  );

  return (
    promptsValid &&
    inputValid &&
    typeof v.temperature === "number" &&
    Number.isFinite(v.temperature) &&
    v.temperature >= 0 &&
    v.temperature <= 2 &&
    (v.test_input as string).trim().length > 0
  );
}

export function snapshotHash(snapshot: Snapshot): string {
  const canonical = JSON.stringify({
    prompt_a: snapshot.prompt_a,
    prompt_b: snapshot.prompt_b,
    system_prompt: snapshot.system_prompt,
    test_input: snapshot.test_input,
    temperature: snapshot.temperature,
  });

  return createHash("sha256").update(canonical).digest("hex");
}

export function validComparisonResult(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const v = value as Record<string, unknown>;

  const nonNegativeInt = (x: unknown) =>
    typeof x === "number" && Number.isInteger(x) && x >= 0;

  return (
    typeof v.text === "string" &&
    v.text.length <= PROMPT_FIELD_MAX * 2 &&
    nonNegativeInt(v.latencyMs) &&
    nonNegativeInt(v.inputTokens) &&
    nonNegativeInt(v.outputTokens) &&
    nonNegativeInt(v.totalTokens) &&
    typeof v.model === "string" &&
    v.model.length > 0 &&
    v.model.length <= 128 &&
    (v.error === undefined ||
      (typeof v.error === "string" && v.error.length <= 300))
  );
}
