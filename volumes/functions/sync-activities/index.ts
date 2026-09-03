import { createClient } from "@supabase/supabase-js";
import {
  GitHubApiError,
  type GitHubEvent,
  githubFetchJson,
  type GitHubStar,
  type Json,
  type NormalizedGitHubActivity,
  normalizeGitHubEvent,
  normalizeStar,
} from "../_shared/github_activity.ts";

type SyncAccount = {
  user_id: string;
  github_id: string;
  username: string;
  access_token: string;
  last_synced_at: string | null;
};

type ActivityEventType = "commit" | "pull_request" | "issue" | "star";

type NormalizedActivity = {
  eventType: ActivityEventType;
  xp: number;
  dedupeKey: string;
  createdAt: string;
  metadata: Json;
};

type FetchResult = {
  fetched: number;
  normalized: number;
  activities: NormalizedActivity[];
};

type UserSyncResult = {
  user_id: string;
  username?: string;
  last_synced_at: string | null;
  synced_at: string | null;
  fetched_events: number;
  processed_events: number;
  awarded_events: number;
  deduped_events: number;
  ignored_events: number;
  exp_applied: number;
  errors: string[];
  rate_limited: boolean;
  token_expired: boolean;
};

type RequestInput = {
  user_id?: string;
  lookback_hours?: number;
  max_users?: number;
};

const SUPABASE_URL = mustGetEnv("SUPABASE_URL");
const SERVICE_ROLE_KEY = mustGetEnv("SUPABASE_SERVICE_ROLE_KEY");
const SYNC_SECRET = Deno.env.get("SYNC_ACTIVITIES_SECRET");
const MAX_GITHUB_PAGES = positiveIntegerEnv(
  "SYNC_ACTIVITIES_MAX_GITHUB_PAGES",
  3,
);
const DEFAULT_LOOKBACK_HOURS = positiveIntegerEnv(
  "SYNC_ACTIVITIES_LOOKBACK_HOURS",
  24,
);
const DEFAULT_MAX_USERS = positiveIntegerEnv("SYNC_ACTIVITIES_MAX_USERS", 50);
const SYNC_OVERLAP_MINUTES = positiveIntegerEnv(
  "SYNC_ACTIVITIES_OVERLAP_MINUTES",
  5,
);
const MAX_RETRIES = positiveIntegerEnv("SYNC_ACTIVITIES_MAX_RETRIES", 3);
const BASE_BACKOFF_MS = positiveIntegerEnv(
  "SYNC_ACTIVITIES_BASE_BACKOFF_MS",
  500,
);
const MAX_BACKOFF_MS = positiveIntegerEnv(
  "SYNC_ACTIVITIES_MAX_BACKOFF_MS",
  30_000,
);
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

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
    headers: { "Content-Type": "application/json" },
  });
}

function getBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  const [scheme, token] = auth?.split(" ") ?? [];
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

function isAuthorized(req: Request): boolean {
  if (getBearerToken(req) === SERVICE_ROLE_KEY) return true;

  return Boolean(
    SYNC_SECRET && req.headers.get("x-sync-activities-secret") === SYNC_SECRET,
  );
}

async function loadAccounts(userId?: string): Promise<SyncAccount[]> {
  const { data, error } = await supabase.rpc("get_github_sync_accounts", {
    p_user_id: userId ?? null,
  });

  if (error) {
    throw new Error(`RPC get_github_sync_accounts failed: ${error.message}`);
  }

  return (data ?? []) as SyncAccount[];
}

async function fetchGitHubEvents(
  account: SyncAccount,
  cutoff: Date,
): Promise<FetchResult> {
  const activities: NormalizedActivity[] = [];
  let fetched = 0;
  let normalized = 0;
  let url: string | null = `https://api.github.com/users/${
    encodeURIComponent(account.username)
  }/events?per_page=100`;

  for (let page = 0; url && page < MAX_GITHUB_PAGES; page += 1) {
    const pageResult: { data: GitHubEvent[]; nextUrl: string | null } =
      await githubFetchJson<GitHubEvent[]>(
        url,
        account.access_token,
        "application/vnd.github+json",
        githubRetryOptions(),
      );
    const data = pageResult.data;
    const fetchedNextUrl: string | null = pageResult.nextUrl;
    fetched += data.length;

    for (const event of data) {
      const createdAt = new Date(event.created_at);
      if (createdAt < cutoff) continue;

      const activity = normalizeGitHubEvent(event, "sync-activities");
      if (activity) {
        normalized += 1;
        activities.push(fromSharedActivity(activity));
      }
    }

    // Events are newest first. Once this page contains an old item, later pages
    // cannot produce new incremental activity for this sync window.
    if (data.some((event) => new Date(event.created_at) < cutoff)) break;
    url = fetchedNextUrl;
  }

  return { fetched, normalized, activities };
}

