/**
 * GitHub marker adapter — implements the GitHub half of `agent-event-ledger.ts`'s
 * `OutboundEmitter` (`emitGitHub`/`hasGitHub`). Discord's half is deliberately out of scope
 * (owner directive, C2 round 3: "GitHub marker adapter ONLY") — every test in this file uses a
 * dependency-injected fetcher, never a real GitHub call, never a real token.
 *
 * Mirrors `runner.ts`'s `DiscordRestClient.findMarkedMessage`/`postMessage` shape on purpose:
 * same author-filter-then-exact-marker-match lookup, same bounded pagination, same
 * fail-closed-on-ambiguity (>1 match throws rather than guessing which post is authoritative).
 * That symmetry is what let `agent-event-ledger.ts`'s `acceptValidated` treat both sinks the
 * same way (`found = await hasX(...); if (found !== true) await emitX(...)`) without needing to
 * know which sink it's talking to.
 */
import { lstatSync, readFileSync, statSync } from "node:fs";
import { retryAfterMs, retryDecision } from "./retry";
import type { OutboundEmitter } from "./agent-event-ledger";

type FetchResponse = { ok: boolean; status: number; headers: Headers; json(): Promise<unknown> };
type FetchLike = (url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }) => Promise<FetchResponse>;
type Sleep = (ms: number) => Promise<void>;
const wait: Sleep = async (ms) => { await new Promise<void>((resolve) => setTimeout(resolve, ms)); };

export type GitHubMarkerSecrets = { token: string };

/**
 * Same shape and same security checks as `loadBridgeSecrets` (bridge-server.ts): an optional
 * file path, refused if it is a symlink or not exactly mode 0600, env fallback otherwise. A
 * separate env var from the Discord bridge's own token — this is a different credential for a
 * different sink, and the two must never be able to satisfy each other by accident.
 */
export function loadGitHubMarkerSecrets(env: Record<string, string | undefined> = process.env): GitHubMarkerSecrets {
  try {
    let values: Record<string, string | undefined> = env;
    const path = env.MAW_AGENT_EVENT_GITHUB_SECRETS_FILE;
    if (path) {
      if (lstatSync(path).isSymbolicLink() || (statSync(path).mode & 0o777) !== 0o600) throw new Error();
      values = JSON.parse(readFileSync(path, "utf8"));
    }
    const token = values.MAW_AGENT_EVENT_GITHUB_TOKEN;
    if (typeof token !== "string" || !token) throw new Error();
    return { token };
  } catch {
    throw new Error("github marker adapter configuration invalid");
  }
}

/**
 * owner/repo#N — identical shape to `project-routes.ts`'s private `ISSUE_RE` (not exported
 * there, so duplicated here rather than reaching across a module boundary for a regex; the two
 * must be kept in sync by hand if either changes). "Exact repo/issue marker" starts here: this
 * parse is the gate that stops a loosely-matched reference from ever letting a lookup or a post
 * land on the wrong issue.
 */
const ISSUE_RE = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})#([1-9][0-9]{0,6})$/;
export function parseIssueRef(issueRef: string): { owner: string; repo: string; issueNumber: number } {
  const match = ISSUE_RE.exec(issueRef);
  if (!match) throw new Error("github marker adapter: issue reference invalid");
  return { owner: match[1]!, repo: match[2]!, issueNumber: Number(match[3]) };
}

