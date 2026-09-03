-- ============================================================
-- 21_backfill_resume_state.sql
-- Resumable cursor state for large GitHub onboarding backfills.
-- ============================================================

create table if not exists public.github_backfill_runs (
  user_id uuid primary key references public.users(id) on delete cascade,
  status text not null default 'running'
    check (status in ('running', 'rate_limited', 'failed', 'completed')),
  phase text not null default 'events'
    check (phase in ('events', 'stars', 'completed')),
  events_next_url text,
  stars_next_url text,
  fetched_events int not null default 0 check (fetched_events >= 0),
  normalized_events int not null default 0 check (normalized_events >= 0),
  saved_count int not null default 0 check (saved_count >= 0),
  duplicate_skipped_count int not null default 0
    check (duplicate_skipped_count >= 0),
  exp_applied int not null default 0 check (exp_applied >= 0),
  last_error text,
  retry_after text,
  rate_limit_reset timestamptz,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.github_backfill_runs is
  'Current cursor and partial result counters for resumable GitHub onboarding backfills.';
comment on column public.github_backfill_runs.events_next_url is
  'GitHub REST Link rel=next URL for /users/{login}/events, saved after each successful page.';
comment on column public.github_backfill_runs.stars_next_url is
  'GitHub REST Link rel=next URL for /user/starred, saved after each successful page.';

create index if not exists idx_github_backfill_runs_status_updated
  on public.github_backfill_runs(status, updated_at desc);

alter table public.github_backfill_runs enable row level security;

drop policy if exists "github_backfill_runs: service only" on public.github_backfill_runs;
create policy "github_backfill_runs: service only"
  on public.github_backfill_runs for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.github_backfill_runs
  to service_role;

-- Inserts one fetched page/chunk without marking the whole onboarding backfill
-- complete. This keeps partial progress durable while activities still flow
-- through public.activities and trg_update_pet_on_activity.
create or replace function public.record_github_backfill_activities(
  p_user_id uuid,
  p_activities jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
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

  select jsonb_array_length(p_activities)
    into input_count;

  -- Lock the user row so concurrent backfill calls for the same user serialize.
  perform 1
  from public.users
  where id = p_user_id
  for update;

  if not found then
    raise exception 'user not found: %', p_user_id;
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
      'release',
      'checkin'
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

  return jsonb_build_object(
    'received_count', input_count,
    'inserted_count', inserted_count,
    'duplicate_count', greatest(input_count - inserted_count, 0),
    'exp_applied', inserted_exp
  );
end;
$$;

grant execute on function public.record_github_backfill_activities(uuid, jsonb)
  to service_role;
