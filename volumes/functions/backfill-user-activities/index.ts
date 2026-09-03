import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/response.ts";
import { errorResponse, GitPetError } from "../_shared/error.ts";
import {
  GitHubApiError,
  type GitHubEvent,
  githubFetchJson,
  type GitHubStar,
  type NormalizedGitHubActivity,
  normalizeGitHubEvent,
  normalizeStar,
} from "../_shared/github_activity.ts";

type BackfillAccount = {
  user_id: string;
  github_id: string;
  username: string;
  access_token: string | null;
  backfilled_at: string | null;
};

type GitHubFetchResult = {
  fetched: number;
  normalized: number;
  activities: ActivityInput[];
};

type GitHubPageResult = GitHubFetchResult & {
  nextUrl: string | null;
  reachedCutoff: boolean;
};

type ActivityInput = NormalizedGitHubActivity;

type RequestBody = {
  user_id?: string;
  days?: number;
  limit?: number;
  force?: boolean;
};

type BackfillPhase = "events" | "stars" | "completed";
type BackfillStatus = "running" | "rate_limited" | "failed" | "completed";

type BackfillRun = {
  user_id: string;
  status: BackfillStatus;
  phase: BackfillPhase;
  events_next_url: string | null;
  stars_next_url: string | null;
  fetched_events: number;
  normalized_events: number;
  saved_count: number;
  duplicate_skipped_count: number;
  exp_applied: number;
  last_error: string | null;
  retry_after: string | null;
  rate_limit_reset: string | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
};

type BackfillSummary = {
  fetched_events: number;
  normalized_events: number;
  saved_count: number;
  duplicate_skipped_count: number;
  exp_applied: number;
  completed: boolean;
  backfilled_at: string | null;
  phase: BackfillPhase;
};

