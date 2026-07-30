-- ============================================================
-- 14_user_profiles.sql
-- Public profile API backing table.
-- ============================================================

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  github_login text not null,
  nickname text not null,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.user_profiles is
  'GitHub OAuth users public profile fields used by user-profile Edge Function.';
comment on column public.user_profiles.github_login is
  'Original GitHub login. This is not edited by profile update APIs.';
comment on column public.user_profiles.nickname is
  'Editable display name shown in app screens.';

create index if not exists idx_user_profiles_github_login
  on public.user_profiles(github_login);

alter table public.user_profiles enable row level security;

drop policy if exists "user_profiles: public read" on public.user_profiles;
create policy "user_profiles: public read"
  on public.user_profiles for select
  using (true);

drop policy if exists "user_profiles: owner insert" on public.user_profiles;
create policy "user_profiles: owner insert"
  on public.user_profiles for insert
  with check (user_id = public.auth_uid());

drop policy if exists "user_profiles: owner update" on public.user_profiles;
create policy "user_profiles: owner update"
  on public.user_profiles for update
  using (user_id = public.auth_uid())
  with check (user_id = public.auth_uid());

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  login text;
  display_name text;
begin
  login := coalesce(
    new.raw_user_meta_data->>'user_name',
    new.raw_user_meta_data->>'preferred_username',
    new.raw_user_meta_data->>'name',
    'user_' || substr(new.id::text, 1, 8)
  );
  display_name := coalesce(new.raw_user_meta_data->>'name', login);

  insert into public.user_profiles (
    user_id,
    github_login,
    nickname,
    avatar_url
  )
  values (
    new.id,
    login,
    display_name,
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists trg_on_auth_user_profile_created on auth.users;
create trigger trg_on_auth_user_profile_created
  after insert on auth.users
  for each row
  execute procedure public.handle_new_user_profile();

insert into public.user_profiles (
  user_id,
  github_login,
  nickname,
  avatar_url,
  created_at,
  updated_at
)
select
  u.id,
  u.username,
  u.username,
  u.avatar_url,
  u.created_at,
  u.updated_at
from public.users u
on conflict (user_id) do nothing;
