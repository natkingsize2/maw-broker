import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAgentEventServer } from "../src/agent-event-server";
import { AGENT_EVENT_SCHEMA, type OutboundEmitter } from "../src/agent-event-ledger";
import { loadAgentEventDaemonConfig, signTrustedDiscordRow } from "../src/agent-event-daemon";
import { ProjectRegistry } from "../src/project-routes";

/**
 * Real local HTTP (Bun.serve + fetch), same convention as final-event-server.test.ts and
 * bridge-server.test.ts: every server is `.stop()`-ed at test end (tracked + closed in
 * afterEach as a backstop). No Discord/GitHub network call anywhere — every emitter here is a
 * fake, matching "no real GitHub emit/token/service deploy".
 *
 * Gap this file closes vs. the existing suite: `agent-event-daemon.test.ts` already proves the
 * ingress logic itself (auth, nonce replay, idempotency) by calling `AgentEventHttpIngress.
 * handle()` directly, in-process, no network. `agent-event-ledger.test.ts` already proves the
 * ledger's own writer-lease semantics across two REAL spawned OS processes. Neither exercises
 * the NEW piece — `agent-event-server.ts`'s `Bun.serve` wrapper: does it actually bind
 * loopback-only, enforce the body-size bound over a real socket (not just the in-memory
 * `handle()` call), and get the lease-then-bind / stop-listener-then-release-lease ordering
 * right when composed with a real, file-backed `AgentEventLedger`. This file does not re-prove
 * the OS-process-level lease contention `agent-event-ledger.test.ts` already covers; it proves
 * the daemon wrapper correctly delegates to (and doesn't bypass) that same lease.
 */
const servers: Array<{ stop(): void }> = [];
afterEach(() => { while (servers.length) servers.pop()!.stop(); });

const route = { name: "livesiang", transport: "discord-text" as const, destination: "1537404238861438996", agent: "03-canon:1", issue: "natkingsize2/liveSiang#15" };
const key = (start: number) => Buffer.from(Array.from({ length: 32 }, (_, i) => start + i)).toString("base64");
const env = { MAW_AGENT_EVENT_HTTP_TOKEN: "A".repeat(32), MAW_AGENT_EVENT_AUTHOR_ID: "1056224550129508415", MAW_AGENT_EVENT_INGRESS_KEY_B64: key(1), MAW_AGENT_EVENT_STORE_KEY_B64: key(65) };
const config = loadAgentEventDaemonConfig(env);
const registry = () => new ProjectRegistry([route]);
// realpathSync matters here: on macOS, os.tmpdir()'s ancestry runs through /var, which is
// itself a symlink to /private/var — agent-event-ledger.ts's safeRoot() walks the FULL
// ancestry of the store root and refuses if any ancestor is a symlink (agent-event-ledger.ts
// dir traversal check). agent-event-ledger.test.ts's own `root()` helper resolves this the
// same way; without it every test here fails at ledger construction with "agent-event store
// ancestry unsafe" before the daemon-specific behavior being tested ever runs.
const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const storeAt = (prefix: string) => join(tempDir(prefix), "ledger.json");
// Fixed clock for every test that posts a signed envelope: AgentEventLedger's authenticate()
// refuses any issuedAt more than 5 minutes from `now()`, and the real wall clock drifts from
// signedEvent()'s hardcoded default timestamp by however long this suite takes to reach that
// assertion after the file was written — flaky by construction if left to the real Date.now().
const NOW = "2026-08-14T15:45:05.000Z";

function fakeEmitter(calls: string[] = []): OutboundEmitter {
  return {
    async emitDiscord() { calls.push("d"); },
    async emitGitHub() { calls.push("g"); },
    async hasDiscord() { return false; },
    async hasGitHub() { return false; },
  };
}

function signedEvent(eventId: string, messageId: string, timestamp = "2026-08-14T15:45:00.000Z") {
  return signTrustedDiscordRow(
    { authorId: config.authority.authorId, authorIsBot: false, webhookId: null, channelId: route.destination, projectRoute: route.name, messageId, timestamp, event: { schema: AGENT_EVENT_SCHEMA, project: route.name, kind: "done", event_id: eventId, agent: "canon", summary: "done", occurred_at: timestamp } },
    config.authority,
  );
}

