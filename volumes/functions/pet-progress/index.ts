// Git-Pet: pet-progress Edge Function (조회 전용으로 전환)
// 배치 위치: volumes/functions/pet-progress/index.ts
//
// GET /pet-progress
// - 요청자의 Authorization 헤더(사용자 JWT)로 본인 확인
// - 본인의 pets 현재 상태를 그대로 반환 (mutation 없음)
//
// 변경 이력: 기존에는 client가 user_id/exp_gained를 직접 보내 apply_pet_progress()로
// pets를 직접 변경하는 구조였으나, 다음 두 가지 문제로 폐기함:
//   1) 기존 update_pet_on_activity 트리거와 XP 모델이 달라 레벨/스테이지 롤백 버그 발생
//   2) 인증 없이 클라이언트가 임의 user_id에 XP를 지급할 수 있는 보안 문제
// XP 적용은 webhook -> activities insert -> update_pet_on_activity 트리거로만 이루어지며,
// 레벨업 알림도 trg_record_level_up_feed가 자동 처리한다.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

    // 요청자 신원 확인 (본인 것만 조회 가능)
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();

    if (userError || !user) {
      return new Response(JSON.stringify({ error: "인증 실패" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data, error } = await adminClient
      .from("pets")
      .select("level, xp, stage, mood")
      .eq("user_id", user.id)
      .single();

    if (error) {
      console.error("pet-progress query error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        level: data.level,
        exp: data.xp,
        stage: data.stage,
        mood: data.mood,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    console.error("pet-progress unexpected error:", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
