import type { SupabaseClient } from "@supabase/supabase-js";

export async function claimRun(
  db: SupabaseClient,
  code: string,
  ttlSeconds: number
): Promise<{ claimed: boolean; claimedAt: string }> {
  const now = new Date();
  const staleBefore = new Date(
    now.getTime() - ttlSeconds * 1000
  ).toISOString();

  const { data, error } = await db
    .from("studio_rooms")
    .update({
      run_status: "running",
      run_claimed_at: now.toISOString(),
    })
    .or(
      `run_status.neq.running,run_claimed_at.lt.${staleBefore}`
    )
    .eq("code", code)
    .select("code");

  if (error) throw error;

  return {
    claimed: Array.isArray(data) && data.length > 0,
    claimedAt: now.toISOString(),
  };
}

export async function releaseRunClaim(
  db: SupabaseClient,
  code: string,
  claimedAt: string
): Promise<void> {
  await db
    .from("studio_rooms")
    .update({ run_status: "idle", run_claimed_at: null })
    .eq("code", code)
    .eq("run_status", "running")
    .eq("run_claimed_at", claimedAt);
}
