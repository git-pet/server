import { getServiceClient } from "../_shared/db.ts";
import { errorResponse, GitPetError } from "../_shared/error.ts";
import { corsHeaders, ok } from "../_shared/response.ts";
import { requireAuth } from "../_shared/auth.ts";

type ProfileRow = {
  user_id: string;
  github_login: string;
  nickname: string;
  avatar_url: string | null;
};

type PetRow = {
  level: number;
  xp: number;
};

type UpdateBody = {
  nickname?: unknown;
  avatar_url?: unknown;
};

function routeParts(req: Request): string[] {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const functionIndex = parts.indexOf("user-profile");

  return functionIndex >= 0 ? parts.slice(functionIndex + 1) : parts.slice(1);
}

function profileResponse(profile: ProfileRow, pet: PetRow | null) {
  return {
    id: profile.user_id,
    github_login: profile.github_login,
    nickname: profile.nickname,
    avatar_url: profile.avatar_url,
    level: pet?.level ?? 1,
    exp: pet?.xp ?? 0,
  };
}

async function getProfile(userId: string) {
  const admin = getServiceClient();

  const { data: profile, error: profileError } = await admin
    .from("user_profiles")
    .select("user_id, github_login, nickname, avatar_url")
    .eq("user_id", userId)
    .single();

  if (profileError) {
    if (profileError.code === "PGRST116") {
      throw new GitPetError("Profile not found", 404);
    }

    throw new GitPetError(profileError.message, 500);
  }

  if (!profile) {
    throw new GitPetError("Profile not found", 404);
  }

  const { data: pet, error: petError } = await admin
    .from("pets")
    .select("level, xp")
    .eq("user_id", userId)
    .maybeSingle();

  if (petError) {
    throw new GitPetError(petError.message, 500);
  }

  return profileResponse(profile as ProfileRow, pet as PetRow | null);
}

function cleanNickname(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new GitPetError("nickname must be a string", 400);
  }

  const nickname = value.trim();
  if (nickname.length < 1 || nickname.length > 40) {
    throw new GitPetError("nickname must be 1-40 characters", 400);
  }

  return nickname;
}

function cleanAvatarUrl(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new GitPetError("avatar_url must be a string or null", 400);
  }

  const avatarUrl = value.trim();
  if (avatarUrl.length === 0) return null;
  if (avatarUrl.length > 2048) {
    throw new GitPetError("avatar_url is too long", 400);
  }

  try {
    const parsed = new URL(avatarUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("invalid protocol");
    }
  } catch {
    throw new GitPetError("avatar_url must be a valid URL", 400);
  }

  return avatarUrl;
}

async function updateMyProfile(userId: string, body: UpdateBody) {
  const nickname = cleanNickname(body.nickname);
  const avatarUrl = cleanAvatarUrl(body.avatar_url);
  const patch: { nickname?: string; avatar_url?: string | null } = {};

  if (nickname !== undefined) patch.nickname = nickname;
  if (avatarUrl !== undefined) patch.avatar_url = avatarUrl;

  if (Object.keys(patch).length === 0) {
    throw new GitPetError("No profile fields to update", 400);
  }

  const admin = getServiceClient();
  const { error: profileError } = await admin
    .from("user_profiles")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("user_id", userId);

  if (profileError) {
    throw new GitPetError(profileError.message, 500);
  }

  // public.users.username is the GitHub login used by sync/webhook flows, so
  // nickname updates intentionally stay in user_profiles only.
  const userPatch: { avatar_url?: string | null } = {};
  if (avatarUrl !== undefined) userPatch.avatar_url = avatarUrl;

  if (Object.keys(userPatch).length > 0) {
    const { error: userError } = await admin
      .from("users")
      .update({ ...userPatch, updated_at: new Date().toISOString() })
      .eq("id", userId);

    if (userError) {
      throw new GitPetError(userError.message, 500);
    }
  }

  return await getProfile(userId);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authUser = await requireAuth(req);
    const parts = routeParts(req);
    const resource = parts[0];

    if (req.method === "GET" && resource === "me") {
      return ok(await getProfile(authUser.id));
    }

    if (req.method === "GET" && resource && parts.length === 1) {
      return ok(await getProfile(resource));
    }

    if (req.method === "PUT" && resource === "me") {
      const body = await req.json().catch(() => {
        throw new GitPetError("Invalid JSON body", 400);
      });

      return ok(await updateMyProfile(authUser.id, body as UpdateBody));
    }

    if (req.method === "PUT") {
      throw new GitPetError("Only /user-profile/me can be updated", 403);
    }

    throw new GitPetError("Not found", 404);
  } catch (err) {
    return errorResponse(err);
  }
});
