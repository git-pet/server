-- ============================================================
-- 02_rooms_items.sql
-- items, user_items, rooms, room_placed_items 테이블
-- ============================================================

-- ────────────────────────────────────────────
-- items
-- 상점에서 판매하거나 해금되는 아이템 마스터 데이터
-- ────────────────────────────────────────────
create table public.items (
  id           uuid    primary key default uuid_generate_v4(),
  name         text    not null,
  description  text,
  type         text    not null
               check (type in ('furniture', 'deco', 'wallpaper', 'floor', 'limited')),
  unlock_type  text    not null
               check (unlock_type in ('shop', 'xp', 'achievement', 'event')),
  price        int     not null default 0 check (price >= 0),
  unlock_value int     default null,
  asset_url    text    not null,
  is_limited   boolean not null default false,
  created_at   timestamptz not null default now()
);

comment on column public.items.type         is 'furniture | deco | wallpaper | floor | limited';
comment on column public.items.unlock_type  is 'shop(재화구매) | xp(레벨해금) | achievement(업적해금) | event(이벤트)';
comment on column public.items.unlock_value is 'xp 해금이면 필요 XP, achievement 해금이면 achievement.id';
comment on column public.items.price        is '재화(포인트) 가격, unlock_type=xp/achievement 이면 0';

-- 기본 아이템 시드 데이터
insert into public.items (name, description, type, unlock_type, price, unlock_value, asset_url) values
  ('기본 벽지',       '흰색 기본 벽지',           'wallpaper',  'xp',          0,   0,    'wallpapers/default.png'),
  ('기본 바닥재',     '나무 기본 바닥',            'floor',      'xp',          0,   0,    'wallpapers/floor_default.png'),
  ('작은 책상',       '심플한 원목 책상',          'furniture',  'xp',          0,   100,  'items/desk_small.png'),
  ('책장',           '책이 꽂힌 책장',            'furniture',  'shop',        200, null, 'items/bookshelf.png'),
  ('소파',           '아늑한 2인용 소파',          'furniture',  'shop',        350, null, 'items/sofa.png'),
  ('작은 화분',       '초록 잎 화분',              'deco',       'xp',          0,   200,  'items/plant_small.png'),
  ('트로피',         '첫 PR 달성 트로피',          'deco',       'achievement', 0,   null, 'items/trophy.png'),
  ('GitHub 그래프',  '기여도 그래프 위젯',         'deco',       'xp',          0,   500,  'items/github_graph.png'),
  ('업적 액자',      '달성한 업적을 전시하는 액자', 'deco',       'xp',          0,   300,  'items/achievement_frame.png'),
  ('밤하늘 벽지',    '별이 가득한 밤하늘',         'wallpaper',  'shop',        150, null, 'wallpapers/night_sky.png'),
  ('잔디 바닥재',    '초록 잔디 바닥',             'floor',      'shop',        150, null, 'wallpapers/floor_grass.png');

-- ────────────────────────────────────────────
-- user_items
-- 유저가 보유한 아이템 목록
-- ────────────────────────────────────────────
create table public.user_items (
  id             uuid        primary key default uuid_generate_v4(),
  user_id        uuid        not null references public.users(id) on delete cascade,
  item_id        uuid        not null references public.items(id) on delete cascade,
  unlock_source  text        not null
                 check (unlock_source in ('shop', 'xp', 'achievement', 'event', 'default')),
  acquired_at    timestamptz not null default now(),
  unique (user_id, item_id)
);

comment on column public.user_items.unlock_source is '어떤 경로로 획득했는지 기록';

create index idx_user_items_user_id on public.user_items(user_id);

-- ────────────────────────────────────────────
-- rooms
-- 유저의 방 (1:1)
-- ────────────────────────────────────────────
create table public.rooms (
  id           uuid        primary key default uuid_generate_v4(),
  user_id      uuid        not null unique references public.users(id) on delete cascade,
  wallpaper_id uuid        references public.items(id) on delete set null,
  floor_id     uuid        references public.items(id) on delete set null,
  layout_json  jsonb       not null default '[]'::jsonb,
  updated_at   timestamptz not null default now()
);

comment on column public.rooms.layout_json is '[{item_id, pos_x, pos_y, layer_order}, ...] Flutter 렌더링용 스냅샷';

-- ────────────────────────────────────────────
-- room_placed_items
-- 방에 실제 배치된 아이템 (쿼리/통계용)
-- layout_json 과 이중 관리: json은 렌더링용, 이 테이블은 집계용
-- ────────────────────────────────────────────
create table public.room_placed_items (
  id          uuid primary key default uuid_generate_v4(),
  room_id     uuid not null references public.rooms(id) on delete cascade,
  item_id     uuid not null references public.items(id) on delete cascade,
  pos_x       int  not null default 0,
  pos_y       int  not null default 0,
  layer_order int  not null default 0
);

create index idx_room_placed_items_room_id on public.room_placed_items(room_id);

-- ────────────────────────────────────────────
-- 신규 유저 room 자동 생성 (01 트리거 보완)
-- handle_new_user 에서 users insert 후 room 도 생성
-- ────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
declare
  default_wallpaper uuid;
  default_floor     uuid;
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

  -- 기본 아이템 id 조회
  select id into default_wallpaper from public.items where name = '기본 벽지' limit 1;
  select id into default_floor     from public.items where name = '기본 바닥재' limit 1;

  -- rooms 생성
  insert into public.rooms (user_id, wallpaper_id, floor_id)
  values (new.id, default_wallpaper, default_floor)
  on conflict (user_id) do nothing;

  -- 기본 아이템 지급
  insert into public.user_items (user_id, item_id, unlock_source)
  select new.id, id, 'default'
  from public.items
  where unlock_type = 'xp' and unlock_value = 0
  on conflict (user_id, item_id) do nothing;

  return new;
end;
$$;