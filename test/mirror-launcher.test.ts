import { expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MirrorService, MIRROR_CHANNEL_ID, type StateSource } from "../src/mirror-launcher";
import { FileMirrorStateStore, type DigestSink, type AgentState } from "../src/state-mirror";

const s = (agent: string, phase: AgentState["phase"], summary: string): AgentState => ({ agent, phase, summary, version: 1 });

function recordingSink() {
  const calls: string[] = [];
  const sink: DigestSink = {
    post: async () => { calls.push("post"); return { messageId: "1000000000000000001" }; },
    edit: async () => { calls.push("edit"); },
    recover: async () => undefined,
  };
  return { calls, sink };
}
function fixedSource(states: AgentState[]): StateSource { return { collect: async () => states }; }

function svc(root: string, source: StateSource, sink: DigestSink) {
  return new MirrorService({ sink, store: new FileMirrorStateStore(join(root, "mirror.json")), source, leaseRoot: root, intervalMs: 1000, maxPolls: 1 });
}

// ── the single-writer guarantee, cross-process (anvil: per-instance single-flight is not enough)
test("a second MirrorService on the same lease root is refused before it can post", () => {
  const root = mkdtempSync(join(tmpdir(), "maw-mirror-lease-"));
  const first = svc(root, fixedSource([s("canon", "active", "x")]), recordingSink().sink);
  expect(() => svc(root, fixedSource([s("canon", "active", "x")]), recordingSink().sink)).toThrow("runner lease already held");
  first.close();
  // after release, a new service can take the lease
  const third = svc(root, fixedSource([s("canon", "active", "x")]), recordingSink().sink);
  expect(existsSync(join(root, "runner.lease"))).toBe(true);
  third.close();
});

test("tick collects then reconciles; a collect error holds without posting", async () => {
  const root = mkdtempSync(join(tmpdir(), "maw-mirror-tick-"));
  const { calls, sink } = recordingSink();
  const service = svc(root, { collect: async () => { throw new Error("argus down"); } }, sink);
  expect(await service.tick()).toBe("held");
  expect(calls.length).toBe(0);
  service.close();
});

test("tick posts once for a fresh state, then noop for the same state", async () => {
  const root = mkdtempSync(join(tmpdir(), "maw-mirror-tick2-"));
  const { calls, sink } = recordingSink();
  const service = new MirrorService({ sink, store: new FileMirrorStateStore(join(root, "mirror.json")), source: fixedSource([s("canon", "active", "x")]), leaseRoot: root, intervalMs: 1000, maxPolls: 5 });
  expect(await service.tick()).toBe("posted");
  expect(await service.tick()).toBe("noop");
  expect(calls.filter(c => c === "post").length).toBe(1);
  service.close();
});

test("MirrorService rejects a bad interval/poll configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "maw-mirror-cfg-"));
  expect(() => new MirrorService({ sink: recordingSink().sink, store: new FileMirrorStateStore(join(root, "m.json")), source: fixedSource([]), leaseRoot: root, intervalMs: 500, maxPolls: 1 })).toThrow("mirror service configuration invalid");
});

test("MIRROR_CHANNEL_ID is the pinned project room", () => {
  expect(MIRROR_CHANNEL_ID).toBe("1056224550129508415");
});

// ── M5 (probe P2): pin the channel-pin to the real config path, not just the value
import { assertMirrorConfig } from "../src/mirror-launcher";
const goodEnv = { MAW_MIRROR_STORE_ROOT: "/tmp/x", MAW_MIRROR_CHANNEL_ID: MIRROR_CHANNEL_ID, MIRROR_POLL_INTERVAL_MS: "10000", MIRROR_MAX_POLLS: "120" };
test("assertMirrorConfig accepts the pinned project channel", () => {
  expect(assertMirrorConfig(goodEnv)).toMatchObject({ channel: MIRROR_CHANNEL_ID, intervalMs: 10000, maxPolls: 120 });
});
test("assertMirrorConfig refuses a wrong channel on the real config path (M5 call-site pin)", () => {
  expect(() => assertMirrorConfig({ ...goodEnv, MAW_MIRROR_CHANNEL_ID: "9999999999999999999" })).toThrow("differs from production pin");
  expect(() => assertMirrorConfig({ ...goodEnv, MAW_MIRROR_CHANNEL_ID: undefined })).toThrow("differs from production pin");
});
test("assertMirrorConfig rejects missing store root and bad interval/poll", () => {
  expect(() => assertMirrorConfig({ ...goodEnv, MAW_MIRROR_STORE_ROOT: undefined })).toThrow("mirror service configuration invalid");
  expect(() => assertMirrorConfig({ ...goodEnv, MIRROR_POLL_INTERVAL_MS: "500" })).toThrow("mirror service configuration invalid");
});
