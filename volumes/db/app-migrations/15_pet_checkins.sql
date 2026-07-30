-- ============================================================
-- 15_pet_checkins.sql
-- Daily pet check-in rewards.
-- ============================================================

create table if not exists public.pet_checkins (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  checkin_date date not null,
  streak_count int not null check (streak_count >= 1),
  exp_awarded int not null default 0 check (exp_awarded >= 0),
  activity_id uuid references public.activities(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (user_id, checkin_date)
);

alter table public.activities
  drop constraint if exists activities_event_type_check;

alter table public.activities
  add constraint activities_event_type_check
  check (
    event_type in (
      'commit',
      'pull_request',
      'code_review',
      'issue',
      'star',
      'fork',
      'release',
      'checkin'
    )
  );

comment on table public.pet_checkins is
  'One row per user per KST date for daily pet check-in rewards.';
comment on column public.pet_checkins.checkin_date is
  'KST calendar date used for the daily reset.';

create index if not exists idx_pet_checkins_user_date
  on public.pet_checkins(user_id, checkin_date desc);

alter table public.pet_checkins enable row level security;

drop policy if exists "pet_checkins: owner read" on public.pet_checkins;
create policy "pet_checkins: owner read"
  on public.pet_checkins for select
  using (user_id = public.auth_uid());

drop policy if exists "pet_checkins: service insert" on public.pet_checkins;
create policy "pet_checkins: service insert"
  on public.pet_checkins for insert
  with check (false);
