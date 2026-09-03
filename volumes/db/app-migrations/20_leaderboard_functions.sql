-- ============================================================
-- 20_leaderboard_functions.sql
-- RPC functions used by the leaderboard Edge Function.
-- ============================================================

create or replace function public.get_leaderboard(
  p_type text default 'exp',
  p_limit int default 100
)
returns table (
  rank bigint,
  user_id uuid,
  github_login text,
  nickname text,
  avatar_url text,
  level int,
  exp int,
  weekly_exp int
)
language sql
stable
security definer
set search_path = public
as $$
  with normalized_input as (
    select
      case when p_type = 'weekly' then 'weekly' else 'exp' end as leaderboard_type,
      least(greatest(coalesce(p_limit, 100), 1), 100) as row_limit
  ),
  ranked as (
    select
      dense_rank() over (
        order by
          case
            when ni.leaderboard_type = 'weekly' then le.weekly_exp
            else le.exp
          end desc,
          le.level desc,
          le.created_at asc,
          le.user_id asc
      ) as rank,
      le.user_id,
      le.github_login,
      le.nickname,
      le.avatar_url,
      le.level,
      le.exp,
      le.weekly_exp
    from public.leaderboard_entries le
    cross join normalized_input ni
  )
  select
    r.rank,
    r.user_id,
    r.github_login,
    r.nickname,
    r.avatar_url,
    r.level,
    r.exp,
    r.weekly_exp
  from ranked r
  order by r.rank asc, r.exp desc, r.weekly_exp desc, r.user_id asc
  limit (select row_limit from normalized_input);
$$;

grant execute on function public.get_leaderboard(text, int)
  to authenticated, service_role;

create or replace function public.get_my_leaderboard_window(
  p_user_id uuid,
  p_type text default 'exp',
  p_window int default 5
)
returns table (
  rank bigint,
  user_id uuid,
  github_login text,
  nickname text,
  avatar_url text,
  level int,
  exp int,
  weekly_exp int,
  is_me boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with normalized_input as (
    select
      case when p_type = 'weekly' then 'weekly' else 'exp' end as leaderboard_type,
      least(greatest(coalesce(p_window, 5), 1), 20) as row_window
  ),
  ranked as (
    select
      dense_rank() over (
        order by
          case
            when ni.leaderboard_type = 'weekly' then le.weekly_exp
            else le.exp
          end desc,
          le.level desc,
          le.created_at asc,
          le.user_id asc
      ) as rank,
      le.user_id,
      le.github_login,
      le.nickname,
      le.avatar_url,
      le.level,
      le.exp,
      le.weekly_exp
    from public.leaderboard_entries le
    cross join normalized_input ni
  ),
  me as (
    select r.rank
    from ranked r
    where r.user_id = p_user_id
  )
  select
    r.rank,
    r.user_id,
    r.github_login,
    r.nickname,
    r.avatar_url,
    r.level,
    r.exp,
    r.weekly_exp,
    r.user_id = p_user_id as is_me
  from ranked r
  cross join me
  where r.rank between me.rank - (select row_window from normalized_input)
                   and me.rank + (select row_window from normalized_input)
  order by r.rank asc, r.exp desc, r.weekly_exp desc, r.user_id asc;
$$;

grant execute on function public.get_my_leaderboard_window(uuid, text, int)
  to authenticated, service_role;
