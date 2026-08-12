export type RetryKind = "429" | "401" | "403" | "5xx";
export function retryDecision(status: number): { kind: RetryKind | "ok"; retry: boolean; hold: boolean; delayMs?: number } {
  if (status === 429) return { kind: "429", retry: true, hold: false, delayMs: 0 };
  if (status === 401) return { kind: "401", retry: false, hold: true };
  if (status === 403) return { kind: "403", retry: false, hold: true };
  if (status >= 500) return { kind: "5xx", retry: true, hold: true, delayMs: Math.min(60_000, 1000) };
  return { kind: "ok", retry: false, hold: false };
}
