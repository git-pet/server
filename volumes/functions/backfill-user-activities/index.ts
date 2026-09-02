import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/response.ts";
import { errorResponse, GitPetError } from "../_shared/error.ts";

type Json = Record<string, unknown>;

type BackfillAccount = {
  user_id: string;
  github_id: string;
  username: string;
  access_token: string | null;
  backfilled_at: string | null;
};

type GitHubEvent = {
  id: string;
  type: string;
  created_at: string;
  repo?: { id?: number; name?: string };
  payload?: Json;
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

type GitHubStar = {
  starred_at: string;
  repo: {
    id: number;
    full_name: string;
    html_url?: string;
    owner?: { id?: number; login?: string };
  };
};

type ActivityInput = {
  event_type: "commit" | "pull_request" | "issue" | "star";
  xp_gained: number;
  github_event_id: string;
  metadata: Json;
  created_at: string;
};

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

class GitHubApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfter?: string | null,
    public rateLimitReset?: string | null,
  ) {
    super(message);
  }
}

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function githubFetchJson<T>(
  url: string,
  accessToken: string,
  accept = "application/vnd.github+json",
): Promise<{ data: T; nextUrl: string | null }> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await githubFetchJsonOnce<T>(url, accessToken, accept);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || !shouldRetry(error)) {
        throw error;
      }

      if (attempt >= MAX_RETRIES) throw error;

      const waitMs = retryDelayMs(error, attempt);
      console.warn(JSON.stringify({
        message: "backfill-user-activities retrying GitHub request",
        url,
        attempt: attempt + 1,
        wait_ms: waitMs,
        status: error.status,
        retry_after: error.retryAfter ?? null,
        rate_limit_reset: error.rateLimitReset ?? null,
      }));
      await delay(waitMs);
    }
  }

  throw new GitHubApiError("GitHub request retry loop failed", 0);
}

async function githubFetchJsonOnce<T>(
  url: string,
  accessToken: string,
  accept: string,
): Promise<{ data: T; nextUrl: string | null }> {
  let response: Response;

  try {
    response = await fetch(url, {
      headers: {
        accept,
        authorization: `Bearer ${accessToken}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "git-pet-backfill-user-activities",
      },
    });
  } catch (error) {
    throw new GitHubApiError(`GitHub network error: ${String(error)}`, 0);
  }

  if (!response.ok) {
    const body = await response.text();
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    const retryAfter = response.headers.get("retry-after");
    const resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : null;

    if (response.status === 401) {
      throw new GitHubApiError("GitHub token is expired or invalid", 401);
    }

    if (response.status === 403 && remaining === "0") {
      throw new GitHubApiError(
        "GitHub rate limit exceeded",
        403,
        retryAfter,
        resetAt,
      );
    }

    throw new GitHubApiError(
      `GitHub ${response.status}: ${body.slice(0, 500)}`,
      response.status,
      retryAfter,
      resetAt,
    );
  }

  return {
    data: await response.json() as T,
    nextUrl: nextLink(response.headers.get("link")),
  };
}

function shouldRetry(error: GitHubApiError): boolean {
  if (error.status === 0) return true;
  if (error.status === 429) return true;
  if (error.status === 403 && error.message.includes("rate limit")) {
    return true;
  }
  return error.status >= 500;
}

function retryDelayMs(error: GitHubApiError, attempt: number): number {
  const retryAfterSeconds = Number(error.retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, MAX_BACKOFF_MS);
  }

  if (error.rateLimitReset) {
    const resetMs = new Date(error.rateLimitReset).getTime() - Date.now();
    if (Number.isFinite(resetMs) && resetMs > 0) {
      return Math.min(resetMs, MAX_BACKOFF_MS);
    }
  }

  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

function nextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;

  for (const part of linkHeader.split(",")) {
    const [rawUrl, rawRel] = part.trim().split(";");
    if (rawRel?.trim() === 'rel="next"') {
      return rawUrl.trim().slice(1, -1);
    }
  }

  return null;
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

  const pageResult = await githubFetchJson<GitHubEvent[]>(url, accessToken);
  const data = pageResult.data;

  for (const event of data) {
    const createdAt = new Date(event.created_at);
    if (createdAt < cutoff) {
      reachedCutoff = true;
      continue;
    }

    const activity = normalizeGitHubEvent(event);
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
  );
  const data = pageResult.data;

  for (const star of data) {
    const starredAt = new Date(star.starred_at);
    if (starredAt < cutoff) {
      reachedCutoff = true;
      continue;
    }

    normalized += 1;
    activities.push(normalizeStar(star));
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

function normalizeGitHubEvent(event: GitHubEvent): ActivityInput | null {
  const payload = event.payload ?? {};
  const repo = event.repo?.name ?? null;

  if (event.type === "PushEvent") {
    const commits = Array.isArray(payload.commits) ? payload.commits : [];
    if (commits.length === 0) return null;

    return {
      event_type: "commit",
      xp_gained: Math.min(commits.length * 10, 50),
      github_event_id: `github-rest:event:${event.id}`,
      created_at: event.created_at,
      metadata: {
        source: "backfill-user-activities",
        github_event_type: event.type,
        repo,
        commits: commits.length,
        github_event: event,
      },
    };
  }

  if (event.type === "PullRequestEvent") {
    const action = getString(payload, "action");
    const pr = asJsonObject(payload.pull_request);
    const merged = pr?.merged === true;
    let xp = 0;

    if (action === "opened") xp = 20;
    else if (action === "closed" && merged) xp = 50;
    else if (action === "closed") xp = 5;
    else return null;

    return {
      event_type: "pull_request",
      xp_gained: xp,
      github_event_id: `github-rest:event:${event.id}`,
      created_at: event.created_at,
      metadata: {
        source: "backfill-user-activities",
        github_event_type: event.type,
        repo,
        action,
        number: pr?.number ?? null,
        title: getString(pr, "title"),
        url: getString(pr, "html_url"),
        github_event: event,
      },
    };
  }

  if (event.type === "IssuesEvent") {
    const action = getString(payload, "action");
    const issue = asJsonObject(payload.issue);
    let xp = 0;

    if (action === "opened") xp = 10;
    else if (action === "closed") xp = 20;
    else return null;

    return {
      event_type: "issue",
      xp_gained: xp,
      github_event_id: `github-rest:event:${event.id}`,
      created_at: event.created_at,
      metadata: {
        source: "backfill-user-activities",
        github_event_type: event.type,
        repo,
        action,
        number: issue?.number ?? null,
        title: getString(issue, "title"),
        url: getString(issue, "html_url"),
        github_event: event,
      },
    };
  }

  return null;
}

function normalizeStar(star: GitHubStar): ActivityInput {
  return {
    event_type: "star",
    xp_gained: 5,
    github_event_id: `github-rest:star:${star.repo.id}:${star.starred_at}`,
    created_at: star.starred_at,
    metadata: {
      source: "backfill-user-activities",
      github_event_type: "StarredRepository",
      repo: star.repo.full_name,
      repo_id: star.repo.id,
      url: star.repo.html_url ?? null,
      owner: star.repo.owner?.login ?? null,
      starred_at: star.starred_at,
    },
  };
}

function asJsonObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Json
    : null;
}

function getString(object: Json | null, key: string): string | null {
  const value = object?.[key];
  return typeof value === "string" ? value : null;
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
