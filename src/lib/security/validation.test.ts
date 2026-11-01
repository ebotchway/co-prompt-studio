import { describe, expect, it } from "vitest";
import {
  snapshotHash,
  validComparisonResult,
  validSnapshot,
} from "@/lib/security/validation";

const base = {
  prompt_a: "A",
  prompt_b: "B",
  system_prompt: "S",
  test_input: "input",
  temperature: 0.7,
};

describe("snapshot validation", () => {
  it("accepts a valid snapshot", () => {
    expect(validSnapshot(base)).toBe(true);
  });

  it("rejects unexpected top-level keys", () => {
    expect(validSnapshot({ ...base, extra: "x" })).toBe(false);
  });

  it("rejects missing fields", () => {
    expect(validSnapshot({ ...base, prompt_a: undefined })).toBe(
      false
    );
  });

  it("enforces the 8k test input cap", () => {
    expect(
      validSnapshot({ ...base, test_input: "x".repeat(8001) })
    ).toBe(false);
    expect(
      validSnapshot({ ...base, test_input: "x".repeat(8000) })
    ).toBe(true);
  });

  it("enforces the 12k prompt cap", () => {
    expect(
      validSnapshot({ ...base, prompt_a: "x".repeat(12001) })
    ).toBe(false);
  });

  it("rejects out-of-range temperature", () => {
    expect(validSnapshot({ ...base, temperature: 2.1 })).toBe(false);
    expect(validSnapshot({ ...base, temperature: -0.1 })).toBe(false);
    expect(validSnapshot({ ...base, temperature: NaN })).toBe(false);
  });

  it("rejects blank test input and non-objects", () => {
    expect(validSnapshot({ ...base, test_input: "   " })).toBe(false);
    expect(validSnapshot(null)).toBe(false);
    expect(validSnapshot([base])).toBe(false);
  });
});

describe("snapshot hash", () => {
  it("is stable for identical snapshots", () => {
    expect(snapshotHash(base)).toBe(snapshotHash({ ...base }));
  });

  it("changes with any field", () => {
    expect(snapshotHash(base)).not.toBe(
      snapshotHash({ ...base, temperature: 0.8 })
    );
  });

  it("is a sha-256 hex digest", () => {
    expect(snapshotHash(base)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("comparison result validation", () => {
  const result = {
    text: "output",
    latencyMs: 120,
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    model: "gemini-test",
  };

  it("accepts a valid result", () => {
    expect(validComparisonResult(result)).toBe(true);
  });

  it("accepts an optional short error string", () => {
    expect(validComparisonResult({ ...result, error: "timed out" })).toBe(
      true
    );
  });

  it("rejects negative or fractional counters", () => {
    expect(
      validComparisonResult({ ...result, inputTokens: -1 })
    ).toBe(false);
    expect(
      validComparisonResult({ ...result, latencyMs: 1.5 })
    ).toBe(false);
  });

  it("rejects missing model and non-object payloads", () => {
    expect(validComparisonResult({ ...result, model: "" })).toBe(false);
    expect(validComparisonResult(null)).toBe(false);
    expect(validComparisonResult("ok")).toBe(false);
  });
});
