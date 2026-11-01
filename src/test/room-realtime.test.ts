import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { RoomRealtimeController } from "@/lib/realtime/room-realtime";
import type { RoomRealtimeCallbacks } from "@/lib/realtime/room-realtime";

class FakeChannel {
  topic: string;
  subscribed = false;
  events: string[] = [];
  handlers: Record<string, Array<(status: string) => void>> = {};
  track = vi.fn(async () => "ok" as const);
  send = vi.fn(async () => "ok" as const);

  constructor(topic: string) {
    this.topic = topic;
  }

  on(type: string, _filter: unknown, callback: () => void) {
    if (this.subscribed) {
      throw new Error(
        `cannot add \`${type}\` callbacks for ${this.topic} after subscribe()`
      );
    }

    this.events.push(`on:${type}`);
    (this.handlers[type] ??= []).push(callback);
    return this;
  }

  subscribe(callback: (status: string) => void) {
    this.events.push("subscribe");
    this.subscribed = true;
    this.handlers.subscribe = [callback];
    queueMicrotask(() => callback("SUBSCRIBED"));
    return this;
  }

  emit(status: string) {
    for (const cb of this.handlers.subscribe ?? []) cb(status);
  }

  presenceState() {
    return { self: [{ name: "self" }] };
  }
}

function fakeSupabase() {
  const registry = new Map<string, FakeChannel>();
  const removed: FakeChannel[] = [];
  const created: FakeChannel[] = [];

  return {
    registry,
    removed,
    created,
    realtime: { setAuth: vi.fn(async () => undefined) },
    channel(topic: string) {
      const existing = registry.get(topic);

      if (existing) return existing;

      const channel = new FakeChannel(topic);
      registry.set(topic, channel);
      created.push(channel);
      return channel;
    },
    async removeChannel(channel: FakeChannel) {
      // Mirror supabase-js: the instance stays registered until the
      // server acknowledges the leave.
      await Promise.resolve();
      registry.delete(channel.topic);
      removed.push(channel);
      return "ok" as const;
    },
    getChannels() {
      return [...registry.values()] as unknown as RealtimeChannel[];
    },
  };
}

type Harness = Awaited<ReturnType<typeof makeController>>;

async function makeController(overrides: {
  join?: () => Promise<{ ok: boolean; status: number }>;
  probe?: () => Promise<number>;
  session?: Promise<string> | string;
} = {}) {
  const supabase = fakeSupabase();
  const connectionChanges: boolean[] = [];
  const denied = vi.fn();
  const joinedRoom = vi.fn();
  const joinedChannels: Array<RealtimeChannel | null> = [];

  let session = overrides.session ?? "tok-1";

  const join =
    overrides.join ?? (async () => ({ ok: true, status: 200 }));
  const probe = overrides.probe ?? (async () => 200);

  const joinRoom = vi.fn(join);
  const probeMembership = vi.fn(probe);

  const callbacks: RoomRealtimeCallbacks = {
    onConnectionChange: (c) => connectionChanges.push(c),
    onEdit: () => undefined,
    onResultsUpdated: () => undefined,
    onPresenceCount: () => undefined,
    onMembershipDenied: denied,
    onJoinedRoom: joinedRoom,
    onSubscribed: (channel) => joinedChannels.push(channel),
    presenceKey: () => "tester",
  };

  const controller = new RoomRealtimeController({
    supabase: supabase as unknown as ConstructorParameters<
      typeof RoomRealtimeController
    >[0]["supabase"],
    code: "4650",
    getSessionToken: async () =>
      typeof session === "string" || session === null
        ? session
        : await session,
    joinRoom: joinRoom as unknown as () => Promise<{
      ok: boolean;
      status: number;
    }>,
    probeMembership: probeMembership as unknown as () => Promise<number>,
    callbacks,
  });

  return {
    controller,
    supabase,
    joinRoom,
    probeMembership,
    connectionChanges,
    denied,
    joinedRoom,
    joinedChannels,
    realtimeSetAuth: supabase.realtime.setAuth,
    setSession(next: Promise<string> | string) {
      session = next;
    },
  };
}

