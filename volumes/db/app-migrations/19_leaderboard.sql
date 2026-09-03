-- 19_leaderboard.sql
-- 랭킹/리더보드 조회용 DB 함수 + 집계 커버링 인덱스
-- type:  weekly | monthly | total   (total은 pets.xp 누적치 기준)
-- scope: all | friends

CREATE INDEX IF NOT EXISTS idx_activities_created_at_user_id
  ON public.activities (created_at, user_id) INCLUDE (xp_gained);

CREATE INDEX IF NOT EXISTS idx_pets_xp_desc
  ON public.pets (xp DESC);

CREATE OR REPLACE FUNCTION public.leaderboard_period_start(p_type text)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT CASE p_type
    WHEN 'weekly'  THEN date_trunc('week',  now())
    WHEN 'monthly' THEN date_trunc('month', now())
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.get_leaderboard_rows(
  p_user_id uuid,
  p_type    text,
  p_scope   text
)
RETURNS TABLE (
  rank       bigint,
  user_id    uuid,
  username   text,
  nickname   text,
  avatar_url text,
  xp         bigint,
  level      integer,
  stage      text,
  is_me      boolean
)
LANGUAGE sql
STABLE
AS $$
  WITH scope_users AS (
    SELECT u.id
    FROM public.users u
    WHERE p_scope IS DISTINCT FROM 'friends'
       OR u.id = p_user_id
       OR EXISTS (
            SELECT 1
            FROM public.friendships f
            WHERE f.status = 'accepted'
              AND ( (f.requester_id = p_user_id AND f.receiver_id  = u.id)
                 OR (f.receiver_id  = p_user_id AND f.requester_id = u.id) )
          )
  ),
  agg AS (
    SELECT a.user_id AS uid, SUM(a.xp_gained)::bigint AS sum_xp
    FROM public.activities a
    WHERE p_type IS DISTINCT FROM 'total'
      AND a.created_at >= public.leaderboard_period_start(p_type)
    GROUP BY a.user_id
  ),
  scored AS (
    SELECT
      su.id AS uid,
      CASE WHEN p_type = 'total' THEN COALESCE(p.xp, 0)::bigint
           ELSE COALESCE(agg.sum_xp, 0) END AS score,
      COALESCE(p.level, 1)     AS lvl,
      COALESCE(p.stage, 'egg') AS stg
    FROM scope_users su
    LEFT JOIN public.pets p  ON p.user_id = su.id
    LEFT JOIN agg            ON agg.uid   = su.id
  )
  SELECT
    RANK() OVER (ORDER BY s.score DESC)::bigint,
    s.uid,
    u.username,
    COALESCE(pr.nickname,   u.username),
    COALESCE(pr.avatar_url, u.avatar_url),
    s.score,
    s.lvl,
    s.stg,
    (s.uid = p_user_id)
  FROM scored s
  JOIN public.users u             ON u.id       = s.uid
  LEFT JOIN public.user_profiles pr ON pr.user_id = s.uid
  ORDER BY 1, 3;
$$;

CREATE OR REPLACE FUNCTION public.get_leaderboard(
  p_user_id uuid,
  p_type    text DEFAULT 'weekly',
  p_scope   text DEFAULT 'all',
  p_limit   integer DEFAULT 100,
  p_offset  integer DEFAULT 0
)
RETURNS TABLE (
  rank       bigint,
  user_id    uuid,
  username   text,
  nickname   text,
  avatar_url text,
  xp         bigint,
  level      integer,
  stage      text,
  is_me      boolean
)
LANGUAGE sql
STABLE
AS $$
  SELECT r.rank, r.user_id, r.username, r.nickname, r.avatar_url,
         r.xp, r.level, r.stage, r.is_me
  FROM public.get_leaderboard_rows(p_user_id, p_type, p_scope) r
  ORDER BY r.rank, r.username
  LIMIT  LEAST(GREATEST(COALESCE(p_limit, 100), 1), 100)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

CREATE OR REPLACE FUNCTION public.get_leaderboard_me(
  p_user_id uuid,
  p_type    text DEFAULT 'weekly',
  p_scope   text DEFAULT 'all',
  p_around  integer DEFAULT 5
)
RETURNS TABLE (
  rank        bigint,
  user_id     uuid,
  username    text,
  nickname    text,
  avatar_url  text,
  xp          bigint,
  level       integer,
  stage       text,
  is_me       boolean,
  total_users bigint,
  percentile  numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH lb AS (
    SELECT r.*, ROW_NUMBER() OVER (ORDER BY r.rank, r.username) AS pos
    FROM public.get_leaderboard_rows(p_user_id, p_type, p_scope) r
  ),
  me  AS (SELECT lb.pos AS mypos FROM lb WHERE lb.is_me),
  tot AS (SELECT COUNT(*)::bigint AS n FROM lb)
  SELECT lb.rank, lb.user_id, lb.username, lb.nickname, lb.avatar_url,
         lb.xp, lb.level, lb.stage, lb.is_me,
         tot.n,
         ROUND(100.0 * lb.rank / NULLIF(tot.n, 0), 1)
  FROM lb, me, tot
  WHERE lb.pos BETWEEN me.mypos - LEAST(GREATEST(COALESCE(p_around, 5), 0), 20)
                   AND me.mypos + LEAST(GREATEST(COALESCE(p_around, 5), 0), 20)
  ORDER BY lb.pos;
$$;

REVOKE EXECUTE ON FUNCTION public.get_leaderboard_rows(uuid, text, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_leaderboard(uuid, text, text, integer, integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_leaderboard_me(uuid, text, text, integer) FROM anon, authenticated;
