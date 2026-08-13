import { expect, test } from "bun:test";
import { renderDigest, sanitizeSummary, diffSnapshot, StateMirror, DiscordDigestSink, type AgentState, type DigestSink, type MirrorSnapshot } from "../src/state-mirror";

const s = (agent: string, phase: AgentState["phase"], summary: string, version = 1): AgentState => ({ agent, phase, summary, version });

// ── render: one deterministic line per agent, phase icon, sorted
test("renderDigest sorts by agent and shows one line each with a phase icon", () => {
  const out = renderDigest([s("mason", "active", "fixing primary_edge"), s("canon", "blocked", "waiting on anvil")]);
  const lines = out.split("\n");
  expect(lines.length).toBe(2);
  expect(lines[0]).toContain("canon");   // sorted before mason
  expect(lines[0]).toContain("🔴");
  expect(lines[1]).toContain("mason");
  expect(lines[1]).toContain("🟢");
});

// ── sanitize: summaries are labels, never payloads
test("sanitizeSummary collapses whitespace and caps length", () => {
  expect(sanitizeSummary("  a   b\n c  ")).toBe("a b c");
  const long = "x".repeat(200);
  expect(sanitizeSummary(long).length).toBe(118);
  expect(sanitizeSummary(long).endsWith("…")).toBe(true);
});

// ── diff/coalesce: identical fingerprints emit nothing even when version bumps
test("diffSnapshot coalesces a version bump that renders identically", () => {
  const first = diffSnapshot([s("canon", "active", "on route", 1)], new Map());
  expect(first.changed).toBe(true);
  const again = diffSnapshot([s("canon", "active", "on route", 99)], first.next);  // version up, same render
  expect(again.changed).toBe(false);
});
test("diffSnapshot detects a phase change, a summary change, and agent add/remove", () => {
  const base = diffSnapshot([s("canon", "active", "on route")], new Map()).next;
  expect(diffSnapshot([s("canon", "blocked", "on route")], base).changed).toBe(true);
  expect(diffSnapshot([s("canon", "active", "different")], base).changed).toBe(true);
  expect(diffSnapshot([s("canon", "active", "on route"), s("mason", "idle", "x")], base).changed).toBe(true);
  expect(diffSnapshot([], base).changed).toBe(true);
});

// ── mirror: post once, edit-in-place after, noop on no change
function recordingSink() {
  const calls: string[] = [];
  const sink: DigestSink = {
    post: async (text) => { calls.push(`post:${text.split("\n").length}`); return { messageId: "msg-1" }; },
    edit: async (id, text) => { calls.push(`edit:${id}:${text.split("\n").length}`); },
  };
  return { calls, sink };
}

test("StateMirror posts once then edits the same message; unchanged state is a noop", async () => {
  const { calls, sink } = recordingSink();
  const mirror = new StateMirror(sink);
  expect(await mirror.reconcile([s("canon", "active", "a")])).toBe("posted");
  expect(await mirror.reconcile([s("canon", "active", "a")])).toBe("noop");       // identical → no call
  expect(await mirror.reconcile([s("canon", "blocked", "a")])).toBe("edited");    // change → edit same msg
  expect(await mirror.reconcile([s("canon", "blocked", "a")], )).toBe("noop");
  expect(calls).toEqual(["post:1", "edit:msg-1:1"]);
});

test("StateMirror never posts a second message — one living digest, not a stream", async () => {
  const { calls, sink } = recordingSink();
  const mirror = new StateMirror(sink);
  await mirror.reconcile([s("a", "active", "1")]);
  await mirror.reconcile([s("a", "active", "2")]);
  await mirror.reconcile([s("a", "done", "3")]);
  expect(calls.filter(c => c.startsWith("post:")).length).toBe(1);
  expect(calls.filter(c => c.startsWith("edit:")).length).toBe(2);
});

// ── sink binds exactly one channel (single visible sink, anvil)
test("DiscordDigestSink routes post/edit to exactly the configured channel", async () => {
  const seen: string[] = [];
  const client = {
    postMessage: async (ch: string, text: string) => { seen.push(`post ${ch}`); return { messageId: "m1" }; },
    editMessage: async (ch: string, id: string, text: string) => { seen.push(`edit ${ch} ${id}`); },
  };
  const sink = new DiscordDigestSink(client, "1056224550129508415");
  await sink.post("x");
  await sink.edit("m1", "y");
  expect(seen).toEqual(["post 1056224550129508415", "edit 1056224550129508415 m1"]);
});

// ── digest carries no secrets: sanitize is applied on the render path
test("a summary with newlines/padding is flattened in the rendered digest", () => {
  const out = renderDigest([s("canon", "active", "line1\nline2   trailing")]);
  expect(out).not.toContain("\nline2");
  expect(out).toContain("line1 line2 trailing");
});

// ── anvil acceptance: EXACTLY ONE visible sink, ZERO to #canon, restart = no second message
import type { MirrorState, MirrorStateStore } from "../src/state-mirror";

