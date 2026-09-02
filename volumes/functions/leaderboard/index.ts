import { requireAuth } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/db.ts";
import { errorResponse, GitPetError } from "../_shared/error.ts";
import { corsHeaders, ok } from "../_shared/response.ts";

type LeaderboardType = "exp" | "weekly";

type LeaderboardRow = {
  rank: number;
  user_id: string;
  github_login: string;
  nickname: string;
  avatar_url: string | null;
  level: number;
  exp: number;
  weekly_exp: number;
  is_me?: boolean;
};

type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;
const ME_WINDOW = 5;
const cache = new Map<string, CacheEntry>();

function routeParts(req: Request): string[] {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const functionIndex = parts.indexOf("leaderboard");

  return functionIndex >= 0 ? parts.slice(functionIndex + 1) : parts.slice(1);
}

function parseLeaderboardType(value: string | null): LeaderboardType {
  if (value === null || value === "" || value === "exp") return "exp";
  if (value === "weekly") return "weekly";

  throw new GitPetError("type must be exp or weekly", 400);
}

function parseLimit(value: string | null): number {
  if (value === null || value === "") return DEFAULT_LIMIT;

  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new GitPetError("limit must be a positive integer", 400);
  }

  return Math.min(limit, MAX_LIMIT);
}

function publicRow(row: LeaderboardRow) {
  return {
    rank: Number(row.rank),
    user_id: row.user_id,
    github_login: row.github_login,
    nickname: row.nickname,
    avatar_url: row.avatar_url,
    level: Number(row.level ?? 1),
    exp: Number(row.exp ?? 0),
    weekly_exp: Number(row.weekly_exp ?? 0),
  };
}

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return entry.value as T;
}

function setCached(key: string, value: unknown) {
  cache.set(key, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value,
  });
}

async function topLeaderboard(type: LeaderboardType, limit: number) {
  const cacheKey = `leaderboard:${type}:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const admin = getServiceClient();
  const { data, error } = await admin.rpc("get_leaderboard", {
    p_type: type,
    p_limit: limit,
  });

  if (error) {
    throw new GitPetError(error.message, 500);
  }

  const response = {
    type,
    limit,
    cache_ttl_seconds: CACHE_TTL_MS / 1000,
    users: ((data ?? []) as LeaderboardRow[]).map(publicRow),
  };

  setCached(cacheKey, response);
  return response;
}

async function myLeaderboard(userId: string, type: LeaderboardType) {
  const cacheKey = `leaderboard:me:${type}:${userId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const admin = getServiceClient();
  const { data, error } = await admin.rpc("get_my_leaderboard_window", {
    p_user_id: userId,
    p_type: type,
    p_window: ME_WINDOW,
  });

  if (error) {
    throw new GitPetError(error.message, 500);
  }

  const rows = ((data ?? []) as LeaderboardRow[]).map((row) => ({
    ...publicRow(row),
    is_me: row.is_me === true,
  }));
  const me = rows.find((row) => row.is_me);

  if (!me) {
    throw new GitPetError("Profile not found in leaderboard", 404);
  }

  const response = {
    type,
    window: ME_WINDOW,
    cache_ttl_seconds: CACHE_TTL_MS / 1000,
    me,
    users: rows,
  };

  setCached(cacheKey, response);
  return response;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "GET") {
      throw new GitPetError("Method not allowed", 405);
    }

    const url = new URL(req.url);
    const parts = routeParts(req);
    const type = parseLeaderboardType(url.searchParams.get("type"));

    if (parts.length === 0) {
      const limit = parseLimit(url.searchParams.get("limit"));
      return ok(await topLeaderboard(type, limit));
    }

    if (parts[0] === "me" && parts.length === 1) {
      const user = await requireAuth(req);
      return ok(await myLeaderboard(user.id, type));
    }

    throw new GitPetError("Not found", 404);
  } catch (err) {
    return errorResponse(err);
  }
});
