import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFinalEventServer } from "../src/final-event-server";
import { ACCEPTED_KIND, ALLOWED_ROUTE, CONTENT_EVENT_TYPE, CONTENT_SOURCE, IDEMPOTENCY_KEY_PREFIX, SCHEMA, InMemoryFinalEventStore, FileFinalEventStore, computeContentDigest, type FinalEventSecrets, type LiveSiangFinalEventContent } from "../src/final-event-contract";

/** Real local HTTP (Bun.serve + fetch), fully in-memory store — no Discord, no bridge, no live
 *  config anywhere in this file, matching the owner's "local in-memory HTTP only" scope. Every
 *  server is `.stop()`-ed at test end (tracked + closed in afterEach as a backstop). */
const servers: Array<{ stop(): void }> = [];
afterEach(() => { while (servers.length) servers.pop()!.stop(); });

const SECRETS: FinalEventSecrets = { authorizedToken: "receipt-secret-xyz" };
const EVENT_ID = "evt-1";
const content: LiveSiangFinalEventContent = {
  conversation_id: "conv-1", event_id: EVENT_ID, event_type: CONTENT_EVENT_TYPE,
  final_text: "hello", locale: "en-US", occurred_at: "2026-08-14T01:50:00.000Z",
  schema: SCHEMA, source: CONTENT_SOURCE, turn_id: "turn-1",
};
const digest = computeContentDigest(content);
const IDEM_KEY = IDEMPOTENCY_KEY_PREFIX + EVENT_ID;
const goodBody = (overrides: Record<string, unknown> = {}) => ({ schema: SCHEMA, route: ALLOWED_ROUTE, kind: ACCEPTED_KIND, eventId: EVENT_ID, idempotencyKey: IDEM_KEY, contentDigest: digest, content, ...overrides });