function activeChannel(h: Harness) {
  return h.supabase.created[h.supabase.created.length - 1];
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RoomRealtimeController", () => {
  it("registers every broadcast and presence handler before subscribe()", async () => {
    const h = await makeController();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);

    const channel = activeChannel(h);

    expect(channel.events).toEqual([
      "on:broadcast",
      "on:broadcast",
      "on:presence",
      "subscribe",
    ]);
  });

  it("never reuses a subscribed channel when rebuilding after socket loss", async () => {
    const h = await makeController();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);

    const first = activeChannel(h);
    first.emit("CHANNEL_ERROR");

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);

    const second = activeChannel(h);

    expect(second).not.toBe(first);
    expect(h.supabase.removed).toContain(first);
    expect(second.subscribed).toBe(true);
    expect(second.events[second.events.length - 1]).toBe("subscribe");
  });

  it("joins exactly once across repeated reconnects", async () => {
    const h = await makeController();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);

    for (let i = 0; i < 5; i++) {
      activeChannel(h).emit("CHANNEL_ERROR");
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(h.joinRoom).toHaveBeenCalledTimes(1);
    expect(h.supabase.created.length).toBe(6);
  });

  it("does not let a stale async attempt subscribe after stop()", async () => {
    let releaseSession: ((token: string) => void) | undefined;

    const h = await makeController({
      session: new Promise<string>((resolve) => {
        releaseSession = resolve;
      }),
    });

    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.supabase.created.length).toBe(0);

    await h.controller.stop();

    releaseSession?.("late-token");
    await vi.advanceTimersByTimeAsync(60000);

    expect(h.supabase.created.length).toBe(0);
    expect(h.connectionChanges).not.toContain(true);
  });

  it("reports connected only for an established subscription", async () => {
    const h = await makeController();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.connectionChanges).toEqual([true]);

    activeChannel(h).emit("TIMED_OUT");
    await vi.advanceTimersByTimeAsync(0);

    expect(h.connectionChanges).toEqual([true, false]);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.connectionChanges).toEqual([true, false, true]);
  });

  it("forwards refreshed session tokens to the socket", async () => {
    const h = await makeController();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);

    await h.controller.setAuth("tok-2");
    expect(h.realtimeSetAuth).toHaveBeenCalledWith("tok-2");

    await h.controller.stop();
    await h.controller.setAuth("tok-3");
    expect(h.realtimeSetAuth).not.toHaveBeenCalledWith("tok-3");
  });

  it("never overlaps membership probe requests", async () => {
    let releaseProbe: ((status: number) => void) | undefined;

    const h = await makeController({
      probe: () =>
        new Promise<number>((resolve) => {
          releaseProbe = resolve;
        }),
    });

    h.controller.start();

    await vi.advanceTimersByTimeAsync(45000);
    expect(h.probeMembership).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(90000);
    expect(h.probeMembership).toHaveBeenCalledTimes(1);

    releaseProbe?.(200);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(45000);
    expect(h.probeMembership).toHaveBeenCalledTimes(2);
  });

  it("fails closed on a 403 membership probe", async () => {
    const h = await makeController({ probe: async () => 403 });
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(45000);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.denied).toHaveBeenCalledTimes(1);
    expect(h.supabase.removed).toContain(activeChannel(h));
    expect(h.connectionChanges[h.connectionChanges.length - 1]).toBe(false);

    const afterStop = h.supabase.created.length;
    await vi.advanceTimersByTimeAsync(120000);
    expect(h.supabase.created.length).toBe(afterStop);
  });

  it("caps reconnect backoff at 30 seconds", async () => {
    const h = await makeController();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);

    const delays: number[] = [];
    let created = 1;

    for (let i = 0; i < 7; i++) {
      activeChannel(h).emit("CHANNEL_ERROR");
      await vi.advanceTimersByTimeAsync(0);

      const expectedDelay = Math.min(30000, 1000 * 2 ** i);
      delays.push(expectedDelay);

      await vi.advanceTimersByTimeAsync(expectedDelay);
      await vi.advanceTimersByTimeAsync(0);

      created += 1;
      expect(h.supabase.created.length).toBe(created);
    }

    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it("leaves no retry timers behind after stop()", async () => {
    const h = await makeController();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);

    activeChannel(h).emit("CLOSED");
    await vi.advanceTimersByTimeAsync(0);

    await h.controller.stop();

    const channels = h.supabase.created.length;
    await vi.advanceTimersByTimeAsync(120000);

    expect(h.supabase.created.length).toBe(channels);
    expect(h.supabase.registry.size).toBe(0);
  });

  it("attaches presence listeners exactly once per fresh channel", async () => {
    const h = await makeController();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);

    for (let i = 0; i < 3; i++) {
      activeChannel(h).emit("CHANNEL_ERROR");
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);
    }

    for (const channel of h.supabase.created) {
      expect(
        (channel.handlers["presence"] ?? []).length
      ).toBe(1);
      expect(
        (channel.handlers["broadcast"] ?? []).length
      ).toBe(2);
    }

    expect(h.supabase.removed.length).toBe(3);
  });

  it("denies membership immediately when the join is rejected", async () => {
    const h = await makeController({
      join: async () => ({ ok: false, status: 403 }),
    });

    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.denied).toHaveBeenCalledTimes(1);
    expect(h.supabase.created.length).toBe(0);
    expect(h.connectionChanges).toEqual([]);
  });

  it("retries the join after a transient join failure", async () => {
    let calls = 0;

    const h = await makeController({
      join: async () => {
        calls += 1;
        return calls === 1
          ? { ok: false, status: 500 }
          : { ok: true, status: 200 };
      },
    });

    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.joinRoom).toHaveBeenCalledTimes(2);
    expect(activeChannel(h).subscribed).toBe(true);
  });
});
