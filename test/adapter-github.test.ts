import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubRestClient, githubMarkerEmitter, loadGitHubMarkerSecrets, parseIssueRef } from "../src/adapter-github";

// No real network call anywhere in this file — every GitHubRestClient is constructed with a
// fake, in-memory fetcher (owner constraint: "No real GitHub emit/token/service deploy").
type Comment = { id: number; body: string; user: { id: number } };
const noSleep = async () => {};

function ok(body: unknown, headers: Record<string, string> = {}) {
  return { ok: true, status: 200, headers: new Headers(headers), async json() { return body; } };
}
function fail(status: number, headers: Record<string, string> = {}) {
  return { ok: false, status, headers: new Headers(headers), async json() { return {}; } };
}

/** `pages[i]` is what page `i+1` of `GET .../comments` returns. `onPost`, if given, is called
 *  with the posted body and must return the created comment's id. */
function fakeGitHub(opts: { selfId: number; pages?: Comment[][]; onPost?: (body: string) => number }) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetcher = async (url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, body: init.body });
    if (url === "https://api.github.com/user") return ok({ id: opts.selfId });
    if (init.method === "GET" && url.includes("/comments")) {
      const page = Number(new URL(url).searchParams.get("page"));
      return ok(opts.pages?.[page - 1] ?? []);
    }
    if (init.method === "POST" && url.endsWith("/comments")) {
      const parsed = JSON.parse(init.body ?? "{}") as { body?: string };
      const id = opts.onPost ? opts.onPost(parsed.body ?? "") : 999;
      return ok({ id });
    }
    throw new Error(`fakeGitHub: unexpected request ${init.method} ${url}`);
  };
  return { fetcher, calls };
}

const ISSUE = "natkingsize2/maw-broker#1";
const BOT_ID = 12345;

describe("parseIssueRef — exact repo/issue marker parsing", () => {
  test("valid owner/repo#N parses to owner, repo, issueNumber", () => {
    expect(parseIssueRef("natkingsize2/maw-broker#42")).toEqual({ owner: "natkingsize2", repo: "maw-broker", issueNumber: 42 });
  });
  for (const bad of [
    "", "natkingsize2/maw-broker", "natkingsize2#1", "natkingsize2/maw-broker#0",
    "natkingsize2/maw-broker#01", "/maw-broker#1", "natkingsize2/#1",
    "natkingsize2/maw-broker/extra#1", "-natkingsize2/maw-broker#1",
    "natkingsize2 /maw-broker#1", "natkingsize2/maw-broker#1x", "natkingsize2/maw broker#1",
  ]) {
    test(`rejects malformed reference: ${JSON.stringify(bad)}`, () => {
      expect(() => parseIssueRef(bad)).toThrow("issue reference invalid");
    });
  }
});

describe("GitHubRestClient.findMarkedComment — authenticated bot actor + outsider ignore", () => {
  test("comment from the authenticated bot containing the marker is found", async () => {
    const { fetcher } = fakeGitHub({ selfId: BOT_ID, pages: [[{ id: 1, body: "hello\n<!-- marker-a -->", user: { id: BOT_ID } }]] });
    const client = new GitHubRestClient("t", fetcher, noSleep);
    await expect(client.findMarkedComment(ISSUE, "marker-a")).resolves.toEqual({ commentId: 1 });
  });

  test("outsider comment containing the exact marker text is ignored, not treated as found", async () => {
    const OUTSIDER_ID = 999;
    const { fetcher } = fakeGitHub({ selfId: BOT_ID, pages: [[{ id: 1, body: "forged <!-- marker-a -->", user: { id: OUTSIDER_ID } }]] });
    const client = new GitHubRestClient("t", fetcher, noSleep);
    await expect(client.findMarkedComment(ISSUE, "marker-a")).resolves.toBeUndefined();
  });

  test("bot comment present but marker text does not match is not found", async () => {
    const { fetcher } = fakeGitHub({ selfId: BOT_ID, pages: [[{ id: 1, body: "unrelated body", user: { id: BOT_ID } }]] });
    const client = new GitHubRestClient("t", fetcher, noSleep);
    await expect(client.findMarkedComment(ISSUE, "marker-a")).resolves.toBeUndefined();
  });

  test("no comments at all is not found, not a throw", async () => {
    const { fetcher } = fakeGitHub({ selfId: BOT_ID, pages: [[]] });
    const client = new GitHubRestClient("t", fetcher, noSleep);
    await expect(client.findMarkedComment(ISSUE, "marker-a")).resolves.toBeUndefined();
  });
});

