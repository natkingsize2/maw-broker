import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridgeServer, type BridgeSecrets } from "../src/bridge-server";
import { startFinalEventServer } from "../src/final-event-server";
import { ACCEPTED_KIND, ALLOWED_ROUTE, CONTENT_EVENT_TYPE, CONTENT_SOURCE, FileFinalEventStore, SCHEMA, buildIdempotencyKey, computeContentDigest, type FinalEventSecrets, type LiveSiangFinalEventContent } from "../src/final-event-contract";

/**
 * Dry-run / fake-supervisor test backing `RUNBOOK-central-daemon-cutover-v1.md` (owner
 * directive 2026-08-14 05:11 +07: "a dry-run or fake-supervisor test"). `FakeSupervisor` models
 * launchd's single-instance-per-label semantics (refuses a duplicate `start()` of a running
 * label — mirrors Phase 1/2's "one bridge token owner" / "one final-event receiver" rules at the
 * SUPERVISOR layer, complementing the code-level `PersistentLease` enforcement tested
 * elsewhere). It drives REAL `bridge-server.ts`/`final-event-server.ts` instances (real
 * `Bun.serve`, real `fetch`) — nothing here is a real launchd job, a real Discord call, or a
 * real credential; the "fake" is load-bearing.
 */
class FakeSupervisor {
  private jobs = new Map<string, { stop(closeActiveConnections?: boolean): void }>();
  start(label: string, factory: () => { stop(closeActiveConnections?: boolean): void }): { stop(closeActiveConnections?: boolean): void } {
    if (this.jobs.has(label)) throw new Error(`fake supervisor: label "${label}" already running — refuse duplicate start`);
    const handle = factory();
    this.jobs.set(label, handle);
    return handle;
  }
  stop(label: string): void {
    const handle = this.jobs.get(label);
    if (!handle) return;
    handle.stop(true);
    this.jobs.delete(label);
  }
  isRunning(label: string): boolean { return this.jobs.has(label); }
  stopAll(): void { for (const label of [...this.jobs.keys()]) this.stop(label); }
}

const sup = new FakeSupervisor();
afterEach(() => sup.stopAll());

const BRIDGE_SECRETS: BridgeSecrets = { discordBotToken: "fake-never-sent-to-real-discord", localAuthToken: "fake-local-bridge-token" };
const RECEIPT_SECRETS: FinalEventSecrets = { authorizedToken: "fake-receipt-token" };
const fakeDiscordFetcher = async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({}) });

async function healthOf(port: number): Promise<{ ok: true; pid: number } | { ok: false }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    if (!res.ok) return { ok: false };
    const body = await res.json();
    return { ok: true, pid: body.pid };
  } catch { return { ok: false }; }
}

describe("FakeSupervisor — single-instance-per-label (Phase 1 / Phase 2 at the supervisor layer)", () => {
  test("refuses to double-start the bridge label", () => {
    sup.start("bridge", () => startBridgeServer({ port: 18901, secrets: BRIDGE_SECRETS, fetcher: fakeDiscordFetcher }));
    expect(() => sup.start("bridge", () => startBridgeServer({ port: 18902, secrets: BRIDGE_SECRETS, fetcher: fakeDiscordFetcher }))).toThrow('label "bridge" already running');
  });
  test("refuses to double-start the final-event label", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-cutover-fe-"));
    const store = () => new FileFinalEventStore(join(root, "store.json"));
    sup.start("final-event", () => startFinalEventServer({ port: 18903, store: store(), secrets: RECEIPT_SECRETS }));
    expect(() => sup.start("final-event", () => startFinalEventServer({ port: 18904, store: store(), secrets: RECEIPT_SECRETS }))).toThrow('label "final-event" already running');
  });
  test("a stopped label can be started again (this IS the cutover's stop-old/start-new step)", () => {
    sup.start("bridge", () => startBridgeServer({ port: 18905, secrets: BRIDGE_SECRETS, fetcher: fakeDiscordFetcher }));
    sup.stop("bridge");
    expect(sup.isRunning("bridge")).toBe(false);
    expect(() => sup.start("bridge", () => startBridgeServer({ port: 18906, secrets: BRIDGE_SECRETS, fetcher: fakeDiscordFetcher }))).not.toThrow();
  });
});

