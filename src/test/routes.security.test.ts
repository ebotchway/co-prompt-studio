import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase", () => ({
  serverDb: vi.fn(),
}));

import { serverDb } from "@/lib/supabase";
import { hashAccessToken } from "@/lib/security/tokens";
import { GET, PATCH } from "@/app/api/rooms/[code]/route";
import { POST as runPOST } from "@/app/api/rooms/[code]/run/route";
import { POST as joinPOST } from "@/app/api/rooms/[code]/join/route";
import { POST as createPOST } from "@/app/api/rooms/route";
import { claimRun } from "@/lib/security/run-claims";

type Result = { data: unknown; error: unknown };

const TOKEN = "test-access-token";
const HASH = hashAccessToken(TOKEN);

const authRoom = {
  data: {
    code: "1234",
    access_token_hash: HASH,
    access_token_issued_at: new Date().toISOString(),
  },
  error: null,
};

const legacyRoom = {
  data: {
    code: "6878",
    access_token_hash: null,
    access_token_issued_at: null,
  },
  error: null,
};

function builder(result: Result) {
  const b: Record<string, unknown> = {};

  for (const method of [
    "select", "eq", "neq", "is", "or", "order", "limit",
    "update", "insert", "upsert", "single", "maybeSingle", "returns",
  ]) {
    b[method] = vi.fn().mockReturnValue(b);
  }

  b.then = (
    resolve: (value: Result) => unknown,
    reject: (reason: unknown) => unknown
  ) => Promise.resolve(result).then(resolve, reject);

  return b;
}

function fakeDb(map: Record<string, Result[]>) {
  const queues = new Map(
    Object.entries(map).map(([table, results]) => [table, [...results]])
  );

  return {
    from: vi.fn((table: string) =>
      builder(
        (queues.get(table) as Result[] | undefined)?.shift() ?? {
          data: null,
          error: null,
        }
      )
    ),
    rpc: vi
      .fn()
      .mockResolvedValue({ data: true, error: null }),
    auth: {
      getUser: vi
        .fn()
        .mockResolvedValue({ data: { user: { id: "anon-1" } }, error: null }),
    },
  } as unknown as SupabaseClient;
}