describe("GitHubRestClient.findMarkedComment — ambiguity HOLD", () => {
  test("two bot comments both containing the same marker: throws ambiguous, does not guess", async () => {
    const { fetcher } = fakeGitHub({ selfId: BOT_ID, pages: [[
      { id: 1, body: "first\n<!-- marker-a -->", user: { id: BOT_ID } },
      { id: 2, body: "second\n<!-- marker-a -->", user: { id: BOT_ID } },
    ]] });
    const client = new GitHubRestClient("t", fetcher, noSleep);
    await expect(client.findMarkedComment(ISSUE, "marker-a")).rejects.toThrow("ambiguous github marker comments");
  });

  test("ambiguity is detected on page 1 before ever fetching page 2 (fails closed early, does not keep scanning)", async () => {
    const { fetcher, calls } = fakeGitHub({
      selfId: BOT_ID,
      pages: [
        [{ id: 1, body: "a\n<!-- marker-a -->", user: { id: BOT_ID } }, { id: 2, body: "b\n<!-- marker-a -->", user: { id: BOT_ID } }, ...Array.from({ length: 98 }, (_, i) => ({ id: 100 + i, body: "filler", user: { id: BOT_ID } }))],
        [{ id: 3, body: "c\n<!-- marker-a -->", user: { id: BOT_ID } }],
      ],
    });
    const client = new GitHubRestClient("t", fetcher, noSleep);
    await expect(client.findMarkedComment(ISSUE, "marker-a")).rejects.toThrow("ambiguous");
    expect(calls.filter((c) => c.url.includes("page=2")).length).toBe(0);
  });
});

describe("GitHubRestClient.findMarkedComment — pagination", () => {
  test("marker on page 2 (page 1 full at 100, no match) is found, and both pages were queried for the exact issue", async () => {
    const page1: Comment[] = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: "filler", user: { id: BOT_ID } }));
    const page2: Comment[] = [{ id: 200, body: "found\n<!-- marker-b -->", user: { id: BOT_ID } }];
    const { fetcher, calls } = fakeGitHub({ selfId: BOT_ID, pages: [page1, page2] });
    const client = new GitHubRestClient("t", fetcher, noSleep);
    await expect(client.findMarkedComment(ISSUE, "marker-b")).resolves.toEqual({ commentId: 200 });
    const commentCalls = calls.filter((c) => c.url.includes("/comments") && c.method === "GET");
    expect(commentCalls.length).toBe(2);
    for (const c of commentCalls) expect(c.url).toContain("/repos/natkingsize2/maw-broker/issues/1/comments");
    expect(commentCalls[0]!.url).toContain("page=1");
    expect(commentCalls[1]!.url).toContain("page=2");
  });

  test("maxScan full-page exhaustion HOLD rather than false absence", async () => {
    const page1: Comment[] = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: "filler", user: { id: BOT_ID } }));
    const page2: Comment[] = [{ id: 200, body: "found <!-- marker-c -->", user: { id: BOT_ID } }];
    const { fetcher, calls } = fakeGitHub({ selfId: BOT_ID, pages: [page1, page2] });
    const client = new GitHubRestClient("t", fetcher, noSleep);
    await expect(client.findMarkedComment(ISSUE, "marker-c", 100)).rejects.toThrow("pagination exhausted");
    expect(calls.filter((c) => c.url.includes("page=2")).length).toBe(0);
  });

  test("a short page (< 100 rows) stops pagination even under maxScan", async () => {
    const page1: Comment[] = [{ id: 1, body: "only one", user: { id: BOT_ID } }];
    const { fetcher, calls } = fakeGitHub({ selfId: BOT_ID, pages: [page1, [{ id: 2, body: "should never be reached <!-- marker-d -->", user: { id: BOT_ID } }]] });
    const client = new GitHubRestClient("t", fetcher, noSleep);
    await expect(client.findMarkedComment(ISSUE, "marker-d")).resolves.toBeUndefined();
    expect(calls.filter((c) => c.url.includes("page=2")).length).toBe(0);
  });
});

