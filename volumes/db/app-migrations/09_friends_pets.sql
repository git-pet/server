-- Git-Pet: 친구 목록 + 각 친구 펫 상태 조회 함수
-- 실행 위치: Supabase DB
--
-- friendships(status=accepted) 기준 친구 목록을 구하고, 각 친구의 pets 상태를
-- pet-progress 응답과 동일한 키 네이밍(level, exp, leveled_up, evolved, new_stage)으로 반환한다.
--
-- 주의: 이 API는 "현재 상태 스냅샷" 조회이지 이벤트가 아니므로,
-- leveled_up/evolved는 의미상 항상 false로 고정 반환한다 (키 네이밍 통일을 위한 결정).
--
-- 비공개 처리: users.room_visibility = 'private'인 친구는 결과에서 제외한다.
--
-- N+1 방지: 단일 쿼리로 친구 전체의 pets를 한 번에 조인 조회 (친구별 개별 호출 없음).

CREATE OR REPLACE FUNCTION public.get_friends_pets(
  p_user_id uuid
)
RETURNS TABLE(
  user_id uuid,
  nickname text,
  avatar text,
  level integer,
  exp integer,
  leveled_up boolean,
  evolved boolean,
  new_stage text
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
    u.id AS user_id,
    u.username AS nickname,
    u.avatar_url AS avatar,
    p.level,
    p.xp AS exp,
    false AS leveled_up,   -- 스냅샷 조회라 이벤트 없음, 항상 false
    false AS evolved,      -- 스냅샷 조회라 이벤트 없음, 항상 false
    p.stage AS new_stage
  FROM friend_ids fi
  JOIN users u ON u.id = fi.friend_id
  JOIN pets p ON p.user_id = u.id
  WHERE u.room_visibility <> 'private'   -- 비공개 친구 제외
  ORDER BY p.level DESC, u.username;
$$;
