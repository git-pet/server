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
 * Pet progress payload returned by add_pet_exp (08_pet_level_evolution.sql).
 * Key naming is snake_case to match the RPC jsonb response — pending final
 * confirmation with the pet-progress GET endpoint (code kim).
 */
export interface PetProgressResult {
  userId: string | null;
  xp: number;
  skipped: boolean;
  level: number | null;
  exp: number | null;
  leveled_up: boolean;
  evolved: boolean;
  new_level: number | null;
  new_stage: string | null;
  unlocked: unknown[];
}

const EMPTY_PROGRESS = {
  level: null,
  exp: null,
  leveled_up: false,
  evolved: false,
  new_level: null,
  new_stage: null,
  unlocked: [] as unknown[],
};

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
 * Returns level-up / evolution flags so handlers can forward them to
 * clients as the notification payload.
 */
export async function awardXP(
  supabase: SupabaseClient,
  githubId: number,
  xp: number,
  reason: string,
  activityEventType: ActivityEventType = "commit",
  githubEventId?: string,
  metadata: Json = {},
): Promise<PetProgressResult> {
  const userId = await resolveUserId(supabase, githubId);
  if (!userId) {
    console.log(
      `[xp] skip github_id=${githubId} not registered reason=${reason}`,
    );
    return { userId: null, xp: 0, skipped: true, ...EMPTY_PROGRESS };
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

  const rpc = (data ?? {}) as Json;
  const inserted = rpc.inserted !== false;
  const appliedXp = inserted ? xp : 0;

  console.log(
    `[xp] +${appliedXp} xp user=${userId} reason=${reason} inserted=${inserted}` +
      ` leveled_up=${rpc.leveled_up ?? false} evolved=${rpc.evolved ?? false}`,
  );

  return {
    userId,
    xp: appliedXp,
    skipped: !inserted,
    level: (rpc.level as number | null) ?? null,
    exp: (rpc.exp as number | null) ?? null,
    leveled_up: rpc.leveled_up === true,
    evolved: rpc.evolved === true,
    new_level: (rpc.new_level as number | null) ?? null,
    new_stage: (rpc.new_stage as string | null) ?? null,
    unlocked: Array.isArray(rpc.unlocked) ? rpc.unlocked : [],
  };
}
