-- ============================================================
-- 22_github_webhook_delivery_guard.sql
-- X-GitHub-Delivery based idempotency guard for GitHub webhooks.
-- ============================================================

alter table public.webhook_events
  add column if not exists status text not null default 'processed'
    check (status in ('processing', 'processed', 'failed', 'ignored'));

alter table public.webhook_events
  add column if not exists error_message text;

alter table public.webhook_events
  add column if not exists processed_at timestamptz;

alter table public.webhook_events
  add column if not exists updated_at timestamptz not null default now();

comment on column public.webhook_events.status is
  'processing while a delivery is being handled, then processed/failed/ignored.';
comment on column public.webhook_events.error_message is
  'Short failure reason when webhook handling fails after signature validation.';

create or replace function public.claim_github_webhook_delivery(
  p_delivery_id text,
  p_event_type text,
  p_action text default null,
  p_raw_payload_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_id uuid;
  existing public.webhook_events%rowtype;
begin
  if p_delivery_id is null or length(trim(p_delivery_id)) = 0 then
    raise exception 'p_delivery_id is required';
  end if;

  insert into public.webhook_events (
    event_type,
    action,
    delivery_id,
    raw_payload_hash,
    status
  )
  values (
    coalesce(nullif(p_event_type, ''), 'unknown'),
    p_action,
    p_delivery_id,
    p_raw_payload_hash,
    'processing'
  )
  on conflict (delivery_id) do nothing
  returning id into inserted_id;

  if inserted_id is not null then
    return jsonb_build_object(
      'claimed', true,
      'delivery_id', p_delivery_id,
      'status', 'processing'
    );
  end if;

  select *
    into existing
  from public.webhook_events
  where delivery_id = p_delivery_id;

  return jsonb_build_object(
    'claimed', false,
    'delivery_id', p_delivery_id,
    'status', existing.status,
    'processed_at', existing.processed_at,
    'user_id', existing.user_id,
    'xp_awarded', existing.xp_awarded
  );
end;
$$;

grant execute on function public.claim_github_webhook_delivery(
  text,
  text,
  text,
  text
) to service_role;

create or replace function public.finish_github_webhook_delivery(
  p_delivery_id text,
  p_status text,
  p_user_id uuid default null,
  p_xp_awarded int default 0,
  p_action text default null,
  p_error_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  updated public.webhook_events%rowtype;
begin
  if p_delivery_id is null or length(trim(p_delivery_id)) = 0 then
    raise exception 'p_delivery_id is required';
  end if;

  if p_status not in ('processed', 'failed', 'ignored') then
    raise exception 'invalid webhook status: %', p_status;
  end if;

  update public.webhook_events
  set
    status = p_status,
    action = coalesce(p_action, action),
    user_id = p_user_id,
    xp_awarded = coalesce(p_xp_awarded, 0),
    error_message = p_error_message,
    processed_at = now(),
    updated_at = now()
  where delivery_id = p_delivery_id
  returning * into updated;

  if updated.id is null then
    raise exception 'webhook delivery not claimed: %', p_delivery_id;
  end if;

  return jsonb_build_object(
    'delivery_id', updated.delivery_id,
    'status', updated.status,
    'user_id', updated.user_id,
    'xp_awarded', updated.xp_awarded,
    'processed_at', updated.processed_at
  );
end;
$$;

grant execute on function public.finish_github_webhook_delivery(
  text,
  text,
  uuid,
  int,
  text,
  text
) to service_role;
