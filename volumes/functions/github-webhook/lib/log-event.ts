import type { SupabaseClient } from "@supabase/supabase-js";

type ClaimResult = {
  claimed?: boolean;
  status?: string;
  processed_at?: string | null;
  user_id?: string | null;
  xp_awarded?: number | null;
};

/**
 * Reserve a GitHub webhook delivery before running handlers.
 *
 * If GitHub redelivers the same X-GitHub-Delivery id, the DB unique index makes
 * this return claimed=false so the router can acknowledge it without awarding
 * XP again.
 */
export async function claimWebhookDelivery(
  supabase: SupabaseClient,
  params: {
    eventType: string | null;
    deliveryId: string;
    rawBody: string;
  },
): Promise<ClaimResult> {
  const rawPayloadHash = await sha256Hex(params.rawBody);
  const { data, error } = await supabase.rpc("claim_github_webhook_delivery", {
    p_delivery_id: params.deliveryId,
    p_event_type: params.eventType ?? "unknown",
    p_action: null,
    p_raw_payload_hash: rawPayloadHash,
  });

  if (error) {
    throw new Error(
      `RPC claim_github_webhook_delivery failed: ${error.message}`,
    );
  }

  return (data ?? {}) as ClaimResult;
}

/**
 * Mark the reserved delivery with the final handler result.
 * Logging failures are intentionally swallowed so GitHub does not retry a
 * successfully processed webhook only because audit logging failed.
 */
export async function finishWebhookDelivery(
  supabase: SupabaseClient,
  params: {
    deliveryId: string;
    status: "processed" | "failed" | "ignored";
    action?: string | null;
    userId?: string | null;
    xpAwarded?: number;
    errorMessage?: string | null;
  },
): Promise<void> {
  const { error } = await supabase.rpc("finish_github_webhook_delivery", {
    p_delivery_id: params.deliveryId,
    p_status: params.status,
    p_user_id: params.userId ?? null,
    p_xp_awarded: params.xpAwarded ?? 0,
    p_action: params.action ?? null,
    p_error_message: params.errorMessage ?? null,
  });

  if (error) {
    console.error(
      `[webhook-log] finish failed delivery=${params.deliveryId}: ${error.message}`,
    );
  }
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
