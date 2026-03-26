-- ============================================================
-- 03_social.sql
-- achievements, user_achievements, friendships,
-- friend_feed, room_visits, notifications 테이블
-- ============================================================

-- ────────────────────────────────────────────
-- achievements
-- 업적 마스터 데이터
-- ────────────────────────────────────────────
create table public.achievements (
  id               uuid    primary key default uuid_generate_v4(),
  name             text    not null,
  description      text    not null,
  condition_type   text    not null
                   check (condition_type in ('commit_count', 'pr_count', 'review_count',
                                             'streak_days', 'xp_total', 'friend_count',
                                             'room_visit_count', 'special')),
  condition_value  int     not null default 1,
  icon_url         text    not null,
  reward_item_id   uuid    references public.items(id) on delete set null,
  created_at       timestamptz not null default now()
);

comment on column public.achievements.condition_type  is '달성 조건 유형';
comment on column public.achievements.condition_value is '조건 수치 (예: commit_count=100 이면 커밋 100개)';
comment on column public.achievements.reward_item_id  is '달성 시 자동 지급되는 아이템 (없으면 null)';

-- 기본 업적 시드
insert into public.achievements (name, description, condition_type, condition_value, icon_url) values
  ('첫 발걸음',     '첫 번째 커밋을 했어요',          'commit_count',     1,    'achievements/first_commit.png'),
  ('코드 장인',     '커밋 100개를 달성했어요',         'commit_count',     100,  'achievements/commit_100.png'),
  ('PR 마스터',     'PR을 10개 머지했어요',            'pr_count',         10,   'achievements/pr_master.png'),
  ('꼼꼼한 리뷰어', '코드 리뷰를 50회 했어요',         'review_count',     50,   'achievements/reviewer.png'),
  ('연속의 달인',   '30일 연속 커밋 달성',             'streak_days',      30,   'achievements/streak_30.png'),
  ('XP 부자',       'XP 1000 달성',                   'xp_total',         1000, 'achievements/xp_1000.png'),
  ('인싸 개발자',   '친구 10명 추가',                  'friend_count',     10,   'achievements/social.png'),
  ('탐험가',        '다른 유저 방 10곳 방문',          'room_visit_count', 10,   'achievements/explorer.png');

-- ────────────────────────────────────────────
-- user_achievements
-- 유저가 달성한 업적 기록
-- ────────────────────────────────────────────
create table public.user_achievements (
  id              uuid        primary key default uuid_generate_v4(),
  user_id         uuid        not null references public.users(id) on delete cascade,
  achievement_id  uuid        not null references public.achievements(id) on delete cascade,
  unlocked_at     timestamptz not null default now(),
  unique (user_id, achievement_id)
);

create index idx_user_achievements_user_id on public.user_achievements(user_id);

-- 업적 달성 시 보상 아이템 자동 지급 트리거
create or replace function public.grant_achievement_reward()
returns trigger
language plpgsql
security definer
as $$
declare
  reward_id uuid;
begin
  select reward_item_id into reward_id
  from public.achievements
  where id = new.achievement_id;

  if reward_id is not null then
    insert into public.user_items (user_id, item_id, unlock_source)
    values (new.user_id, reward_id, 'achievement')
    on conflict (user_id, item_id) do nothing;
  end if;

  return new;
end;
$$;

create trigger trg_achievement_reward
  after insert on public.user_achievements
  for each row
  execute procedure public.grant_achievement_reward();

