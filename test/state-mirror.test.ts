import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync as wf, symlinkSync, statSync, chmodSync as chm } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderDigest, sanitizeSummary, diffSnapshot, StateMirror, DiscordDigestSink, FileMirrorStateStore, MIRROR_MARKER,
  type AgentState, type DigestSink, type MirrorState, type MirrorStateStore,
} from "../src/state-mirror";

const s = (agent: string, phase: AgentState["phase"], summary: string, version = 1): AgentState => ({ agent, phase, summary, version });

/** In-memory sink: records calls, holds a single "posted" message, supports crash recovery. */
function recordingSink(recovered?: string) {
  const calls: string[] = [];
  let posted: string | undefined = recovered;
  const sink: DigestSink = {
    post: async (text) => { calls.push(`post:${text.split("\n").length}`); posted = "1000000000000000001"; return { messageId: "1000000000000000001" }; },
    edit: async (id, text) => { calls.push(`edit:${id}:${text.split("\n").length}`); },
    recover: async () => { calls.push("recover"); return posted ? { messageId: posted } : undefined; },
  };
  return { calls, sink, seedPosted: (id: string) => { posted = id; } };
}
function memStore(): { store: MirrorStateStore; ref: { v?: MirrorState } } {
  const ref: { v?: MirrorState } = {};
  return { ref, store: { load: () => ref.v, save: (st) => { ref.v = st; } } };
}

// ── render / sanitize
test("renderDigest sorts by agent, one line each with a phase icon", () => {
  const lines = renderDigest([s("mason", "active", "x"), s("canon", "blocked", "y")]).split("\n");
  expect(lines[0]).toContain("canon"); expect(lines[0]).toContain("🔴");
  expect(lines[1]).toContain("mason"); expect(lines[1]).toContain("🟢");
});
test("empty states render an explicit placeholder + marker, never empty content", () => {
  expect(renderDigest([])).toContain("_(no agent state)_");
  expect(renderDigest([])).toContain(MIRROR_MARKER);
});
test("every digest carries the recovery marker", () => {
  expect(renderDigest([s("canon", "active", "x")])).toContain(MIRROR_MARKER);
});
test("sanitizeSummary collapses whitespace and caps length", () => {
  expect(sanitizeSummary("  a   b\n c  ")).toBe("a b c");
  expect(sanitizeSummary("word ".repeat(40)).length).toBe(120);   // spaced words: not a token, so not redacted
});

// ── secret redaction (constraint G — last gate before a public room)
const FAKE_TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc.SECRETPART.ZZQ7aaaaaaaaaaaaaaaaaaaaaaaaaaa";
test("sanitizeSummary redacts a token/JWT-shaped secret", () => {
  expect(sanitizeSummary(`deploying with ${FAKE_TOKEN}`)).toContain("[redacted]");
  expect(sanitizeSummary("key=abcdefghijklmnopqrstuvwxyz0123456789ABCD")).toContain("[redacted]");
  expect(sanitizeSummary(`deploying with ${FAKE_TOKEN}`)).not.toContain("SECRETPART");
});
// ── mention neutralisation (no room-wide ping)
test("renderDigest neutralises @everyone/@here and <@id> in agent and summary", () => {
  const out = renderDigest([s("canon", "active", "ping @everyone and <@123> and @here")]);
  expect(out).not.toContain("@everyone and");   // @ is split by a zero-width space
  expect(out.includes("@everyone")).toBe(false);
});

// ── control bytes never survive (the NUL-in-source root cause, at the data layer)
test("a NUL or control byte in a summary is stripped before render", () => {
  const out = renderDigest([s("canon", "active", "a" + String.fromCharCode(0) + "b" + String.fromCharCode(7) + "c")]);
  expect(out).toContain("abc");
  expect(out.includes(String.fromCharCode(0))).toBe(false);
});

