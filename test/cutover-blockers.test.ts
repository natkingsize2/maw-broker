import { describe, expect, test, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFinalEventServer } from "../src/final-event-server";
import { InMemoryFinalEventStore, type FinalEventSecrets } from "../src/final-event-contract";
import { runCutoverPreflight } from "../src/cutover-preflight";

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