export class GitHubRestClient {
  constructor(private readonly token: string, private readonly fetcher: FetchLike = fetch as FetchLike, private readonly sleep: Sleep = wait) {
    if (!token) throw new Error("github rest client configuration invalid");
  }
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...extra };
  }
  private selfId: number | undefined;
  /** The "authenticated bot actor" identity — every marker lookup filters comments down to
   *  this id before even looking at body text, exactly mirroring Discord's `getSelfId`. */
  private async getSelfId(): Promise<number> {
    if (this.selfId !== undefined) return this.selfId;
    for (let attempt = 0; ; attempt++) {
      let response: FetchResponse;
      try { response = await this.fetcher("https://api.github.com/user", { method: "GET", headers: this.headers() }); }
      catch { throw new Error("github REST request failed"); }
      if (response.ok) {
        const body = (await response.json()) as { id?: unknown };
        if (typeof body?.id !== "number") throw new Error("github REST response invalid");
        return (this.selfId = body.id);
      }
      const policy = retryDecision(response.status, attempt);
      if (!policy.retry) throw new Error("github REST request held");
      await this.sleep(response.status === 429 ? retryAfterMs(response.headers, attempt) : (policy.delayMs ?? retryAfterMs(response.headers, attempt)));
    }
  }
  /**
   * Find the single comment authored by THIS authenticated actor whose body contains `marker`
   * exactly. Author-filtering is the outsider-ignore gate: a comment from anyone else — even
   * one whose text happens to contain the marker — is never treated as evidence of a prior
   * post. Without it, an outsider could forge "already delivered" and suppress a real
   * notification (the same forged-marker hijack `findMarkedMessage`'s doc comment names for
   * Discord). Bounded pagination (`maxScan`, page by page) closes the same "keeps paging past
   * the first page forever" gap. `matches.length > 1` throws — fail-closed HOLD rather than
   * picking one and risking the wrong idempotency signal.
   */
  async findMarkedComment(issueRef: string, marker: string, maxScan = 200): Promise<{ commentId: number } | undefined> {
    const { owner, repo, issueNumber } = parseIssueRef(issueRef);
    const me = await this.getSelfId();
    const matches: number[] = [];
    const perPage = 100;
    for (let page = 1; (page - 1) * perPage < maxScan; page++) {
      const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments?per_page=${perPage}&page=${page}`;
      let response: FetchResponse;
      for (let attempt = 0; ; attempt++) {
        try { response = await this.fetcher(url, { method: "GET", headers: this.headers() }); }
        catch { throw new Error("github REST request failed"); }
        if (response.ok) break;
        const policy = retryDecision(response.status, attempt);
        if (!policy.retry) throw new Error("github REST request held");
        await this.sleep(response.status === 429 ? retryAfterMs(response.headers, attempt) : (policy.delayMs ?? retryAfterMs(response.headers, attempt)));
      }
      const rows = (await response.json()) as Array<{ id?: unknown; body?: unknown; user?: { id?: unknown } }>;
      if (!Array.isArray(rows)) throw new Error("github REST response invalid");
      if (rows.length === 0) break;
      for (const row of rows) {
        if (typeof row?.id === "number" && row.user?.id === me && typeof row.body === "string" && row.body.includes(marker)) matches.push(row.id);
      }
      if (matches.length > 1) throw new Error("ambiguous github marker comments");
      if (rows.length < perPage) break;
    }
    return matches.length === 1 ? { commentId: matches[0]! } : undefined;
  }
  /** POST a new comment; returns the created comment id. This is never called until the
   *  caller's own `hasGitHub`/`findMarkedComment` lookup has already said "not found" — the
   *  accept-then-drop invariant lives in `agent-event-ledger.ts`'s `acceptValidated`, not here;
   *  this method has no idempotency logic of its own, by design (single responsibility: post). */
  async postComment(issueRef: string, body: string): Promise<{ commentId: number }> {
    const { owner, repo, issueNumber } = parseIssueRef(issueRef);
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`;
    for (let attempt = 0; ; attempt++) {
      let response: FetchResponse;
      try { response = await this.fetcher(url, { method: "POST", headers: this.headers({ "Content-Type": "application/json" }), body: JSON.stringify({ body }) }); }
      catch { throw new Error("github REST request failed"); }
      if (response.ok) {
        const created = (await response.json()) as { id?: unknown };
        if (typeof created?.id !== "number") throw new Error("github REST response invalid");
        return { commentId: created.id };
      }
      const policy = retryDecision(response.status, attempt);
      if (!policy.retry) throw new Error("github REST request held");
      await this.sleep(response.status === 429 ? retryAfterMs(response.headers, attempt) : (policy.delayMs ?? retryAfterMs(response.headers, attempt)));
    }
  }
}

/**
 * Satisfies exactly the GitHub half of `OutboundEmitter`. Spread this into whatever composes
 * the real Discord+GitHub emitter for production wiring — that composition is out of scope
 * here (owner: "GitHub marker adapter ONLY"; Discord stays a fake in every test in this file).
 * The marker is embedded as an HTML comment (invisible on GitHub's rendered view, present
 * verbatim in the raw body `findMarkedComment` reads) so a human-facing comment never has a
 * raw idempotency key dangling in it, while the exact-substring lookup above still matches.
 */
export function githubMarkerEmitter(client: GitHubRestClient): Pick<OutboundEmitter, "emitGitHub" | "hasGitHub"> {
  return {
    async hasGitHub(issueRef, idempotencyKey) {
      return (await client.findMarkedComment(issueRef, idempotencyKey)) !== undefined;
    },
    async emitGitHub(issueRef, comment, idempotencyKey) {
      const body = idempotencyKey ? `${comment}\n\n<!-- ${idempotencyKey} -->` : comment;
      await client.postComment(issueRef, body);
    },
  };
}