test("both channels configured: a state change posts to project ONLY, canon count stays 0", async () => {
  const counts: Record<string, number> = { project: 0, canon: 0 };
  const client = {
    postMessage: async (ch: string) => { counts[ch === "1056224550129508415" ? "project" : "canon"]++; return { messageId: "m1" }; },
    editMessage: async (ch: string) => { counts[ch === "1056224550129508415" ? "project" : "canon"]++; },
  };
  // Only the project sink is wired — the canon channel client exists but the mirror never holds it.
  const mirror = new StateMirror(new DiscordDigestSink(client, "1056224550129508415"));
  await mirror.reconcile([s("canon", "active", "on route")]);
  await mirror.reconcile([s("canon", "blocked", "waiting")]);
  expect(counts.project).toBe(2);   // one post + one edit
  expect(counts.canon).toBe(0);     // never
});

function memStore(): { store: MirrorStateStore; ref: { v?: MirrorState } } {
  const ref: { v?: MirrorState } = {};
  return { ref, store: { load: () => ref.v, save: (st) => { ref.v = st; } } };
}

test("restart replay produces NO second visible message — persisted id routes to edit", async () => {
  const { calls, sink } = recordingSink();
  const { store } = memStore();
  const first = new StateMirror(sink, store);
  expect(await first.reconcile([s("canon", "active", "a")])).toBe("posted");
  // process dies and restarts: a brand-new mirror loads the persisted state
  const restarted = new StateMirror(sink, store);
  expect(await restarted.reconcile([s("canon", "active", "a")])).toBe("noop");        // identical → nothing
  expect(await restarted.reconcile([s("canon", "done", "a")])).toBe("edited");         // change → edit, not post
  expect(calls.filter(c => c.startsWith("post:")).length).toBe(1);                     // still exactly one post ever
});

test("restart with an identical state emits nothing at all (no post, no edit)", async () => {
  const { calls, sink } = recordingSink();
  const { store } = memStore();
  await new StateMirror(sink, store).reconcile([s("a", "active", "1")]);
  const after = calls.length;
  await new StateMirror(sink, store).reconcile([s("a", "active", "1")]);
  expect(calls.length).toBe(after);   // second process added nothing
});

// ── FileMirrorStateStore: 0600/dir-0700, symlink+shape fail-closed, atomic round-trip
import { FileMirrorStateStore } from "../src/state-mirror";
import { mkdtempSync, writeFileSync as wf, symlinkSync, statSync, chmodSync as chm } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("FileMirrorStateStore round-trips and writes 0600 file under a 0700 dir", () => {
  const root = mkdtempSync(join(tmpdir(), "maw-mirror-"));
  const store = new FileMirrorStateStore(join(root, "state", "mirror.json"));
  expect(store.load()).toBeUndefined();
  store.save({ messageId: "msg-9", snapshot: { canon: "canon active x" } });
  expect(store.load()).toEqual({ messageId: "msg-9", snapshot: { canon: "canon active x" } });
  expect(statSync(join(root, "state", "mirror.json")).mode & 0o777).toBe(0o600);
  expect(statSync(join(root, "state")).mode & 0o777).toBe(0o700);
});
test("FileMirrorStateStore rejects a wrong-mode file (tamper), fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "maw-mirror-mode-"));
  const store = new FileMirrorStateStore(join(root, "mirror.json"));
  store.save({ messageId: "m", snapshot: {} });
  chm(join(root, "mirror.json"), 0o644);
  expect(() => store.load()).toThrow("mirror state corrupt");
});
test("FileMirrorStateStore rejects a symlinked state file", () => {
  const root = mkdtempSync(join(tmpdir(), "maw-mirror-sym-"));
  const target = join(root, "real.json"); wf(target, JSON.stringify({ messageId: "m", snapshot: {} }), { mode: 0o600 });
  const link = join(root, "mirror.json"); symlinkSync(target, link);
  expect(() => new FileMirrorStateStore(link)).toThrow("mirror state corrupt");
});
test("FileMirrorStateStore rejects tampered shape (non-string fingerprint, missing id)", () => {
  const root = mkdtempSync(join(tmpdir(), "maw-mirror-shape-"));
  const p = join(root, "mirror.json");
  const store = new FileMirrorStateStore(p);
  wf(p, JSON.stringify({ messageId: "m", snapshot: { canon: 42 } }), { mode: 0o600 });
  expect(() => store.load()).toThrow("mirror state corrupt");
  wf(p, JSON.stringify({ snapshot: {} }), { mode: 0o600 });
  expect(() => store.load()).toThrow("mirror state corrupt");
});
test("StateMirror across restart via FILE store edits, never re-posts", async () => {
  const root = mkdtempSync(join(tmpdir(), "maw-mirror-restart-"));
  const path = join(root, "mirror.json");
  const { calls, sink } = recordingSink();
  const m1 = new StateMirror(sink, new FileMirrorStateStore(path));
  expect(await m1.reconcile([s("canon", "active", "a")])).toBe("posted");
  const m2 = new StateMirror(sink, new FileMirrorStateStore(path));   // restart: reload from disk
  expect(await m2.reconcile([s("canon", "done", "a")])).toBe("edited");
  expect(calls.filter(c => c.startsWith("post:")).length).toBe(1);
});
