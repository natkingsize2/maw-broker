export type RetryKind = "429" | "401" | "403" | "5xx";
export const MAX_RETRIES = 5;
export function retryDecision(status: number, attempt = 0): { kind: RetryKind | "ok"; retry: boolean; hold: boolean; delayMs?: number } {
  if (status === 429) return { kind: "429", retry: attempt < MAX_RETRIES, hold: attempt >= MAX_RETRIES, delayMs: Math.min(60_000, 1000*2**attempt) };
  if (status === 401) return { kind: "401", retry: false, hold: true };
  if (status === 403) return { kind: "403", retry: false, hold: true };
  if (status >= 500) return { kind: "5xx", retry: attempt < MAX_RETRIES, hold: true, delayMs: Math.min(60_000, 1000*2**attempt) };
  return { kind: "ok", retry: false, hold: false };
}
export function retryAfterMs(headers: Headers, attempt: number): number {
  const retryAfter=Number(headers.get("retry-after")); if(Number.isFinite(retryAfter)&&retryAfter>0) return Math.min(60_000,retryAfter*1000);
  return Math.min(60_000,1000*2**attempt);
}
