-- ============================================================
-- 13_sync_activities_last_synced.sql
-- Incremental scheduled sync support for GitHub activity polling.
-- ============================================================

-- backfilled_at is for the one-time onboarding import. last_synced_at is for
-- scheduled incremental syncs that keep already-registered users up to date.
alter table public.users
  add column if not exists last_synced_at timestamptz;

comment on column public.users.last_synced_at is
  'Last successful scheduled GitHub activity sync timestamp for this user.';

create index if not exists idx_users_last_synced_at
  on public.users(last_synced_at);

-- Keep the existing RPC name used by sync-activities, but include
-- last_synced_at so the Edge Function can request only incremental activity.
drop function if exists public.get_github_sync_accounts(uuid);

create or replace function public.get_github_sync_accounts(
  p_user_id uuid default null
)
returns table (
  user_id uuid,
  github_id text,
  username text,
  access_token text,
  last_synced_at timestamptz
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
    ) as access_token,
    u.last_synced_at
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
  order by coalesce(u.last_synced_at, u.created_at) asc, u.updated_at desc;
$$;

grant execute on function public.get_github_sync_accounts(uuid)
  to service_role;

create or replace function public.mark_github_activities_synced(
  p_user_id uuid,
  p_synced_at timestamptz default now()
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  update public.users
  set
    last_synced_at = coalesce(p_synced_at, now()),
    updated_at = now()
  where id = p_user_id;

  if not found then
    raise exception 'user not found: %', p_user_id;
  end if;

  return (
    select last_synced_at
    from public.users
    where id = p_user_id
  );
end;
$$;

grant execute on function public.mark_github_activities_synced(uuid, timestamptz)
  to service_role;