const SUPABASE_URL = mustGetEnv("SUPABASE_URL");
const SERVICE_ROLE_KEY = mustGetEnv("SUPABASE_SERVICE_ROLE_KEY");
const ANON_KEY = mustGetEnv("SUPABASE_ANON_KEY");
const DEFAULT_DAYS = positiveIntegerEnv("BACKFILL_GITHUB_DAYS", 90);
const DEFAULT_LIMIT = positiveIntegerEnv("BACKFILL_GITHUB_LIMIT", 300);
const MAX_RETRIES = positiveIntegerEnv("BACKFILL_GITHUB_MAX_RETRIES", 3);
const BASE_BACKOFF_MS = positiveIntegerEnv(
  "BACKFILL_GITHUB_BASE_BACKOFF_MS",
  500,
);
const MAX_BACKOFF_MS = positiveIntegerEnv(
  "BACKFILL_GITHUB_MAX_BACKOFF_MS",
  30_000,
);
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const serviceSupabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function mustGetEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(Deno.env.get(name) ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function bearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  const [scheme, token] = auth?.split(" ") ?? [];
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

async function resolveTargetUser(req: Request, body: RequestBody): Promise<{
  userId: string;
  internal: boolean;
}> {
  const token = bearerToken(req);
  if (!token) throw new GitPetError("Unauthorized", 401);

  // Internal callers may run a specific user by sending the service role key.
  if (token === SERVICE_ROLE_KEY) {
    if (!body.user_id) {
      throw new GitPetError("user_id is required for service role calls", 400);
    }
    return { userId: body.user_id, internal: true };
  }

  // Normal onboarding path: the signed-in Flutter client calls for itself.
  const authSupabase = createClient(SUPABASE_URL, ANON_KEY);
  const { data, error } = await authSupabase.auth.getUser(token);
  if (error || !data.user) throw new GitPetError("Unauthorized", 401);

  if (body.user_id && body.user_id !== data.user.id) {
    throw new GitPetError("Cannot backfill another user", 403);
  }

  return { userId: data.user.id, internal: false };
}

async function loadAccount(userId: string): Promise<BackfillAccount> {
  const { data, error } = await serviceSupabase.rpc(
    "get_github_backfill_account",
    { p_user_id: userId },
  );

  if (error) {
    throw new Error(`RPC get_github_backfill_account failed: ${error.message}`);
  }

  const account = (data ?? [])[0] as BackfillAccount | undefined;
  if (!account) throw new GitPetError("User profile not found", 404);

  return account;
}

async function fetchGitHubEventsPage(
  accessToken: string,
  url: string,
  cutoff: Date,
  limit: number,
): Promise<GitHubPageResult> {
  const activities: ActivityInput[] = [];
  let normalized = 0;
  let reachedCutoff = false;

  const pageResult = await githubFetchJson<GitHubEvent[]>(
    url,
    accessToken,
    "application/vnd.github+json",
    {
      maxRetries: MAX_RETRIES,
      baseBackoffMs: BASE_BACKOFF_MS,
      maxBackoffMs: MAX_BACKOFF_MS,
      userAgent: "git-pet-backfill-user-activities",
    },
  );
  const data = pageResult.data;

  for (const event of data) {
    const createdAt = new Date(event.created_at);
    if (createdAt < cutoff) {
      reachedCutoff = true;
      continue;
    }

    const activity = normalizeGitHubEvent(event, "backfill-user-activities");
    if (activity) {
      normalized += 1;
      activities.push(activity);
    }
    if (activities.length >= limit) break;
  }

  return {
    fetched: data.length,
    normalized,
    activities,
    nextUrl: pageResult.nextUrl,
    reachedCutoff,
  };
}

async function fetchGitHubStarsPage(
  accessToken: string,
  url: string,
  cutoff: Date,
  remainingLimit: number,
): Promise<GitHubPageResult> {
  const activities: ActivityInput[] = [];
  let normalized = 0;
  let reachedCutoff = false;

  const pageResult = await githubFetchJson<GitHubStar[]>(
    url,
    accessToken,
    "application/vnd.github.star+json",
    {
      maxRetries: MAX_RETRIES,
      baseBackoffMs: BASE_BACKOFF_MS,
      maxBackoffMs: MAX_BACKOFF_MS,
      userAgent: "git-pet-backfill-user-activities",
    },
  );
  const data = pageResult.data;

  for (const star of data) {
    const starredAt = new Date(star.starred_at);
    if (starredAt < cutoff) {
      reachedCutoff = true;
      continue;
    }

    normalized += 1;
    activities.push(normalizeStar(star, "backfill-user-activities"));
    if (activities.length >= remainingLimit) break;
  }

  return {
    fetched: data.length,
    normalized,
    activities,
    nextUrl: pageResult.nextUrl,
    reachedCutoff,
  };
}

async function recordBackfillActivityChunk(
  userId: string,
  activities: ActivityInput[],
): Promise<{
  inserted_count: number;
  duplicate_count: number;
  exp_applied: number;
}> {
  if (activities.length === 0) {
    return { inserted_count: 0, duplicate_count: 0, exp_applied: 0 };
  }

  const { data, error } = await serviceSupabase.rpc(
    "record_github_backfill_activities",
    {
      p_user_id: userId,
      p_activities: activities,
    },
  );

  if (error) {
    throw new Error(
      `RPC record_github_backfill_activities failed: ${error.message}`,
    );
  }

  return data as {
    inserted_count: number;
    duplicate_count: number;
    exp_applied: number;
  };
}

async function loadBackfillRun(userId: string): Promise<BackfillRun | null> {
  const { data, error } = await serviceSupabase
    .from("github_backfill_runs")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Load github_backfill_runs failed: ${error.message}`);
  }

  return data as BackfillRun | null;
}

async function saveBackfillRun(
  userId: string,
  patch: Partial<BackfillRun>,
): Promise<void> {
  const { error } = await serviceSupabase
    .from("github_backfill_runs")
    .upsert({
      user_id: userId,
      ...patch,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

  if (error) {
    throw new Error(`Save github_backfill_runs failed: ${error.message}`);
  }
}

async function resetBackfillRun(userId: string): Promise<void> {
  const { error } = await serviceSupabase
    .from("github_backfill_runs")
    .delete()
    .eq("user_id", userId);

  if (error) {
    throw new Error(`Reset github_backfill_runs failed: ${error.message}`);
  }
}

async function markBackfillCompleted(userId: string): Promise<string | null> {
  const completedAt = new Date().toISOString();
  const { data, error } = await serviceSupabase
    .from("users")
    .update({ backfilled_at: completedAt, updated_at: completedAt })
    .eq("id", userId)
    .select("backfilled_at")
    .single();

  if (error) {
    throw new Error(`Mark backfill completed failed: ${error.message}`);
  }

  return (data as { backfilled_at: string | null }).backfilled_at;
}

function initialEventsUrl(username: string): string {
  return `https://api.github.com/users/${
    encodeURIComponent(username)
  }/events?per_page=100`;
}

function initialStarsUrl(): string {
  return "https://api.github.com/user/starred?per_page=100";
}

async function runResumableBackfill(
  userId: string,
  account: BackfillAccount,
  cutoff: Date,
  limit: number,
  force: boolean,
): Promise<BackfillSummary> {
  if (force) {
    await resetBackfillRun(userId);
  }

  const savedRun = force ? null : await loadBackfillRun(userId);
  let phase: BackfillPhase = savedRun?.phase ?? "events";
  let eventsNextUrl: string | null = savedRun?.events_next_url ??
    initialEventsUrl(
      account.username,
    );
  let starsNextUrl: string | null = savedRun?.stars_next_url ??
    initialStarsUrl();
  let fetchedEvents = savedRun?.fetched_events ?? 0;
  let normalizedEvents = savedRun?.normalized_events ?? 0;
  let savedCount = savedRun?.saved_count ?? 0;
  let duplicateSkippedCount = savedRun?.duplicate_skipped_count ?? 0;
  let expApplied = savedRun?.exp_applied ?? 0;

  const saveRunningState = async (patch: Partial<BackfillRun> = {}) => {
    await saveBackfillRun(userId, {
      status: "running",
      phase,
      events_next_url: eventsNextUrl,
      stars_next_url: starsNextUrl,
      fetched_events: fetchedEvents,
      normalized_events: normalizedEvents,
      saved_count: savedCount,
      duplicate_skipped_count: duplicateSkippedCount,
      exp_applied: expApplied,
      last_error: null,
      retry_after: null,
      rate_limit_reset: null,
      completed_at: null,
      ...patch,
    });
  };

  try {
    await saveRunningState();

    // Public Events are returned newest-first. We follow every Link rel=next
    // page until the requested date window or item limit is exhausted.
    while (phase === "events" && eventsNextUrl && normalizedEvents < limit) {
      await saveRunningState();
      const page = await fetchGitHubEventsPage(
        account.access_token!,
        eventsNextUrl,
        cutoff,
        limit - normalizedEvents,
      );
      const persisted = await recordBackfillActivityChunk(
        userId,
        page.activities,
      );

      fetchedEvents += page.fetched;
      normalizedEvents += page.normalized;
      savedCount += persisted.inserted_count;
      duplicateSkippedCount += persisted.duplicate_count;
      expApplied += persisted.exp_applied;
      eventsNextUrl = page.nextUrl;

      if (page.reachedCutoff || !eventsNextUrl || normalizedEvents >= limit) {
        phase = normalizedEvents >= limit ? "completed" : "stars";
      }

      await saveRunningState();
    }

    // Starred repositories use a separate endpoint, so the cursor is tracked
    // independently from the Events API cursor.
    while (phase === "stars" && starsNextUrl && normalizedEvents < limit) {
      await saveRunningState();
      const page = await fetchGitHubStarsPage(
        account.access_token!,
        starsNextUrl,
        cutoff,
        limit - normalizedEvents,
      );
      const persisted = await recordBackfillActivityChunk(
        userId,
        page.activities,
      );

      fetchedEvents += page.fetched;
      normalizedEvents += page.normalized;
      savedCount += persisted.inserted_count;
      duplicateSkippedCount += persisted.duplicate_count;
      expApplied += persisted.exp_applied;
      starsNextUrl = page.nextUrl;

      if (page.reachedCutoff || !starsNextUrl || normalizedEvents >= limit) {
        phase = "completed";
      }

      await saveRunningState();
    }

    phase = "completed";
    const backfilledAt = await markBackfillCompleted(userId);
    await saveRunningState({
      status: "completed",
      phase,
      completed_at: backfilledAt ?? new Date().toISOString(),
    });

    return {
      fetched_events: fetchedEvents,
      normalized_events: normalizedEvents,
      saved_count: savedCount,
      duplicate_skipped_count: duplicateSkippedCount,
      exp_applied: expApplied,
      completed: true,
      backfilled_at: backfilledAt,
      phase,
    };
  } catch (error) {
    const retryAfter = error instanceof GitHubApiError
      ? error.retryAfter ?? null
      : null;
    const rateLimitReset = error instanceof GitHubApiError
      ? error.rateLimitReset ?? null
      : null;
    const status: BackfillStatus = error instanceof GitHubApiError &&
        (error.status === 429 ||
          (error.status === 403 && error.message.includes("rate limit")))
      ? "rate_limited"
      : "failed";

    await saveBackfillRun(userId, {
      status,
      phase,
      events_next_url: eventsNextUrl,
      stars_next_url: starsNextUrl,
      fetched_events: fetchedEvents,
      normalized_events: normalizedEvents,
      saved_count: savedCount,
      duplicate_skipped_count: duplicateSkippedCount,
      exp_applied: expApplied,
      last_error: String(error),
      retry_after: retryAfter,
      rate_limit_reset: rateLimitReset,
    });

    throw error;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: true, message: "Method not allowed" }, 405);
  }

  let body: RequestBody = {};
  let activeUserId: string | null = null;
  try {
    body = await req.json();
  } catch {
    // Empty JSON is valid for the default authenticated-user backfill.
  }

  try {
    const { userId, internal } = await resolveTargetUser(req, body);
    activeUserId = userId;
    const force = internal && body.force === true;
    const days = body.days && body.days > 0
      ? Math.floor(body.days)
      : DEFAULT_DAYS;
    const limit = body.limit && body.limit > 0
      ? Math.min(Math.floor(body.limit), DEFAULT_LIMIT)
      : DEFAULT_LIMIT;
    const cutoff = new Date(Date.now() - days * ONE_DAY_MS);
    const account = await loadAccount(userId);

    if (account.backfilled_at && !force) {
      console.log(JSON.stringify({
        message: "backfill-user-activities skipped: already completed",
        user_id: userId,
        backfilled_at: account.backfilled_at,
      }));

      return jsonResponse({
        user_id: userId,
        fetched_events: 0,
        saved_count: 0,
        duplicate_skipped_count: 0,
        exp_applied: 0,
        completed: true,
        error: false,
        backfilled_at: account.backfilled_at,
        skipped_reason: "already_backfilled",
      });
    }

    if (!account.access_token) {
      return jsonResponse({
        user_id: userId,
        fetched_events: 0,
        saved_count: 0,
        duplicate_skipped_count: 0,
        exp_applied: 0,
        completed: false,
        error: true,
        message: "GitHub access token not found for user",
      }, 409);
    }

    const persisted = await runResumableBackfill(
      userId,
      account,
      cutoff,
      limit,
      force,
    );

    console.log(JSON.stringify({
      message: "backfill-user-activities completed",
      user_id: userId,
      username: account.username,
      fetched_events: persisted.fetched_events,
      normalized_events: persisted.normalized_events,
      saved_count: persisted.saved_count,
      duplicate_skipped_count: persisted.duplicate_skipped_count,
      exp_applied: persisted.exp_applied,
      backfilled_at: persisted.backfilled_at,
    }));

    return jsonResponse({
      user_id: userId,
      fetched_events: persisted.fetched_events,
      saved_count: persisted.saved_count,
      duplicate_skipped_count: persisted.duplicate_skipped_count,
      exp_applied: persisted.exp_applied,
      completed: persisted.completed,
      error: false,
      backfilled_at: persisted.backfilled_at,
      phase: persisted.phase,
      ignored_events: Math.max(
        persisted.fetched_events - persisted.normalized_events,
        0,
      ),
    });
  } catch (error) {
    if (error instanceof GitPetError) {
      return jsonResponse({
        user_id: body.user_id ?? null,
        fetched_events: 0,
        saved_count: 0,
        duplicate_skipped_count: 0,
        exp_applied: 0,
        completed: false,
        error: true,
        message: error.message,
      }, error.status);
    }

    if (error instanceof GitHubApiError) {
      const run = activeUserId ? await loadBackfillRun(activeUserId) : null;
      console.warn(JSON.stringify({
        message: "backfill-user-activities GitHub API error",
        user_id: activeUserId,
        status: error.status,
        retry_after: error.retryAfter,
        rate_limit_reset: error.rateLimitReset,
        error: error.message,
      }));

      return jsonResponse({
        user_id: activeUserId ?? body.user_id ?? null,
        fetched_events: run?.fetched_events ?? 0,
        saved_count: run?.saved_count ?? 0,
        duplicate_skipped_count: run?.duplicate_skipped_count ?? 0,
        exp_applied: run?.exp_applied ?? 0,
        completed: false,
        error: true,
        message: error.message,
        phase: run?.phase ?? null,
        resumable: Boolean(run?.events_next_url || run?.stars_next_url),
        github_status: error.status,
        retry_after: error.retryAfter ?? null,
        rate_limit_reset: error.rateLimitReset ?? null,
      }, error.status === 401 ? 401 : 503);
    }

    return errorResponse(error);
  }
});
