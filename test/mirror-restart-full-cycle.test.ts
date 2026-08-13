import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MirrorService, type StateSource } from "../src/mirror-launcher";
import { FileMirrorStateStore, type DigestSink, type AgentState } from "../src/state-mirror";

/**
 * Gap this file closes vs the existing suite: `mirror-launcher.test.ts` proves a SECOND live
 * MirrorService is refused the lease, and `state-mirror.test.ts` proves a fresh StateMirror
 * (bare, no lease) resumes correctly from a FileMirrorStateStore. Neither proves the thing the
 * owner actually asked for — durable mirror idempotency ACROSS RESTART for the real production
 * entrypoint, i.e. lease release → process exit → new process → lease re-acquire → store resume,
 * all in one chain, end to end.
 */
const s = (agent: string, phase: AgentState["phase"], summary: string): AgentState => ({ agent, phase, summary, version: 1 });

function recordingSink() {
  const calls: string[] = [];
  const sink: DigestSink = {
    post: async () => { calls.push("post"); return { messageId: "1000000000000000001" }; },
    edit: async (id) => { calls.push(`edit:${id}`); },
    recover: async () => undefined,
  };
  return { calls, sink };
}
function fixedSource(states: AgentState[]): StateSource { return { collect: async () => states }; }

describe("mirror idempotency across a full restart cycle (lease + store + sink together)", () => {
  test("process 1 posts and holds the lease; process 2 cannot start while process 1 is still up (no double-writer window)", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-mirror-cycle-"));
    const sink1 = recordingSink();
    const svc1 = new MirrorService({ sink: sink1.sink, store: new FileMirrorStateStore(join(root, "mirror.json")), source: fixedSource([s("canon", "active", "working")]), leaseRoot: root, intervalMs: 1000, maxPolls: 1 });
    expect(await svc1.tick()).toBe("posted");

    // Attempted restart WHILE the old process is still alive and holding the lease — must refuse,
    // not silently start a second writer that could post a competing digest.
    expect(() => new MirrorService({ sink: recordingSink().sink, store: new FileMirrorStateStore(join(root, "mirror.json")), source: fixedSource([s("canon", "active", "working")]), leaseRoot: root, intervalMs: 1000, maxPolls: 1 })).toThrow("runner lease already held");

    svc1.close(); // graceful stop = lease release, exactly what a real restart does

    // process 2: fresh MirrorService instance (models a fresh OS process after restart), same
    // lease root, same store path. Lease must now be acquirable (proves release worked).
    const sink2 = recordingSink();
    const svc2 = new MirrorService({ sink: sink2.sink, store: new FileMirrorStateStore(join(root, "mirror.json")), source: fixedSource([s("canon", "active", "working")]), leaseRoot: root, intervalMs: 1000, maxPolls: 1 });
    // Same state as before the restart ⇒ must be a noop, never a second post.
    expect(await svc2.tick()).toBe("noop");
    expect(sink2.calls.filter(c => c === "post").length).toBe(0);
    svc2.close();
  });

  test("process 2 sees a real state change after restart ⇒ edits the SAME message id, never posts a second one", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-mirror-cycle2-"));
    const sink1 = recordingSink();
    const svc1 = new MirrorService({ sink: sink1.sink, store: new FileMirrorStateStore(join(root, "mirror.json")), source: fixedSource([s("canon", "active", "working")]), leaseRoot: root, intervalMs: 1000, maxPolls: 1 });
    expect(await svc1.tick()).toBe("posted");
    svc1.close();

    const persisted = JSON.parse(readFileSync(join(root, "mirror.json"), "utf8"));
    expect(persisted.messageId).toBe("1000000000000000001");

    const sink2 = recordingSink();
    const svc2 = new MirrorService({ sink: sink2.sink, store: new FileMirrorStateStore(join(root, "mirror.json")), source: fixedSource([s("canon", "done", "finished")]), leaseRoot: root, intervalMs: 1000, maxPolls: 1 });
    expect(await svc2.tick()).toBe("edited");
    expect(sink2.calls).toEqual([`edit:1000000000000000001`]);   // edits the id it inherited, not a fresh one
    expect(sink2.calls.filter(c => c === "post").length).toBe(0);
    svc2.close();
  });

  test("three consecutive restarts, alternating unchanged/changed state: exactly one post ever, rest are noop/edit", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-mirror-cycle3-"));
    const posts: number[] = [];
    const runOne = async (state: AgentState[]) => {
      const sink = recordingSink();
      const svc = new MirrorService({ sink: sink.sink, store: new FileMirrorStateStore(join(root, "mirror.json")), source: fixedSource(state), leaseRoot: root, intervalMs: 1000, maxPolls: 1 });
      const r = await svc.tick();
      posts.push(sink.calls.filter(c => c === "post").length);
      svc.close();
      return r;
    };
    expect(await runOne([s("canon", "active", "a")])).toBe("posted");
    expect(await runOne([s("canon", "active", "a")])).toBe("noop");
    expect(await runOne([s("canon", "blocked", "b")])).toBe("edited");
    expect(await runOne([s("canon", "blocked", "b")])).toBe("noop");
    expect(posts.reduce((a, b) => a + b, 0)).toBe(1);   // total posts across all 4 "process lifetimes"
  });
});