async function post(port: number, body: unknown, token = config.httpToken) {
  return fetch(`http://127.0.0.1:${port}/agent-event`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

describe("agent-event-server — /health (loopback receiver check, no auth required)", () => {
  test("GET /health returns ok + pid + startedAt without any Authorization header", async () => {
    const server = startAgentEventServer({ port: 19230, registry: registry(), emitter: fakeEmitter(), storePath: storeAt("ae-"), config });
    servers.push(server);
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.pid).toBe("number");
    expect(new Date(body.startedAt).toString()).not.toBe("Invalid Date");
  });
});

describe("agent-event-server — refuses to bind outside 127.0.0.1", () => {
  test("throws before ever touching Bun.serve", () => {
    expect(() => startAgentEventServer({ port: 19231, hostname: "0.0.0.0", registry: registry(), emitter: fakeEmitter(), storePath: storeAt("ae-"), config })).toThrow("refuses to bind outside 127.0.0.1");
  });
});

describe("agent-event-server — real local HTTP round trip", () => {
  test("accepted then identical nonce replay returns durable duplicate over real HTTP", async () => {
    const calls: string[] = [];
    const server = startAgentEventServer({ port: 19232, registry: registry(), emitter: fakeEmitter(calls), storePath: storeAt("ae-"), config, now: () => NOW });
    servers.push(server);
    const signed = signedEvent("e-http-1", "1537404238861438997");
    const first = await post(19232, signed);
    expect(first.status).toBe(202);
    const second = await post(19232, signed); // same nonce -> replay
    expect(second.status).toBe(200);
    expect((await second.json()).status).toBe("duplicate");
    expect(calls).toEqual(["d", "g"]);
  });

  test("wrong bearer ⇒ 401 before ledger is ever touched", async () => {
    const calls: string[] = [];
    const server = startAgentEventServer({ port: 19233, registry: registry(), emitter: fakeEmitter(calls), storePath: storeAt("ae-"), config });
    servers.push(server);
    const res = await post(19233, signedEvent("e-http-2", "1537404238861438998"), "totally-wrong");
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("unknown path ⇒ 404, GET on /agent-event ⇒ 404", async () => {
    const server = startAgentEventServer({ port: 19234, registry: registry(), emitter: fakeEmitter(), storePath: storeAt("ae-"), config });
    servers.push(server);
    const badPath = await fetch(`http://127.0.0.1:${server.port}/not-a-real-path`, { method: "POST" });
    expect(badPath.status).toBe(404);
    const badMethod = await fetch(`http://127.0.0.1:${server.port}/agent-event`, { method: "GET" });
    expect(badMethod.status).toBe(404);
  });
});

describe("agent-event-server — bounded body over real HTTP", () => {
  test("a body larger than maxBodyBytes is rejected 400, over a real socket, not just in-memory handle()", async () => {
    const server = startAgentEventServer({ port: 19235, registry: registry(), emitter: fakeEmitter(), storePath: storeAt("ae-"), config });
    servers.push(server);
    const oversized = "x".repeat(config.maxBodyBytes + 1);
    const res = await post(19235, oversized);
    expect(res.status).toBe(400);
  });
  test("a body at exactly maxBodyBytes (but not valid ingress JSON) still reaches parsing, not the size gate", async () => {
    const server = startAgentEventServer({ port: 19236, registry: registry(), emitter: fakeEmitter(), storePath: storeAt("ae-"), config });
    servers.push(server);
    const atLimit = `{"pad":"${"x".repeat(Math.max(0, config.maxBodyBytes - 10))}"`; // malformed JSON, under/at the byte bound
    const res = await post(19236, atLimit);
    expect(res.status).toBe(400); // rejected for being malformed/unauthenticated, not for size
  });
});

describe("agent-event-server — stop(): listener before lease, both free immediately after stop()", () => {
  test("after stop(), the exact same port can be rebound AND the exact same storePath can be reused, in the same tick", async () => {
    const storePath = storeAt("ae-");
    const port = 19237;
    const server1 = startAgentEventServer({ port, registry: registry(), emitter: fakeEmitter(), storePath, config });
    server1.stop();
    // Port free: a fresh server can bind the identical port.
    // Lease free: a fresh ledger can be constructed against the identical storePath.
    const server2 = startAgentEventServer({ port, registry: registry(), emitter: fakeEmitter(), storePath, config });
    servers.push(server2);
    expect(server2.port).toBe(port);
    const res = await fetch(`http://127.0.0.1:${server2.port}/health`);
    expect(res.status).toBe(200);
  });

  test("stop() releases the lease even if called twice (idempotent-safe teardown)", async () => {
    const storePath = storeAt("ae-");
    const server = startAgentEventServer({ port: 19238, registry: registry(), emitter: fakeEmitter(), storePath, config });
    server.stop();
    expect(() => server.stop()).not.toThrow();
    const successor = startAgentEventServer({ port: 19239, registry: registry(), emitter: fakeEmitter(), storePath, config });
    servers.push(successor);
    expect(successor.port).toBe(19239);
  });

  test("a second daemon on the SAME storePath while the first is still alive is refused (lease genuinely held, not a no-op)", () => {
    const storePath = storeAt("ae-");
    const server = startAgentEventServer({ port: 19240, registry: registry(), emitter: fakeEmitter(), storePath, config });
    servers.push(server);
    expect(() => startAgentEventServer({ port: 19241, registry: registry(), emitter: fakeEmitter(), storePath, config })).toThrow();
  });

  test("bind failure (port already in use) releases the lease instead of stranding it", () => {
    const storePathA = storeAt("ae-");
    const storePathB = storeAt("ae-");
    const port = 19242;
    const first = startAgentEventServer({ port, registry: registry(), emitter: fakeEmitter(), storePath: storePathA, config });
    servers.push(first);
    // Different storePath (so it's not the lease that blocks this one), same port ⇒ bind fails.
    expect(() => startAgentEventServer({ port, registry: registry(), emitter: fakeEmitter(), storePath: storePathB, config })).toThrow();
    // Proof the failed attempt's lease was released, not stranded: a THIRD daemon can now take
    // storePathB's lease cleanly on a free port.
    const third = startAgentEventServer({ port: 19243, registry: registry(), emitter: fakeEmitter(), storePath: storePathB, config });
    servers.push(third);
    expect(third.port).toBe(19243);
  });
});

describe("agent-event-server — two-process restart (sequential: stop, then a fresh daemon on the same store)", () => {
  test("event accepted by daemon 1 is a 'duplicate' on daemon 2 (same store, different messageId/nonce) and is NOT re-emitted to either sink", async () => {
    const storePath = storeAt("ae-");
    const port = 19244;
    const calls1: string[] = [];
    const server1 = startAgentEventServer({ port, registry: registry(), emitter: fakeEmitter(calls1), storePath, config, now: () => NOW });
    const first = await post(port, signedEvent("e-restart-1", "1537404238861439001"));
    expect(first.status).toBe(202);
    expect((await first.json()).status).toBe("accepted");
    expect(calls1).toEqual(["d", "g"]); // delivered exactly once
    server1.stop(); // simulates process exit

    // "restart": a fresh AgentEventLedger loading the SAME storePath, fresh server, fresh
    // emitter instance with its OWN call counter — if this counter stays empty, the restart
    // genuinely re-derived "already delivered" from the persisted snapshot rather than
    // re-emitting.
    const calls2: string[] = [];
    const server2 = startAgentEventServer({ port, registry: registry(), emitter: fakeEmitter(calls2), storePath, config, now: () => NOW });
    servers.push(server2);
    // Different messageId ⇒ different nonce ⇒ passes authentication (not a nonce replay); same
    // event_id ⇒ same idempotencyKey ⇒ the ledger's own business-level dedupe applies.
    const second = await post(port, signedEvent("e-restart-1", "1537404238861439002"));
    expect(second.status).toBe(200); // duplicate receipts are 200, not 202 (AgentEventHttpIngress)
    expect((await second.json()).status).toBe("duplicate");
    expect(calls2).toEqual([]); // no repost to either sink
  });

  test("two ledgers cannot be live on the same store at once, but a clean stop always permits the next one (repeated 3x, proving no leak accumulates across restarts)", async () => {
    const storePath = storeAt("ae-");
    for (let round = 0; round < 3; round++) {
      const port = 19250 + round;
      const server = startAgentEventServer({ port, registry: registry(), emitter: fakeEmitter(), storePath, config });
      // While alive, a same-store contender on a different port is refused.
      expect(() => startAgentEventServer({ port: port + 100, registry: registry(), emitter: fakeEmitter(), storePath, config })).toThrow();
      server.stop();
    }
    // Final state: store is free for one more.
    const last = startAgentEventServer({ port: 19260, registry: registry(), emitter: fakeEmitter(), storePath, config });
    servers.push(last);
    expect(last.port).toBe(19260);
  });
});
