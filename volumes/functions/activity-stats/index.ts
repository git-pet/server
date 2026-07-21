import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAuth } from "../_shared/auth.ts";
import { errorResponse, GitPetError } from "../_shared/error.ts";
import { ok } from "../_shared/response.ts";

serve(async (req) => {
  try {
    const user = await requireAuth(req);
    const token = req.headers.get("Authorization")!.replace("Bearer ", "");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );

    // service_role로 집계 (RLS 우회, 본인 user_id 필터는 코드에서 처리)
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    // /activity-stats/daily
    // /activity-stats/weekly
    // /activity-stats/breakdown

    if (req.method !== "GET") throw new GitPetError("Method not allowed", 405);

    // GET /activity-stats/daily?days=30
    if (parts[1] === "daily") {
      const days = Math.min(Number(url.searchParams.get("days") ?? 30), 90);

      const { data, error } = await admin.rpc("get_daily_xp", {
        p_user_id: user.id,
        p_days: days,
      });

      if (error) throw new GitPetError(error.message, 500);
      return ok({ daily: data });
    }

    // GET /activity-stats/weekly?weeks=12
    if (parts[1] === "weekly") {
      const weeks = Math.min(Number(url.searchParams.get("weeks") ?? 12), 52);

      const { data, error } = await admin.rpc("get_weekly_xp", {
        p_user_id: user.id,
        p_weeks: weeks,
      });

      if (error) throw new GitPetError(error.message, 500);
      return ok({ weekly: data });
    }

    // GET /activity-stats/breakdown
    if (parts[1] === "breakdown") {
      const days = Math.min(Number(url.searchParams.get("days") ?? 30), 90);

      const { data, error } = await admin.rpc("get_xp_breakdown", {
        p_user_id: user.id,
        p_days: days,
      });

      if (error) throw new GitPetError(error.message, 500);
      return ok({ breakdown: data });
    }

    throw new GitPetError("Not found", 404);
  } catch (err) {
    return errorResponse(err);
  }
});
