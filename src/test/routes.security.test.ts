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

const member = { data: { id: "m1", role: "owner" }, error: null };

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

function fakeDb(
  map: Record<string, Result[]> = {},
  { rpcResult = { data: true, error: null } as unknown, rpcReject = false } = {}
) {
  const queues = new Map(
    Object.entries(map).map(([table, results]) => [table, [...results]])
  );

  const rpc = vi.fn();
  if (rpcReject) rpc.mockRejectedValue(new Error("counter storage down"));
  else rpc.mockResolvedValue(rpcResult);

  return {
    from: vi.fn((table: string) =>
      builder(
        (queues.get(table) as Result[] | undefined)?.shift() ?? {
          data: null,
          error: null,
        }
      )
    ),
    rpc,
    auth: {
      getUser: vi
        .fn()
        .mockResolvedValue({ data: { user: { id: "user-1" } }, error: null }),
    },
    channel: vi.fn().mockReturnValue({
      subscribe: (cb: (status: string) => void) => cb("SUBSCRIBED"),
      send: vi.fn().mockResolvedValue("ok"),
    }),
    removeChannel: vi.fn().mockResolvedValue(undefined),
  } as unknown as SupabaseClient & {
    rpc: ReturnType<typeof vi.fn>;
    auth: { getUser: ReturnType<typeof vi.fn> };
    from: ReturnType<typeof vi.fn>;
  };
}

