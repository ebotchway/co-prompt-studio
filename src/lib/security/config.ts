function num(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export const limits = {
  roomCreate: {
    windowSeconds: num("ROOM_CREATE_WINDOW_SECONDS", 3600),
    max: num("ROOM_CREATE_MAX_PER_WINDOW", 10),
  },
  roomPatch: {
    windowSeconds: num("ROOM_PATCH_WINDOW_SECONDS", 60),
    max: num("ROOM_PATCH_MAX_PER_WINDOW", 120),
  },
  runPerRoom: {
    windowSeconds: num("RUN_QUOTA_WINDOW_SECONDS", 86400),
    max: num("RUN_QUOTA_PER_ROOM_DAY", 50),
  },
  runGlobal: {
    windowSeconds: num("RUN_QUOTA_WINDOW_SECONDS", 86400),
    max: num("RUN_QUOTA_GLOBAL_DAY", 500),
  },
  textFieldMax: 12000,
  testInputMax: num("TEST_INPUT_MAX_CHARS", 8000),
  runClaimTtlSeconds: num("RUN_CLAIM_TTL_SECONDS", 90),
  bodyMaxChars: 50000,
};
