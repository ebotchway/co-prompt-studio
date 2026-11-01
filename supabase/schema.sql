create table if not exists public.studio_rooms (
  code text primary key
    check (code ~ '^[0-9]{4}$'),
  prompt_a text not null default '',
  prompt_b text not null default '',
  system_prompt text not null default '',
  test_input text not null default '',
  temperature double precision not null default 0.7,
  result_a jsonb,
  result_b jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists studio_rooms_updated_idx
  on public.studio_rooms(updated_at desc);

-- Room data is accessed by server-side API routes only.
alter table public.studio_rooms enable row level security;

-- No anonymous INSERT, UPDATE, DELETE or SELECT grants.
revoke all on public.studio_rooms from anon, authenticated;

-- The trusted service-role API bypasses RLS.

-- Explicit server-only permissions for Supabase Data API
GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.studio_rooms
TO service_role;

-- Security hardening objects (memberships, run records, rate limits,
-- realtime authorization) live in security-hardening.sql. Apply it
-- separately, after this file:
--   psql -f supabase/security-hardening.sql
