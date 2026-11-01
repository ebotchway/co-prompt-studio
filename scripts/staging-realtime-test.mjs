import { createClient } from "@supabase/supabase-js";

// Genuine (non-mocked) staging verification for private-room Realtime
// authorization. Run AFTER applying security-hardening.sql, against staging:
//
//   STAGING_SUPABASE_URL=https://<proj>.supabase.co \
//   STAGING_SUPABASE_ANON_KEY=<publishable key> \
//   STAGING_APP_URL=https://<staging app> \
//   STAGING_ROOM_CODE=1234 \
//   STAGING_INVITE_TOKEN=<room access token> \
//   node scripts/staging-realtime-test.mjs
//
// Prerequisites on the staging project: anonymous sign-in enabled, Realtime
// authorization enabled, migration applied, and a room created via the app
// (its owner is the signed-in browser user who created it; the invite token
// is in that browser's sessionStorage under coprompt-token-<code>).
//
// The script mints three genuine anonymous users via Supabase Auth:
//   A and B join the room with the invite token (become members),
//   C never joins (unauthorized). It then checks:
//   1. member join with the invite token succeeds
//   2. member A subscribes to the private channel
//   3. member B receives A's broadcast and presence
//   4. C cannot subscribe to the private channel
//   5. C's broadcast is rejected or undelivered
//   6. C's API GET is rejected (403) even with a valid session
//   7. B's API GET is authorized

const url = process.env.STAGING_SUPABASE_URL;
const anonKey = process.env.STAGING_SUPABASE_ANON_KEY;
const appUrl = process.env.STAGING_APP_URL?.replace(/\/$/, "");
const roomCode = process.env.STAGING_ROOM_CODE;
const inviteToken = process.env.STAGING_INVITE_TOKEN;

if (!url || !anonKey || !appUrl || !roomCode || !inviteToken) {
  console.error(
    "Set STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY, STAGING_APP_URL, STAGING_ROOM_CODE, STAGING_INVITE_TOKEN"
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

const memberA = client();
const memberB = client();
const outsider = client();

const sessionA = await signInAnonymously(memberA);
const sessionB = await signInAnonymously(memberB);
const sessionC = await signInAnonymously(outsider);

// 1. Members join with the invite token + their genuine anonymous JWT.
const joinA = await fetch(`${appUrl}/api/rooms/${roomCode}/join`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${inviteToken}`,
    "x-supabase-auth": sessionA.access_token,
  },
});

check("member A join with invite token", joinA.ok, `status ${joinA.status}`);

const joinB = await fetch(`${appUrl}/api/rooms/${roomCode}/join`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${inviteToken}`,
    "x-supabase-auth": sessionB.access_token,
  },
});

check("member B join with invite token", joinB.ok, `status ${joinB.status}`);

// 2-3. Private channel subscription and delivery.
const received = [];
const channelName = `coprompt-room-${roomCode}`;

const channelA = memberA.channel(channelName, {
  config: { private: true, presence: { key: "member-a" } },
});

const channelB = memberB.channel(channelName, {
  config: { private: true, presence: { key: "member-b" } },
});

const channelC = outsider.channel(channelName, {
  config: { private: true, presence: { key: "outsider" } },
});

channelB.on("broadcast", { event: "staging-probe" }, ({ payload }) => {
  received.push(payload);
});

channelB.on("presence", { event: "sync" }, () => {
  if (Object.keys(channelB.presenceState()).length > 1) {
    received.push({ presence: true });
  }
});

function subscribe(channel) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("TIMEOUT"), 10000);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve("SUBSCRIBED");
      } else if (status === "CHANNEL_ERROR" || status === "CLOSED") {
        clearTimeout(timer);
        resolve(status);
      }
    });
  });
}

const [statusA, statusB, statusC] = await Promise.all([
  subscribe(channelA),
  subscribe(channelB),
  subscribe(channelC),
]);

check("member A subscribed to private channel", statusA === "SUBSCRIBED", statusA);
check("member B subscribed to private channel", statusB === "SUBSCRIBED", statusB);
check(
  "unauthorized user could not subscribe to private channel",
  statusC !== "SUBSCRIBED",
  statusC
);

// 4. Member presence is visible to B.
if (statusA === "SUBSCRIBED") {
  await channelA.track({ name: "staging-member-a" });
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

// 5. Member A broadcasts; B must receive it.
const sendA = await channelA.send({
  type: "broadcast",
  event: "staging-probe",
  payload: { probe: Date.now() },
});

await new Promise((resolve) => setTimeout(resolve, 2000));

check(
  "member B received member A broadcast and presence",
  received.some((p) => p?.probe) && received.some((p) => p?.presence),
  `received ${received.length} events, send ${sendA}`
);

// 6. Unauthorized broadcast is rejected or undelivered.
const sendC = await channelC.send({
  type: "broadcast",
  event: "staging-probe",
  payload: { spoofed: true },
});

check(
  "unauthorized broadcast rejected or undelivered",
  sendC === "error" || sendC === "timed out" ||
    !received.some((p) => p?.spoofed),
  `send returned ${sendC}`
);

// 7. API authorization follows membership, not just the invite token.
const outsiderGet = await fetch(`${appUrl}/api/rooms/${roomCode}`, {
  headers: {
    Authorization: `Bearer ${inviteToken}`,
    "x-supabase-auth": sessionC.access_token,
  },
});

check(
  "nonmember API GET rejected",
  outsiderGet.status === 403,
  `status ${outsiderGet.status}`
);

const memberGet = await fetch(`${appUrl}/api/rooms/${roomCode}`, {
  headers: {
    Authorization: `Bearer ${inviteToken}`,
    "x-supabase-auth": sessionB.access_token,
  },
});

check("member API GET authorized", memberGet.ok, `status ${memberGet.status}`);

// 8. Immediate revocation: delete A's membership server-side via the app is
// not exposed as an API (owner-only, future work); verify the DB-driven path
// by removing the membership with the service role key if provided.
const serviceKey = process.env.STAGING_SERVICE_ROLE_KEY;

if (serviceKey) {
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  await admin
    .from("room_memberships")
    .delete()
    .eq("room_code", roomCode)
    .eq("auth_user_id", sessionA.user.id);

  const revokedGet = await fetch(`${appUrl}/api/rooms/${roomCode}`, {
    headers: {
      Authorization: `Bearer ${inviteToken}`,
      "x-supabase-auth": sessionA.access_token,
    },
  });

  check(
    "revoked member API access denied immediately",
    revokedGet.status === 403,
    `status ${revokedGet.status}`
  );
} else {
  console.log("SKIP  revocation check (STAGING_SERVICE_ROLE_KEY not set)");
}

const failed = results.filter((r) => !r.ok);

console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

process.exit(failed.length ? 1 : 0);
