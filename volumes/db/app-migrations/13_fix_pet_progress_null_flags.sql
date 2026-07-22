-- ============================================================
-- 13_fix_pet_progress_null_flags.sql
-- Extend add_pet_exp() with level-up / evolution detection and
-- a client notification payload.
-- Keeps the 05_sync_activities.sql signature and idempotency
-- behavior intact (06_backfill depends on it).
-- XP model: cumulative (existing trigger trg_update_pet_on_activity
-- remains the single source of truth for level/stage computation).
-- ============================================================

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
  before_pet public.pets%rowtype;
  after_pet public.pets%rowtype;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  if p_exp is null or p_exp < 0 then
    raise exception 'p_exp must be a non-negative integer';
  end if;

  -- Lock the pet row for the whole transaction so concurrent
  -- webhook deliveries cannot interleave between our read and
  -- the trigger's update (prevents lost/duplicated level-up flags).
  select * into before_pet
  from public.pets
  where user_id = p_user_id
  for update;

  -- Idempotency gate (unchanged from 05). If p_github_event_id
  -- already exists, nothing is inserted and the trigger does not fire.
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
    -- Duplicate delivery: report current pet state, no transition flags.
    return jsonb_build_object(
      'inserted', false,
      'skipped_reason', 'duplicate',
      'github_event_id', p_github_event_id,
      'level', before_pet.level,
      'exp', before_pet.xp,
      'leveled_up', false,
      'evolved', false,
      'new_level', before_pet.level,
      'new_stage', before_pet.stage,
      'unlocked', '[]'::jsonb
    );
  end if;

  -- Re-read pet state after trg_update_pet_on_activity has run.
  select * into after_pet
  from public.pets
  where user_id = p_user_id;

  if after_pet.id is null then
    -- User has no pet row: activity was recorded (existing behavior),
    -- but there is no pet state to report.
    return jsonb_build_object(
      'inserted', true,
      'activity_id', inserted_activity.id,
      'xp_gained', inserted_activity.xp_gained,
      'github_event_id', inserted_activity.github_event_id,
      'level', null,
      'exp', null,
      'leveled_up', false,
      'evolved', false,
      'new_level', null,
      'new_stage', null,
      'unlocked', '[]'::jsonb
    );
  end if;

  return jsonb_build_object(
    'inserted', true,
    'activity_id', inserted_activity.id,
    'xp_gained', inserted_activity.xp_gained,
    'github_event_id', inserted_activity.github_event_id,
    'level', after_pet.level,
    'exp', after_pet.xp,
    'leveled_up', coalesce(after_pet.level > before_pet.level, false),
    'evolved', coalesce(
      before_pet.stage is not null
      and after_pet.stage is distinct from before_pet.stage,
      false),
    'new_level', after_pet.level,
    'new_stage', after_pet.stage,
    'unlocked', '[]'::jsonb
  );
end;
$$;

grant execute on function public.add_pet_exp(uuid, int, text, text, jsonb)
  to service_role;