-- ────────────────────────────────────────────
-- friendships
-- 친구 관계 (양방향 수락 기반)
-- ────────────────────────────────────────────
create table public.friendships (
  id            uuid        primary key default uuid_generate_v4(),
  requester_id  uuid        not null references public.users(id) on delete cascade,
  receiver_id   uuid        not null references public.users(id) on delete cascade,
  status        text        not null default 'pending'
                check (status in ('pending', 'accepted', 'rejected')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (requester_id, receiver_id),
  check (requester_id != receiver_id)
);

create index idx_friendships_receiver_id  on public.friendships(receiver_id);
create index idx_friendships_requester_id on public.friendships(requester_id);

-- ────────────────────────────────────────────
-- friend_feed
-- 친구의 활동 타임라인 (레벨업, 업적, 방문 등)
-- ────────────────────────────────────────────
create table public.friend_feed (
  id          uuid        primary key default uuid_generate_v4(),
  actor_id    uuid        not null references public.users(id) on delete cascade,
  event_type  text        not null
              check (event_type in ('level_up', 'achievement', 'room_updated', 'xp_milestone')),
  metadata    jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

comment on column public.friend_feed.metadata is '{ level, achievement_name, xp 등 이벤트별 상세 }';

create index idx_friend_feed_actor_id   on public.friend_feed(actor_id);
create index idx_friend_feed_created_at on public.friend_feed(created_at desc);

-- 레벨업 시 friend_feed 자동 기록 트리거
create or replace function public.record_level_up_feed()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.level > old.level then
    insert into public.friend_feed (actor_id, event_type, metadata)
    values (
      new.user_id,
      'level_up',
      jsonb_build_object('old_level', old.level, 'new_level', new.level, 'stage', new.stage)
    );
  end if;
  return new;
end;
$$;

create trigger trg_record_level_up_feed
  after update on public.pets
  for each row
  execute procedure public.record_level_up_feed();

-- ────────────────────────────────────────────
-- room_visits
-- 방 방문 기록 + 방명록
-- ────────────────────────────────────────────
create table public.room_visits (
  id             uuid        primary key default uuid_generate_v4(),
  visitor_id     uuid        not null references public.users(id) on delete cascade,
  room_owner_id  uuid        not null references public.users(id) on delete cascade,
  reaction       text        check (reaction in ('like', 'cool', 'cute', 'wow')),
  message        text        check (char_length(message) <= 100),
  visited_at     timestamptz not null default now(),
  check (visitor_id != room_owner_id)
);

create index idx_room_visits_room_owner_id on public.room_visits(room_owner_id);
create index idx_room_visits_visitor_id    on public.room_visits(visitor_id);

-- ────────────────────────────────────────────
-- notifications
-- 앱 내 알림 (레벨업, 친구 요청, 방문 등)
-- ────────────────────────────────────────────
create table public.notifications (
  id          uuid        primary key default uuid_generate_v4(),
  user_id     uuid        not null references public.users(id) on delete cascade,
  type        text        not null
              check (type in ('level_up', 'achievement', 'friend_request',
                              'friend_accepted', 'room_visited', 'xp_gained')),
  payload     jsonb       not null default '{}'::jsonb,
  is_read     boolean     not null default false,
  created_at  timestamptz not null default now()
);

comment on column public.notifications.payload is '{ sender_id, sender_name, avatar_url 등 알림별 상세 }';

create index idx_notifications_user_id    on public.notifications(user_id);
create index idx_notifications_is_read    on public.notifications(user_id, is_read);
create index idx_notifications_created_at on public.notifications(created_at desc);

-- 친구 요청 시 알림 자동 생성 트리거
create or replace function public.notify_friend_request()
returns trigger
language plpgsql
security definer
as $$
declare
  requester_name text;
  requester_avatar text;
begin
  if new.status = 'pending' then
    select username, avatar_url
    into requester_name, requester_avatar
    from public.users where id = new.requester_id;

    insert into public.notifications (user_id, type, payload)
    values (
      new.receiver_id,
      'friend_request',
      jsonb_build_object(
        'requester_id',     new.requester_id,
        'requester_name',   requester_name,
        'requester_avatar', requester_avatar,
        'friendship_id',    new.id
      )
    );
  end if;

  if new.status = 'accepted' and old.status = 'pending' then
    select username, avatar_url
    into requester_name, requester_avatar
    from public.users where id = new.receiver_id;

    insert into public.notifications (user_id, type, payload)
    values (
      new.requester_id,
      'friend_accepted',
      jsonb_build_object(
        'friend_id',     new.receiver_id,
        'friend_name',   requester_name,
        'friend_avatar', requester_avatar
      )
    );
  end if;

  return new;
end;
$$;

create trigger trg_notify_friend_request
  after insert or update on public.friendships
  for each row
  execute procedure public.notify_friend_request();

-- 방 방문 시 방 주인에게 알림 자동 생성
create or replace function public.notify_room_visited()
returns trigger
language plpgsql
security definer
as $$
declare
  visitor_name   text;
  visitor_avatar text;
begin
  select username, avatar_url
  into visitor_name, visitor_avatar
  from public.users where id = new.visitor_id;

  insert into public.notifications (user_id, type, payload)
  values (
    new.room_owner_id,
    'room_visited',
    jsonb_build_object(
      'visitor_id',     new.visitor_id,
      'visitor_name',   visitor_name,
      'visitor_avatar', visitor_avatar,
      'reaction',       new.reaction,
      'message',        new.message
    )
  );

  return new;
end;
$$;

create trigger trg_notify_room_visited
  after insert on public.room_visits
  for each row
  execute procedure public.notify_room_visited();