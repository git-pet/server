import { createClient } from "@supabase/supabase-js";

type Json = Record<string, unknown>;

// sync-activities is a backfill/safety-net Edge Function.
// - POST {} runs batch mode for every user with a saved GitHub token.
// - POST {"user_id":"..."} runs one user only.
// The function reads recent GitHub Events with the user's OAuth access token,
// then calls add_pet_exp so the existing activities -> pet trigger path awards XP.

type SyncAccount = {
  user_id: string;
  github_id: string;
  username: string;
  access_token: string;
};

type GitHubEvent = {
  id: string;
  type: string;
  created_at: string;
  repo?: {
    name?: string;
  };
  payload?: Json;
};

type NormalizedActivity = {
  eventType: "commit" | "pull_request" | "issue";
  xp: number;
  dedupeKey: string;
  metadata: Json;
};

type UserSyncResult = {
  user_id: string;
  username?: string;
  fetched_events: number;
  processed_events: number;
  awarded_events: number;
  deduped_events: number;
  ignored_events: number;
  errors: string[];
};

const SUPABASE_URL = mustGetEnv("SUPABASE_URL");
const SERVICE_ROLE_KEY = mustGetEnv("SUPABASE_SERVICE_ROLE_KEY");
const SYNC_SECRET = Deno.env.get("SYNC_ACTIVITIES_SECRET");
const MAX_GITHUB_PAGES = positiveIntegerEnv("SYNC_ACTIVITIES_MAX_GITHUB_PAGES", 3);
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function mustGetEnv(name: string): string {
  const value = Deno.env.get(name);

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

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

  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token;
}

function isAuthorized(req: Request): boolean {
  // Cron can use the Supabase service role key as a Bearer token.
  if (getBearerToken(req) === SERVICE_ROLE_KEY) {
    return true;
  }

  // External schedulers can use a narrower shared secret instead.
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
  accessToken: string,
  cutoff: Date,
): Promise<GitHubEvent[]> {
  const events: GitHubEvent[] = [];
  let url: string | null = "https://api.github.com/user/events?per_page=100";

  for (let page = 0; url && page < MAX_GITHUB_PAGES; page += 1) {
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "git-pet-sync-activities",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub ${response.status}: ${body}`);
    }

    const pageEvents = await response.json() as GitHubEvent[];
    events.push(...pageEvents);

    // GitHub returns newest events first. If this page already has an old
    // event, later pages are older too and cannot matter for the 24h window.
    if (pageEvents.some((event) => new Date(event.created_at) < cutoff)) {
      break;
    }

    url = nextLink(response.headers.get("link"));
  }

  return events.filter((event) => new Date(event.created_at) >= cutoff);
}

function nextLink(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }

  for (const part of linkHeader.split(",")) {
    const [rawUrl, rawRel] = part.trim().split(";");

    if (rawRel?.trim() === 'rel="next"') {
      return rawUrl.trim().slice(1, -1);
    }
  }

  return null;
}

function normalizeEvent(event: GitHubEvent): NormalizedActivity | null {
  const payload = event.payload ?? {};
  const repo = event.repo?.name ?? null;

  if (event.type === "PushEvent") {
    const commits = Array.isArray(payload.commits) ? payload.commits : [];

    if (commits.length === 0) {
      return null;
    }

    return {
      eventType: "commit",
      xp: Math.min(commits.length * 10, 50),
      dedupeKey: dedupeKey(event),
      metadata: {
        source: "sync-activities",
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

    if (action === "opened") {
      xp = 20;
    } else if (action === "closed" && merged) {
      xp = 50;
    } else if (action === "closed") {
      xp = 5;
    } else {
      return null;
    }

    return {
      eventType: "pull_request",
      xp,
      dedupeKey: dedupeKey(event),
      metadata: {
        source: "sync-activities",
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

    if (action === "opened") {
      xp = 10;
    } else if (action === "closed") {
      xp = 20;
    } else {
      return null;
    }

    return {
      eventType: "issue",
      xp,
      dedupeKey: dedupeKey(event),
      metadata: {
        source: "sync-activities",
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

function dedupeKey(event: GitHubEvent): string {
  // Namespacing prevents accidental collisions with webhook delivery IDs.
  return `github-rest:event:${event.id}`;
}

function asJsonObject(value: unknown): Json | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Json;
  }

  return null;
}

function getString(object: Json | null, key: string): string | null {
  const value = object?.[key];

  return typeof value === "string" ? value : null;
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
    p_metadata: activity.metadata,
  });

  if (error) {
    throw new Error(`RPC add_pet_exp failed: ${error.message}`);
  }

  return (data as Json | null)?.inserted === true;
}

async function syncAccount(
  account: SyncAccount,
  cutoff: Date,
): Promise<UserSyncResult> {
  const result: UserSyncResult = {
    user_id: account.user_id,
    username: account.username,
    fetched_events: 0,
    processed_events: 0,
    awarded_events: 0,
    deduped_events: 0,
    ignored_events: 0,
    errors: [],
  };

  try {
    const events = await fetchGitHubEvents(account.access_token, cutoff);
    result.fetched_events = events.length;

    for (const event of events) {
      const activity = normalizeEvent(event);

      if (!activity) {
        result.ignored_events += 1;
        continue;
      }

      result.processed_events += 1;

      try {
        const inserted = await awardActivity(account, activity);

        if (inserted) {
          result.awarded_events += 1;
        } else {
          result.deduped_events += 1;
        }
      } catch (error) {
        result.errors.push(`${event.type}:${event.id}: ${String(error)}`);
      }
    }
  } catch (error) {
    result.errors.push(String(error));
  }

  console.log(JSON.stringify({
    message: "sync-activities user finished",
    ...result,
  }));

  return result;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok");
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!isAuthorized(req)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let input: { user_id?: string } = {};

  try {
    input = await req.json();
  } catch {
    // Empty body is allowed and means batch mode.
  }

  try {
    const cutoff = new Date(Date.now() - ONE_DAY_MS);
    const accounts = await loadAccounts(input.user_id);
    const mode = input.user_id ? "single_user" : "batch";

    if (input.user_id && accounts.length === 0) {
      return jsonResponse({
        mode,
        cutoff: cutoff.toISOString(),
        results: [{
          user_id: input.user_id,
          fetched_events: 0,
          processed_events: 0,
          awarded_events: 0,
          deduped_events: 0,
          ignored_events: 0,
          errors: ["GitHub access token not found for user"],
        }],
      });
    }

    const results: UserSyncResult[] = [];

    // Sequential processing avoids rate-limit spikes during cron batch runs.
    for (const account of accounts) {
      results.push(await syncAccount(account, cutoff));
    }

    const totals = results.reduce(
      (acc, result) => ({
        users: acc.users + 1,
        fetched_events: acc.fetched_events + result.fetched_events,
        processed_events: acc.processed_events + result.processed_events,
        awarded_events: acc.awarded_events + result.awarded_events,
        deduped_events: acc.deduped_events + result.deduped_events,
        ignored_events: acc.ignored_events + result.ignored_events,
        failed_users: acc.failed_users + (result.errors.length > 0 ? 1 : 0),
      }),
      {
        users: 0,
        fetched_events: 0,
        processed_events: 0,
        awarded_events: 0,
        deduped_events: 0,
        ignored_events: 0,
        failed_users: 0,
      },
    );

    console.log(JSON.stringify({
      message: "sync-activities run finished",
      mode,
      cutoff: cutoff.toISOString(),
      totals,
    }));

    return jsonResponse({
      mode,
      cutoff: cutoff.toISOString(),
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