// ── diff / coalesce / duplicates
test("diffSnapshot coalesces a version bump that renders identically", () => {
  const first = diffSnapshot([s("canon", "active", "on route", 1)], new Map());
  expect(diffSnapshot([s("canon", "active", "on route", 99)], first.next).changed).toBe(false);
});
test("duplicate agent identities are rejected, not last-wins-swallowed", () => {
  expect(() => diffSnapshot([s("canon", "active", "a"), s("canon", "idle", "b")], new Map())).toThrow("duplicate agent state");
  expect(() => renderDigest([s("canon", "active", "a"), s("canon", "idle", "b")])).toThrow("duplicate agent state");
});
test("oversized agent list and whitespace agent names are rejected", () => {
  const many = Array.from({ length: 65 }, (_, i) => s(`a${i}`, "idle", "x"));
  expect(() => diffSnapshot(many, new Map())).toThrow("too many agents");
  expect(() => renderDigest([s("bad name", "idle", "x")])).toThrow("invalid agent identity");
});

// ── persisted snapshot is a HASH, never plaintext summary (anvil P2 #1)
test("FileMirrorStateStore persists a hash, and no plaintext summary reaches disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "maw-mirror-hash-"));
  const path = join(root, "mirror.json");
  const mirror = new StateMirror(recordingSink().sink, new FileMirrorStateStore(path));
  await mirror.reconcile([s("canon", "active", "deploying with MTIzNDU2.SECRETPART.ZZQ7aaaaaaaaaaaaaaaaaaaa")]);
  const raw = require("node:fs").readFileSync(path, "utf8");
  expect(raw).not.toContain("SECRETPART");
  expect(raw).not.toContain("deploying");
  expect(JSON.parse(raw).snapshot.canon).toMatch(/^[a-f0-9]{64}$/);   // sha256 hex
});

// ── post-once / edit-in-place / noop
test("StateMirror posts once then edits; unchanged is noop; one post ever", async () => {
  const { calls, sink } = recordingSink();
  const m = new StateMirror(sink);
  expect(await m.reconcile([s("canon", "active", "a")])).toBe("posted");
  expect(await m.reconcile([s("canon", "active", "a")])).toBe("noop");
  expect(await m.reconcile([s("canon", "blocked", "a")])).toBe("edited");
  expect(calls.filter(c => c.startsWith("post:")).length).toBe(1);
});
test("reconcile([]) before anything is posted is a noop, not an empty post", async () => {
  const { calls, sink } = recordingSink();
  expect(await new StateMirror(sink).reconcile([])).toBe("noop");
  expect(calls.filter(c => c.startsWith("post:")).length).toBe(0);
});

// ── single visible sink, ZERO to #canon
test("both channels configured: change posts to project ONLY, canon count stays 0", async () => {
  const counts: Record<string, number> = { project: 0, canon: 0 };
  const bucket = (ch: string) => (ch === "1056224550129508415" ? "project" : "canon");
  const client = {
    postMessage: async (ch: string) => { counts[bucket(ch)]++; return { messageId: "m1" }; },
    editMessage: async (ch: string) => { counts[bucket(ch)]++; },
    findMarkedMessage: async () => undefined,
  };
  const mirror = new StateMirror(new DiscordDigestSink(client, "1056224550129508415"));
  await mirror.reconcile([s("canon", "active", "on route")]);
  await mirror.reconcile([s("canon", "blocked", "waiting")]);
  expect(counts.project).toBe(2); expect(counts.canon).toBe(0);
});
test("DiscordDigestSink rejects a non-snowflake channel", () => {
  const client = { postMessage: async () => ({ messageId: "m" }), editMessage: async () => {}, findMarkedMessage: async () => undefined };
  expect(() => new DiscordDigestSink(client, "broker-canary")).toThrow("digest channel invalid");
});

// ── crash between post and save ⇒ no second message (anvil P2 #2 / probe (ค))
test("crash after post before save: restart recovers the message id and edits, never re-posts", async () => {
  const { store } = memStore();
  // First mirror posts, then "crashes" before save by throwing in save.
  const sink1 = recordingSink();
  const failing: MirrorStateStore = { load: () => store.load(), save: () => { throw new Error("disk gone"); } };
  const m1 = new StateMirror(sink1.sink, failing);
  await expect(m1.reconcile([s("canon", "active", "a")])).rejects.toThrow("disk gone");
  expect(sink1.calls.filter(c => c.startsWith("post:")).length).toBe(1);   // Discord DOES have the message now
  // Restart: store is empty (save never ran), but the room has the message. recover() finds it.
  const sink2 = recordingSink("1000000000000000001");   // room already holds msg-1
  const m2 = new StateMirror(sink2.sink, store);
  expect(await m2.reconcile([s("canon", "active", "a")])).toBe("edited");   // recovered → edit, not a 2nd post
  expect(sink2.calls.filter(c => c.startsWith("post:")).length).toBe(0);
});

