-- Security hardening: room identity, run records, rate limits, realtime auth.
-- Additive only: new tables + new columns, no existing column is dropped or
-- rewritten. Apply with: psql $DATABASE_URL -f supabase/security-hardening.sql

-- 1. Room access credential and run claim state -----------------------------

alter table public.studio_rooms
  add column if not exists access_token_hash text,
  add column if not exists access_token_issued_at timestamptz,
  add column if not exists owner_member_id uuid,
  add column if not exists run_status text not null default 'idle',
  add column if not exists run_claimed_at timestamptz;

-- Legacy rooms (created before this migration, e.g. test room 6878) have a
-- null access_token_hash. Their data is untouched; a room stays locked until
-- its owner claims it once via POST /api/rooms/[code]/claim, which issues a
-- token and binds it atomically (guarded by access_token_hash is null).

-- 2. Memberships: an anon-auth JWT linked to a room via a valid invite token

create table if not exists public.room_memberships (
  id uuid primary key default gen_random_uuid(),
  room_code text not null references public.studio_rooms(code)
    on delete cascade,
  auth_user_id uuid,
  role text not null default 'member'
    check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  unique (room_code, auth_user_id)
);

create index if not exists room_memberships_room_idx
  on public.room_memberships(room_code);

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

-- Atomic consume: one row per key, row lock serializes concurrent requests.
create or replace function public.consume_rate_limit(
  p_key text,
  p_window_seconds integer,
  p_max integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_window_start timestamptz;
  v_count integer;
begin
  select window_started_at, event_count
    into v_window_start, v_count
  from public.rate_limit_counters
  where counter_key = p_key
  for update;

  if not found
     or v_window_start <= v_now - make_interval(secs => p_window_seconds) then
    insert into public.rate_limit_counters (counter_key, window_started_at, event_count)
    values (p_key, v_now, 1)
    on conflict (counter_key) do update
      set window_started_at = excluded.window_started_at,
          event_count = 1;

    return true;
  end if;

  v_count := v_count + 1;

  update public.rate_limit_counters
  set event_count = v_count
  where counter_key = p_key;

  return v_count <= p_max;
end;
$$;

-- 5. Access control ----------------------------------------------------------

alter table public.room_memberships enable row level security;
alter table public.room_runs enable row level security;
alter table public.rate_limit_counters enable row level security;

revoke all on public.room_memberships from anon, authenticated;
revoke all on public.room_runs from anon, authenticated;
revoke all on public.rate_limit_counters from anon, authenticated;

revoke all on function public.consume_rate_limit(text, integer, integer)
  from anon, authenticated, public;

grant select, insert, update, delete
on table public.room_memberships, public.room_runs,
         public.rate_limit_counters
to service_role;

grant execute on function public.consume_rate_limit(text, integer, integer)
  to service_role;

-- 6. Realtime authorization for private room channels -----------------------
-- Clients sign in anonymously; the join endpoint links their auth_user_id to
-- the room only after the invite token is verified server-side.
-- NOTE: apply this migration and run security-hardening-verification.sql
-- BEFORE switching the client channels to private: true.

create policy "room members can subscribe"
on realtime.messages
for select
to anon
using (
  realtime.topic() like 'coprompt-room-%'
  and exists (
    select 1
    from public.room_memberships m
    where m.auth_user_id = auth.uid()
      and m.room_code = replace(realtime.topic(), 'coprompt-room-', '')
  )
);

create policy "room members can broadcast"
on realtime.messages
for insert
to anon
with check (
  realtime.topic() like 'coprompt-room-%'
  and exists (
    select 1
    from public.room_memberships m
    where m.auth_user_id = auth.uid()
      and m.room_code = replace(realtime.topic(), 'coprompt-room-', '')
  )
);
