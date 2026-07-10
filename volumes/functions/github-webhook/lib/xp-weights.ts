/**
 * XP 가중치 외부화 (env 기반)
 *
 * 운영 중 재배포 없이 가중치를 조정할 수 있도록 env 변수로 분리한다.
 * env 미설정/파싱 실패 시 아래 DEFAULT 값으로 폴백한다.
 *
 * env 키:
 *   XP_PUSH_PER_COMMIT, XP_PUSH_MAX
 *   XP_PR_OPENED, XP_PR_MERGED, XP_PR_CLOSED
 *   XP_ISSUE_OPENED, XP_ISSUE_CLOSED
 *   XP_STAR
 */

const DEFAULTS = {
  push: { per_commit: 10, max: 50 },
  pull_request: { opened: 15, merged: 60, closed: 10 },
  issues: { opened: 8, closed: 25 },
  star: { created: 3 },
} as const;

/**
 * env에서 정수를 읽는다. 미설정/빈값/NaN/음수면 fallback으로 폴백하고 warn.
 */
function envInt(key: string, fallback: number): number {
  const raw = Deno.env.get(key);
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    console.warn(
      `[xp-weights] invalid ${key}="${raw}", falling back to ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

export const XP_WEIGHTS = {
  push: {
    per_commit: envInt("XP_PUSH_PER_COMMIT", DEFAULTS.push.per_commit),
    max: envInt("XP_PUSH_MAX", DEFAULTS.push.max),
  },
  pull_request: {
    opened: envInt("XP_PR_OPENED", DEFAULTS.pull_request.opened),
    merged: envInt("XP_PR_MERGED", DEFAULTS.pull_request.merged),
    closed: envInt("XP_PR_CLOSED", DEFAULTS.pull_request.closed),
  },
  issues: {
    opened: envInt("XP_ISSUE_OPENED", DEFAULTS.issues.opened),
    closed: envInt("XP_ISSUE_CLOSED", DEFAULTS.issues.closed),
  },
  star: {
    created: envInt("XP_STAR", DEFAULTS.star.created),
  },
} as const;
