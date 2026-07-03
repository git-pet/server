import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

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

function mapToActivityEventType(eventType: string): string {
  const map: Record<string, string> = {
    push: "commit",
    pull_request: "pull_request",
    pr_opened: "pull_request",
    pr_merged: "pull_request",
    pr_closed: "pull_request",
    issues: "issue",
    issue_opened: "issue",
    issue_closed: "issue",
    star: "star",
    star_created: "star",
  };
  const mapped = map[eventType];
  if (!mapped) throw new Error(`Unknown eventType for activities: ${eventType}`);
  return mapped;
}

export async function awardXP(
  supabase: SupabaseClient,
  githubId: number,
  xp: number,
  eventType: string,
): Promise<{ userId: string | null; xp: number; skipped: boolean }> {
  const userId = await resolveUserId(supabase, githubId);
  if (!userId) {
    console.log(
      `[xp] skip — github_id=${githubId} not registered (event=${eventType})`,
    );
    return { userId: null, xp: 0, skipped: true };
  }

  const { error } = await supabase.from("activities").insert({
    user_id: userId,
    event_type: mapToActivityEventType(eventType),
    xp_gained: xp,
  });

  if (error) throw new Error(`activities insert failed: ${error.message}`);
  console.log(`[xp] +${xp} xp → user=${userId} (event=${eventType})`);
  return { userId, xp, skipped: false };
}