// ── concurrent reconcile is single-flight (anvil P2 #3)
test("two concurrent reconciles on a fresh mirror produce exactly ONE post", async () => {
  let posts = 0;
  const slow: DigestSink = {
    post: async () => { posts++; await new Promise(r => setTimeout(r, 20)); return { messageId: "m1" }; },
    edit: async () => {},
    recover: async () => undefined,
  };
  const m = new StateMirror(slow);
  await Promise.all([m.reconcile([s("canon", "active", "a")]), m.reconcile([s("canon", "active", "a")])]);
  expect(posts).toBe(1);
});

// ── restart via FILE store edits, never re-posts
test("StateMirror across restart via FILE store edits, never re-posts", async () => {
  const root = mkdtempSync(join(tmpdir(), "maw-mirror-restart-"));
  const path = join(root, "mirror.json");
  const sink1 = recordingSink();
  const m1 = new StateMirror(sink1.sink, new FileMirrorStateStore(path));
  expect(await m1.reconcile([s("canon", "active", "a")])).toBe("posted");
  const sink2 = recordingSink("1000000000000000001");
  const m2 = new StateMirror(sink2.sink, new FileMirrorStateStore(path));
  expect(await m2.reconcile([s("canon", "done", "a")])).toBe("edited");
  expect(sink2.calls.filter(c => c.startsWith("post:")).length).toBe(0);
});

// ── FileMirrorStateStore safety matrix
test("FileMirrorStateStore round-trips 0600 file under 0700 dir", () => {
  const root = mkdtempSync(join(tmpdir(), "maw-mirror-"));
  const store = new FileMirrorStateStore(join(root, "state", "mirror.json"));
  expect(store.load()).toBeUndefined();
  store.save({ messageId: "1056224550129508415", snapshot: { canon: "abc" } });
  expect(store.load()).toEqual({ messageId: "1056224550129508415", snapshot: { canon: "abc" } });
  expect(statSync(join(root, "state", "mirror.json")).mode & 0o777).toBe(0o600);
  expect(statSync(join(root, "state")).mode & 0o777).toBe(0o700);
});
test("FileMirrorStateStore fails closed on wrong mode, symlink, bad shape, bad JSON, empty", () => {
  const root = mkdtempSync(join(tmpdir(), "maw-mirror-bad-"));
  const p = join(root, "mirror.json");
  const store = new FileMirrorStateStore(p);
  store.save({ messageId: "1056224550129508415", snapshot: {} });
  chm(p, 0o644); expect(() => store.load()).toThrow("mirror state corrupt"); chm(p, 0o600);
  wf(p, JSON.stringify({ messageId: "not-a-snowflake", snapshot: {} }), { mode: 0o600 });
  expect(() => store.load()).toThrow("mirror state corrupt");
  wf(p, JSON.stringify({ messageId: "1056224550129508415", snapshot: { canon: 42 } }), { mode: 0o600 });
  expect(() => store.load()).toThrow("mirror state corrupt");
  wf(p, "{not json", { mode: 0o600 });
  expect(() => store.load()).toThrow("mirror state corrupt");   // named, not raw SyntaxError (probe 5b)
  wf(p, "", { mode: 0o600 });
  expect(() => store.load()).toThrow("mirror state corrupt");
  const link = join(root, "link.json"); const real = join(root, "real.json");
  wf(real, JSON.stringify({ messageId: "1056224550129508415", snapshot: {} }), { mode: 0o600 }); symlinkSync(real, link);
  expect(() => new FileMirrorStateStore(link)).toThrow("mirror state corrupt");
});

