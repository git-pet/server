import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAuth } from "../_shared/auth.ts";
import { errorResponse, GitPetError } from "../_shared/error.ts";
import { ok } from "../_shared/response.ts";

const VALID_TYPES = ["weekly", "monthly", "total"];
const VALID_SCOPES = ["all", "friends"];

function clampInt(raw: string | null, def: number, min: number, max: number) {
  if (raw === null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new GitPetError("Invalid numeric parameter", 400);
  }
  return Math.min(Math.max(n, min), max);
}

interface Row {
  rank: number;
  user_id: string;
  username: string;
  nickname: string;
  avatar_url: string | null;
  xp: number;
  level: number;
  stage: string;
  is_me: boolean;
  total_users?: number;
  percentile?: number;
}

function toEntry(r: Row) {
  return {
    rank: r.rank,
    user_id: r.user_id,
    username: r.username,
    nickname: r.nickname,
    avatar_url: r.avatar_url,
    xp: r.xp,
    level: r.level,
    stage: r.stage,
    is_me: r.is_me,
  };
}

serve(async (req) => {
  try {
    if (req.method !== "GET") throw new GitPetError("Method not allowed", 405);

    const user = await requireAuth(req);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    const type = url.searchParams.get("type") ?? "weekly";
    const scope = url.searchParams.get("scope") ?? "all";

    if (!VALID_TYPES.includes(type)) {
      throw new GitPetError("Invalid type. Use weekly, monthly or total", 400);
    }
    if (!VALID_SCOPES.includes(scope)) {
      throw new GitPetError("Invalid scope. Use all or friends", 400);
    }

    if (parts[1] === "me") {
      const around = clampInt(url.searchParams.get("around"), 5, 0, 20);

      const { data, error } = await admin.rpc("get_leaderboard_me", {
        p_user_id: user.id,
        p_type: type,
        p_scope: scope,
        p_around: around,
      });

      if (error) throw new GitPetError(error.message, 500);

      const rows = (data ?? []) as Row[];
      const meRow = rows.find((r) => r.is_me);
      if (!meRow) throw new GitPetError("Rank not found for user", 404);

      return ok({
        type,
        scope,
        total_users: meRow.total_users ?? rows.length,
        me: { ...toEntry(meRow), percentile: meRow.percentile },
        around: rows.map(toEntry),
      });
    }

    if (parts.length === 1) {
      const limit = clampInt(url.searchParams.get("limit"), 100, 1, 100);
      const offset = clampInt(url.searchParams.get("offset"), 0, 0, 100000);

      const { data, error } = await admin.rpc("get_leaderboard", {
        p_user_id: user.id,
        p_type: type,
        p_scope: scope,
        p_limit: limit,
        p_offset: offset,
      });

      if (error) throw new GitPetError(error.message, 500);

      const rows = (data ?? []) as Row[];

      return ok({
        type,
        scope,
        limit,
        offset,
        count: rows.length,
        entries: rows.map(toEntry),
      });
    }

    throw new GitPetError("Not found", 404);
  } catch (err) {
    return errorResponse(err);
  }
});
