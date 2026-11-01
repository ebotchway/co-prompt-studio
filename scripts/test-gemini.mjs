import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;

loadEnvConfig(process.cwd());

const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL;

if (!key || key.startsWith("YOUR_") || !model) {
  console.error("Configure GEMINI_API_KEY and GEMINI_MODEL first.");
  process.exit(1);
}

const started = performance.now();

const response = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: "Reply with exactly: Co-Prompt Studio Gemini connection successful"
        }]
      }],
      generationConfig: {
        maxOutputTokens: 100
      }
    })
  }
);

const json = await response.json();

console.log("HTTP status:", response.status);
console.log("Model:", model);
console.log("Latency (ms):", Math.round(performance.now() - started));

if (!response.ok) {
  console.error("Error:", json.error?.message || "Unknown error");
  process.exit(1);
}

const text = (json.candidates?.[0]?.content?.parts || [])
  .map(p => p.text || "")
  .join("");

console.log("Response:", text || "(No text returned)");
console.log("Token usage:", JSON.stringify(json.usageMetadata || {}));