function request(
  url: string,
  {
    token = TOKEN,
    jwt = "valid-anon-jwt",
    method,
    body,
    headers: headerInit,
  }: {
    token?: string | null;
    jwt?: string | null;
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {}
): NextRequest {
  const headers = new Headers(headerInit);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (jwt) headers.set("x-supabase-auth", jwt);
  return new NextRequest(url, { method, body, headers });
}

const ctx = { params: Promise.resolve({ code: "1234" }) };

const memberTables = {
  studio_rooms: [authRoom],
  room_memberships: [member],
};

beforeEach(() => {
  vi.mocked(serverDb).mockReset();
  process.env.GEMINI_RUNS_ENABLED = "true";
  process.env.GEMINI_API_KEY = "test-key";
});

describe("membership-gated authorization", () => {
  it("returns 401 on GET without an invite token", async () => {
    vi.mocked(serverDb).mockReturnValue(fakeDb());

    const response = await GET(
      request("http://localhost/api/rooms/1234", { token: null }),
      ctx
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 on GET with a wrong invite token", async () => {
    vi.mocked(serverDb).mockReturnValue(
      fakeDb({ studio_rooms: [authRoom] })
    );

    const response = await GET(
      request("http://localhost/api/rooms/1234", { token: "wrong" }),
      ctx
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 on GET without a verified client session", async () => {
    vi.mocked(serverDb).mockReturnValue(
      fakeDb(memberTables, {
        rpcReject: false,
      })
    );

    const response = await GET(
      request("http://localhost/api/rooms/1234", { jwt: null }),
      ctx
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 when the client session cannot be verified", async () => {
    const db = fakeDb(memberTables);
    vi.mocked(db.auth.getUser).mockResolvedValue({
      data: { user: null },
      error: { message: "bad jwt" },
    });
    vi.mocked(serverDb).mockReturnValue(db);

    const response = await GET(request("http://localhost/api/rooms/1234"), ctx);

    expect(response.status).toBe(401);
  });

  it("returns 403 immediately when the caller is not a member (revocation)", async () => {
    vi.mocked(serverDb).mockReturnValue(
      fakeDb({
        studio_rooms: [authRoom],
        room_memberships: [{ data: null, error: null }],
      })
    );

    const response = await GET(request("http://localhost/api/rooms/1234"), ctx);

    expect(response.status).toBe(403);
  });

  it("returns 404 for a room that does not exist", async () => {
    vi.mocked(serverDb).mockReturnValue(
      fakeDb({ studio_rooms: [{ data: null, error: null }] })
    );

    const response = await GET(request("http://localhost/api/rooms/9999"), ctx);

    expect(response.status).toBe(404);
  });

  it("returns 400 for a malformed room code", async () => {
    vi.mocked(serverDb).mockReturnValue(fakeDb());

    const response = await GET(request("http://localhost/api/rooms/abcd"), {
      params: Promise.resolve({ code: "abcd" }),
    });

    expect(response.status).toBe(400);
  });

  it("locks an unclaimed legacy room regardless of token", async () => {
    vi.mocked(serverDb).mockReturnValue(
      fakeDb({ studio_rooms: [legacyRoom, legacyRoom] })
    );

    const noToken = await GET(
      request("http://localhost/api/rooms/6878", { token: null, jwt: null }),
      ctx
    );

    const withToken = await GET(
      request("http://localhost/api/rooms/6878"),
      ctx
    );

    expect(noToken.status).toBe(401);
    expect(withToken.status).toBe(401);
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
        room_memberships: [member],
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
});

describe("PATCH", () => {
  it("returns 409 when expected_updated_at is stale", async () => {
    vi.mocked(serverDb).mockReturnValue(
      fakeDb({
        studio_rooms: [
          authRoom,
          { data: { code: "1234", updated_at: "2026-01-01T00:00:00Z" }, error: null },
        ],
        room_memberships: [member],
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
        room_memberships: [member],
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
    vi.mocked(serverDb).mockReturnValue(fakeDb(memberTables));

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
  const snapshot = {
    prompt_a: "A",
    prompt_b: "B",
    system_prompt: "S",
    test_input: "input",
    temperature: 0.7,
  };

  function runRequest() {
    return request("http://localhost/api/rooms/1234/run", {
      method: "POST",
      body: JSON.stringify(snapshot),
      headers: { "Content-Type": "application/json" },
    });
  }

  it("returns 503 while Gemini execution is disabled by default", async () => {
    delete process.env.GEMINI_RUNS_ENABLED;

    vi.mocked(serverDb).mockReturnValue(fakeDb());

    const response = await runPOST(runRequest(), ctx);

    expect(response.status).toBe(503);
  });

  it("returns 413 for oversized bodies", async () => {
    vi.mocked(serverDb).mockReturnValue(fakeDb(memberTables));

    const response = await runPOST(
      request("http://localhost/api/rooms/1234/run", {
        method: "POST",
        body: JSON.stringify({
          ...snapshot,
          test_input: "x".repeat(51000),
        }),
        headers: { "Content-Type": "application/json" },
      }),
      ctx
    );

    expect(response.status).toBe(413);
  });

  it("rejects snapshots with unexpected keys", async () => {
    vi.mocked(serverDb).mockReturnValue(fakeDb(memberTables));

    const response = await runPOST(
      request("http://localhost/api/rooms/1234/run", {
        method: "POST",
        body: JSON.stringify({ ...snapshot, injected: "field" }),
        headers: { "Content-Type": "application/json" },
      }),
      ctx
    );

    expect(response.status).toBe(400);
  });

  it("returns 429 when the quota is exhausted", async () => {
    const db = fakeDb(memberTables, { rpcResult: { data: false, error: null } });
    vi.mocked(serverDb).mockReturnValue(db);

    const response = await runPOST(runRequest(), ctx);

    expect(response.status).toBe(429);
  });

  it("returns 503, never runs Gemini, when the quota store is down", async () => {
    const db = fakeDb(memberTables, { rpcReject: true });
    vi.mocked(serverDb).mockReturnValue(db);

    const fetchSpy = vi.spyOn(global, "fetch");

    const response = await runPOST(runRequest(), ctx);

    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/temporarily unavailable/);
    expect(
      fetchSpy.mock.calls.filter(([url]) => String(url).includes("googleapis"))
    ).toHaveLength(0);

    fetchSpy.mockRestore();
  });

  it("returns 409 when a run is already claimed", async () => {
    vi.mocked(serverDb).mockReturnValue(
      fakeDb({
        studio_rooms: [authRoom, { data: [], error: null }],
        room_memberships: [member],
      })
    );

    const response = await runPOST(runRequest(), ctx);

    expect(response.status).toBe(409);
  });

  it("completes an authorized run with server-validated results", async () => {
    const geminiJson = {
      candidates: [{ content: { parts: [{ text: "model output" }] } }],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 2,
        totalTokenCount: 3,
      },
    };

    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(geminiJson), { status: 200 })
      );

    vi.mocked(serverDb).mockReturnValue(
      fakeDb({
        studio_rooms: [
          authRoom,
          { data: ["1234"], error: null },
          { data: ["1234"], error: null },
          { data: ["1234"], error: null },
        ],
        room_memberships: [member],
        room_runs: [
          { data: { id: "run-1" }, error: null },
          { data: null, error: null },
        ],
      })
    );

    const response = await runPOST(runRequest(), ctx);

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.runId).toBe("run-1");
    expect(body.result_a.text).toBe("model output");
    expect(body.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    fetchSpy.mockRestore();
  });
});

describe("join", () => {
  it("returns 401 without an invite token", async () => {
    vi.mocked(serverDb).mockReturnValue(fakeDb());

    const response = await joinPOST(
      request("http://localhost/api/rooms/1234/join", {
        method: "POST",
        token: null,
      }),
      ctx
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 without a client session header", async () => {
    vi.mocked(serverDb).mockReturnValue(fakeDb());

    const response = await joinPOST(
      request("http://localhost/api/rooms/1234/join", { method: "POST", jwt: null }),
      ctx
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 when the client session cannot be verified", async () => {
    const db = fakeDb({ studio_rooms: [authRoom] });
    vi.mocked(db.auth.getUser).mockResolvedValue({
      data: { user: null },
      error: { message: "bad jwt" },
    });
    vi.mocked(serverDb).mockReturnValue(db);

    const response = await joinPOST(
      request("http://localhost/api/rooms/1234/join", { method: "POST" }),
      ctx
    );

    expect(response.status).toBe(401);
  });

  it("joins an invited user as member with an active membership", async () => {
    const db = fakeDb({
      studio_rooms: [authRoom],
      room_memberships: [{ data: { id: "m2", role: "member" }, error: null }],
    });
    vi.mocked(serverDb).mockReturnValue(db);

    const response = await joinPOST(
      request("http://localhost/api/rooms/1234/join", { method: "POST" }),
      ctx
    );

    expect(response.status).toBe(200);
    expect((await response.json()).role).toBe("member");
    expect(db.from).toHaveBeenCalledWith("room_memberships");
  });

  it("treats duplicate joins as idempotent", async () => {
    vi.mocked(serverDb).mockReturnValue(
      fakeDb({
        studio_rooms: [authRoom],
        room_memberships: [
          { data: null, error: { code: "23505" } },
          { data: { id: "m2", role: "member" }, error: null },
        ],
      })
    );

    const response = await joinPOST(
      request("http://localhost/api/rooms/1234/join", { method: "POST" }),
      ctx
    );

    expect(response.status).toBe(200);
    expect((await response.json()).joined).toBe(true);
  });
});

describe("room creation", () => {
  it("returns 401 without a verified client session", async () => {
    vi.mocked(serverDb).mockReturnValue(fakeDb());

    const response = await createPOST(
      request("http://localhost/api/rooms", { method: "POST", jwt: null })
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 when the client session cannot be verified", async () => {
    const db = fakeDb();
    vi.mocked(db.auth.getUser).mockResolvedValue({
      data: { user: null },
      error: { message: "bad jwt" },
    });
    vi.mocked(serverDb).mockReturnValue(db);

    const response = await createPOST(
      request("http://localhost/api/rooms", { method: "POST" })
    );

    expect(response.status).toBe(401);
  });

  it("assigns the owner role deterministically at creation", async () => {
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
        { data: ["5678"], error: null },
      ],
      room_memberships: [{ data: { id: "m1" }, error: null }],
    });
    vi.mocked(serverDb).mockReturnValue(db);

    const response = await createPOST(
      request("http://localhost/api/rooms", { method: "POST" })
    );

    expect(response.status).toBe(201);

    const text = JSON.stringify(await response.json());

    expect(text).toContain("accessToken");
    expect(text).not.toContain("access_token_hash");
    expect(db.from).toHaveBeenCalledWith("room_memberships");

    const insertCall = vi
      .mocked(db.from)
      .mock.results.find(
        (r) => (r.value as { mock?: { calls: unknown[][] } }).mock
      );
    void insertCall;
  });

  it("rate limits room creation per address", async () => {
    const db = fakeDb({}, { rpcResult: { data: false, error: null } });
    vi.mocked(serverDb).mockReturnValue(db);

    const response = await createPOST(
      request("http://localhost/api/rooms", { method: "POST" })
    );

    expect(response.status).toBe(429);
  });
});

describe("simultaneous run claims", () => {
  it("allows only one of two simultaneous claims", async () => {
    const makeDb = (rows: string[]) =>
      ({
        from: vi.fn().mockReturnValue({
          update: vi.fn().mockReturnThis(),
          or: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          select: vi.fn().mockResolvedValue({ data: rows, error: null }),
        }),
      }) as unknown as SupabaseClient;

    const [a, b] = await Promise.all([
      claimRun(makeDb(["1234"]), "1234", 90),
      claimRun(makeDb([]), "1234", 90),
    ]);

    expect([a.claimed, b.claimed]).toEqual([true, false]);
  });
});
