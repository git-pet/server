-- Git-Pet: apply_pet_progress 제거
-- 사유: 기존 update_pet_on_activity 트리거(누적 xp, level=floor(xp/100)+1, stage=xp 기준)와
-- 서로 다른 XP 모델을 써서 데이터 충돌을 일으켰음 (레벨/스테이지 롤백 버그).
-- XP 적용 및 레벨업/진화 알림은 기존 트리거 경로(activities insert -> update_pet_on_activity
-- -> trg_record_level_up_feed)로 이미 자동 처리되므로 이 함수는 불필요.

DROP FUNCTION IF EXISTS public.apply_pet_progress(uuid, integer);
