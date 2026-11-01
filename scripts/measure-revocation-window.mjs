import { createClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";

// Measures how long a revoked member keeps receiving on an already-open
// private Realtime socket. Requires LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY,
// LOCAL_APP_URL.

const url = process.env.LOCAL_SUPABASE_URL;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const appUrl = process.env.LOCAL_APP_URL?.replace(/\/$/, "");

if (!url || !anonKey || !appUrl) {
  console.error("Set LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, LOCAL_APP_URL");
  process.exit(2);
}

function client() {
  return createClient(url, anonKey, { auth: { persistSession: false } });
}

async function signIn(c) {
  await c.auth.signInAnonymously();
  return (await c.auth.getSession()).data.session;
}

function subscribe(ch) {
  return new Promise((res) => {
    const t = setTimeout(() => res("TIMED_OUT"), 8000);
    ch.subscribe((s) => {
      if (s === "SUBSCRIBED" || s === "CHANNEL_ERROR" || s === "CLOSED") {
        clearTimeout(t);
        res(s);
      }
    });
  });
}

const creator = client();
const creatorSession = await signIn(creator);

const createResponse = await fetch(`${appUrl}/api/rooms`, {
  method: "POST",
  headers: { "x-supabase-auth": creatorSession.access_token },
});

const created = await createResponse.json();
const code = created.room.code;
const token = created.accessToken;

const A = client();
const B = client();
const sa = await signIn(A);
const sb = await signIn(B);

for (const [, s] of [[A, sa], [B, sb]]) {
  await fetch(`${appUrl}/api/rooms/${code}/join`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-supabase-auth": s.access_token,
    },
  });
}

await A.realtime.setAuth(sa.access_token);
await B.realtime.setAuth(sb.access_token);

const chA = A.channel(`coprompt-room-${code}`, {
  config: { private: true, presence: { key: "A" } },
});
const chB = B.channel(`coprompt-room-${code}`, {
  config: { private: true, presence: { key: "B" } },
});

const bEvents = [];

chB.on("broadcast", { event: "edit" }, ({ payload }) =>
  bEvents.push({ at: Date.now(), payload })
);

const [sa1, sb1] = await Promise.all([subscribe(chA), subscribe(chB)]);
console.log(`A: ${sa1}, B: ${sb1}, room ${code}`);

const revocationAt = Date.now();

execSync(
  `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -q -c "delete from room_memberships where room_code='${code}' and auth_user_id='${sb.user.id}'"`,
  { stdio: "ignore" }
);

console.log(`revoked at t=0 (${new Date(revocationAt).toISOString()})`);

// Broadcast from A every 2s for 40s; log when B stops receiving.
let lastReceived = null;

for (let i = 0; i < 20; i++) {
  await chA.send({
    type: "broadcast",
    event: "edit",
    payload: { n: i, at: Date.now() },
  });
  await new Promise((r) => setTimeout(r, 2000));

  const latest = bEvents[bEvents.length - 1];

  if (latest && latest.payload?.n === i && !lastReceived) {
    lastReceived = { n: i, secondsAfterRevocation: (Date.now() - revocationAt) / 1000 };
  }

  if (i % 5 === 4) {
    const got = bEvents.filter((e) => e.payload?.n !== undefined).map((e) => e.payload.n);
    console.log(`t=${(i + 1) * 2}s  B received broadcasts n=${got.join(",") || "none"}`);
  }
}

const got = bEvents.filter((e) => e.payload?.n !== undefined).map((e) => e.payload.n);
console.log(`\nFinal: B received broadcast numbers: ${got.join(",") || "none"}`);
console.log(`Last broadcast received ${lastReceived?.secondsAfterRevocation.toFixed(1) ?? "n/a"}s after revocation`);

// Can revoked B still publish?
const send = await chB.send({
  type: "broadcast",
  event: "edit",
  payload: { n: "revoked-send" },
});
console.log(`Revoked B send result: ${send}`);

// Does A still receive B's post-revocation messages?
const aEvents = [];
chA.on("broadcast", { event: "edit" }, ({ payload }) => aEvents.push(payload));
await chB.send({ type: "broadcast", event: "edit", payload: { n: "revoked-send-2" } });
await new Promise((r) => setTimeout(r, 3000));
console.log(`A received from revoked B: ${JSON.stringify(aEvents.filter((e) => typeof e.n === "string"))}`);

process.exit(0);
