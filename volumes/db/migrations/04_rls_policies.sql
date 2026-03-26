-- ============================================================
-- 04_rls_policies.sql
-- 모든 테이블 Row Level Security 정책
-- ============================================================

-- ────────────────────────────────────────────
-- RLS 활성화
-- ────────────────────────────────────────────
alter table public.users             enable row level security;
alter table public.pets              enable row level security;
alter table public.activities        enable row level security;
alter table public.items             enable row level security;
alter table public.user_items        enable row level security;
alter table public.rooms             enable row level security;
alter table public.room_placed_items enable row level security;
alter table public.achievements      enable row level security;
alter table public.user_achievements enable row level security;
alter table public.friendships       enable row level security;
alter table public.friend_feed       enable row level security;
alter table public.room_visits       enable row level security;
alter table public.notifications     enable row level security;

-- ────────────────────────────────────────────
-- 헬퍼 함수
-- ────────────────────────────────────────────

-- 현재 로그인 유저 ID
create or replace function public.auth_uid()
returns uuid
language sql stable
as $$ select auth.uid() $$;

-- 두 유저가 친구인지 확인
create or replace function public.are_friends(user_a uuid, user_b uuid)
returns boolean
language sql stable
as $$
  select exists (
    select 1 from public.friendships
    where status = 'accepted'
      and (
        (requester_id = user_a and receiver_id = user_b)
        or
        (requester_id = user_b and receiver_id = user_a)
      )
  )
$$;

-- ────────────────────────────────────────────
-- users 정책
-- ────────────────────────────────────────────
create policy "users: 전체 공개 읽기"
  on public.users for select
  using (true);

create policy "users: 본인만 수정"
  on public.users for update
  using (id = public.auth_uid());

-- ────────────────────────────────────────────
-- pets 정책
-- ────────────────────────────────────────────
create policy "pets: 전체 공개 읽기"
  on public.pets for select
  using (true);

-- pets 직접 수정 불가 (트리거로만 변경)
create policy "pets: 본인만 수정"
  on public.pets for update
  using (user_id = public.auth_uid());

-- ────────────────────────────────────────────
-- activities 정책
-- ────────────────────────────────────────────
create policy "activities: 본인만 읽기"
  on public.activities for select
  using (user_id = public.auth_uid());

-- insert는 Edge Function(service_role)에서만 수행
-- 클라이언트 직접 insert 불가 → 조작 방지
create policy "activities: service_role만 insert"
  on public.activities for insert
  with check (false); -- anon/authenticated 불가, service_role은 RLS 우회

-- ────────────────────────────────────────────
-- items 정책 (마스터 데이터 - 전체 공개 읽기)
-- ────────────────────────────────────────────
create policy "items: 전체 공개 읽기"
  on public.items for select
  using (true);

-- ────────────────────────────────────────────
-- user_items 정책
-- ────────────────────────────────────────────
create policy "user_items: 본인만 읽기"
  on public.user_items for select
  using (user_id = public.auth_uid());

create policy "user_items: 본인만 insert (상점 구매)"
  on public.user_items for insert
  with check (user_id = public.auth_uid());

-- ────────────────────────────────────────────
-- rooms 정책 (room_visibility 기반)
-- ────────────────────────────────────────────
create policy "rooms: public이면 전체 읽기"
  on public.rooms for select
  using (
    -- 본인 방은 항상 읽기 가능
    user_id = public.auth_uid()
    or
    -- public 방
    (select room_visibility from public.users where id = rooms.user_id) = 'public'
    or
    -- friends 방: 친구 관계 확인
    (
      (select room_visibility from public.users where id = rooms.user_id) = 'friends'
      and public.are_friends(rooms.user_id, public.auth_uid())
    )
  );

create policy "rooms: 본인만 수정"
  on public.rooms for update
  using (user_id = public.auth_uid());

-- ────────────────────────────────────────────
-- room_placed_items 정책
-- ────────────────────────────────────────────
create policy "room_placed_items: 방 읽기 권한 있으면 읽기"
  on public.room_placed_items for select
  using (
    exists (
      select 1 from public.rooms r
      where r.id = room_placed_items.room_id
        and (
          r.user_id = public.auth_uid()
          or (select room_visibility from public.users where id = r.user_id) = 'public'
          or (
            (select room_visibility from public.users where id = r.user_id) = 'friends'
            and public.are_friends(r.user_id, public.auth_uid())
          )
        )
    )
  );

create policy "room_placed_items: 방 주인만 수정"
  on public.room_placed_items for all
  using (
    exists (
      select 1 from public.rooms r
      where r.id = room_placed_items.room_id
        and r.user_id = public.auth_uid()
    )
  );

-- ────────────────────────────────────────────
-- achievements 정책 (마스터 데이터)
-- ────────────────────────────────────────────
create policy "achievements: 전체 공개 읽기"
  on public.achievements for select
  using (true);

-- ────────────────────────────────────────────
-- user_achievements 정책
-- ────────────────────────────────────────────
create policy "user_achievements: 전체 공개 읽기 (자랑용)"
  on public.user_achievements for select
  using (true);

-- insert는 service_role(트리거)에서만
create policy "user_achievements: service_role만 insert"
  on public.user_achievements for insert
  with check (false);

-- ────────────────────────────────────────────
-- friendships 정책
-- ────────────────────────────────────────────
create policy "friendships: 당사자만 읽기"
  on public.friendships for select
  using (
    requester_id = public.auth_uid()
    or receiver_id = public.auth_uid()
  );

create policy "friendships: 본인만 신청"
  on public.friendships for insert
  with check (requester_id = public.auth_uid());

create policy "friendships: 수신자만 수락/거절"
  on public.friendships for update
  using (receiver_id = public.auth_uid());

create policy "friendships: 당사자만 삭제 (친구 끊기)"
  on public.friendships for delete
  using (
    requester_id = public.auth_uid()
    or receiver_id = public.auth_uid()
  );

-- ────────────────────────────────────────────
-- friend_feed 정책
-- ────────────────────────────────────────────
create policy "friend_feed: 친구 피드만 읽기"
  on public.friend_feed for select
  using (
    -- 본인 피드
    actor_id = public.auth_uid()
    or
    -- 친구 피드
    public.are_friends(actor_id, public.auth_uid())
  );

-- ────────────────────────────────────────────
-- room_visits 정책
-- ────────────────────────────────────────────
create policy "room_visits: 방 주인 + 방문자만 읽기"
  on public.room_visits for select
  using (
    room_owner_id = public.auth_uid()
    or visitor_id = public.auth_uid()
  );

create policy "room_visits: 로그인 유저면 방문 가능"
  on public.room_visits for insert
  with check (visitor_id = public.auth_uid());

-- ────────────────────────────────────────────
-- notifications 정책
-- ────────────────────────────────────────────
create policy "notifications: 본인 알림만 읽기"
  on public.notifications for select
  using (user_id = public.auth_uid());

create policy "notifications: 본인 알림만 읽음 처리"
  on public.notifications for update
  using (user_id = public.auth_uid());