describe("Full cutover dry run — Phases 0-5 against real HTTP, fake supervisor, no real credential", () => {
  test("stop-old / start-new / durable-store-preserved / rollback, end to end", async () => {
    const BRIDGE_PORT = 18910;
    const RECEIPT_PORT = 18911;
    const root = mkdtempSync(join(tmpdir(), "maw-cutover-e2e-"));
    const storePath = join(root, "final-event-store.json");

    // ── Phase 0 (partial): preflight — nothing running yet
    expect(sup.isRunning("bridge")).toBe(false);
    expect(sup.isRunning("final-event")).toBe(false);
    expect((await healthOf(BRIDGE_PORT)).ok).toBe(false);
    expect((await healthOf(RECEIPT_PORT)).ok).toBe(false);

    // ── "OLD" daemons — models what's already running in production before this cutover
    sup.start("bridge", () => startBridgeServer({ port: BRIDGE_PORT, secrets: BRIDGE_SECRETS, fetcher: fakeDiscordFetcher }));
    sup.start("final-event", () => startFinalEventServer({ port: RECEIPT_PORT, store: new FileFinalEventStore(storePath), secrets: RECEIPT_SECRETS }));

    const bridgeHealthOld = await healthOf(BRIDGE_PORT);
    const receiptHealthOld = await healthOf(RECEIPT_PORT);
    expect(bridgeHealthOld.ok).toBe(true);
    expect(receiptHealthOld.ok).toBe(true);

    // OLD accepts one real final-event request — this is the pre-cutover durable state that
    // Phase 5 promises to preserve.
    const content: LiveSiangFinalEventContent = {
      conversation_id: "conv-cutover-1", event_id: "evt-cutover-1", event_type: CONTENT_EVENT_TYPE,
      final_text: "pre-cutover message", locale: "en-US", occurred_at: "2026-08-14T05:00:00.000Z",
      schema: SCHEMA, source: CONTENT_SOURCE, turn_id: "turn-cutover-1",
    };
    const contentDigest = computeContentDigest(content);
    const eventId = content.event_id;
    const idempotencyKey = buildIdempotencyKey(eventId);
    const request = { schema: SCHEMA, route: ALLOWED_ROUTE, kind: ACCEPTED_KIND, eventId, idempotencyKey, contentDigest, content };

    const acceptRes = await fetch(`http://127.0.0.1:${RECEIPT_PORT}/final-event`, {
      method: "POST", headers: { Authorization: `Bearer ${RECEIPT_SECRETS.authorizedToken}`, "Content-Type": "application/json" }, body: JSON.stringify(request),
    });
    expect(acceptRes.status).toBe(200);
    const acceptedReceipt = await acceptRes.json();
    expect(acceptedReceipt.status).toBe("accepted");

    // ── Phase 0 archive: snapshot the durable store bytes BEFORE cutover
    const storeBytesBeforeCutover = readFileSync(storePath, "utf8");

    // ── Phase 5 step 1: stop OLD
    sup.stop("bridge");
    sup.stop("final-event");
    expect(sup.isRunning("bridge")).toBe(false);
    expect(sup.isRunning("final-event")).toBe(false);
    // Real proof of a genuine stop, not just supervisor bookkeeping: the port actually refuses connections.
    expect((await healthOf(BRIDGE_PORT)).ok).toBe(false);
    expect((await healthOf(RECEIPT_PORT)).ok).toBe(false);

    // Durable store on disk is untouched by stopping the process that owned it.
    expect(readFileSync(storePath, "utf8")).toBe(storeBytesBeforeCutover);

    // ── Cutover: start NEW, same ports, SAME store path
    sup.start("bridge", () => startBridgeServer({ port: BRIDGE_PORT, secrets: BRIDGE_SECRETS, fetcher: fakeDiscordFetcher }));
    sup.start("final-event", () => startFinalEventServer({ port: RECEIPT_PORT, store: new FileFinalEventStore(storePath), secrets: RECEIPT_SECRETS }));

    const bridgeHealthNew = await healthOf(BRIDGE_PORT);
    const receiptHealthNew = await healthOf(RECEIPT_PORT);
    expect(bridgeHealthNew.ok).toBe(true);
    expect(receiptHealthNew.ok).toBe(true);

    // ── Phase 5 step 5: NEW resumes correctly — replaying the OLD request is a DUPLICATE, never a fresh accept
    const replayRes = await fetch(`http://127.0.0.1:${RECEIPT_PORT}/final-event`, {
      method: "POST", headers: { Authorization: `Bearer ${RECEIPT_SECRETS.authorizedToken}`, "Content-Type": "application/json" }, body: JSON.stringify(request),
    });
    expect(replayRes.status).toBe(200);
    const replayReceipt = await replayRes.json();
    expect(replayReceipt.status).toBe("duplicate");
    expect(replayReceipt.receivedAt).toBe(acceptedReceipt.receivedAt); // proves it's the ORIGINAL record, carried across the cutover

    // ── Simulated failure → ROLLBACK: stop NEW, verify store still intact, start OLD-shaped config again
    sup.stop("bridge");
    sup.stop("final-event");
    expect((await healthOf(RECEIPT_PORT)).ok).toBe(false);
    expect(readFileSync(storePath, "utf8")).toBe(storeBytesBeforeCutover); // still untouched — no accept/duplicate call writes a NEW record, only a first accept does

    sup.start("bridge", () => startBridgeServer({ port: BRIDGE_PORT, secrets: BRIDGE_SECRETS, fetcher: fakeDiscordFetcher }));
    sup.start("final-event", () => startFinalEventServer({ port: RECEIPT_PORT, store: new FileFinalEventStore(storePath), secrets: RECEIPT_SECRETS }));
    expect((await healthOf(BRIDGE_PORT)).ok).toBe(true);
    expect((await healthOf(RECEIPT_PORT)).ok).toBe(true);

    // Rollback is symmetric: a THIRD pass through the same idempotencyKey is STILL a duplicate
    // with the ORIGINAL receivedAt — state survived two full stop/start cycles, not just one.
    const afterRollbackRes = await fetch(`http://127.0.0.1:${RECEIPT_PORT}/final-event`, {
      method: "POST", headers: { Authorization: `Bearer ${RECEIPT_SECRETS.authorizedToken}`, "Content-Type": "application/json" }, body: JSON.stringify(request),
    });
    const afterRollbackReceipt = await afterRollbackRes.json();
    expect(afterRollbackReceipt.status).toBe("duplicate");
    expect(afterRollbackReceipt.receivedAt).toBe(acceptedReceipt.receivedAt);
  });
});
