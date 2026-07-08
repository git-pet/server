-- Git-Pet: 펫 레벨업/진화 처리 RPC 함수
-- 실행 위치: Supabase DB (psql로 직접 실행하거나 마이그레이션 파일로 관리)
--
-- 기존 add_pet_exp()의 "한 번에 한 레벨만 오르는" 버그를 while 루프(LOOP)로 해결하고,
-- 레벨 기준으로 진화(stage) 판정을 같이 처리합니다.
--
-- 사용 예:
--   SELECT * FROM apply_pet_progress('11111111-1111-1111-1111-111111111111', 250);
--   -> level, exp, leveled_up, evolved, new_stage 컬럼으로 결과 반환

CREATE OR REPLACE FUNCTION public.apply_pet_progress(
  p_user_id uuid,
  p_exp_gained integer
)
RETURNS TABLE(
  level integer,
  exp integer,
  leveled_up boolean,
  evolved boolean,
  new_stage text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_level integer;
  v_xp integer;
  v_old_stage text;
  v_new_stage text;
  v_leveled_up boolean := false;
  v_threshold integer;
BEGIN
  -- FOR UPDATE로 동시 요청(동시에 커밋 2개 들어오는 경우) 레이스 컨디션 방지
  SELECT p.level, p.xp, p.stage
  INTO v_level, v_xp, v_old_stage
  FROM pets p
  WHERE p.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pet not found for user %', p_user_id;
  END IF;

  v_xp := v_xp + p_exp_gained;

  -- 핵심 수정: if가 아니라 LOOP라서 한 번에 여러 레벨 상승 가능
  LOOP
    v_threshold := v_level * 100;
    EXIT WHEN v_xp < v_threshold;
    v_xp := v_xp - v_threshold;
    v_level := v_level + 1;
    v_leveled_up := true;
  END LOOP;

  -- 진화(stage) 판정: 레벨 기준 (팀 논의 후 숫자 조정 가능)
  v_new_stage := CASE
    WHEN v_level >= 20 THEN 'legend'
    WHEN v_level >= 10 THEN 'expert'
    WHEN v_level >= 5  THEN 'adult'
    WHEN v_level >= 2  THEN 'baby'
    ELSE 'egg'
  END;

  UPDATE pets
  SET level = v_level,
      xp = v_xp,
      stage = v_new_stage,
      updated_at = now()
  WHERE user_id = p_user_id;

  RETURN QUERY
  SELECT
    v_level,
    v_xp,
    v_leveled_up,
    (v_new_stage IS DISTINCT FROM v_old_stage) AS evolved,
    v_new_stage;
END;
$$;
