import { awardXP } from "../lib/user.ts";
import { XP_WEIGHTS, ok, type HandlerContext } from "../types.ts";

/**
 * star 이벤트 처리
 *
 * GitHub Webhook 이벤트명: "star" (구 "watch")
 * action: "created" | "deleted"
 *
 * - created → 리포 소유자에게 XP 5 지급
 * - deleted → ack만 (XP 차감 없음, 세부 정책은 별도)
 *
 * XP 귀속: 리포 소유자 기준
 * (sender는 스타를 누른 외부 유저, 우리 DB에 없을 가능성 높음)
 * → repository.owner.id로 귀속
 */
export async function handleStar(ctx: HandlerContext): Promise<Response> {
  const { supabase, payload, deliveryId } = ctx;
  const action = payload.action;
  const repo = payload.repository;
  const starrer = payload.sender;

  console.log(
    `[star] delivery=${deliveryId} repo=${repo?.full_name} action=${action} by=${starrer.login}`,
  );

  if (action !== "created") {
    return ok(`star: action '${action}' acknowledged, no xp`);
  }

  // 리포 오너가 XP를 받음
  const repoOwnerId = repo?.owner?.id;
  if (!repoOwnerId) return ok("star: no repo owner, skipped");

  const xp = XP_WEIGHTS.star.created;
  const result = await awardXP(
    supabase,
    repoOwnerId,
    xp,
    "star_created",
    "star",
    `github-webhook:${deliveryId}`,
    {
      repo: repo?.full_name ?? null,
      starred_by: starrer.login,
      delivery_id: deliveryId,
    },
  );

  return ok("star handled", {
    repo: repo?.full_name,
    starredBy: starrer.login,
    ...result,
  });
}
