import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { RoomEdit } from "@/lib/room-types";

export interface RoomRealtimeCallbacks {
  onConnectionChange(connected: boolean): void;
  onEdit(edit: RoomEdit): void;
  onResultsUpdated(): void;
  onPresenceCount(count: number): void;
  onMembershipDenied(): void;
  onJoinedRoom(): void;
  onSubscribed(channel: RealtimeChannel | null): void;
  presenceKey(): string;
}

export interface RoomRealtimeDeps {
  supabase: SupabaseClient;
  code: string;
  getSessionToken(): Promise<string | null>;
  joinRoom(): Promise<{ ok: boolean; status: number }>;
  probeMembership(): Promise<number>;
  callbacks: RoomRealtimeCallbacks;
}

const PROBE_INTERVAL_MS = 45000;
const MAX_BACKOFF_MS = 30000;

function topicFor(code: string) {
  return `coprompt-room-${code}`;
}

export class RoomRealtimeController {
  private readonly deps: RoomRealtimeDeps;
  private generation = 0;
  private stopped = true;
  private attempts = 0;
  private joinedOk = false;
  private connected = false;
  private joinPromise: Promise<{ ok: boolean; status: number }> | null = null;
  private channel: RealtimeChannel | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private probeInFlight = false;

  constructor(deps: RoomRealtimeDeps) {
    this.deps = deps;
  }

  start(): void {
    if (!this.stopped) return;

    this.stopped = false;
    void this.attempt(++this.generation);
    this.probeTimer = setInterval(
      () => void this.runMembershipProbe(),
      PROBE_INTERVAL_MS
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    this.joinPromise = null;

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }

    await this.disposeChannel();
    this.setConnected(false);
  }

  async setAuth(token: string): Promise<void> {
    if (this.stopped) return;
    await this.deps.supabase.realtime.setAuth(token);
  }

  private setConnected(connected: boolean) {
    if (this.connected !== connected) {
      this.connected = connected;
      this.deps.callbacks.onConnectionChange(connected);
    }
  }

  private joinOnce(): Promise<{ ok: boolean; status: number }> {
    this.joinPromise ??= this.deps.joinRoom();
    return this.joinPromise;
  }

  private async disposeChannel(): Promise<void> {
    const channel = this.channel;
    this.channel = null;

    if (channel) {
      this.deps.callbacks.onSubscribed(null);

      await this.deps.supabase.removeChannel(channel);
    }
  }

  private async ensureFreshChannel(
    config: { private: boolean; presence: { key: string } }
  ): Promise<RealtimeChannel> {
    const topic = topicFor(this.deps.code);

    // supabase-js caches channel instances by topic until removal
    // completes; a still-registered subscribed channel must never be
    // handed back for re-wiring.
    const existing = this.deps.supabase
      .getChannels()
      .find((channel) => channel.topic === topic);

    if (existing) {
      await this.deps.supabase.removeChannel(existing);
    }

    return this.deps.supabase.channel(topic, { config });
  }

  private async attempt(generation: number): Promise<void> {
    const sessionToken = await this.deps.getSessionToken();

    if (this.stale(generation)) return;

    if (!sessionToken) {
      this.scheduleRetry(generation);
      return;
    }

    if (!this.joinedOk) {
      const join = await this.joinOnce();

      if (this.stale(generation)) return;

      if (!join.ok) {
        if (join.status === 401 || join.status === 403) {
          await this.deny();
        } else {
          this.joinPromise = null;
          this.scheduleRetry(generation);
        }

        return;
      }

      this.joinedOk = true;
    }

    await this.deps.supabase.realtime.setAuth(sessionToken);

    if (this.stale(generation)) return;

    const channel = await this.ensureFreshChannel({
      private: true,
      presence: { key: this.deps.callbacks.presenceKey() },
    });

    if (this.stale(generation)) {
      await this.deps.supabase.removeChannel(channel);
      return;
    }

    channel.on(
      "broadcast",
      { event: "edit" },
      ({ payload }) => this.deps.callbacks.onEdit(payload as RoomEdit)
    );

    channel.on("broadcast", { event: "results-updated" }, () => {
      this.deps.callbacks.onResultsUpdated();
    });

    channel.on("presence", { event: "sync" }, () => {
      this.deps.callbacks.onPresenceCount(
        Object.keys(channel.presenceState()).length
      );
    });

    this.channel = channel;
    this.deps.callbacks.onSubscribed(channel);

    channel.subscribe((status) => {
      if (generation !== this.generation) return;

      if (status === "SUBSCRIBED") {
        this.attempts = 0;
        this.setConnected(true);

        void channel.track({
          name: this.deps.callbacks.presenceKey(),
          joined_at: new Date().toISOString(),
        });

        this.deps.callbacks.onJoinedRoom();
      } else if (
        status === "CHANNEL_ERROR" ||
        status === "TIMED_OUT" ||
        status === "CLOSED"
      ) {
        this.setConnected(false);
        void this.handleSocketLoss(generation);
      }
    });
  }

  private stale(generation: number) {
    return this.stopped || generation !== this.generation;
  }

  private async handleSocketLoss(generation: number): Promise<void> {
    await this.disposeChannel();

    if (this.stale(generation)) return;

    this.attempts += 1;

    if (this.attempts >= 3) {
      const status = await this.deps.probeMembership();

      if (this.stale(generation)) return;

      if (status === 401 || status === 403) {
        await this.deny();
        return;
      }
    }

    this.scheduleRetry(generation);
  }

  private scheduleRetry(generation: number): void {
    if (this.stopped || generation !== this.generation) return;

    if (this.retryTimer) clearTimeout(this.retryTimer);

    const delay = Math.min(
      MAX_BACKOFF_MS,
      1000 * 2 ** Math.max(0, this.attempts - 1)
    );

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;

      if (this.stale(generation)) return;

      void this.attempt(generation);
    }, delay);
  }

  private async deny(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    this.joinPromise = null;

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }

    await this.disposeChannel();
    this.setConnected(false);
    this.deps.callbacks.onMembershipDenied();
  }

  private async runMembershipProbe(): Promise<void> {
    if (this.stopped || this.probeInFlight) return;

    this.probeInFlight = true;

    try {
      const status = await this.deps.probeMembership();

      if (this.stopped) return;

      if (status === 401 || status === 403) {
        await this.deny();
      }
    } catch {
      // Network errors during the probe are tolerated; the socket loss
      // path owns reconnection decisions.
    } finally {
      this.probeInFlight = false;
    }
  }
}
