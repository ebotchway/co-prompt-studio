import { createClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";

// Local acceptance test for private Realtime + membership authorization.
// Requires: local Supabase on 127.0.0.1:54321 with both migrations applied,
// the Next dev server running, and GEMINI_RUNS_ENABLED=false locally.
//
//   LOCAL_SUPABASE_URL=http://127.0.0.1:54321 \
//   LOCAL_SUPABASE_ANON_KEY=<anon key> \
//   LOCAL_APP_URL=http://localhost:3001 \
//   node scripts/local-private-realtime.mjs

const url = process.env.LOCAL_SUPABASE_URL;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const appUrl = process.env.LOCAL_APP_URL?.replace(/\/$/, "");

if (!url || !anonKey || !appUrl) {
  console.error(
    "Set LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, LOCAL_APP_URL"
  );
  process.exit(2);
}

const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function client() {
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: true },
  });
}

async function signInAnonymously(c) {
  const { error } = await c.auth.signInAnonymously();
  if (error) throw new Error(`anonymous sign-in failed: ${error.message}`);
  const session = (await c.auth.getSession()).data.session;
  if (!session?.access_token) throw new Error("no session after sign-in");
  return session;
}

async function createRoom(session) {
  const response = await fetch(`${appUrl}/api/rooms`, {
    method: "POST",
    headers: { "x-supabase-auth": session.access_token },
  });

  const body = await response.json();

  if (response.status !== 201 || !body.accessToken) {
    throw new Error(`room creation failed: ${response.status}`);
  }

  return { code: body.room.code, token: body.accessToken };
}

function join(code, token, session) {
  return fetch(`${appUrl}/api/rooms/${code}/join`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-supabase-auth": session.access_token,
    },
  });
}

function subscribe(channel) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("TIMED_OUT"), 10000);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve("SUBSCRIBED");
      } else if (
        status === "CHANNEL_ERROR" ||
        status === "TIMED_OUT" ||
        status === "CLOSED"
      ) {
        clearTimeout(timer);
        resolve(status);
      }
    });
  });
}

// ---- Setup: creator makes two rooms for cross-room isolation. ----

const creator = client();
const creatorSession = await signInAnonymously(creator);

const room1 = await createRoom(creatorSession);
const room2 = await createRoom(creatorSession);

check("creator created two rooms", Boolean(room1.code && room2.code), `${room1.code}, ${room2.code}`);

const memberA = client();
const memberB = client();
const outsider = client();

const sessionA = await signInAnonymously(memberA);
const sessionB = await signInAnonymously(memberB);
const sessionC = await signInAnonymously(outsider);

check("member A joined room 1", (await join(room1.code, room1.token, sessionA)).ok);
check("member B joined room 1", (await join(room1.code, room1.token, sessionB)).ok);
check("member B joined room 2", (await join(room2.code, room2.token, sessionB)).ok);

// ---- Private channel subscription ----

const chA1 = memberA.channel(`coprompt-room-${room1.code}`, {
  config: { private: true, presence: { key: "A" } },
});
const chB1 = memberB.channel(`coprompt-room-${room1.code}`, {
  config: { private: true, presence: { key: "B" } },
});
const chC1 = outsider.channel(`coprompt-room-${room1.code}`, {
  config: { private: true, presence: { key: "C" } },
});
const chB2 = memberB.channel(`coprompt-room-${room2.code}`, {
  config: { private: true, presence: { key: "B" } },
});
const chOwner2 = creator.channel(`coprompt-room-${room2.code}`, {
  config: { private: true, presence: { key: "owner" } },
});

await memberA.realtime.setAuth(sessionA.access_token);
await memberB.realtime.setAuth(sessionB.access_token);
await outsider.realtime.setAuth(sessionC.access_token);
await creator.realtime.setAuth(creatorSession.access_token);

const receivedB1 = [];
const receivedB2 = [];
const receivedOwner2 = [];

chB1.on("broadcast", { event: "edit" }, ({ payload }) => receivedB1.push(payload));
chB1.on("presence", { event: "sync" }, () => receivedB1.push({ presence: chB1.presenceState() }));
chB2.on("broadcast", { event: "edit" }, ({ payload }) => receivedB2.push(payload));
chOwner2.on("broadcast", { event: "edit" }, ({ payload }) => receivedOwner2.push(payload));

