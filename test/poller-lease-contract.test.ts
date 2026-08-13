import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerRunner, DurableCursor } from "../src/runner";
import { Broker, NAT_USER_ID } from "../src/broker";
import { DurableStore } from "../src/store";
import { BrokerIngress } from "../src/ingress";
import { DiscordPollSource } from "../src/discord-source";
import { MirrorService, type StateSource } from "../src/mirror-launcher";
import { FileMirrorStateStore, type AgentState, type DigestSink } from "../src/state-mirror";

/**
 * CONTRACT (owner 2026-08-14): "Add persistent cross-process lease before any poller like
 * worker can start." Every poller-like worker in this codebase — anything that runs a loop
 * pulling from an external source on an interval — MUST acquire a `PersistentLease`
 * (`src/runner.ts`) as the first thing its constructor does, so a second instance targeting the
 * same root is refused before it can do any work, not after.
 *
 * This file proves the contract holds for BOTH currently-existing poller-like workers, and notes
 * the third (the MQTT poller) satisfies it trivially: it no longer has a constructible class at
 * all — see `src/project-poller.ts` and `test/project-poller.test.ts`.
 */
const route = { name: "r", transport: "discord-text" as const, destination: "thread-1", agent: "a" };
const key = Buffer.alloc(32, 3);

describe("poller-like worker #1 — BrokerRunner (command broker poll loop)", () => {
  test("a second BrokerRunner on the same cursor root is refused before it can poll", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-poller-lease-broker-"));
    const build = () => {
      const broker = new Broker(key, new Map([["thread-1", route]]), new DurableStore(join(root, "store")), NAT_USER_ID);
      return new BrokerRunner({
        source: new DiscordPollSource({ getMessages: async () => [] }, "thread-1"),
        ingress: new BrokerIngress(broker),
        cursor: new DurableCursor(join(root, "cursor.json")),
        key,
      });
    };
    const first = build();
    expect(() => build()).toThrow("runner lease already held");
    first.close();
    const third = build(); // lease released ⇒ acquirable again
    third.close();
  });
});

describe("poller-like worker #2 — MirrorService (state-mirror reconcile loop)", () => {
  test("a second MirrorService on the same lease root is refused before it can post (existing coverage, re-asserted as the contract)", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-poller-lease-mirror-"));
    const sink: DigestSink = { post: async () => ({ messageId: "1000000000000000001" }), edit: async () => {}, recover: async () => undefined };
    const source: StateSource = { collect: async () => [] as AgentState[] };
    const build = () => new MirrorService({ sink, store: new FileMirrorStateStore(join(root, "mirror.json")), source, leaseRoot: root, intervalMs: 1000, maxPolls: 1 });
    const first = build();
    expect(() => build()).toThrow("runner lease already held");
    first.close();
  });
});

describe("poller-like worker #3 — MQTT poller: satisfies the contract by not existing as a worker", () => {
  test("there is no constructible class to acquire a lease for — project-poller.ts exports only a rejection function", async () => {
    const mod = await import("../src/project-poller");
    // No class export at all — nothing here could be instantiated into a worker that skips a lease.
    expect(Object.keys(mod).sort()).toEqual(["MQTT_POLLER_REJECTED_REASON", "assertMqttPollerOutOfScope", "main"]);
    expect(typeof (mod as any).ProjectPoller).toBe("undefined");
    expect(typeof (mod as any).MosquittoPublisher).toBe("undefined");
  });
});
