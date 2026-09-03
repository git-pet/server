export type Json = Record<string, unknown>;

export type GitHubEvent = {
  id: string;
  type: string;
  created_at: string;
  repo?: { id?: number; name?: string };
  payload?: Json;
};

export type GitHubStar = {
  starred_at: string;
  repo: {
    id: number;
    full_name: string;
    html_url?: string;
    owner?: { id?: number; login?: string };
  };
};

export type NormalizedGitHubActivity = {
  event_type: "commit" | "pull_request" | "issue" | "star";
  xp_gained: number;
  github_event_id: string;
  metadata: Json;
  created_at: string;
};

export type GitHubRetryOptions = {
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  userAgent: string;
};

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfter?: string | null,
    public rateLimitReset?: string | null,
  ) {
    super(message);
  }
}

export async function githubFetchJson<T>(
  url: string,
  accessToken: string,
  accept = "application/vnd.github+json",
  options: GitHubRetryOptions,
): Promise<{ data: T; nextUrl: string | null }> {
  const maxRetries = options.maxRetries ?? 3;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await githubFetchJsonOnce<T>(url, accessToken, accept, options);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || !shouldRetry(error)) {
        throw error;
      }

      if (attempt >= maxRetries) throw error;

      const waitMs = retryDelayMs(error, attempt, options);
      console.warn(JSON.stringify({
        message: "retrying GitHub request",
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

export function nextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;

  for (const part of linkHeader.split(",")) {
    const [rawUrl, rawRel] = part.trim().split(";");
    if (rawRel?.trim() === 'rel="next"') {
      return rawUrl.trim().slice(1, -1);
    }
  }

  return null;
}

export function normalizeGitHubEvent(
  event: GitHubEvent,
  source: string,
): NormalizedGitHubActivity | null {
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
        source,
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
        source,
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
        source,
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

export function normalizeStar(
  star: GitHubStar,
  source: string,
): NormalizedGitHubActivity {
  return {
    event_type: "star",
    xp_gained: 5,
    github_event_id: `github-rest:star:${star.repo.id}:${star.starred_at}`,
    created_at: star.starred_at,
    metadata: {
      source,
      github_event_type: "StarredRepository",
      repo: star.repo.full_name,
      repo_id: star.repo.id,
      url: star.repo.html_url ?? null,
      owner: star.repo.owner?.login ?? null,
      starred_at: star.starred_at,
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function githubFetchJsonOnce<T>(
  url: string,
  accessToken: string,
  accept: string,
  options: GitHubRetryOptions,
): Promise<{ data: T; nextUrl: string | null }> {
  let response: Response;

  try {
    response = await fetch(url, {
      headers: {
        accept,
        authorization: `Bearer ${accessToken}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": options.userAgent,
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

    if (
      response.status === 429 || (response.status === 403 &&
        remaining === "0")
    ) {
      throw new GitHubApiError(
        "GitHub rate limit exceeded",
        response.status,
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

function retryDelayMs(
  error: GitHubApiError,
  attempt: number,
  options: GitHubRetryOptions,
): number {
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  const retryAfterSeconds = Number(error.retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, maxBackoffMs);
  }

  if (error.rateLimitReset) {
    const resetMs = new Date(error.rateLimitReset).getTime() - Date.now();
    if (Number.isFinite(resetMs) && resetMs > 0) {
      return Math.min(resetMs, maxBackoffMs);
    }
  }

  return Math.min((options.baseBackoffMs ?? 500) * 2 ** attempt, maxBackoffMs);
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
