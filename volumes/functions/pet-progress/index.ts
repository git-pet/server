import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl     = Deno.env.get("SUPABASE_URL")!;
const anonKey         = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceRoleKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 스테이지별 다음 XP 임계값
function nextStageThreshold(xp: number): number {
  if (xp < 100)  return 100;
  if (xp < 500)  return 500;
  if (xp < 1500) return 1500;
  if (xp < 3000) return 3000;
  return -1; // legend: 최고 단계
}

// 현재 스테이지 시작 XP
function currentStageStart(xp: number): number {
  if (xp < 100)  return 0;
  if (xp < 500)  return 100;
  if (xp < 1500) return 500;
  if (xp < 3000) return 1500;
  return 3000;
}

serve(async (req) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "GET만 허용됩니다" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Authorization 헤더가 필요합니다" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 인증
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "인증 실패" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);

    // 펫 조회
    const { data: pet, error: petError } = await admin
      .from("pets")
      .select("id, level, xp, stage, mood, specialty, last_active_at, updated_at")
      .eq("user_id", user.id)
      .single();

    // 신규 유저 (펫 없음)
    if (petError?.code === "PGRST116" || !pet) {
      return new Response(JSON.stringify({ error: "pet_not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (petError) {
      return new Response(JSON.stringify({ error: petError.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 마지막 EXP 갱신 시점 (activities 테이블에서)
    const { data: lastActivity } = await admin
      .from("activities")
      .select("created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    // next_level_threshold, progress 계산
    const xp             = pet.xp ?? 0;
    const nextThreshold  = nextStageThreshold(xp);
    const stageStart     = currentStageStart(xp);
    const progress       = nextThreshold === -1
      ? 1.0
      : (xp - stageStart) / (nextThreshold - stageStart);

    return new Response(
      JSON.stringify({
        pet_id:               pet.id,
        level:                pet.level,
        current_exp:          xp,
        next_level_threshold: nextThreshold,   // -1이면 최고 단계
        progress:             Math.round(progress * 1000) / 1000, // 소수점 3자리
        stage:                pet.stage,
        mood:                 pet.mood,
        specialty:            pet.specialty ?? null,
        last_exp_updated_at:  lastActivity?.created_at ?? pet.updated_at,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (e) {
    console.error("pet-progress unexpected error:", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
