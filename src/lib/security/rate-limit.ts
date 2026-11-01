import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { limits } from "./config";

type RpcResult = {
  data: unknown;
  error: { message?: string } | null;
};

export async function consumeRateLimit(
  db: SupabaseClient,
  key: string,
  windowSeconds: number,
  max: number
): Promise<boolean> {
  try {
    const { data, error } = (await db.rpc("consume_rate_limit", {
      p_key: key,
      p_window_seconds: windowSeconds,
      p_max: max,
    })) as unknown as RpcResult;

    if (error) throw error;

    return data === true;
  } catch {
    console.error("Rate limit counter unavailable");

    return true;
  }
}

export function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");

  if (forwarded) {
    return forwarded.split(",")[0].trim().slice(0, 64);
  }

  return request.headers.get("x-real-ip")?.slice(0, 64) || "unknown";
}

export async function checkRoomCreateLimit(
  db: SupabaseClient,
  request: NextRequest
): Promise<boolean> {
  return consumeRateLimit(
    db,
    `room-create:${clientIp(request)}`,
    limits.roomCreate.windowSeconds,
    limits.roomCreate.max
  );
}

export async function checkRoomPatchLimit(
  db: SupabaseClient,
  code: string
): Promise<boolean> {
  return consumeRateLimit(
    db,
    `room-patch:${code}`,
    limits.roomPatch.windowSeconds,
    limits.roomPatch.max
  );
}

export async function checkRunQuota(
  db: SupabaseClient,
  code: string
): Promise<boolean> {
  const [perRoom, global] = await Promise.all([
    consumeRateLimit(
      db,
      `run-room:${code}`,
      limits.runPerRoom.windowSeconds,
      limits.runPerRoom.max
    ),
    consumeRateLimit(
      db,
      "run-global",
      limits.runGlobal.windowSeconds,
      limits.runGlobal.max
    ),
  ]);

  return perRoom && global;
}
