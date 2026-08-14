import { describe, expect, test, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFinalEventServer } from "../src/final-event-server";
import { InMemoryFinalEventStore, type FinalEventSecrets } from "../src/final-event-contract";
import { assertDistinctLeaseRoots, runCutoverPreflight } from "../src/cutover-preflight";

/** Closes the two non-secret real-cutover blockers (owner 2026-08-14 11:39):
 *  (1) final-event receiver lease gap — now fail-closed at construction;
 *  (2) executable preflight rejecting lingering mqtt fields in routes config. */
const servers: Array<{ stop(): void }> = [];
afterEach(() => { while (servers.length) servers.pop()!.stop(); });
const SECRETS: FinalEventSecrets = { authorizedToken: "t" };

describe("final-event receiver lease (blocker 3 closed)", () => {
  test("second receiver on the SAME lease root is refused at construction — even on a different port", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-fe-lease-"));
    const first = startFinalEventServer({ port: 18941, store: new InMemoryFinalEventStore(), secrets: SECRETS, leaseRoot: root });
    servers.push(first);
    expect(() => startFinalEventServer({ port: 18942, store: new InMemoryFinalEventStore(), secrets: SECRETS, leaseRoot: root })).toThrow("runner lease already held");
  });
  test("stop() releases the lease — a successor can then acquire the same root", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-fe-lease2-"));
    const first = startFinalEventServer({ port: 18943, store: new InMemoryFinalEventStore(), secrets: SECRETS, leaseRoot: root });
    first.stop(true);
    const second = startFinalEventServer({ port: 18944, store: new InMemoryFinalEventStore(), secrets: SECRETS, leaseRoot: root });
    servers.push(second);
    expect(second.port).toBe(18944);
  });
  test("lease-holding server still serves /health (wrapper preserves HTTP behavior)", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-fe-lease3-"));
    const server = startFinalEventServer({ port: 18945, store: new InMemoryFinalEventStore(), secrets: SECRETS, leaseRoot: root });
    servers.push(server);
    const res = await fetch("http://127.0.0.1:18945/health");
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });
});

describe("cutover preflight (blocker 1 made executable)", () => {
  const write = (body: unknown, mode = 0o600) => {
    const p = join(mkdtempSync(join(tmpdir(), "maw-preflight-")), "project-routes.json");
    writeFileSync(p, JSON.stringify(body)); chmodSync(p, mode); return p;
  };
  const CLEAN = [{ name: "maw-pipecat", transport: "discord-text", destination: "1537405946379243600", agent: "mba:02-anvil", issue: "natkingsize2/liveSiang#95" }];

  test("clean config → exit 0, reports the denominator (read N routes)", () => {
    const r = runCutoverPreflight(write(CLEAN));
    expect(r.code).toBe(0);
    expect(r.message).toContain("read 1 routes");
    expect(r.message).toContain("maw-pipecat");
  });
  test("lingering mqtt field → exit 1 with the loader's own named rejection", () => {
    const r = runCutoverPreflight(write([{ ...CLEAN[0], mqtt: "canon" }]));
    expect(r.code).toBe(1);
    expect(r.message).toContain("mqtt field rejected");
  });
  test("missing file → exit 2, distinct from invalid", () => {
    const r = runCutoverPreflight("/nonexistent/project-routes.json");
    expect(r.code).toBe(2);
    expect(r.message).toContain("missing");
  });
  test("wrong mode (0644) → exit 1 (loader's own perms guard fires through the preflight)", () => {
    const r = runCutoverPreflight(write(CLEAN, 0o644));
    expect(r.code).toBe(1);
  });
});

describe("review r1 — lease lifecycle edges", () => {
  test("bind failure (port already in use) releases the lease — immediate reacquire succeeds", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-fe-bindfail-"));
    const occupant = startFinalEventServer({ port: 18951, store: new InMemoryFinalEventStore(), secrets: SECRETS, leaseRoot: mkdtempSync(join(tmpdir(), "maw-fe-occ-")) });
    servers.push(occupant);
    // Same PORT as the occupant, fresh root: Bun.serve must throw, and the lease
    // taken moments earlier must NOT be left behind.
    expect(() => startFinalEventServer({ port: 18951, store: new InMemoryFinalEventStore(), secrets: SECRETS, leaseRoot: root })).toThrow();
    // Negative immediate reacquire: works right away, no stale-heartbeat wait.
    const survivor = startFinalEventServer({ port: 18952, store: new InMemoryFinalEventStore(), secrets: SECRETS, leaseRoot: root });
    servers.push(survivor);
    expect(survivor.port).toBe(18952);
  });

  test("stop() ordering: SAME port + SAME lease root restart succeeds immediately (listener stopped before lease released)", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-fe-order-"));
    const first = startFinalEventServer({ port: 18953, store: new InMemoryFinalEventStore(), secrets: SECRETS, leaseRoot: root });
    first.stop(true);
    // If the lease were released BEFORE the listener stopped, this successor could
    // acquire the lease while the old socket still holds the port — the bind here
    // would then fail. Passing on the same port proves the ordering.
    const second = startFinalEventServer({ port: 18953, store: new InMemoryFinalEventStore(), secrets: SECRETS, leaseRoot: root });
    servers.push(second);
    const res = await fetch("http://127.0.0.1:18953/health");
    expect(res.status).toBe(200);
  });

  test("leaseRoot is REQUIRED — an empty value is refused before anything binds", () => {
    expect(() => startFinalEventServer({ port: 18954, store: new InMemoryFinalEventStore(), secrets: SECRETS, leaseRoot: "" })).toThrow("leaseRoot required");
  });
});

describe("review r1 — distinct lease roots across daemons", () => {
  test("three distinct roots pass", () => {
    const r = assertDistinctLeaseRoots({ A: "/tmp/a", B: "/tmp/b", C: "/tmp/c" });
    expect(r.code).toBe(0);
    expect(r.message).toContain("3 lease root(s) distinct");
  });
  test("collision (same path, even via non-normalized spelling) is rejected and NAMES both daemons", () => {
    const r = assertDistinctLeaseRoots({ MAW_BROKER_STORE_ROOT: "/tmp/x", MAW_PIPECAT_RECEIPT_STORE_ROOT: "/tmp/../tmp/x" });
    expect(r.code).toBe(1);
    expect(r.message).toContain("MAW_BROKER_STORE_ROOT");
    expect(r.message).toContain("MAW_PIPECAT_RECEIPT_STORE_ROOT");
  });
  test("undefined roots are not collisions (a daemon not deployed is not a conflict)", () => {
    expect(assertDistinctLeaseRoots({ A: "/tmp/only", B: undefined, C: undefined }).code).toBe(0);
  });
});