async function fetchGitHubStars(
  accessToken: string,
  cutoff: Date,
): Promise<FetchResult> {
  const activities: NormalizedActivity[] = [];
  let fetched = 0;
  let normalized = 0;
  let url: string | null = "https://api.github.com/user/starred?per_page=100";

  for (let page = 0; url && page < MAX_GITHUB_PAGES; page += 1) {
    const pageResult: { data: GitHubStar[]; nextUrl: string | null } =
      await githubFetchJson<GitHubStar[]>(
        url,
        accessToken,
        "application/vnd.github.star+json",
        githubRetryOptions(),
      );
    const data = pageResult.data;
    const fetchedNextUrl: string | null = pageResult.nextUrl;
    fetched += data.length;

    for (const star of data) {
      const starredAt = new Date(star.starred_at);
      if (starredAt < cutoff) continue;

      normalized += 1;
      activities.push(
        fromSharedActivity(normalizeStar(star, "sync-activities")),
      );
    }

    if (data.some((star) => new Date(star.starred_at) < cutoff)) break;
    url = fetchedNextUrl;
  }

  return { fetched, normalized, activities };
}

function githubRetryOptions() {
  return {
    maxRetries: MAX_RETRIES,
    baseBackoffMs: BASE_BACKOFF_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
    userAgent: "git-pet-sync-activities",
  };
}

function fromSharedActivity(
  activity: NormalizedGitHubActivity,
): NormalizedActivity {
  return {
    eventType: activity.event_type,
    xp: activity.xp_gained,
    dedupeKey: activity.github_event_id,
    createdAt: activity.created_at,
    metadata: activity.metadata,
  };
}

async function awardActivity(
  account: SyncAccount,
  activity: NormalizedActivity,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("add_pet_exp", {
    p_user_id: account.user_id,
    p_exp: activity.xp,
    p_event_type: activity.eventType,
    p_github_event_id: activity.dedupeKey,
    p_metadata: {
      ...activity.metadata,
      created_at: activity.createdAt,
    },
  });

  if (error) throw new Error(`RPC add_pet_exp failed: ${error.message}`);
  return (data as { inserted?: boolean } | null)?.inserted === true;
}

async function markSynced(userId: string, syncedAt: Date): Promise<string> {
  const { data, error } = await supabase.rpc("mark_github_activities_synced", {
    p_user_id: userId,
    p_synced_at: syncedAt.toISOString(),
  });

  if (error) {
    throw new Error(
      `RPC mark_github_activities_synced failed: ${error.message}`,
    );
  }

  return String(data);
}

function syncCutoff(account: SyncAccount, lookbackHours: number): Date {
  if (!account.last_synced_at) {
    return new Date(Date.now() - lookbackHours * ONE_HOUR_MS);
  }

  // Small overlap protects against clock drift and events near the boundary.
  return new Date(
    new Date(account.last_synced_at).getTime() -
      SYNC_OVERLAP_MINUTES * ONE_MINUTE_MS,
  );
}