function request(
  url: string,
  {
    token = TOKEN,
    method,
    body,
    headers: headerInit,
  }: {
    token?: string | null;
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {}
): NextRequest {
  const headers = new Headers(headerInit);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new NextRequest(url, { method, body, headers });
}

const ctx = { params: Promise.resolve({ code: "1234" }) };

beforeEach(() => {
  vi.mocked(serverDb).mockReset();
  process.env.GEMINI_RUNS_ENABLED = "true";
  process.env.GEMINI_API_KEY = "test-key";
});

describe("room authentication", () => {
  it("returns 401 on GET without a bearer token", async () => {
    vi.mocked(serverDb).mockReturnValue(fakeDb({}));

    const response = await GET(
      request("http://localhost/api/rooms/1234", { token: null }),
      ctx
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 on GET with a wrong token", async () => {
    vi.mocked(serverDb).mockReturnValue(
      fakeDb({
        studio_rooms: [
          { data: { code: "1234", access_token_hash: HASH }, error: null },
        ],
      })
    );

    const response = await GET(
      request("http://localhost/api/rooms/1234", { token: "wrong" }),
      ctx
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 on PATCH and run without a token", async () => {
    vi.mocked(serverDb).mockReturnValue(fakeDb({}));

    const patch = await PATCH(
      request("http://localhost/api/rooms/1234", {
        method: "PATCH",
        token: null,
        body: JSON.stringify({ prompt_a: "x" }),
        headers: { "Content-Type": "application/json" },
      }),
      ctx
    );

    const run = await runPOST(
      request("http://localhost/api/rooms/1234/run", {
        method: "POST",
        token: null,
        body: "{}",
        headers: { "Content-Type": "application/json" },
      }),
      ctx
    );

    expect(patch.status).toBe(401);
    expect(run.status).toBe(401);
  });

  it("returns 400 for a malformed room code", async () => {
    vi.mocked(serverDb).mockReturnValue(fakeDb({}));

    const response = await GET(
      request("http://localhost/api/rooms/abcd"),
      { params: Promise.resolve({ code: "abcd" }) }
    );

    expect(response.status).toBe(400);
  });
});

describe("PATCH", () => {
  it("returns 409 when expected_updated_at is stale", async () => {
    vi.mocked(serverDb).mockReturnValue(
      fakeDb({
        studio_rooms: [
          authRoom,
          { data: { code: "1234", updated_at: "2026-01-01T00:00:00Z" }, error: null },
        ],
      })
    );

    const response = await PATCH(
      request("http://localhost/api/rooms/1234", {
        method: "PATCH",
        body: JSON.stringify({
          prompt_a: "x",
          expected_updated_at: "2025-12-31T00:00:00Z",
        }),
        headers: { "Content-Type": "application/json" },
      }),
      ctx
    );

    expect(response.status).toBe(409);
  });

  it("applies the change when the version matches", async () => {
    const room = { code: "1234", prompt_a: "x", updated_at: "2026-01-02T00:00:00Z" };

    vi.mocked(serverDb).mockReturnValue(
      fakeDb({
        studio_rooms: [
          authRoom,
          { data: { code: "1234", updated_at: "2026-01-01T00:00:00Z" }, error: null },
          { data: room, error: null },
        ],
      })
    );

    const response = await PATCH(
      request("http://localhost/api/rooms/1234", {
        method: "PATCH",
        body: JSON.stringify({
          prompt_a: "x",
          expected_updated_at: "2026-01-01T00:00:00Z",
        }),
        headers: { "Content-Type": "application/json" },
      }),
      ctx
    );

    expect(response.status).toBe(200);
  });

  it("rejects unknown fields", async () => {
    vi.mocked(serverDb).mockReturnValue(
      fakeDb({ studio_rooms: [authRoom] })
    );

    const response = await PATCH(
      request("http://localhost/api/rooms/1234", {
        method: "PATCH",
        body: JSON.stringify({ access_token_hash: "x" }),
        headers: { "Content-Type": "application/json" },
      }),
      ctx
    );

    expect(response.status).toBe(400);
  });
});

describe("run", () => {
  it("returns 413 for oversized bodies", async () => {
    vi.mocked(serverDb).mockReturnValue(
      fakeDb({ studio_rooms: [authRoom] })
    );

    const response = await runPOST(
      request("http://localhost/api/rooms/1234/run", {
        method: "POST",
        body: JSON.stringify({
          prompt_a: "x".repeat(12000),
          prompt_b: "x".repeat(12000),
          system_prompt: "x".repeat(12000),
          test_input: "x".repeat(15000),
          temperature: 0.7,
        }),
        headers: { "Content-Type": "application/json" },
      }),
      ctx
    );

    expect(response.status).toBe(413);
  });

  it("returns 429 when the quota is exhausted", async () => {
    const db = fakeDb({ studio_rooms: [authRoom] });
    vi.mocked(db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: false,
      error: null,
    });
    vi.mocked(serverDb).mockReturnValue(db);

    const response = await runPOST(
      request("http://localhost/api/rooms/1234/run", {
        method: "POST",
        body: JSON.stringify({
          prompt_a: "A",
          prompt_b: "B",
          system_prompt: "S",
          test_input: "input",
          temperature: 0.7,
        }),
        headers: { "Content-Type": "application/json" },
      }),
      ctx
    );

    expect(response.status).toBe(429);
  });

  it("returns 409 when a run is already claimed", async () => {
    vi.mocked(serverDb).mockReturnValue(
      fakeDb({
        studio_rooms: [
          authRoom,
          { data: [], error: null },
        ],
      })
    );

    const response = await runPOST(
      request("http://localhost/api/rooms/1234/run", {
        method: "POST",
        body: JSON.stringify({
          prompt_a: "A",
          prompt_b: "B",
          system_prompt: "S",
          test_input: "input",
          temperature: 0.7,
        }),
        headers: { "Content-Type": "application/json" },
      }),
      ctx
    );

    expect(response.status).toBe(409);
  });

  it("rejects snapshots with unexpected keys", async () => {
    vi.mocked(serverDb).mockReturnValue(
      fakeDb({ studio_rooms: [authRoom] })
    );

    const response = await runPOST(
      request("http://localhost/api/rooms/1234/run", {
        method: "POST",
        body: JSON.stringify({
          prompt_a: "A",
          prompt_b: "B",
          system_prompt: "S",
          test_input: "input",
          temperature: 0.7,
          injected: "field",
        }),
        headers: { "Content-Type": "application/json" },
      }),
      ctx
    );

    expect(response.status).toBe(400);
  });
});

describe("legacy rooms and token expiry", () => {
  it("locks an unclaimed legacy room out of GET regardless of token", async () => {
    vi.mocked(serverDb).mockReturnValue(
      fakeDb({ studio_rooms: [legacyRoom, legacyRoom] })
    );

    const noToken = await GET(
      request("http://localhost/api/rooms/6878", { token: null }),
      ctx
    );

    const withToken = await GET(
      request("http://localhost/api/rooms/6878"),
      ctx
    );

    expect(noToken.status).toBe(401);
    expect(withToken.status).toBe(401);
    expect((await withToken.json()).error).toMatch(/not been claimed/);
  });

  it("returns 404 for a room that does not exist", async () => {
    vi.mocked(serverDb).mockReturnValue(
      fakeDb({ studio_rooms: [{ data: null, error: null }] })
    );

    const response = await GET(
      request("http://localhost/api/rooms/9999"),
      ctx
    );

    expect(response.status).toBe(404);
  });

  it("rejects an expired token when a TTL is configured", async () => {
    process.env.ACCESS_TOKEN_TTL_SECONDS = "5";

    vi.mocked(serverDb).mockReturnValue(
      fakeDb({
        studio_rooms: [
          {
            data: {
              code: "1234",
              access_token_hash: HASH,
              access_token_issued_at: new Date(
                Date.now() - 10 * 60 * 1000
              ).toISOString(),
            },
            error: null,
          },
        ],
      })
    );

    const response = await GET(
      request("http://localhost/api/rooms/1234"),
      ctx
    );

    delete process.env.ACCESS_TOKEN_TTL_SECONDS;

    expect(response.status).toBe(401);
    expect((await response.json()).error).toMatch(/expired/);
  });

  it("accepts the same token when no TTL is configured", async () => {
    vi.mocked(serverDb).mockReturnValue(
      fakeDb({
        studio_rooms: [
          authRoom,
          {
            data: { code: "1234", updated_at: "2026-01-01T00:00:00Z" },
            error: null,
          },
        ],
      })
    );

    const response = await GET(
      request("http://localhost/api/rooms/1234"),
      ctx
    );

    expect(response.status).toBe(200);
  });
});

describe("join", () => {
  it("returns 401 when the client session cannot be verified", async () => {
    const db = fakeDb({ studio_rooms: [authRoom] });
    vi.mocked(db.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: null },
      error: { message: "bad jwt" },
    });
    vi.mocked(serverDb).mockReturnValue(db);

    const response = await joinPOST(
      request("http://localhost/api/rooms/1234/join", {
        method: "POST",
        headers: { "x-supabase-auth": "forged-jwt" },
      }),
      ctx
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 without a room token", async () => {
    vi.mocked(serverDb).mockReturnValue(fakeDb({}));

    const response = await joinPOST(
      request("http://localhost/api/rooms/1234/join", {
        method: "POST",
        token: null,
        headers: { "x-supabase-auth": "jwt" },
      }),
      ctx
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 without a client session header", async () => {
    vi.mocked(serverDb).mockReturnValue(fakeDb({}));

    const response = await joinPOST(
      request("http://localhost/api/rooms/1234/join", {
        method: "POST",
      }),
      ctx
    );

    expect(response.status).toBe(401);
  });

  it("exchanges a valid token and session for a membership", async () => {
    const db = fakeDb({
      studio_rooms: [
        authRoom,
        { data: { code: "1234", owner_member_id: null }, error: null },
        { data: ["1234"], error: null },
      ],
      room_memberships: [
        { data: { id: "m1", role: "owner" }, error: null },
      ],
    });
    vi.mocked(serverDb).mockReturnValue(db);

    const response = await joinPOST(
      request("http://localhost/api/rooms/1234/join", {
        method: "POST",
        headers: { "x-supabase-auth": "anon-jwt" },
      }),
      ctx
    );

    expect(response.status).toBe(200);
    expect(db.from).toHaveBeenCalledWith("room_memberships");
    expect((await response.json()).role).toBe("owner");
  });

  it("joins as member when the room already has an owner", async () => {
    vi.mocked(serverDb).mockReturnValue(
      fakeDb({
        studio_rooms: [
          authRoom,
          { data: { code: "1234", owner_member_id: "m0" }, error: null },
        ],
        room_memberships: [
          { data: { id: "m2", role: "member" }, error: null },
        ],
      })
    );

    const response = await joinPOST(
      request("http://localhost/api/rooms/1234/join", {
        method: "POST",
        headers: { "x-supabase-auth": "anon-jwt" },
      }),
      ctx
    );

    expect(response.status).toBe(200);
    expect((await response.json()).role).toBe("member");
  });

  it("treats duplicate joins as idempotent", async () => {
    vi.mocked(serverDb).mockReturnValue(
      fakeDb({
        studio_rooms: [
          authRoom,
          { data: { code: "1234", owner_member_id: "m0" }, error: null },
        ],
        room_memberships: [
          { data: null, error: { code: "23505" } },
          { data: { id: "m2", role: "member" }, error: null },
        ],
      })
    );

    const response = await joinPOST(
      request("http://localhost/api/rooms/1234/join", {
        method: "POST",
        headers: { "x-supabase-auth": "anon-jwt" },
      }),
      ctx
    );

    expect(response.status).toBe(200);
    expect((await response.json()).joined).toBe(true);
  });

  it("falls back to member when the owner slot is taken concurrently", async () => {
    vi.mocked(serverDb).mockReturnValue(
      fakeDb({
        studio_rooms: [
          authRoom,
          { data: { code: "1234", owner_member_id: null }, error: null },
        ],
        room_memberships: [
          { data: null, error: { code: "23505" } },
          { data: { id: "m3", role: "member" }, error: null },
        ],
      })
    );

    const response = await joinPOST(
      request("http://localhost/api/rooms/1234/join", {
        method: "POST",
        headers: { "x-supabase-auth": "anon-jwt" },
      }),
      ctx
    );

    expect(response.status).toBe(200);
    expect((await response.json()).role).toBe("member");
  });
});

describe("fail-closed quotas and disabled execution", () => {
  it("returns 503, never runs Gemini, when the quota store is down", async () => {
    const db = fakeDb({ studio_rooms: [authRoom] });
    vi.mocked(db.rpc as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("counter storage down")
    );
    vi.mocked(serverDb).mockReturnValue(db);

    const response = await runPOST(
      request("http://localhost/api/rooms/1234/run", {
        method: "POST",
        body: JSON.stringify({
          prompt_a: "A",
          prompt_b: "B",
          system_prompt: "S",
          test_input: "input",
          temperature: 0.7,
        }),
        headers: { "Content-Type": "application/json" },
      }),
      ctx
    );

    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(
      /temporarily unavailable/
    );
  });

  it("returns 503 while Gemini execution is disabled by default", async () => {
    delete process.env.GEMINI_RUNS_ENABLED;

    vi.mocked(serverDb).mockReturnValue(fakeDb({}));

    const response = await runPOST(
      request("http://localhost/api/rooms/1234/run", {
        method: "POST",
        body: JSON.stringify({
          prompt_a: "A",
          prompt_b: "B",
          system_prompt: "S",
          test_input: "input",
          temperature: 0.7,
        }),
        headers: { "Content-Type": "application/json" },
      }),
      ctx
    );

    expect(response.status).toBe(503);
  });

  it("never exposes token material in a room GET response", async () => {
    vi.mocked(serverDb).mockReturnValue(
      fakeDb({
        studio_rooms: [
          authRoom,
          {
            data: {
              code: "1234",
              prompt_a: "a",
              prompt_b: "b",
              system_prompt: "s",
              test_input: "i",
              temperature: 0.7,
              result_a: null,
              result_b: null,
              updated_at: "2026-01-01T00:00:00Z",
              created_at: "2026-01-01T00:00:00Z",
            },
            error: null,
          },
        ],
        room_runs: [],
      })
    );

    const response = await GET(request("http://localhost/api/rooms/1234"), ctx);

    expect(response.status).toBe(200);

    const text = JSON.stringify(await response.json());

    expect(text).not.toContain("access_token_hash");
    expect(text).not.toContain("access_token_issued_at");
    expect(text).not.toContain("accessToken");
    expect(text).not.toContain(HASH);
  });

  it("returns the invite token exactly once at creation and no membership row yet", async () => {
    const db = fakeDb({
      studio_rooms: [
        {
          data: {
            code: "5678",
            prompt_a: "",
            prompt_b: "",
            system_prompt: "",
            test_input: "",
            temperature: 0.7,
            result_a: null,
            result_b: null,
            updated_at: "2026-01-01T00:00:00Z",
            created_at: "2026-01-01T00:00:00Z",
          },
          error: null,
        },
      ],
    });
    vi.mocked(serverDb).mockReturnValue(db);

    const response = await createPOST(
      request("http://localhost/api/rooms", { method: "POST" })
    );

    expect(response.status).toBe(201);

    const text = JSON.stringify(await response.json());

    expect(text).toContain("accessToken");
    expect(text).not.toContain("access_token_hash");
    expect(db.from).not.toHaveBeenCalledWith("room_memberships");
  });

  it("allows only one of two simultaneous run claims", async () => {
    const first = {
      from: vi.fn().mockReturnValue({
        update: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        select: vi
          .fn()
          .mockResolvedValue({ data: ["1234"], error: null }),
      }),
    } as unknown as SupabaseClient;
    const second = {
      from: vi.fn().mockReturnValue({
        update: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        select: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    } as unknown as SupabaseClient;

    const [a, b] = await Promise.all([
      claimRun(first, "1234", 90),
      claimRun(second, "1234", 90),
    ]);

    expect([a.claimed, b.claimed]).toEqual([true, false]);
  });
});
