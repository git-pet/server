// Git-Pet: pet-progress Edge Function
// 배치 위치: volumes/functions/pet-progress/index.ts
//
// 역할: user_id + 이번에 획득한 exp를 받아서 apply_pet_progress() RPC를 호출하고,
// 레벨업/진화 여부를 정형화된 JSON으로 반환한다.
// add_pet_exp 흐름(github-webhook)에서 이 함수를 호출하거나, RPC를 직접 호출해도 됨.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST만 허용됩니다" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { user_id, exp_gained } = await req.json();

    if (!user_id || typeof exp_gained !== "number") {
      return new Response(
        JSON.stringify({ error: "user_id(uuid), exp_gained(number)이 필요합니다" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { data, error } = await supabase
      .rpc("apply_pet_progress", {
        p_user_id: user_id,
        p_exp_gained: exp_gained,
      })
      .single();

    if (error) {
      console.error("apply_pet_progress rpc error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Flutter 쪽이 그대로 소비하는 정형 페이로드
    // { level, exp, leveled_up, evolved, new_stage }
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("pet-progress unexpected error:", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
