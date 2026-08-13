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