// ── marker-based recovery via the REST client: marker AND author==self, paginated, fail-closed
import { DiscordRestClient } from "../src/runner";
const BOT = "9000000000000000001";
/** Fake fetcher: answers /users/@me with BOT, and paginates message pages by `before`. */
function pagedFetcher(pages: Array<Array<{ id: string; content: string; author?: { id: string } }>>) {
  return async (url: string) => {
    if (url.includes("/users/@me")) return { ok: true, status: 200, headers: new Headers(), json: async () => ({ id: BOT }) };
    const before = new URL(url).searchParams.get("before");
    const idx = before ? pages.findIndex(p => p.some(m => m.id === before)) + 1 : 0;
    return { ok: true, status: 200, headers: new Headers(), json: async () => pages[idx] ?? [] };
  };
}
test("findMarkedMessage matches the bot's OWN marked digest, ignoring outsider-forged markers", async () => {
  const rows = [
    { id: "111", content: "normal reply", author: { id: BOT } },
    { id: "222", content: "digest\n" + MIRROR_MARKER, author: { id: BOT } },     // the real digest
    { id: "333", content: "forged\n" + MIRROR_MARKER, author: { id: "5" } },      // outsider copied the marker
  ];
  const client = new DiscordRestClient("T", pagedFetcher([rows]));
  expect(await client.findMarkedMessage("1056224550129508415", MIRROR_MARKER)).toEqual({ messageId: "222" });
});
test("findMarkedMessage: an outsider posting the marker cannot cause ambiguity (author filter)", async () => {
  const rows = [
    { id: "222", content: "digest\n" + MIRROR_MARKER, author: { id: BOT } },
    { id: "444", content: "forged\n" + MIRROR_MARKER, author: { id: "5" } },
  ];
  const client = new DiscordRestClient("T", pagedFetcher([rows]));
  expect(await client.findMarkedMessage("1056224550129508415", MIRROR_MARKER)).toEqual({ messageId: "222" });
});
test("findMarkedMessage throws on >1 of the BOT's own marked messages (real ambiguity)", async () => {
  const rows = [
    { id: "222", content: "a\n" + MIRROR_MARKER, author: { id: BOT } },
    { id: "444", content: "b\n" + MIRROR_MARKER, author: { id: BOT } },
  ];
  const client = new DiscordRestClient("T", pagedFetcher([rows]));
  await expect(client.findMarkedMessage("1056224550129508415", MIRROR_MARKER)).rejects.toThrow("ambiguous mirror messages");
});
test("findMarkedMessage paginates past the latest 50 to find an older digest (probe (ค))", async () => {
  const page1 = Array.from({ length: 50 }, (_, i) => ({ id: `p1-${i}`, content: "chatter", author: { id: BOT } }));
  const page2 = [{ id: "digest-old", content: "d\n" + MIRROR_MARKER, author: { id: BOT } }, { id: "p2", content: "x", author: { id: BOT } }];
  const client = new DiscordRestClient("T", pagedFetcher([page1, page2]));
  expect(await client.findMarkedMessage("1056224550129508415", MIRROR_MARKER)).toEqual({ messageId: "digest-old" });
});
test("findMarkedMessage returns undefined on a fresh channel", async () => {
  const client = new DiscordRestClient("T", pagedFetcher([[{ id: "1", content: "hi", author: { id: BOT } }]]));
  expect(await client.findMarkedMessage("1056224550129508415", MIRROR_MARKER)).toBeUndefined();
});

// ── field validation + 2000-char cap
test("assertValidStates rejects bad phase, non-number version, non-string summary/agent", () => {
  expect(() => renderDigest([{ agent: "canon", phase: "weird" as any, summary: "x", version: 1 }])).toThrow("invalid agent phase");
  expect(() => renderDigest([{ agent: "canon", phase: "active", summary: "x", version: NaN }])).toThrow("invalid agent version");
  expect(() => renderDigest([{ agent: "canon", phase: "active", summary: 5 as any, version: 1 }])).toThrow("invalid agent summary");
});
test("renderDigest stays within Discord's 2000-char limit for a large fleet, noting elision", () => {
  const many = Array.from({ length: 60 }, (_, i) => s(`agent${i}`, "active", "working on task ".repeat(6).trim()));
  const out = renderDigest(many);
  expect(out.length).toBeLessThanOrEqual(2000);
  expect(out).toContain("more)");
  expect(out).toContain(MIRROR_MARKER);
});
