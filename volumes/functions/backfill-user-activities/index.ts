import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/response.ts";
import { GitPetError, errorResponse } from "../_shared/error.ts";

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
const MAX_GITHUB_PAGES = positiveIntegerEnv("BACKFILL_GITHUB_MAX_PAGES", 10);
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

async function githubFetchJson<T>(
  url: string,
  accessToken: string,
  accept = "application/vnd.github+json",
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

async function fetchGitHubEvents(
  accessToken: string,
  username: string,
  cutoff: Date,
  limit: number,
): Promise<GitHubFetchResult> {
  const activities: ActivityInput[] = [];
  let fetched = 0;
  let normalized = 0;
  let url: string | null =
    `https://api.github.com/users/${encodeURIComponent(username)}/events?per_page=100`;

  for (
    let page = 0;
    url && page < MAX_GITHUB_PAGES && activities.length < limit;
    page += 1
  ) {
    const { data, nextUrl: fetchedNextUrl } = await githubFetchJson<
      GitHubEvent[]
    >(
      url,
      accessToken,
    );
    fetched += data.length;

    for (const event of data) {
      const createdAt = new Date(event.created_at);
      if (createdAt < cutoff) continue;

      const activity = normalizeGitHubEvent(event);
      if (activity) {
        normalized += 1;
        activities.push(activity);
      }
      if (activities.length >= limit) break;
    }

    // GitHub Events are newest first, so older pages cannot enter the window.
    if (data.some((event) => new Date(event.created_at) < cutoff)) break;
    url = fetchedNextUrl;
  }

  return { fetched, normalized, activities };
}

async function fetchGitHubStars(
  accessToken: string,
  cutoff: Date,
  remainingLimit: number,
): Promise<GitHubFetchResult> {
  const activities: ActivityInput[] = [];
  let fetched = 0;
  let normalized = 0;
  let url: string | null = "https://api.github.com/user/starred?per_page=100";

  for (
    let page = 0;
    url && page < MAX_GITHUB_PAGES && activities.length < remainingLimit;
    page += 1
  ) {
    const { data, nextUrl: fetchedNextUrl } = await githubFetchJson<
      GitHubStar[]
    >(
      url,
      accessToken,
      "application/vnd.github.star+json",
    );
    fetched += data.length;

    for (const star of data) {
      const starredAt = new Date(star.starred_at);
      if (starredAt < cutoff) continue;

      normalized += 1;
      activities.push(normalizeStar(star));
      if (activities.length >= remainingLimit) break;
    }

    if (data.some((star) => new Date(star.starred_at) < cutoff)) break;
    url = fetchedNextUrl;
  }

  return { fetched, normalized, activities };
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

async function persistActivities(
  userId: string,
  activities: ActivityInput[],
  force: boolean,
): Promise<{
  already_backfilled: boolean;
  inserted_count: number;
  duplicate_count: number;
  exp_applied: number;
  backfilled_at: string | null;
}> {
  const { data, error } = await serviceSupabase.rpc("add_pet_exp", {
    p_user_id: userId,
    p_activities: activities,
    p_force: force,
  });

  if (error) throw new Error(`RPC add_pet_exp bulk failed: ${error.message}`);
  return data as {
    already_backfilled: boolean;
    inserted_count: number;
    duplicate_count: number;
    exp_applied: number;
    backfilled_at: string | null;
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: true, message: "Method not allowed" }, 405);
  }

  let body: RequestBody = {};
  try {
    body = await req.json();
  } catch {
    // Empty JSON is valid for the default authenticated-user backfill.
  }

  try {
    const { userId, internal } = await resolveTargetUser(req, body);
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

    const eventResult = await fetchGitHubEvents(
      account.access_token,
      account.username,
      cutoff,
      limit,
    );
    const starResult = await fetchGitHubStars(
      account.access_token,
      cutoff,
      Math.max(limit - eventResult.activities.length, 0),
    );
    const activities = [...eventResult.activities, ...starResult.activities]
      .slice(0, limit);

    const persisted = await persistActivities(userId, activities, force);
    const fetchedEvents = eventResult.fetched + starResult.fetched;
    const normalizedEvents = eventResult.normalized + starResult.normalized;

    console.log(JSON.stringify({
      message: "backfill-user-activities completed",
      user_id: userId,
      username: account.username,
      fetched_events: fetchedEvents,
      normalized_events: normalizedEvents,
      saved_count: persisted.inserted_count,
      duplicate_skipped_count: persisted.duplicate_count,
      exp_applied: persisted.exp_applied,
      backfilled_at: persisted.backfilled_at,
    }));

    return jsonResponse({
      user_id: userId,
      fetched_events: fetchedEvents,
      saved_count: persisted.inserted_count,
      duplicate_skipped_count: persisted.duplicate_count,
      exp_applied: persisted.exp_applied,
      completed: true,
      error: false,
      backfilled_at: persisted.backfilled_at,
      skipped_reason: persisted.already_backfilled
        ? "already_backfilled"
        : undefined,
      ignored_events: Math.max(fetchedEvents - normalizedEvents, 0),
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
      console.warn(JSON.stringify({
        message: "backfill-user-activities GitHub API error",
        status: error.status,
        retry_after: error.retryAfter,
        rate_limit_reset: error.rateLimitReset,
        error: error.message,
      }));

      return jsonResponse({
        user_id: body.user_id ?? null,
        fetched_events: 0,
        saved_count: 0,
        duplicate_skipped_count: 0,
        exp_applied: 0,
        completed: false,
        error: true,
        message: error.message,
        github_status: error.status,
        retry_after: error.retryAfter ?? null,
        rate_limit_reset: error.rateLimitReset ?? null,
      }, error.status === 401 ? 401 : 503);
    }

    return errorResponse(error);
  }
});
