import { createClient } from "npm:@supabase/supabase-js@2";
import { err, ok, type GitHubPayload } from "./types.ts";
import { handlePush } from "./handlers/push.ts";
import { handlePullRequest } from "./handlers/pull_request.ts";
import { handleIssues } from "./handlers/issues.ts";
import { handleStar } from "./handlers/star.ts";
import { logWebhookEvent } from "./lib/log-event.ts";

// ──────────────────────────────────────────────
// 서명 검증 (HMAC-SHA256)
// ──────────────────────────────────────────────
async function verifySignature(
  body: string,
  signature: string | null,
): Promise<boolean> {
  const secret = Deno.env.get("GITHUB_WEBHOOK_SECRET");
  if (!secret || !signature) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const expected =
    "sha256=" +
    Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  // タイミング攻撃 対策: 長さが違っても定数時間比較
  if (expected.length !== signature.length) return false;

  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

// ──────────────────────────────────────────────
// Supabase 클라이언트 (service role — Edge Function 내부용)
// ──────────────────────────────────────────────
function makeSupabase() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Missing Supabase env vars");
  return createClient(url, key);
}

// ──────────────────────────────────────────────
// 지원 이벤트 라우터
// ──────────────────────────────────────────────
const SUPPORTED_EVENTS = ["push", "pull_request", "issues", "star"] as const;
type SupportedEvent = (typeof SUPPORTED_EVENTS)[number];

function isSupportedEvent(e: string | null): e is SupportedEvent {
  return SUPPORTED_EVENTS.includes(e as SupportedEvent);
}

// ──────────────────────────────────────────────
// 메인 핸들러
// ──────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  // ── 1. Method guard
  if (req.method !== "POST") {
    return err("Method not allowed", 405);
  }

  // ── 2. 바디 읽기 (서명 검증에 raw string 필요)
  const body = await req.text();

  // ── 3. 서명 검증
  const signature = req.headers.get("x-hub-signature-256");
  if (!(await verifySignature(body, signature))) {
    console.warn("[webhook] signature verification failed");
    return err("Unauthorized", 401);
  }

  // ── 4. 헤더 파싱
  const eventType = req.headers.get("x-github-event");
  const deliveryId = req.headers.get("x-github-delivery") ?? "unknown";

  console.log(`[webhook] event=${eventType} delivery=${deliveryId}`);

  // ── 5. 페이로드 파싱
  let payload: GitHubPayload;
  try {
    payload = JSON.parse(body);
  } catch {
    return err("Invalid JSON payload", 400);
  }

  // ── 6. ping 이벤트 — 즉시 ack (설치 직후 GitHub이 보냄)
  if (eventType === "ping") {
    console.log(`[webhook] ping received — zen: ${payload.zen ?? ""}`);
    return ok("pong");
  }

  // ── 7. 미지원 이벤트 — 200 ack + 로그
  if (!isSupportedEvent(eventType)) {
    console.log(`[webhook] unsupported event '${eventType}', ack only`);
    return ok(`event '${eventType}' acknowledged`);
  }

  // ── 8. Supabase 클라이언트 생성
  const supabase = makeSupabase();
  const ctx = { supabase, payload, deliveryId };

  // ── 9. 이벤트 라우팅
  let response: Response;
  try {
    switch (eventType) {
      case "push":
        response = await handlePush(ctx);
        break;
      case "pull_request":
        response = await handlePullRequest(ctx);
        break;
      case "issues":
        response = await handleIssues(ctx);
        break;
      case "star":
        response = await handleStar(ctx);
        break;
      default:
        return ok(`event '${eventType}' acknowledged`);
    }
  } catch (e) {
    console.error(`[webhook] unhandled error (event=${eventType}):`, e);
    return err("Internal server error", 500);
  }

  // ── 10. 수신 이벤트 로깅 (실패해도 응답에 영향 없음)
  //   핸들러 응답 body에서 지급 결과(userId/xp)를 꺼내 기록한다.
  //   body는 한 번만 읽히므로 clone해서 파싱.
  let userId: string | null = null;
  let xpAwarded = 0;
  try {
    const parsed = await response.clone().json();
    userId = parsed.userId ?? null;
    xpAwarded = typeof parsed.xp === "number" ? parsed.xp : 0;
  } catch {
    // 핸들러가 결과 필드 없는 응답을 준 경우 → 0/null로 기록
  }

  await logWebhookEvent(supabase, {
    eventType,
    action: payload.action ?? null,
    userId,
    xpAwarded,
    deliveryId,
    rawBody: body,
  });

  return response;
});
