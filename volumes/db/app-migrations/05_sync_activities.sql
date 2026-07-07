-- ============================================================
-- 05_sync_activities.sql
-- Backfill/safety-net sync support for GitHub REST activity polling.
-- ============================================================

-- The webhook path currently writes public.activities. The sync path writes
-- the same table too, but stores a namespaced github_event_id so retries do
-- not award XP more than once.
alter table public.activities
  add column if not exists github_event_id text;

create unique index if not exists idx_activities_github_event_id
  on public.activities(github_event_id)
  where github_event_id is not null;

comment on column public.activities.github_event_id is
  'Namespaced dedupe key. Example: github-rest:event:<GitHub event id>.';

-- Existing Edge code already calls add_pet_exp(p_user_id, p_exp). Keep that
-- simple call working, and add optional fields for activity logging/dedupe.
create or replace function public.add_pet_exp(
  p_user_id uuid,
  p_exp int,
  p_event_type text default 'commit',
  p_github_event_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_activity public.activities%rowtype;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  if p_exp is null or p_exp < 0 then
    raise exception 'p_exp must be a non-negative integer';
  end if;

  -- This insert is the idempotency gate. If p_github_event_id already exists,
  -- the trigger that updates pets will not fire again.
  insert into public.activities (
    user_id,
    event_type,
    xp_gained,
    metadata,
    github_event_id
  )
  values (
    p_user_id,
    p_event_type,
    p_exp,
    coalesce(p_metadata, '{}'::jsonb),
    p_github_event_id
  )
  on conflict (github_event_id)
  where github_event_id is not null
  do nothing
  returning *
    into inserted_activity;

  if inserted_activity.id is null then
    return jsonb_build_object(
      'inserted', false,
      'skipped_reason', 'duplicate',
      'github_event_id', p_github_event_id
    );
  end if;

  return jsonb_build_object(
    'inserted', true,
    'activity_id', inserted_activity.id,
    'xp_gained', inserted_activity.xp_gained,
    'github_event_id', inserted_activity.github_event_id
  );
end;
$$;

grant execute on function public.add_pet_exp(uuid, int, text, text, jsonb)
  to service_role;

-- Edge Functions should not query auth.identities directly through PostgREST.
-- This security definer RPC exposes only the minimum fields needed for sync.
create or replace function public.get_github_sync_accounts(
  p_user_id uuid default null
)
returns table (
  user_id uuid,
  github_id text,
  username text,
  access_token text
)
language sql
security definer
set search_path = public, auth
as $$
  select
    u.id as user_id,
    u.github_id,
    u.username,
    coalesce(
      i.identity_data->>'provider_access_token',
      i.identity_data->>'access_token',
      i.identity_data->>'provider_token',
      au.raw_app_meta_data->>'provider_access_token',
      au.raw_app_meta_data->>'access_token',
      au.raw_app_meta_data->>'provider_token',
      au.raw_user_meta_data->>'provider_access_token',
      au.raw_user_meta_data->>'access_token',
      au.raw_user_meta_data->>'provider_token'
    ) as access_token
  from public.users u
  join auth.users au
    on au.id = u.id
  left join auth.identities i
    on i.user_id = u.id
   and i.provider = 'github'
  where (p_user_id is null or u.id = p_user_id)
    and coalesce(
      i.identity_data->>'provider_access_token',
      i.identity_data->>'access_token',
      i.identity_data->>'provider_token',
      au.raw_app_meta_data->>'provider_access_token',
      au.raw_app_meta_data->>'access_token',
      au.raw_app_meta_data->>'provider_token',
      au.raw_user_meta_data->>'provider_access_token',
      au.raw_user_meta_data->>'access_token',
      au.raw_user_meta_data->>'provider_token'
    ) is not null
  order by u.updated_at desc;
$$;

grant execute on function public.get_github_sync_accounts(uuid)
  to service_role;
