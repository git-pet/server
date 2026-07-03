import { awardXP } from "../lib/user.ts";
import { XP_WEIGHTS, ok, type HandlerContext } from "../types.ts";
/**
 * push 이벤트 처리
 *
 * 지급 조건:
 * - 커밋이 1개 이상
 * - default branch push만 XP 지급 (feature 브랜치 push 어뷰징 방지)
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
  // default branch가 아니면 XP 지급 스킵 (feature 브랜치 push 어뷰징 방지)
  const defaultBranch = payload.repository?.default_branch ?? "main";
  if (ref !== `refs/heads/${defaultBranch}`) {
    console.log(`[push] non-default branch (${ref}), skip xp`);
    return ok("push: non-default branch, no xp");
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
