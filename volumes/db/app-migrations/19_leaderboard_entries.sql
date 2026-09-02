-- ============================================================
-- 19_leaderboard_entries.sql
-- Shared read model for leaderboard APIs.
-- ============================================================

drop view if exists public.leaderboard_entries;

create view public.leaderboard_entries as
with weekly_activity as (
  select
    a.user_id,
    coalesce(sum(a.xp_gained), 0)::int as weekly_exp
  from public.activities a
  where a.created_at >= date_trunc('week', now())
  group by a.user_id
)
select
  up.user_id,
  up.github_login,
  up.nickname,
  up.avatar_url,
  coalesce(p.level, 1)::int as level,
  coalesce(p.xp, 0)::int as exp,
  coalesce(wa.weekly_exp, 0)::int as weekly_exp,
  up.created_at
from public.user_profiles up
left join public.pets p
  on p.user_id = up.user_id
left join weekly_activity wa
  on wa.user_id = up.user_id;

comment on view public.leaderboard_entries is
  'Profile, pet, and weekly activity summary used by leaderboard RPCs.';

grant select on public.leaderboard_entries
  to authenticated, service_role;
