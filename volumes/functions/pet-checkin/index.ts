import { requireAuth } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/db.ts";
import { errorResponse, GitPetError } from "../_shared/error.ts";
import { corsHeaders, ok } from "../_shared/response.ts";

type CheckinRow = {
  id: string;
  user_id: string;
  checkin_date: string;
  streak_count: number;
  exp_awarded: number;
  created_at: string;
};

type AddPetExpResult = {
  inserted?: boolean;
  activity_id?: string;
  level?: number | null;
  exp?: number | null;
  leveled_up?: boolean;
  evolved?: boolean;
  new_level?: number | null;
  new_stage?: string | null;
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function routeParts(req: Request): string[] {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const functionIndex = parts.indexOf("pet-checkin");

  return functionIndex >= 0 ? parts.slice(functionIndex + 1) : parts.slice(1);
}

function kstDateString(now = new Date()): string {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  return new Date(date.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function rewardForStreak(streak: number): number {
  if (streak >= 30) return 200;
  if (streak >= 7) return 50;
  if (streak >= 3) return 15;
  return 5;
}

function nextReward(streak: number) {
  if (streak < 3) return { streak_count: 3, exp: 15 };
  if (streak < 7) return { streak_count: 7, exp: 50 };
  if (streak < 30) return { streak_count: 30, exp: 200 };
  return { streak_count: streak + 1, exp: 200 };
}

async function latestCheckin(userId: string): Promise<CheckinRow | null> {
  const admin = getServiceClient();
  const { data, error } = await admin
    .from("pet_checkins")
    .select("id, user_id, checkin_date, streak_count, exp_awarded, created_at")
    .eq("user_id", userId)
    .order("checkin_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new GitPetError(error.message, 500);
  }

  return data as CheckinRow | null;
}

async function todayCheckin(
  userId: string,
  today: string,
): Promise<CheckinRow | null> {
  const admin = getServiceClient();
  const { data, error } = await admin
    .from("pet_checkins")
    .select("id, user_id, checkin_date, streak_count, exp_awarded, created_at")
    .eq("user_id", userId)
    .eq("checkin_date", today)
    .maybeSingle();

  if (error) {
    throw new GitPetError(error.message, 500);
  }

  return data as CheckinRow | null;
}

function streakAfterCheckin(
  previous: CheckinRow | null,
  today: string,
): number {
  if (!previous) return 1;
  if (previous.checkin_date === today) return previous.streak_count;

  return previous.checkin_date === addDays(today, -1)
    ? previous.streak_count + 1
    : 1;
}

async function performCheckin(userId: string) {
  const admin = getServiceClient();
  const today = kstDateString();
  const existing = await todayCheckin(userId, today);

  if (existing) {
    return {
      checked_in: false,
      already_checked_in: true,
      checkin_date: today,
      streak_count: existing.streak_count,
      exp_awarded: 0,
      next_reward: nextReward(existing.streak_count),
    };
  }

  const previous = await latestCheckin(userId);
  const streak = streakAfterCheckin(previous, today);
  const exp = rewardForStreak(streak);
  const dedupeKey = `pet-checkin:${userId}:${today}`;

  const { data: xpData, error: xpError } = await admin.rpc("add_pet_exp", {
    p_user_id: userId,
    p_exp: exp,
    p_event_type: "checkin",
    p_github_event_id: dedupeKey,
    p_metadata: {
      source: "pet-checkin",
      checkin_date: today,
      streak_count: streak,
      reward_exp: exp,
      timezone: "Asia/Seoul",
    },
  });

  if (xpError) {
    throw new GitPetError(xpError.message, 500);
  }

  const xpResult = xpData as AddPetExpResult | null;

  const { data: checkin, error: insertError } = await admin
    .from("pet_checkins")
    .insert({
      user_id: userId,
      checkin_date: today,
      streak_count: streak,
      exp_awarded: xpResult?.inserted === false ? 0 : exp,
      activity_id: xpResult?.activity_id ?? null,
    })
    .select("id, user_id, checkin_date, streak_count, exp_awarded, created_at")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      const duplicate = await todayCheckin(userId, today);
      return {
        checked_in: false,
        already_checked_in: true,
        checkin_date: today,
        streak_count: duplicate?.streak_count ?? streak,
        exp_awarded: 0,
        next_reward: nextReward(duplicate?.streak_count ?? streak),
      };
    }

    throw new GitPetError(insertError.message, 500);
  }

  return {
    checked_in: true,
    already_checked_in: false,
    checkin_date: today,
    streak_count: (checkin as CheckinRow).streak_count,
    exp_awarded: (checkin as CheckinRow).exp_awarded,
    next_reward: nextReward((checkin as CheckinRow).streak_count),
    pet: {
      level: xpResult?.level ?? xpResult?.new_level ?? null,
      exp: xpResult?.exp ?? null,
      leveled_up: xpResult?.leveled_up === true,
      evolved: xpResult?.evolved === true,
      new_level: xpResult?.new_level ?? null,
      new_stage: xpResult?.new_stage ?? null,
    },
  };
}

async function getStreak(userId: string) {
  const today = kstDateString();
  const latest = await latestCheckin(userId);

  if (!latest) {
    return {
      checkin_date: today,
      checked_in_today: false,
      streak_count: 0,
      next_reward: nextReward(0),
    };
  }

  const checkedInToday = latest.checkin_date === today;
  const stillActive = checkedInToday ||
    latest.checkin_date === addDays(today, -1);
  const streak = stillActive ? latest.streak_count : 0;

  return {
    checkin_date: today,
    checked_in_today: checkedInToday,
    streak_count: streak,
    last_checkin_date: latest.checkin_date,
    next_reward: nextReward(streak),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const user = await requireAuth(req);
    const parts = routeParts(req);

    if (req.method === "POST" && parts.length === 0) {
      return ok(await performCheckin(user.id));
    }

    if (req.method === "GET" && parts[0] === "streak" && parts.length === 1) {
      return ok(await getStreak(user.id));
    }

    if (!["GET", "POST"].includes(req.method)) {
      throw new GitPetError("Method not allowed", 405);
    }

    throw new GitPetError("Not found", 404);
  } catch (err) {
    return errorResponse(err);
  }
});
