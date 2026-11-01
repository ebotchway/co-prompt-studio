import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;

loadEnvConfig(process.cwd());

const key = process.env.GEMINI_API_KEY;

if (!key || key.startsWith("YOUR_")) {
  console.error("GEMINI_API_KEY is missing or is still a placeholder.");
  process.exit(1);
}

const preferred = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-2.5-flash",
];

let models = [];
let pageToken;

try {
  do {
    const url = new URL(
      "https://generativelanguage.googleapis.com/v1beta/models"
    );

    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetch(url, {
      headers: { "x-goog-api-key": key },
    });

    const json = await response.json();

    if (!response.ok) {
      console.error("Model listing failed:", response.status);
      console.error(json.error?.message || "Unknown API error");
      process.exit(1);
    }

    models.push(...(json.models || []));
    pageToken = json.nextPageToken;
  } while (pageToken);

  const available = models.filter(
    (m) => m.supportedGenerationMethods?.includes("generateContent")
  );

  console.log("Models supporting generateContent:");

  for (const model of available) {
    console.log(`  ${model.name.replace(/^models\//, "")}`);
  }

  console.log("\nPreferred model availability:");

  for (const id of preferred) {
    const exists = available.some((m) => m.name === `models/${id}`);
    console.log(`${exists ? "LISTED" : "NOT LISTED"} ${id}`);
  }

  const selected = process.env.GEMINI_MODEL;

  console.log(
    `\nConfigured model: ${selected || "(not configured)"}`
  );

} catch (error) {
  console.error("Gemini API request failed:",
    error instanceof Error ? error.message : "Unknown error"
  );
  process.exit(1);
}
