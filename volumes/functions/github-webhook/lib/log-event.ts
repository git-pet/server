import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

/**
 * webhook_events 테이블에 수신 이벤트를 기록한다.
 *
 * - delivery_id unique 충돌(동일 delivery 재전송)은 정상 흐름으로 간주하고 조용히 스킵.
 * - 그 외 에러도 삼킨다: 로깅 실패가 웹훅 200 응답(→ GitHub 재전송 방지)을 막으면 안 됨.
 */
export async function logWebhookEvent(
  supabase: SupabaseClient,
  params: {
    eventType: string;
    action: string | null;
    userId: string | null;
    xpAwarded: number;
    deliveryId: string;
    rawBody: string;
  },
): Promise<void> {
  try {
    const rawPayloadHash = await sha256Hex(params.rawBody);

    const { error } = await supabase.from("webhook_events").insert({
      event_type: params.eventType,
      action: params.action,
      user_id: params.userId,
      xp_awarded: params.xpAwarded,
      delivery_id: params.deliveryId,
      raw_payload_hash: rawPayloadHash,
    });

    if (error) {
      // 23505 = unique_violation → 중복 수신, 정상
      if (error.code === "23505") {
        console.log(
          `[webhook-log] duplicate delivery=${params.deliveryId}, skip`,
        );
        return;
      }
      console.error(`[webhook-log] insert failed: ${error.message}`);
    }
  } catch (e) {
    console.error("[webhook-log] unexpected error:", e);
  }
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