const [statusA1, statusB1, statusC1, statusB2, statusOwner2] = await Promise.all([
  subscribe(chA1),
  subscribe(chB1),
  subscribe(chC1),
  subscribe(chB2),
  subscribe(chOwner2),
]);

check("member A subscribed to private room 1", statusA1 === "SUBSCRIBED", statusA1);
check("member B subscribed to private room 1", statusB1 === "SUBSCRIBED", statusB1);
check("member B subscribed to private room 2", statusB2 === "SUBSCRIBED", statusB2);
check("owner subscribed to private room 2", statusOwner2 === "SUBSCRIBED", statusOwner2);

check(
  "unauthorized participant cannot join private room 1",
  statusC1 !== "SUBSCRIBED",
  statusC1
);

// ---- Broadcast delivery inside room 1 ----

if (statusA1 === "SUBSCRIBED") {
  await chA1.track({ name: "A", joined_at: new Date().toISOString() });
  const send = await chA1.send({
    type: "broadcast",
    event: "edit",
    payload: { sender: "A", field: "prompt_a", value: "private hello" },
  });

  void send;

  await new Promise((resolve) => setTimeout(resolve, 2000));

  check(
    "member B received A's broadcast and presence in room 1",
    receivedB1.some((p) => p?.field === "prompt_a") &&
      receivedB1.some(
        (p) => p?.presence && Object.keys(p.presence).length >= 1
      ),
    `${receivedB1.length} events`
  );
}

// ---- Cross-room isolation ----

if (statusA1 === "SUBSCRIBED") {
  await chA1.send({
    type: "broadcast",
    event: "edit",
    payload: { sender: "A", field: "system_prompt", value: "room1 only" },
  });

  await new Promise((resolve) => setTimeout(resolve, 2000));

  check(
    "room 1 broadcast did not leak into room 2 (B)",
    !receivedB2.some((p) => p?.field === "system_prompt"),
    `${receivedB2.length} events`
  );

  check(
    "room 1 broadcast did not leak into room 2 (owner)",
    !receivedOwner2.some((p) => p?.field === "system_prompt"),
    `${receivedOwner2.length} events`
  );

  if (statusB2 === "SUBSCRIBED") {
    await chB2.send({
      type: "broadcast",
      event: "edit",
      payload: { sender: "B", field: "test_input", value: "room2 only" },
    });

    await new Promise((resolve) => setTimeout(resolve, 2000));

    check(
      "room 2 broadcast reached owner but not room 1 members",
      receivedOwner2.some((p) => p?.field === "test_input") &&
        !receivedB1.some((p) => p?.field === "test_input"),
      `owner ${receivedOwner2.length} events`
    );
  }
}

// ---- API authorization: outsider, then immediate revocation ----

const outsiderGet = await fetch(`${appUrl}/api/rooms/${room1.code}`, {
  headers: {
    Authorization: `Bearer ${room1.token}`,
    "x-supabase-auth": sessionC.access_token,
  },
});

check("nonmember API GET rejected", outsiderGet.status === 403, `status ${outsiderGet.status}`);

execSync(
  `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -q -c "delete from room_memberships where room_code='${room1.code}' and auth_user_id='${sessionA.user.id}'"`,
  { stdio: "ignore" }
);

const revokedGet = await fetch(`${appUrl}/api/rooms/${room1.code}`, {
  headers: {
    Authorization: `Bearer ${room1.token}`,
    "x-supabase-auth": sessionA.access_token,
  },
});

check(
  "revoked member API access denied immediately",
  revokedGet.status === 403,
  `status ${revokedGet.status}`
);

// A re-subscribing after revocation must be rejected by RLS.
if (statusA1 === "SUBSCRIBED") await chA1.unsubscribe();
await memberA.realtime.setAuth(sessionA.access_token);

const chA1again = memberA.channel(`coprompt-room-${room1.code}`, {
  config: { private: true, presence: { key: "A2" } },
});

const revokedStatus = await subscribe(chA1again);

check(
  "revoked member cannot re-subscribe to private room 1",
  revokedStatus !== "SUBSCRIBED",
  revokedStatus
);

await creator.realtime.setAuth(null);
await memberA.realtime.setAuth(null);
await memberB.realtime.setAuth(null);
await outsider.realtime.setAuth(null);

const failed = results.filter((r) => !r.ok);

console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

process.exit(failed.length ? 1 : 0);
