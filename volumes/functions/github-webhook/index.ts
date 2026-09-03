import { createClient } from "@supabase/supabase-js";
import { handleIssues } from "./handlers/issues.ts";
import { handlePullRequest } from "./handlers/pull_request.ts";
import { handlePush } from "./handlers/push.ts";
import { handleStar } from "./handlers/star.ts";
import { err, type GitHubPayload, ok } from "./types.ts";
import {
  claimWebhookDelivery,
  finishWebhookDelivery,
} from "./lib/log-event.ts";

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
  const expected = "sha256=" +
    Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  if (expected.length !== signature.length) return false;

  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

function makeSupabase() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Missing Supabase env vars");
  return createClient(url, key);
}

const SUPPORTED_EVENTS = ["push", "pull_request", "issues", "star"] as const;
type SupportedEvent = (typeof SUPPORTED_EVENTS)[number];

function isSupportedEvent(e: string | null): e is SupportedEvent {
  return SUPPORTED_EVENTS.includes(e as SupportedEvent);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return err("Method not allowed", 405);
  }

  const body = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  const eventType = req.headers.get("x-github-event");
  const deliveryId = req.headers.get("x-github-delivery");

  // Reject invalid signatures before parsing JSON or touching the database.
  if (!(await verifySignature(body, signature))) {
    console.warn(
      `[webhook] signature verification failed event=${eventType} delivery=${
        deliveryId ?? "missing"
      }`,
    );
    return err("Unauthorized", 401);
  }

  if (!deliveryId) {
    console.warn(`[webhook] missing X-GitHub-Delivery event=${eventType}`);
    return err("Missing X-GitHub-Delivery", 400);
  }

  const supabase = makeSupabase();
  const claim = await claimWebhookDelivery(supabase, {
    eventType,
    deliveryId,
    rawBody: body,
  });

  // GitHub retries reuse the same delivery id. A duplicate delivery is already
  // processed or currently processing, so acknowledge it before handlers run.
  if (!claim.claimed) {
    console.log(
      `[webhook] duplicate delivery=${deliveryId} status=${claim.status}`,
    );
    return ok("duplicate delivery acknowledged", {
      deliveryId,
      duplicate: true,
      status: claim.status,
      processedAt: claim.processed_at ?? null,
    });
  }

  console.log(`[webhook] event=${eventType} delivery=${deliveryId}`);

  let payload: GitHubPayload;
  try {
    payload = JSON.parse(body);
  } catch {
    await finishWebhookDelivery(supabase, {
      deliveryId,
      status: "failed",
      errorMessage: "Invalid JSON payload",
    });
    return err("Invalid JSON payload", 400);
  }

  if (eventType === "ping") {
    console.log(`[webhook] ping received zen=${payload.zen ?? ""}`);
    await finishWebhookDelivery(supabase, {
      deliveryId,
      status: "ignored",
      action: payload.action ?? null,
    });
    return ok("pong");
  }

  if (!isSupportedEvent(eventType)) {
    console.log(`[webhook] unsupported event '${eventType}', ack only`);
    await finishWebhookDelivery(supabase, {
      deliveryId,
      status: "ignored",
      action: payload.action ?? null,
    });
    return ok(`event '${eventType}' acknowledged`);
  }

  const ctx = { supabase, payload, deliveryId };
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
    console.error(`[webhook] unhandled error event=${eventType}:`, e);
    await finishWebhookDelivery(supabase, {
      deliveryId,
      status: "failed",
      action: payload.action ?? null,
      errorMessage: String(e).slice(0, 1000),
    });
    return err("Internal server error", 500);
  }

  let userId: string | null = null;
  let xpAwarded = 0;
  try {
    const parsed = await response.clone().json();
    userId = parsed.userId ?? null;
    xpAwarded = typeof parsed.xp === "number" ? parsed.xp : 0;
  } catch {
    // Some handlers may return a simple acknowledgement without XP details.
  }

  await finishWebhookDelivery(supabase, {
    deliveryId,
    status: response.ok ? "processed" : "failed",
    action: payload.action ?? null,
    userId,
    xpAwarded,
    errorMessage: response.ok ? null : `handler returned ${response.status}`,
  });

  return response;
});