async function syncAccount(
  account: SyncAccount,
  lookbackHours: number,
  runStartedAt: Date,
): Promise<UserSyncResult> {
  const result: UserSyncResult = {
    user_id: account.user_id,
    username: account.username,
    last_synced_at: account.last_synced_at,
    synced_at: null,
    fetched_events: 0,
    processed_events: 0,
    awarded_events: 0,
    deduped_events: 0,
    ignored_events: 0,
    exp_applied: 0,
    errors: [],
    rate_limited: false,
    token_expired: false,
  };

  try {
    const cutoff = syncCutoff(account, lookbackHours);
    const eventResult = await fetchGitHubEvents(account, cutoff);
    const starResult = await fetchGitHubStars(account.access_token, cutoff);
    const activities = [...eventResult.activities, ...starResult.activities]
      .sort((a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );

    result.fetched_events = eventResult.fetched + starResult.fetched;
    result.processed_events = activities.length;
    result.ignored_events = Math.max(
      result.fetched_events - eventResult.normalized - starResult.normalized,
      0,
    );

    for (const activity of activities) {
      try {
        const inserted = await awardActivity(account, activity);

        if (inserted) {
          result.awarded_events += 1;
          result.exp_applied += activity.xp;
        } else {
          result.deduped_events += 1;
        }
      } catch (error) {
        result.errors.push(`${activity.dedupeKey}: ${String(error)}`);
      }
    }

    // Only advance the cursor after GitHub fetches and activity inserts
    // completed. If an insert failed, keep last_synced_at unchanged so the
    // next run can retry; github_event_id dedupe protects successful rows.
    if (result.errors.length === 0) {
      result.synced_at = await markSynced(account.user_id, runStartedAt);
    }
  } catch (error) {
    if (error instanceof GitHubApiError) {
      result.rate_limited = error.status === 403 &&
        error.message.includes("rate limit");
      result.token_expired = error.status === 401;
      result.errors.push(JSON.stringify({
        message: error.message,
        github_status: error.status,
        retry_after: error.retryAfter ?? null,
        rate_limit_reset: error.rateLimitReset ?? null,
      }));
    } else {
      result.errors.push(String(error));
    }
  }

  console.log(JSON.stringify({
    message: "sync-activities user finished",
    ...result,
  }));

  return result;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok");

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!isAuthorized(req)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let input: RequestInput = {};

  try {
    input = await req.json();
  } catch {
    // Empty body is allowed and means scheduled batch mode.
  }

  try {
    const runStartedAt = new Date();
    const lookbackHours = input.lookback_hours && input.lookback_hours > 0
      ? Math.floor(input.lookback_hours)
      : DEFAULT_LOOKBACK_HOURS;
    const maxUsers = input.user_id
      ? 1
      : input.max_users && input.max_users > 0
      ? Math.floor(input.max_users)
      : DEFAULT_MAX_USERS;
    const accounts = (await loadAccounts(input.user_id)).slice(0, maxUsers);
    const mode = input.user_id ? "single_user" : "batch";

    if (input.user_id && accounts.length === 0) {
      return jsonResponse({
        mode,
        run_started_at: runStartedAt.toISOString(),
        lookback_hours: lookbackHours,
        results: [{
          user_id: input.user_id,
          last_synced_at: null,
          synced_at: null,
          fetched_events: 0,
          processed_events: 0,
          awarded_events: 0,
          deduped_events: 0,
          ignored_events: 0,
          exp_applied: 0,
          errors: ["GitHub access token not found for user"],
          rate_limited: false,
          token_expired: false,
        }],
      });
    }

    const results: UserSyncResult[] = [];

    // Sequential processing avoids GitHub rate-limit spikes during cron runs.
    for (const account of accounts) {
      results.push(await syncAccount(account, lookbackHours, runStartedAt));
    }

    const totals = results.reduce(
      (acc, result) => ({
        users: acc.users + 1,
        fetched_events: acc.fetched_events + result.fetched_events,
        processed_events: acc.processed_events + result.processed_events,
        awarded_events: acc.awarded_events + result.awarded_events,
        deduped_events: acc.deduped_events + result.deduped_events,
        ignored_events: acc.ignored_events + result.ignored_events,
        exp_applied: acc.exp_applied + result.exp_applied,
        failed_users: acc.failed_users + (result.errors.length > 0 ? 1 : 0),
        rate_limited_users: acc.rate_limited_users +
          (result.rate_limited ? 1 : 0),
        token_expired_users: acc.token_expired_users +
          (result.token_expired ? 1 : 0),
      }),
      {
        users: 0,
        fetched_events: 0,
        processed_events: 0,
        awarded_events: 0,
        deduped_events: 0,
        ignored_events: 0,
        exp_applied: 0,
        failed_users: 0,
        rate_limited_users: 0,
        token_expired_users: 0,
      },
    );

    console.log(JSON.stringify({
      message: "sync-activities run finished",
      mode,
      run_started_at: runStartedAt.toISOString(),
      lookback_hours: lookbackHours,
      max_users: maxUsers,
      totals,
    }));

    return jsonResponse({
      mode,
      run_started_at: runStartedAt.toISOString(),
      lookback_hours: lookbackHours,
      max_users: maxUsers,
      totals,
      results,
    });
  } catch (error) {
    console.error(JSON.stringify({
      message: "sync-activities run failed",
      error: String(error),
    }));

    return jsonResponse({ error: String(error) }, 500);
  }
});
