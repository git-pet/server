import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAuth } from "../_shared/auth.ts";
import { errorResponse, GitPetError } from "../_shared/error.ts";
import { ok } from "../_shared/response.ts";

serve(async (req) => {
  try {
    const user = await requireAuth(req);
    const token = req.headers.get("Authorization")!.replace("Bearer ", "");

    // friend-feed 방식과 동일하게 헤더로 직접 전달
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );

    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // GET /notifications
    if (req.method === "GET" && parts.length === 1) {
      const unreadOnly = url.searchParams.get("unread_only") === "true";
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);

      let query = supabase
        .from("notifications")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (unreadOnly) query = query.eq("is_read", false);

      const { data, error } = await query;
      if (error) throw new GitPetError(error.message, 500);

      return ok({ notifications: data, count: data.length });
    }

    // GET /notifications/unread-count
    if (req.method === "GET" && parts[1] === "unread-count") {
      const { count, error } = await supabase
        .from("notifications")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("is_read", false);

      if (error) throw new GitPetError(error.message, 500);
      return ok({ unread_count: count ?? 0 });
    }

    // POST /notifications/read-all
    if (req.method === "POST" && parts[1] === "read-all") {
      const { error, count } = await supabase
        .from("notifications")
        .update({ is_read: true })
        .eq("user_id", user.id)
        .eq("is_read", false);

      if (error) throw new GitPetError(error.message, 500);
      return ok({ updated: count ?? 0 });
    }

    // POST /notifications/:id/read
    if (req.method === "POST" && parts[2] === "read") {
      const notificationId = parts[1];

      const { data, error } = await supabase
        .from("notifications")
        .update({ is_read: true })
        .eq("id", notificationId)
        .eq("user_id", user.id)
        .select()
        .single();

      if (error) throw new GitPetError(error.message, 500);
      if (!data) throw new GitPetError("Notification not found", 404);

      return ok({ notification: data });
    }

    throw new GitPetError("Not found", 404);
  } catch (err) {
    return errorResponse(err);
  }
});
