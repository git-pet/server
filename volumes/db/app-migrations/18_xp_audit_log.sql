-- 18_xp_audit_log.sql
-- XP 변경 이력 감사 로그 (DB 트리거 방식)

CREATE TABLE IF NOT EXISTS public.xp_audit_log (
  id            bigserial PRIMARY KEY,
  pet_id        uuid NOT NULL REFERENCES public.pets(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  xp_before     integer NOT NULL,
  xp_after      integer NOT NULL,
  xp_delta      integer GENERATED ALWAYS AS (xp_after - xp_before) STORED,
  level_before  integer NOT NULL,
  level_after   integer NOT NULL,
  stage_before  text NOT NULL,
  stage_after   text NOT NULL,
  source        text NOT NULL DEFAULT 'unknown',
  activity_id   uuid REFERENCES public.activities(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_xp_audit_log_user_created
  ON public.xp_audit_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_xp_audit_log_pet_created
  ON public.xp_audit_log (pet_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.log_xp_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
begin
  insert into public.xp_audit_log (
    pet_id, user_id,
    xp_before, xp_after,
    level_before, level_after,
    stage_before, stage_after,
    source, activity_id
  ) values (
    new.id, new.user_id,
    old.xp, new.xp,
    old.level, new.level,
    old.stage, new.stage,
    coalesce(nullif(current_setting('app.xp_source', true), ''), 'unknown'),
    nullif(current_setting('app.xp_activity_id', true), '')::uuid
  );
  return null;
end;
$$;

DROP TRIGGER IF EXISTS trg_log_xp_change ON public.pets;
CREATE TRIGGER trg_log_xp_change
AFTER UPDATE ON public.pets
FOR EACH ROW
WHEN (OLD.xp IS DISTINCT FROM NEW.xp)
EXECUTE FUNCTION public.log_xp_change();

ALTER TABLE public.xp_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "xp_audit_log: 본인만 읽기" ON public.xp_audit_log;
CREATE POLICY "xp_audit_log: 본인만 읽기"
  ON public.xp_audit_log FOR SELECT
  USING (user_id = auth_uid());

GRANT SELECT ON public.xp_audit_log TO authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.xp_audit_log_id_seq TO service_role;

-- update_pet_on_activity(): audit 컨텍스트 주입
-- 주의: 원본이 SECURITY DEFINER이므로 반드시 유지할 것
CREATE OR REPLACE FUNCTION public.update_pet_on_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
declare
  new_xp    int;
  new_level int;
  new_stage text;
  new_mood  text;
begin
  -- audit 컨텍스트 주입 (트랜잭션 로컬)
  perform set_config('app.xp_activity_id', new.id::text, true);
  perform set_config(
    'app.xp_source',
    coalesce(nullif(current_setting('app.xp_source', true), ''), 'activity'),
    true
  );

  -- 현재 XP + 새로 획득한 XP
  select xp + new.xp_gained into new_xp
  from public.pets
  where user_id = new.user_id;

  -- 레벨: 100 XP 당 1레벨
  new_level := floor(new_xp / 100) + 1;

  -- 성장 단계
  new_stage := case
    when new_xp < 100  then 'egg'
    when new_xp < 500  then 'baby'
    when new_xp < 1500 then 'adult'
    when new_xp < 3000 then 'expert'
    else                    'legend'
  end;

  -- 기분
  new_mood := 'happy';

  update public.pets
  set
    xp             = new_xp,
    level          = new_level,
    stage          = new_stage,
    mood           = new_mood,
    last_active_at = now(),
    updated_at     = now()
  where user_id = new.user_id;

  return new;
end;
$$;
