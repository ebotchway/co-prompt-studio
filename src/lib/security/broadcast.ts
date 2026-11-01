import type { SupabaseClient } from "@supabase/supabase-js";

export async function notifyRunCompleted(
  db: SupabaseClient,
  code: string
): Promise<void> {
  try {
    const channel = db.channel(`coprompt-room-${code}`);

    const subscribed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2500);
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });

    if (!subscribed) {
      await db.removeChannel(channel);
      return;
    }

    await channel.send({
      type: "broadcast",
      event: "results-updated",
      payload: {},
    });

    await db.removeChannel(channel);
  } catch {
    console.error("Run completion notification failed");
  }
}
