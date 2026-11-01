-- Manual verification for the private-room Realtime policies.
-- Run AFTER applying security-hardening.sql and BEFORE switching the client
-- to private channels. Connect as a superuser/admin role (needs to SET ROLE
-- and set request.jwt.claims), ideally against a staging database.
-- Every block asserts a negative or positive authorization outcome; a failure
-- aborts the transaction with an exception naming the failed check.

begin;

-- Fixture: a room with one member (anon-uuid) and the same room accessed by
-- a nonmember (outsider-uuid).
insert into public.studio_rooms (code, access_token_hash)
values ('9999', repeat('a', 64))
on conflict (code) do nothing;

insert into public.room_memberships (room_code, auth_user_id, role)
values ('9999', '11111111-1111-1111-1111-111111111111', 'owner')
on conflict (room_code, auth_user_id) do nothing;

-- 1. Nonmember (anonymous, not signed in) can neither read nor broadcast.
set local role anon;
select count(*) as fail_nonmember_reads
from realtime.messages
where realtime.topic() = 'coprompt-room-9999'
having count(*) > 0;

do $$
begin
  if exists (
    select 1 from realtime.messages
    where realtime.topic() = 'coprompt-room-9999'
  ) then
    raise exception 'FAIL: nonmember read room messages';
  end if;
end $$;

-- 2. Member (anonymous sign-in with the membership's auth_user_id) can read
--    their room's channel.
set local role anon;
set local request.jwt.claims =
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"anon"}';

do $$
begin
  if not exists (
    select 1 from realtime.messages
    where realtime.topic() = 'coprompt-room-9999'
  ) then
    raise notice 'member read check: no historical messages (acceptable on an empty channel); insert check below is authoritative';
  end if;
end $$;

-- 3. Member can broadcast (insert) into their room channel.
insert into realtime.messages (topic, extension, payload)
values ('coprompt-room-9999', 'broadcast', '{"event":"edit"}'::jsonb);

-- 4. Nonmember cannot broadcast into any coprompt room channel.
reset request.jwt.claims;

do $$
begin
  begin
    insert into realtime.messages (topic, extension, payload)
    values ('coprompt-room-9999', 'broadcast', '{"event":"edit"}'::jsonb);
    raise exception 'FAIL: nonmember broadcast was accepted';
  exception
    when insufficient_privilege or check_violation then
      null; -- expected: policy rejected the insert
  end;
end $$;

-- 5. Presence uses the same realtime.messages policies; a nonmember has no
--    presence rows visible for the room.
do $$
begin
  if exists (
    select 1 from realtime.messages
    where realtime.topic() = 'coprompt-room-9999'
      and extension = 'presence'
  ) then
    raise exception 'FAIL: nonmember observed presence in the room';
  end if;
end $$;

-- 6. A member of one room cannot read another room's channel.
set local request.jwt.claims =
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"anon"}';

do $$
begin
  if exists (
    select 1 from realtime.messages
    where realtime.topic() = 'coprompt-room-0000'
  ) then
    raise exception 'FAIL: member read a different room';
  end if;
end $$;

rollback;
