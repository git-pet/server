import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
// 핸들러 공통 컨텍스트
export interface HandlerContext {
  supabase: SupabaseClient;
  payload: GitHubPayload;
  deliveryId: string;
}
// GitHub 공통 페이로드 필드
export interface GitHubPayload {
  action?: string;
  sender: {
    id: number;
    login: string;
  };
  repository?: {
    id: number;
    full_name: string;
    default_branch?: string;
    owner?: { id?: number; login?: string };
  };
  // event-specific fields
  commits?: GitHubCommit[];
  ref?: string;
  pull_request?: GitHubPullRequest;
  issue?: GitHubIssue;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}
export interface GitHubCommit {
  id: string;
  message: string;
  author: { name: string; email: string };
}
export interface GitHubPullRequest {
  number: number;
  title: string;
  state: string;
  merged: boolean;
  merged_at: string | null;
  user: { id: number; login: string };
}
export interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  user: { id: number; login: string };
}
// XP 가중치는 env 기반 외부화 모듈에서 관리 (lib/xp-weights.ts)
export { XP_WEIGHTS } from "./lib/xp-weights.ts";
// 공통 응답 헬퍼
export function ok(message: string, data?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ ok: true, message, ...data }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
export function err(message: string, status = 500): Response {
  return new Response(
    JSON.stringify({ ok: false, error: message }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}
