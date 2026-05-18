import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

/**
 * GitHub sender.id → Supabase users.id (UUID) 변환
 * 미가입 유저면 null 반환 (에러 아님)
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
    // PGRST116: row not found → 미가입 유저, 정상 케이스
    if (error.code === "PGRST116") return null;
    // 그 외 DB 에러는 상위로 던짐
    throw new Error(`DB error resolving user: ${error.message}`);
  }

  return data?.id ?? null;
}

/**
 * add_pet_exp RPC 호출 래퍼
 * resolveUserId 실패(미가입) 시 skip하고 ok 반환
 */
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

  const { error } = await supabase.rpc("add_pet_exp", {
    p_user_id: userId,
    p_exp: xp,
  });

  if (error) throw new Error(`RPC add_pet_exp failed: ${error.message}`);

  console.log(`[xp] +${xp} xp → user=${userId} (event=${eventType})`);
  return { userId, xp, skipped: false };
}
