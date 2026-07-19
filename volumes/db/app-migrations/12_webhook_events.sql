-- 12_webhook_events.sql
-- GitHub webhook 수신 이벤트 로깅 테이블.
-- XP 지급 여부와 무관하게 "수신 자체"를 기록한다 (미가입 유저, 스킵 케이스 포함).
-- delivery_id unique로 동일 delivery 재전송(Kong retry 등) 시 중복 기록을 방지한다.
-- 참고: XP 지급 멱등성은 activities.github_event_id(05)가 담당. 이 테이블은 수신 감사 로그.

create table if not exists public.webhook_events (
  id uuid primary key default uuid_generate_v4(),
  event_type text not null,
  action text,
  user_id uuid references public.users(id) on delete set null,
  xp_awarded int not null default 0,
  delivery_id text not null,
  raw_payload_hash text,
  created_at timestamptz not null default now()
);

comment on table public.webhook_events is
  'GitHub webhook 수신 로그. delivery_id 기준 멱등 기록.';
comment on column public.webhook_events.user_id is
  '수신 시점에 매칭된 유저. 미가입 유저 이벤트는 null.';
comment on column public.webhook_events.xp_awarded is
  '이 이벤트로 실제 지급된 XP (스킵/중복이면 0).';
comment on column public.webhook_events.raw_payload_hash is
  '원본 페이로드 SHA-256 해시 (본문 저장 대신 무결성 확인용).';

create unique index if not exists idx_webhook_events_delivery_id
  on public.webhook_events(delivery_id);

create index if not exists idx_webhook_events_user_created
  on public.webhook_events(user_id, created_at desc);
