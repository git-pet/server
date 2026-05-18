import { awardXP } from "../lib/user.ts";
import { XP_WEIGHTS, ok, type HandlerContext } from "../types.ts";

/**
 * push 이벤트 처리
 *
 * 지급 조건:
 * - 커밋이 1개 이상
 * - default branch push 여부는 현재 필터 없음 (모든 브랜치 허용)
 *   → 세부 정책은 XP 가중치 조정 태스크에서 처리
 *
 * XP: 커밋 수 × 10, 최대 50
 */
export async function handlePush(ctx: HandlerContext): Promise<Response> {
  const { supabase, payload, deliveryId } = ctx;
  const commits = payload.commits ?? [];
  const githubId = payload.sender.id;
  const ref = payload.ref ?? "";
  const repoName = payload.repository?.full_name ?? "unknown";

  console.log(
    `[push] delivery=${deliveryId} repo=${repoName} ref=${ref} commits=${commits.length}`,
  );

  // 커밋 없는 push (브랜치 삭제 등) → ack만
  if (commits.length === 0) {
    return ok("push: no commits, skipped");
  }

  const xp = Math.min(
    commits.length * XP_WEIGHTS.push.per_commit,
    XP_WEIGHTS.push.max,
  );

  const result = await awardXP(supabase, githubId, xp, "push");

  return ok("push handled", {
    repo: repoName,
    ref,
    commits: commits.length,
    ...result,
  });
}
