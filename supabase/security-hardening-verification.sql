-- Manual verification for the private-room Realtime policies.
-- Run AFTER applying security-hardening.sql and BEFORE switching the client
-- to private channels. Connect as an admin role that can SET ROLE and set
-- request.jwt.claims. Anonymous sign-in users hold role=authenticated, so all
-- checks use the authenticated role. Any failure aborts with an exception.

begin;

-- Fixture: room 9999 with one member; the member's Supabase identity.
insert into public.studio_rooms (code, access_token_hash)
values ('9999', repeat('a', 64))
on conflict (code) do nothing;

insert into public.room_memberships (room_code, auth_user_id, role)
values (
  '9999',
  '11111111-1111-1111-1111-111111111111',
  'owner'
)
on conflict (room_code, auth_user_id) do nothing;

-- 1. A verified member may broadcast into their own room.
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

insert into realtime.messages (topic, extension, payload)
values ('coprompt-room-9999', 'broadcast', '{"event":"edit"}'::jsonb);

-- 2. A verified member may publish presence in their own room.
insert into realtime.messages (topic, extension, payload)
values ('coprompt-room-9999', 'presence', '{"presence_state":{}}'::jsonb);

-- 3. A member of one room cannot read another room's channel.
do $$
begin
  if exists (
    select 1 from realtime.messages
    where realtime.topic() = 'coprompt-room-0000'
  ) then
    raise exception 'FAIL: member read another room';
  end if;
end $$;

-- 4. A nonmember (authenticated, different identity) cannot read the room.
set local request.jwt.claims =
  '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

do $$
begin
  if exists (
    select 1 from realtime.messages
    where realtime.topic() = 'coprompt-room-9999'
  ) then
    raise exception 'FAIL: nonmember read room messages';
  end if;
end $$;

-- 5. A nonmember cannot broadcast into the room.
do $$
begin
  begin
    insert into realtime.messages (topic, extension, payload)
    values ('coprompt-room-9999', 'broadcast', '{"event":"edit"}'::jsonb);
    raise exception 'FAIL: nonmember broadcast was accepted';
  exception
    when insufficient_privilege or check_violation then
      null; -- expected: RLS rejected the insert
  end;
end $$;

-- 6. A nonmember cannot publish presence into the room.
do $$
begin
  begin
    insert into realtime.messages (topic, extension, payload)
    values ('coprompt-room-9999', 'presence', '{"presence_state":{}}'::jsonb);
    raise exception 'FAIL: nonmember presence was accepted';
  exception
    when insufficient_privilege or check_violation then
      null; -- expected
  end;
end $$;

-- 7. An anonymous client with no JWT at all is also rejected.
reset request.jwt.claims;

do $$
begin
  if exists (
    select 1 from realtime.messages
    where realtime.topic() = 'coprompt-room-9999'
  ) then
    raise exception 'FAIL: unauthenticated read room messages';
  end if;
end $$;

-- 8. Membership revocation takes effect immediately: delete the membership,
--    the former member can no longer read the room.
set local role postgres;

delete from public.room_memberships
where room_code = '9999'
  and auth_user_id = '11111111-1111-1111-1111-111111111111';

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

do $$
begin
  if exists (
    select 1 from realtime.messages
    where realtime.topic() = 'coprompt-room-9999'
  ) then
    raise exception 'FAIL: revoked member still reads the room';
  end if;
end $$;

rollback;