describe("GitHubRestClient — exact repo/issue targeting on both read and write", () => {
  test("findMarkedComment queries exactly the parsed owner/repo/issue, not a lookalike", async () => {
    const { fetcher, calls } = fakeGitHub({ selfId: BOT_ID, pages: [[]] });
    const client = new GitHubRestClient("t", fetcher, noSleep);
    await client.findMarkedComment("acme/widgets#7", "m");
    const call = calls.find((c) => c.url.includes("/comments"))!;
    expect(call.url).toContain("/repos/acme/widgets/issues/7/comments");
  });
  test("postComment posts to exactly the parsed owner/repo/issue", async () => {
    const { fetcher, calls } = fakeGitHub({ selfId: BOT_ID, onPost: () => 555 });
    const client = new GitHubRestClient("t", fetcher, noSleep);
    await client.postComment("acme/widgets#7", "hello");
    const call = calls.find((c) => c.method === "POST")!;
    expect(call.url).toBe("https://api.github.com/repos/acme/widgets/issues/7/comments");
  });
});

describe("GitHubRestClient.postComment", () => {
  test("returns the created comment id", async () => {
    const { fetcher } = fakeGitHub({ selfId: BOT_ID, onPost: () => 777 });
    const client = new GitHubRestClient("t", fetcher, noSleep);
    await expect(client.postComment(ISSUE, "hi")).resolves.toEqual({ commentId: 777 });
  });
  test("request carries Authorization: Bearer <token>", async () => {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetcher = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push({ headers: init.headers });
      if (url.endsWith("/comments")) return ok({ id: 1 });
      return ok({ id: BOT_ID });
    };
    const client = new GitHubRestClient("secret-token-xyz", fetcher as any, noSleep);
    await client.postComment(ISSUE, "hi");
    expect(calls[0]!.headers.Authorization).toBe("Bearer secret-token-xyz");
  });
});

describe("GitHubRestClient — retry policy on transient failures", () => {
  test("429 is retried and eventually succeeds", async () => {
    let attempts = 0;
    const fetcher = async (url: string, init: { method: string }) => {
      if (url === "https://api.github.com/user") return ok({ id: BOT_ID });
      if (url.endsWith("/comments") && init.method === "POST") {
        attempts++;
        if (attempts < 2) return fail(429, { "retry-after": "0" });
        return ok({ id: 42 });
      }
      throw new Error("unexpected");
    };
    const client = new GitHubRestClient("t", fetcher as any, noSleep);
    await expect(client.postComment(ISSUE, "hi")).resolves.toEqual({ commentId: 42 });
    expect(attempts).toBe(2);
  });
  test("401 is held, not retried", async () => {
    const fetcher = async () => fail(401);
    const client = new GitHubRestClient("t", fetcher as any, noSleep);
    await expect(client.postComment(ISSUE, "hi")).rejects.toThrow("github REST request held");
  });
});

describe("githubMarkerEmitter — accepted-then-drop lookup / no repost", () => {
  test("hasGitHub reports true after emitGitHub posted the same marker; the underlying comment is found by exact marker", async () => {
    const store: Comment[] = [];
    const { fetcher } = fakeGitHub({
      selfId: BOT_ID,
      pages: [store],
      onPost: (body) => { const id = store.length + 1; store.push({ id, body, user: { id: BOT_ID } }); return id; },
    });
    const client = new GitHubRestClient("t", fetcher, noSleep);
    const emitter = githubMarkerEmitter(client);

    await expect(emitter.hasGitHub!(ISSUE, "agent-event-v1:proj:evt:github")).resolves.toBe(false);
    await emitter.emitGitHub(ISSUE, "[done] canon @ proj: finished", "agent-event-v1:proj:evt:github");
    await expect(emitter.hasGitHub!(ISSUE, "agent-event-v1:proj:evt:github")).resolves.toBe(true);
  });

  test("simulated caller loop (hasGitHub-guarded emit, matching agent-event-ledger.ts's own pattern) posts exactly once across two calls", async () => {
    const store: Comment[] = [];
    let posts = 0;
    const { fetcher } = fakeGitHub({
      selfId: BOT_ID,
      pages: [store],
      onPost: (body) => { posts++; const id = store.length + 1; store.push({ id, body, user: { id: BOT_ID } }); return id; },
    });
    const client = new GitHubRestClient("t", fetcher, noSleep);
    const emitter = githubMarkerEmitter(client);
    const key = "agent-event-v1:proj:evt:github";

    // This is exactly agent-event-ledger.ts's acceptValidated loop body for the github sink:
    // `found = await hasGitHub(...); if (found !== true) await emitGitHub(...)`.
    for (let round = 0; round < 2; round++) {
      const found = await emitter.hasGitHub!(ISSUE, key);
      if (!found) await emitter.emitGitHub(ISSUE, "content", key);
    }
    expect(posts).toBe(1);
  });

  test("marker is embedded so an exact-substring lookup matches, without leaking the raw idempotency key as the visible comment text", async () => {
    const store: Comment[] = [];
    const { fetcher } = fakeGitHub({ selfId: BOT_ID, pages: [store], onPost: (body) => { store.push({ id: 1, body, user: { id: BOT_ID } }); return 1; } });
    const client = new GitHubRestClient("t", fetcher, noSleep);
    const emitter = githubMarkerEmitter(client);
    await emitter.emitGitHub(ISSUE, "[done] canon @ proj: finished", "agent-event-v1:proj:evt:github");
    expect(store[0]!.body.startsWith("[done] canon @ proj: finished")).toBe(true);
    expect(store[0]!.body).toContain("agent-event-v1:proj:evt:github");
  });
});

