-- Security hardening v2: room identity, run records, rate limits, realtime auth.
-- Additive only: new tables + new columns; no existing row or column is
-- dropped or rewritten. studio_rooms.code is TEXT (see schema.sql), which is
-- the type every foreign key below references.
--
-- Verification plan (after applying):
--   1. Run supabase/security-hardening-verification.sql (policy checks).
--   2. \d public.studio_rooms        -> new columns present, data intact
--   3. \d public.room_memberships    -> FKs to studio_rooms(code) and auth.users(id)
--   4. select count(*) from public.studio_rooms;  -> unchanged row count (incl. 6878)
--
-- Rollback plan (reverse order, none of it touches existing room data):
--   drop policy "room members can broadcast" on realtime.messages;
--   drop policy "room members can subscribe" on realtime.messages;
--   drop function public.is_room_member(text);
--   drop function public.consume_rate_limit(text, integer, integer);
--   drop table public.rate_limit_counters;
--   drop table public.room_runs;
--   drop table public.room_memberships;
--   alter table public.studio_rooms
--     drop column if exists access_token_hash,
--     drop column if exists access_token_issued_at,
--     drop column if exists owner_member_id,
--     drop column if exists run_status,
--     drop column if exists run_claimed_at;

-- 1. Room access credential and run claim state -----------------------------

alter table public.studio_rooms
  add column if not exists access_token_hash text,
  add column if not exists access_token_issued_at timestamptz,
  add column if not exists owner_member_id uuid,
  add column if not exists run_status text not null default 'idle',
  add column if not exists run_claimed_at timestamptz;

-- Run status is constrained: a room is either idle or running. Concurrent
-- claiming is a single conditional UPDATE guarded by run_status /
-- run_claimed_at (see src/lib/security/run-claims.ts), so two overlapping
-- Gemini requests cannot both hold the claim; a stale claim (crashed run)
-- is reclaimable only after RUN_CLAIM_TTL_SECONDS, and the loser's release
-- is bound to its own run_claimed_at value.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'studio_rooms_run_status_check'
  ) then
    alter table public.studio_rooms
      add constraint studio_rooms_run_status_check
      check (run_status in ('idle', 'running'));
  end if;
end $$;

create index if not exists studio_rooms_run_claim_idx
  on public.studio_rooms(run_claimed_at)
  where run_status = 'running';

-- 2. Memberships -------------------------------------------------------------
-- auth_user_id is NOT NULL and FK-bound to auth.users(id): a membership only
-- exists for a verified Supabase identity created through the join endpoint.
-- Legacy rooms (e.g. 6878) are NOT auto-claimed; see the legacy note below.

create table if not exists public.room_memberships (
  id uuid primary key default gen_random_uuid(),
  room_code text not null references public.studio_rooms(code)
    on delete cascade,
  auth_user_id uuid not null references auth.users(id)
    on delete cascade,
  role text not null default 'member'
    check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  unique (room_code, auth_user_id)
);

create index if not exists room_memberships_room_idx
  on public.room_memberships(room_code);

-- At most one owner membership per room.
create unique index if not exists room_memberships_owner_idx
  on public.room_memberships(room_code) where role = 'owner';

-- 3. Reproducible run records -----------------------------------------------

create table if not exists public.room_runs (
  id uuid primary key default gen_random_uuid(),
  room_code text not null references public.studio_rooms(code)
    on delete cascade,
  snapshot_hash text not null,
  model text not null,
  temperature double precision not null,
  result_a jsonb,
  result_b jsonb,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  error text,
  executed_at timestamptz not null default now()
);

create index if not exists room_runs_room_executed_idx
  on public.room_runs(room_code, executed_at desc);

-- 4. Persistent fixed-window rate limit counters ----------------------------

create table if not exists public.rate_limit_counters (
  counter_key text primary key,
  window_started_at timestamptz not null,
  event_count integer not null default 0
);

