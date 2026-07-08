// Git-Pet: friend-feed Edge Function
// 배치 위치: volumes/functions/friend-feed/index.ts
//
// GET /friend-feed?limit=30&cursor=<base64>
// - 요청자의 Authorization 헤더(사용자 JWT)로 본인 확인
// - get_friend_feed() RPC로 친구들의 최근 활동 조회 (RLS 우회는 함수 내부에서만, 친구 범위로 제한)
// - cursor 페이지네이션: base64(JSON.stringify({ occurred_at, activity_id }))

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface Cursor {
  occurred_at: string;
  activity_id: string;
}

function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const json = atob(raw);
    const parsed = JSON.parse(json);
    if (typeof parsed.occurred_at === "string" && typeof parsed.activity_id === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function encodeCursor(occurred_at: string, activity_id: string): string {
  return btoa(JSON.stringify({ occurred_at, activity_id }));
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

    const url = new URL(req.url);
    const limitParam = url.searchParams.get("limit");
    const cursorParam = url.searchParams.get("cursor");

    let limit = limitParam ? parseInt(limitParam, 10) : 30;
    if (!Number.isFinite(limit) || limit <= 0) limit = 30;
    if (limit > 100) limit = 100;

    const cursor = decodeCursor(cursorParam);

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data, error } = await adminClient.rpc("get_friend_feed", {
      p_user_id: user.id,
      p_limit: limit,
      p_cursor_created_at: cursor?.occurred_at ?? null,
      p_cursor_id: cursor?.activity_id ?? null,
    });

    if (error) {
      console.error("get_friend_feed rpc error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const items = data ?? [];
    const lastItem = items[items.length - 1];
    const nextCursor =
      items.length === limit && lastItem
        ? encodeCursor(lastItem.occurred_at, lastItem.activity_id)
        : null;

    return new Response(
      JSON.stringify({
        items,
        next_cursor: nextCursor,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    console.error("friend-feed unexpected error:", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