describe("loadGitHubMarkerSecrets — 0600/no-symlink secret file handling", () => {
  test("env-based token loads correctly", () => {
    expect(loadGitHubMarkerSecrets({ MAW_AGENT_EVENT_GITHUB_TOKEN: "gh-token-abc" })).toEqual({ token: "gh-token-abc" });
  });
  test("missing token is refused with the named configuration error", () => {
    expect(() => loadGitHubMarkerSecrets({})).toThrow("github marker adapter configuration invalid");
  });
  test("empty-string token is refused", () => {
    expect(() => loadGitHubMarkerSecrets({ MAW_AGENT_EVENT_GITHUB_TOKEN: "" })).toThrow("github marker adapter configuration invalid");
  });
  test("configuration error never leaks the supplied token", () => {
    const token = "TOKEN-MUST-NOT-LEAK";
    let threw: unknown;
    try { loadGitHubMarkerSecrets({ MAW_AGENT_EVENT_GITHUB_TOKEN: "" , MAW_AGENT_EVENT_GITHUB_SECRETS_FILE: undefined }); } catch (error) { threw = error; }
    expect(String(threw)).not.toContain(token);
  });
  test("symlinked secrets file is refused even when the target is well-formed and 0600", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-gh-secret-symlink-"));
    const real = join(root, "real-secrets.json"), link = join(root, "secrets.json");
    writeFileSync(real, JSON.stringify({ MAW_AGENT_EVENT_GITHUB_TOKEN: "t" }), { mode: 0o600 });
    symlinkSync(real, link);
    expect(() => loadGitHubMarkerSecrets({ MAW_AGENT_EVENT_GITHUB_SECRETS_FILE: link })).toThrow("github marker adapter configuration invalid");
  });
  test("world-readable (0644) secrets file is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-gh-secret-0644-"));
    const path = join(root, "secrets.json");
    writeFileSync(path, JSON.stringify({ MAW_AGENT_EVENT_GITHUB_TOKEN: "t" }), { mode: 0o644 });
    expect(() => loadGitHubMarkerSecrets({ MAW_AGENT_EVENT_GITHUB_SECRETS_FILE: path })).toThrow("github marker adapter configuration invalid");
  });
  test("group/other-writable (0620) secrets file is refused, not just world-readable", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-gh-secret-0620-"));
    const path = join(root, "secrets.json");
    writeFileSync(path, JSON.stringify({ MAW_AGENT_EVENT_GITHUB_TOKEN: "t" }), { mode: 0o600 });
    chmodSync(path, 0o620);
    expect(() => loadGitHubMarkerSecrets({ MAW_AGENT_EVENT_GITHUB_SECRETS_FILE: path })).toThrow("github marker adapter configuration invalid");
  });
  test("valid 0600 secrets file loads correctly", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "maw-gh-secret-good-")));
    const path = join(root, "secrets.json");
    writeFileSync(path, JSON.stringify({ MAW_AGENT_EVENT_GITHUB_TOKEN: "t-from-file" }), { mode: 0o600 });
    expect(loadGitHubMarkerSecrets({ MAW_AGENT_EVENT_GITHUB_SECRETS_FILE: path })).toEqual({ token: "t-from-file" });
  });
  test("secrets file with malformed JSON is refused with the named error, bytes never echoed", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-gh-secret-badjson-"));
    const path = join(root, "secrets.json");
    writeFileSync(path, "{not json at all", { mode: 0o600 });
    let threw: unknown;
    try { loadGitHubMarkerSecrets({ MAW_AGENT_EVENT_GITHUB_SECRETS_FILE: path }); } catch (error) { threw = error; }
    expect(String(threw)).toContain("github marker adapter configuration invalid");
    expect(String(threw)).not.toContain("not json at all");
  });
});
