import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

type ActivityEventType =
  | "commit"
  | "pull_request"
  | "code_review"
  | "issue"
  | "star"
  | "fork"
  | "release";

type Json = Record<string, unknown>;

/**
 * Resolve a GitHub numeric user id to our public.users UUID.
 * Returning null is expected when the GitHub actor is not registered here.
 */
export async function resolveUserId(
  supabase: SupabaseClient,
  githubId: number,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("users")
    .select("id")
    .eq("github_id", githubId)
    .single();
  if (error) {
    if (error.code === "PGRST116") return null;
    throw new Error(`DB error resolving user: ${error.message}`);
  }
  return data?.id ?? null;
}

/**
 * Award XP through add_pet_exp and, when supplied, store the normalized
 * activity fields used by webhook and backfill flows alike.
 */
export async function awardXP(
  supabase: SupabaseClient,
  githubId: number,
  xp: number,
  reason: string,
  activityEventType: ActivityEventType = "commit",
  githubEventId?: string,
  metadata: Json = {},
): Promise<{ userId: string | null; xp: number; skipped: boolean }> {
  const userId = await resolveUserId(supabase, githubId);
  if (!userId) {
    console.log(
      `[xp] skip github_id=${githubId} not registered reason=${reason}`,
    );
    return { userId: null, xp: 0, skipped: true };
  }

  const { data, error } = await supabase.rpc("add_pet_exp", {
    p_user_id: userId,
    p_exp: xp,
    p_event_type: activityEventType,
    p_github_event_id: githubEventId ?? null,
    p_metadata: {
      source: "github-webhook",
      reason,
      ...metadata,
    },
  });

  if (error) throw new Error(`RPC add_pet_exp failed: ${error.message}`);

  const inserted = (data as { inserted?: boolean } | null)?.inserted !== false;
  const appliedXp = inserted ? xp : 0;

  console.log(
    `[xp] +${appliedXp} xp user=${userId} reason=${reason} inserted=${inserted}`,
  );

  return { userId, xp: appliedXp, skipped: !inserted };
}
