import { getServiceClient } from "./db.ts";

export type NotificationType =
  | "level_up"
  | "achievement"
  | "friend_request"
  | "friend_accepted"
  | "room_visited"
  | "xp_gained";

export async function sendNotification(
  userId: string,
  type: NotificationType,
  payload: Record<string, unknown>,
): Promise<void> {
  const supabase = getServiceClient();

  const { error } = await supabase
    .from("notifications")
    .insert({ user_id: userId, type, payload });

  if (error) {
    console.warn("[send_notification] failed:", error.message);
  }
}
