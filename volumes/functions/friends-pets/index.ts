// Git-Pet: friends-pets Edge Function
// 배치 위치: volumes/functions/friends-pets/index.ts
//
// GET /friends-pets
// - 요청자의 Authorization 헤더(사용자 JWT)로 본인 확인
// - get_friends_pets() RPC로 친구 목록 + 각 친구 펫 상태를 한 번에 조회 (N+1 없음)
// - 응답 키는 pet-progress 단건 응답(level, exp, leveled_up, evolved, new_stage)과 동일하게 통일,
//   단 leveled_up/evolved는 스냅샷 조회 특성상 항상 false

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

    const { data, error } = await adminClient.rpc("get_friends_pets", {
      p_user_id: user.id,
    });

    if (error) {
      console.error("get_friends_pets rpc error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ friends: data ?? [] }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    console.error("friends-pets unexpected error:", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
