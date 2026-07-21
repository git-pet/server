-- Git-Pet: 친구 활동 피드 조회 함수
-- 실행 위치: Supabase DB
--
-- friendships(status=accepted) 기준으로 친구 목록을 구하고,
-- activities 테이블에서 친구들의 최근 GitHub 활동을 시간 역순으로 반환한다.
-- activities에는 RLS로 본인 데이터만 조회 가능하므로, 이 함수는
-- SECURITY DEFINER로 RLS를 우회하되 p_user_id의 "친구"로 범위를 스스로 제한한다.
--
-- 커서 페이지네이션: (occurred_at, activity_id) 튜플 기준 keyset pagination.
-- 첫 페이지는 p_cursor_created_at/p_cursor_id를 NULL로 호출.

CREATE OR REPLACE FUNCTION public.get_friend_feed(
  p_user_id uuid,
  p_limit integer DEFAULT 30,
  p_cursor_created_at timestamptz DEFAULT NULL,
  p_cursor_id uuid DEFAULT NULL
)
RETURNS TABLE(
  activity_id uuid,
  user_id uuid,
  nickname text,
  avatar text,
  event_type text,
  repo_name text,
  occurred_at timestamptz,
  xp_awarded integer
)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  WITH friend_ids AS (
    SELECT
      CASE WHEN f.requester_id = p_user_id THEN f.receiver_id ELSE f.requester_id END AS friend_id
    FROM friendships f
    WHERE f.status = 'accepted'
      AND (f.requester_id = p_user_id OR f.receiver_id = p_user_id)
  )
  SELECT
    a.id AS activity_id,
    a.user_id,
    u.username AS nickname,
    u.avatar_url AS avatar,
    a.event_type,
    a.metadata->>'repo' AS repo_name,
    a.created_at AS occurred_at,
    a.xp_gained AS xp_awarded
  FROM activities a
  JOIN users u ON u.id = a.user_id
  WHERE a.user_id IN (SELECT friend_id FROM friend_ids)
    AND (
      p_cursor_created_at IS NULL
      OR a.created_at < p_cursor_created_at
      OR (a.created_at = p_cursor_created_at AND a.id < p_cursor_id)
    )
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT p_limit;
$$;