-- Atomic consume. One UPSERT handles both "new window" and "increment",
-- so concurrent first requests cannot reset each other: the unique index
-- serializes them and each request returns the post-increment count.
-- Parameters are validated; invalid input raises instead of allowing.
create or replace function public.consume_rate_limit(
  p_key text,
  p_window_seconds integer,
  p_max integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_count integer;
begin
  if p_key is null or length(p_key) = 0 or length(p_key) > 200 then
    raise exception 'consume_rate_limit: invalid key';
  end if;

  if p_window_seconds is null or p_window_seconds not between 1 and 86400 then
    raise exception 'consume_rate_limit: invalid window';
  end if;

  if p_max is null or p_max not between 1 and 100000 then
    raise exception 'consume_rate_limit: invalid max';
  end if;

  insert into public.rate_limit_counters as c
    (counter_key, window_started_at, event_count)
  values (p_key, v_now, 1)
  on conflict (counter_key) do update
    set window_started_at = case
          when c.window_started_at
                <= v_now - make_interval(secs => p_window_seconds)
            then v_now
          else c.window_started_at
        end,
        event_count = case
          when c.window_started_at
                <= v_now - make_interval(secs => p_window_seconds)
            then 1
          else c.event_count + 1
        end
  returning event_count into v_count;

  return v_count <= p_max;
end;
$$;

-- 5. Membership check used by Realtime policies ------------------------------
-- SECURITY DEFINER so RLS on realtime.messages can verify membership without
-- granting clients direct access to room_memberships. Fully qualified with an
-- empty search_path; stable; executable only by authenticated (the role held
-- by anonymous-sign-in users, whose JWTs carry role=authenticated).

create or replace function public.is_room_member(p_room_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_memberships m
    where m.room_code = p_room_code
      and m.auth_user_id = auth.uid()
  );
$$;

-- 6. Access control ----------------------------------------------------------
-- New tables only. realtime.messages RLS is already enabled by Supabase and
-- is intentionally NOT altered here.

alter table public.room_memberships enable row level security;
alter table public.room_runs enable row level security;
alter table public.rate_limit_counters enable row level security;

revoke all on public.room_memberships from anon, authenticated;
revoke all on public.room_runs from anon, authenticated;
revoke all on public.rate_limit_counters from anon, authenticated;

revoke all on function public.consume_rate_limit(text, integer, integer)
  from anon, authenticated, public;
revoke all on function public.is_room_member(text)
  from anon, public;

grant select, insert, update, delete
on table public.room_memberships, public.room_runs,
         public.rate_limit_counters
to service_role;

-- Quota counters are server-only: clients can never consume or reset limits.
grant execute on function public.consume_rate_limit(text, integer, integer)
  to service_role;

grant execute on function public.is_room_member(text)
  to authenticated;

-- 7. Realtime authorization for private room channels -----------------------
-- Anonymous sign-in issues role=authenticated JWTs, so the policies target
-- authenticated. Both broadcast (insert) and presence (publish via insert,
-- receive via select) are covered by these two policies; realtime.messages
-- is the single backing table for both extensions.

drop policy if exists "room members can subscribe"
  on realtime.messages;

create policy "room members can subscribe"
on realtime.messages
for select
to authenticated
using (
  realtime.extension in ('broadcast', 'presence')
  and realtime.topic() like 'coprompt-room-%'
  and public.is_room_member(
    replace(realtime.topic(), 'coprompt-room-', '')
  )
);

drop policy if exists "room members can broadcast"
on realtime.messages;

create policy "room members can broadcast"
on realtime.messages
for insert
to authenticated
with check (
  realtime.extension in ('broadcast', 'presence')
  and realtime.topic() like 'coprompt-room-%'
  and public.is_room_member(
    replace(realtime.topic(), 'coprompt-room-', '')
  )
);

-- 8. Legacy rooms ------------------------------------------------------------
-- Rooms created before this migration (including test room 6878) have a NULL
-- access_token_hash. Their rows and data are untouched. They stay locked
-- until an administrator issues a token out-of-band for a verified owner.
-- The UPDATE prints the raw token exactly once; only its hash is stored
-- (sha256 over the utf-8 token, matching src/lib/security/tokens.ts):
--
--   with new_token as (
--     select encode(gen_random_bytes(32), 'base64') as raw
--   )
--   update public.studio_rooms s
--   set access_token_hash = encode(sha256(convert_to(new_token.raw, 'utf8')), 'hex'),
--       access_token_issued_at = now()
--   from new_token
--   where s.code = '6878' and s.access_token_hash is null
--   returning new_token.raw as one_time_token_for_the_owner;
--
-- No endpoint assigns ownership of a legacy room automatically.
