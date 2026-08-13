-- ============================================================
-- 17_notify_level_up.sql
-- friend_feed에 level_up 이벤트가 기록될 때
-- 행위자 본인에게 알림 1건을 생성한다.
-- ============================================================

create or replace function public.notify_level_up()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications (user_id, type, payload)
  values (new.actor_id, 'level_up', new.metadata);

  return new;
end;
$$;

alter function public.notify_level_up() owner to postgres;

comment on function public.notify_level_up() is
  'friend_feed의 level_up 이벤트를 행위자 본인 대상 notifications 행으로 기록한다.';

drop trigger if exists trg_notify_level_up on public.friend_feed;

create trigger trg_notify_level_up
after insert on public.friend_feed
for each row
when (new.event_type = 'level_up')
execute function public.notify_level_up();
