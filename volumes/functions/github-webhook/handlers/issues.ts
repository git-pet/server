import { awardXP } from "../lib/user.ts";
import { XP_WEIGHTS, ok, type HandlerContext } from "../types.ts";

/**
 * issues 이벤트 처리
 *
 * action별 처리:
 * - opened → XP 10 (이슈 작성)
 * - closed → XP 20 (이슈 해결)
 * - 그 외 (labeled, assigned, reopened 등) → ack만
 *
 * XP 귀속: 이슈 작성자(issue.user.id) 기준
 */
export async function handleIssues(ctx: HandlerContext): Promise<Response> {
  const { supabase, payload, deliveryId } = ctx;
  const action = payload.action;
  const issue = payload.issue;
  const repoName = payload.repository?.full_name ?? "unknown";

  console.log(
    `[issues] delivery=${deliveryId} repo=${repoName} action=${action} issue=#${issue?.number}`,
  );

  if (!issue) return ok("issues: no issue object, skipped");

  const githubId = issue.user.id;

  let xp = 0;
  let reason = "";

  if (action === "opened") {
    xp = XP_WEIGHTS.issues.opened;
    reason = "issue_opened";
  } else if (action === "closed") {
    xp = XP_WEIGHTS.issues.closed;
    reason = "issue_closed";
  } else {
    return ok(`issues: action '${action}' acknowledged, no xp`);
  }

  const result = await awardXP(supabase, githubId, xp, reason);

  return ok("issues handled", {
    repo: repoName,
    issue: issue.number,
    action,
    ...result,
  });
}
