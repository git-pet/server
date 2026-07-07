-- ============================================================
-- 06_backfill_user_activities.sql
-- One-time onboarding backfill support for GitHub OAuth users.
-- ============================================================

-- A completed timestamp is the coarse idempotency gate for onboarding.
-- The github_event_id unique index from 05_sync_activities.sql is still the
-- fine-grained gate that prevents duplicate activity rows and duplicate XP.
alter table public.users
  add column if not exists backfilled_at timestamptz;

comment on column public.users.backfilled_at is
  'Set when the onboarding GitHub activity backfill has completed for this user.';

create index if not exists idx_users_backfilled_at
  on public.users(backfilled_at);

-- Edge Functions should not read auth tables directly through PostgREST.
-- This exposes only the fields needed for a single-user onboarding backfill.
create or replace function public.get_github_backfill_account(
  p_user_id uuid
)
returns table (
  user_id uuid,
  github_id text,
  username text,
  access_token text,
  backfilled_at timestamptz
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
    u.backfilled_at
  from public.users u
  join auth.users au
    on au.id = u.id
  left join auth.identities i
    on i.user_id = u.id
   and i.provider = 'github'
  where u.id = p_user_id
  limit 1;
$$;

grant execute on function public.get_github_backfill_account(uuid)
  to service_role;

-- Bulk version of add_pet_exp for onboarding backfill.
--
-- p_activities is a JSON array whose objects look like:
-- {
--   "event_type": "commit",
--   "xp_gained": 10,
--   "github_event_id": "github-rest:event:123",
--   "metadata": { ... },
--   "created_at": "2026-07-06T00:00:00Z"
-- }
--
-- Inserting into public.activities intentionally reuses the existing
-- trg_update_pet_on_activity trigger, so pet XP/level/stage changes follow
-- the same path as webhook-created activities.
create or replace function public.add_pet_exp(
  p_user_id uuid,
  p_activities jsonb,
  p_force boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  user_backfilled_at timestamptz;
  input_count int := 0;
  inserted_count int := 0;
  inserted_exp int := 0;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  if p_activities is null or jsonb_typeof(p_activities) <> 'array' then
    raise exception 'p_activities must be a JSON array';
  end if;

  -- Serialize concurrent backfill attempts for the same user.
  select backfilled_at
    into user_backfilled_at
  from public.users
  where id = p_user_id
  for update;

  if not found then
    raise exception 'user not found: %', p_user_id;
  end if;

  select jsonb_array_length(p_activities)
    into input_count;

  if user_backfilled_at is not null and not p_force then
    return jsonb_build_object(
      'already_backfilled', true,
      'backfilled_at', user_backfilled_at,
      'received_count', input_count,
      'inserted_count', 0,
      'duplicate_count', input_count,
      'exp_applied', 0
    );
  end if;

  with incoming as (
    select
      event_type,
      xp_gained,
      github_event_id,
      coalesce(metadata, '{}'::jsonb) as metadata,
      coalesce(created_at, now()) as created_at
    from jsonb_to_recordset(p_activities) as activity(
      event_type text,
      xp_gained int,
      github_event_id text,
      metadata jsonb,
      created_at timestamptz
    )
  ),
  valid as (
    select *
    from incoming
    where event_type in (
      'commit',
      'pull_request',
      'code_review',
      'issue',
      'star',
      'fork',
      'release'
    )
      and xp_gained >= 0
      and github_event_id is not null
      and length(github_event_id) > 0
  ),
  inserted as (
    insert into public.activities (
      user_id,
      event_type,
      xp_gained,
      metadata,
      github_event_id,
      created_at
    )
    select
      p_user_id,
      event_type,
      xp_gained,
      metadata,
      github_event_id,
      created_at
    from valid
    on conflict (github_event_id)
    where github_event_id is not null
    do nothing
    returning xp_gained
  )
  select
    count(*),
    coalesce(sum(xp_gained), 0)
    into inserted_count, inserted_exp
  from inserted;

  update public.users
  set
    backfilled_at = now(),
    updated_at = now()
  where id = p_user_id
    and (backfilled_at is null or p_force);

  return jsonb_build_object(
    'already_backfilled', false,
    'backfilled_at', (
      select backfilled_at
      from public.users
      where id = p_user_id
    ),
    'received_count', input_count,
    'inserted_count', inserted_count,
    'duplicate_count', greatest(input_count - inserted_count, 0),
    'exp_applied', inserted_exp
  );
end;
$$;

grant execute on function public.add_pet_exp(uuid, jsonb, boolean)
  to service_role;
