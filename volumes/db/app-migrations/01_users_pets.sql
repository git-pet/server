-- ============================================================
-- 01_users_pets.sql
-- users, pets 테이블 + 신규 유저 자동 생성 트리거
-- ============================================================

-- UUID 확장 활성화
create extension if not exists "uuid-ossp";

-- ────────────────────────────────────────────
-- users
-- auth.users 와 1:1 연결되는 public 프로필
-- ────────────────────────────────────────────
create table public.users (
  id               uuid        primary key references auth.users(id) on delete cascade,
  github_id        text        not null unique,
  username         text        not null,
  avatar_url       text,
  bio              text,
  room_visibility  text        not null default 'public'
                               check (room_visibility in ('public', 'friends', 'private')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table  public.users                is '유저 공개 프로필 (auth.users 와 1:1)';
comment on column public.users.room_visibility is 'public | friends | private';

-- ────────────────────────────────────────────
-- pets
-- 유저당 하나의 펫
-- ────────────────────────────────────────────
create table public.pets (
  id              uuid        primary key default uuid_generate_v4(),
  user_id         uuid        not null unique references public.users(id) on delete cascade,
  xp              int         not null default 0 check (xp >= 0),
  level           int         not null default 1 check (level >= 1),
  stage           text        not null default 'egg'
                              check (stage in ('egg', 'baby', 'adult', 'expert', 'legend')),
  mood            text        not null default 'happy'
                              check (mood in ('happy', 'normal', 'sad', 'sleeping')),
  specialty       text        default null,
  last_active_at  timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table  public.pets           is '유저의 펫 상태';
comment on column public.pets.stage     is 'egg(0~99) | baby(100~499) | adult(500~1499) | expert(1500~2999) | legend(3000+)';
comment on column public.pets.specialty is 'GitHub 주요 언어 기반 자동 분류';

-- ────────────────────────────────────────────
-- activities
-- GitHub 이벤트 로그 + 획득 XP
-- ────────────────────────────────────────────
create table public.activities (
  id          uuid        primary key default uuid_generate_v4(),
  user_id     uuid        not null references public.users(id) on delete cascade,
  event_type  text        not null
              check (event_type in ('commit', 'pull_request', 'code_review', 'issue', 'star', 'fork', 'release')),
  xp_gained   int         not null default 0 check (xp_gained >= 0),
  metadata    jsonb       default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

comment on column public.activities.event_type is 'commit(+10) | pull_request(+30) | code_review(+20) | issue(+15) | star(+5) | fork(+8) | release(+25)';
comment on column public.activities.metadata   is '{ repo, title, url, sha 등 GitHub 이벤트 원본 }';

create index idx_activities_user_id   on public.activities(user_id);
create index idx_activities_created_at on public.activities(created_at desc);

-- ────────────────────────────────────────────
-- XP 변경 시 pets 자동 갱신 트리거
-- ────────────────────────────────────────────
create or replace function public.update_pet_on_activity()
returns trigger
language plpgsql
security definer
as $$
declare
  new_xp    int;
  new_level int;
  new_stage text;
  new_mood  text;
begin
  -- 현재 XP + 새로 획득한 XP
  select xp + new.xp_gained into new_xp
  from public.pets
  where user_id = new.user_id;

  -- 레벨: 100 XP 당 1레벨
  new_level := floor(new_xp / 100) + 1;

  -- 성장 단계
  new_stage := case
    when new_xp < 100  then 'egg'
    when new_xp < 500  then 'baby'
    when new_xp < 1500 then 'adult'
    when new_xp < 3000 then 'expert'
    else                    'legend'
  end;

  -- 기분: 30일 이내 활동 있으면 happy, 7일 이상 없으면 sad
  new_mood := 'happy';

  update public.pets
  set
    xp             = new_xp,
    level          = new_level,
    stage          = new_stage,
    mood           = new_mood,
    last_active_at = now(),
    updated_at     = now()
  where user_id = new.user_id;

  return new;
end;
$$;

create trigger trg_update_pet_on_activity
  after insert on public.activities
  for each row
  execute procedure public.update_pet_on_activity();

-- ────────────────────────────────────────────
-- 비활성 시 기분 하락 함수 (cron에서 주기 호출)
-- ────────────────────────────────────────────
create or replace function public.decay_pet_mood()
returns void
language plpgsql
security definer
as $$
begin
  -- 7일 이상 비활성 → sad
  update public.pets
  set mood = 'sad', updated_at = now()
  where last_active_at < now() - interval '7 days'
    and mood != 'sleeping';

  -- 30일 이상 비활성 → sleeping
  update public.pets
  set mood = 'sleeping', updated_at = now()
  where last_active_at < now() - interval '30 days';
end;
$$;

-- ────────────────────────────────────────────
-- GitHub OAuth 로그인 시 users + pets + rooms 자동 생성
-- ────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  -- public.users 생성
  insert into public.users (id, github_id, username, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'provider_id', new.id::text),
    coalesce(new.raw_user_meta_data->>'user_name', 'user_' || substr(new.id::text, 1, 8)),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;

  -- pets 생성
  insert into public.pets (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row
  execute procedure public.handle_new_user();