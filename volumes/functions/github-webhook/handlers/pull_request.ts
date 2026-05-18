import { awardXP } from "../lib/user.ts";
import { XP_WEIGHTS, ok, type HandlerContext } from "../types.ts";

/**
 * pull_request 이벤트 처리
 *
 * action별 처리:
 * - opened  → XP 20 (PR 작성)
 * - closed + merged=true  → XP 50 (머지 성공)
 * - closed + merged=false → XP 5  (리뷰 후 닫힘)
 * - 그 외 (synchronize, labeled 등) → ack만
 *
 * XP 귀속: PR 작성자(pr.user.id) 기준
 * (sender가 reviewer일 수 있어서 pr.user 사용)
 */
export async function handlePullRequest(
  ctx: HandlerContext,
): Promise<Response> {
  const { supabase, payload, deliveryId } = ctx;
  const action = payload.action;
  const pr = payload.pull_request;
  const repoName = payload.repository?.full_name ?? "unknown";

  console.log(
    `[pull_request] delivery=${deliveryId} repo=${repoName} action=${action} pr=#${pr?.number}`,
  );

  if (!pr) return ok("pull_request: no pr object, skipped");

  const githubId = pr.user.id; // PR 작성자

  let xp = 0;
  let reason = "";

  if (action === "opened") {
    xp = XP_WEIGHTS.pull_request.opened;
    reason = "pr_opened";
  } else if (action === "closed" && pr.merged) {
    xp = XP_WEIGHTS.pull_request.merged;
    reason = "pr_merged";
  } else if (action === "closed" && !pr.merged) {
    xp = XP_WEIGHTS.pull_request.closed;
    reason = "pr_closed";
  } else {
    // synchronize, labeled, review_requested 등 → ack
    return ok(`pull_request: action '${action}' acknowledged, no xp`);
  }

  const result = await awardXP(supabase, githubId, xp, reason);

  return ok("pull_request handled", {
    repo: repoName,
    pr: pr.number,
    action,
    ...result,
  });
}