async function post(port: number, body: unknown, token = SECRETS.authorizedToken) {
  return fetch(`http://127.0.0.1:${port}/final-event`, {
    method: "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("final-event-server — real local HTTP round trip", () => {
  test("accepted then duplicate over real HTTP, in-memory store", async () => {
    const port = 18811;
    const server = startFinalEventServer({ port, store: new InMemoryFinalEventStore(), secrets: SECRETS });
    servers.push(server);
    const first = await post(port, goodBody());
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(firstJson.status).toBe("accepted");

    const second = await post(port, goodBody());
    expect(second.status).toBe(200);
    const secondJson = await second.json();
    expect(secondJson.status).toBe("duplicate");
    expect(secondJson.receivedAt).toBe(firstJson.receivedAt);
  });

  test("conflict over real HTTP returns 409", async () => {
    const port = 18812;
    const server = startFinalEventServer({ port, store: new InMemoryFinalEventStore(), secrets: SECRETS });
    servers.push(server);
    await post(port, goodBody());
    const differentContent: LiveSiangFinalEventContent = { ...content, final_text: "DIFFERENT TEXT ENTIRELY" };
    const conflicting = await post(port, goodBody({ contentDigest: computeContentDigest(differentContent), content: differentContent }));
    expect(conflicting.status).toBe(409);
    const json = await conflicting.json();
    expect(json.error).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("missing auth ⇒ 401, wrong auth ⇒ 401", async () => {
    const port = 18813;
    const server = startFinalEventServer({ port, store: new InMemoryFinalEventStore(), secrets: SECRETS });
    servers.push(server);
    const missing = await post(port, goodBody(), "");
    expect(missing.status).toBe(401);
    const wrong = await post(port, goodBody(), "totally-wrong");
    expect(wrong.status).toBe(401);
  });

  test("wrong route ⇒ 400 UNKNOWN_ROUTE", async () => {
    const port = 18814;
    const server = startFinalEventServer({ port, store: new InMemoryFinalEventStore(), secrets: SECRETS });
    servers.push(server);
    const res = await post(port, goodBody({ route: "livesiang" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("UNKNOWN_ROUTE");
  });

  test("each rejected kind (raw_audio, partial, assistant_tts) ⇒ 400 KIND_REJECTED over real HTTP", async () => {
    const port = 18815;
    const server = startFinalEventServer({ port, store: new InMemoryFinalEventStore(), secrets: SECRETS });
    servers.push(server);
    for (const kind of ["raw_audio", "partial", "assistant_tts"]) {
      const res = await post(port, goodBody({ kind, idempotencyKey: `idem-${kind}` }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("KIND_REJECTED");
    }
  });

  test("malformed JSON body ⇒ 400", async () => {
    const port = 18816;
    const server = startFinalEventServer({ port, store: new InMemoryFinalEventStore(), secrets: SECRETS });
    servers.push(server);
    const res = await fetch(`http://127.0.0.1:${port}/final-event`, { method: "POST", headers: { Authorization: `Bearer ${SECRETS.authorizedToken}`, "Content-Type": "application/json" }, body: "{not json" });
    expect(res.status).toBe(400);
  });

  test("digest mismatch ⇒ 400 DIGEST_MISMATCH", async () => {
    const port = 18817;
    const server = startFinalEventServer({ port, store: new InMemoryFinalEventStore(), secrets: SECRETS });
    servers.push(server);
    const res = await post(port, goodBody({ contentDigest: computeContentDigest({ turnId: "different" }) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("DIGEST_MISMATCH");
  });

  test("unknown path ⇒ 404, GET method ⇒ 404", async () => {
    const port = 18818;
    const server = startFinalEventServer({ port, store: new InMemoryFinalEventStore(), secrets: SECRETS });
    servers.push(server);
    const badPath = await fetch(`http://127.0.0.1:${port}/not-a-real-path`, { method: "POST", headers: { Authorization: `Bearer ${SECRETS.authorizedToken}` }, body: "{}" });
    expect(badPath.status).toBe(404);
    const badMethod = await fetch(`http://127.0.0.1:${port}/final-event`, { method: "GET" });
    expect(badMethod.status).toBe(404);
  });

  test("refuses to bind outside 127.0.0.1", () => {
    expect(() => startFinalEventServer({ port: 18819, hostname: "0.0.0.0", store: new InMemoryFinalEventStore(), secrets: SECRETS })).toThrow("refuses to bind outside 127.0.0.1");
  });
});

describe("final-event-server + FileFinalEventStore — durable across a real restart, over real HTTP", () => {
  test("accepted event survives a server restart: second server (same store path) returns duplicate, not a re-accept", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-final-event-store-"));
    const storePath = join(root, "final-event-store.json");

    const port = 18820;
    const server1 = startFinalEventServer({ port, store: new FileFinalEventStore(storePath), secrets: SECRETS });
    const first = await post(port, goodBody());
    expect((await first.json()).status).toBe("accepted");
    server1.stop(); // simulates process exit

    // "restart": a fresh FileFinalEventStore instance loading the SAME path, fresh server.
    const server2 = startFinalEventServer({ port, store: new FileFinalEventStore(storePath), secrets: SECRETS });
    servers.push(server2);
    const second = await post(port, goodBody());
    expect((await second.json()).status).toBe("duplicate");
  });

  test("FileFinalEventStore fails closed on wrong mode / symlink / corrupt JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-final-event-badstore-"));
    const path = join(root, "store.json");
    writeFileSync(path, "{}", { mode: 0o644 });
    expect(() => new FileFinalEventStore(path)).toThrow("final-event store corrupt");

    const root2 = mkdtempSync(join(tmpdir(), "maw-final-event-badstore2-"));
    const real = join(root2, "real.json"), link = join(root2, "store.json");
    writeFileSync(real, "{}", { mode: 0o600 });
    symlinkSync(real, link);
    expect(() => new FileFinalEventStore(link)).toThrow("final-event store corrupt");

    const root3 = mkdtempSync(join(tmpdir(), "maw-final-event-badstore3-"));
    const path3 = join(root3, "store.json");
    writeFileSync(path3, "{not json", { mode: 0o600 });
    expect(() => new FileFinalEventStore(path3)).toThrow("final-event store corrupt");
  });

  test("FileFinalEventStore round-trips a record with correct 0700/0600 perms", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-final-event-goodstore-"));
    const path = join(root, "sub", "store.json");
    const store = new FileFinalEventStore(path);
    expect(store.lookup("k1")).toBeUndefined();
    store.record("k1", { contentDigest: digest, receipt: { status: "accepted", schema: SCHEMA, route: ALLOWED_ROUTE, eventId: "e1", idempotencyKey: "k1", contentDigest: digest, receivedAt: "2026-08-14T00:00:00.000Z" } });
    const reloaded = new FileFinalEventStore(path);
    expect(reloaded.lookup("k1")?.contentDigest).toBe(digest);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.k1.contentDigest).toBe(digest);
  });
});
