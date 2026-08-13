import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broker, NAT_USER_ID } from "../src/broker";
import { DiscordPollSource } from "../src/discord-source";
import { BrokerIngress } from "../src/ingress";
import { ACK_ACCEPTED, ACK_REJECTED, ACK_RESOLVED, BrokerRunner, DiscordRestClient, DurableCursor, PersistentLease, type Reactor } from "../src/runner";
import { createMawInjector, type CommandRunner } from "../src/injector-maw";
import { DurableStore } from "../src/store";
import { RouteRegistry } from "../src/routes";
import type { DownstreamInjector, Route } from "../src/types";

const key = Buffer.alloc(32, 7);
const route: Route = { name: "gate", transport: "discord-text", destination: "thread-1", agent: "01-target:0" };
const row = (id: string, content = "approve", authorId = NAT_USER_ID, extra: Record<string, unknown> = {}) => ({ id, channel_id: "thread-1", author: { id: authorId }, content, timestamp: id, ...extra });

function fixture(rows: unknown[], root = mkdtempSync(join(tmpdir(), "maw-p2-")), injector?: DownstreamInjector, reactor?: Reactor) {
  const broker = new Broker(key, new Map([["thread-1", route]]), new DurableStore(join(root, "store")), NAT_USER_ID);
  return { root, run: new BrokerRunner({ source: new DiscordPollSource({ getMessages: async () => rows }, "thread-1"), ingress: new BrokerIngress(broker), cursor: new DurableCursor(join(root, "cursor.json")), key, injector, reactor }) };
}
const recordingReactor = () => { const calls: string[] = []; return { calls, reactor: { react: async (_c: string, id: string, emoji: string) => { calls.push(`${id}:${emoji}`); } } }; };
const response = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body });

// ── R3: bot/webhook command rejection writes the symmetric audit row (no injection)
test("R3: bot command is audited as rejected, not silent", async () => {
  const f = fixture([row("100", "approve", "999", { author: { id: "999", bot: true } })]);
  expect(await f.run.runOnce()).toEqual({ processed: 1, held: false });
  expect(f.run.injectionCount).toBe(0);
  const audit = readFileSync(join(f.root, "store", "audit.jsonl"), "utf8");
  expect(audit).toContain('"event":"rejected"');
  expect(audit).toContain('"messageId":"100"');
  f.run.close();
});
test("R3: disallowed webhook command is audited as rejected", async () => {
  const f = fixture([row("100", "approve", "999", { author: { id: "999", bot: true }, webhook_id: "555" })]);
  expect(await f.run.runOnce()).toEqual({ processed: 1, held: false });
  const audit = readFileSync(join(f.root, "store", "audit.jsonl"), "utf8");
  expect(audit).toContain('"event":"rejected"');
  f.run.close();
});

// ── R1: non-numeric message id is isolated, never crashes the BigInt sort
test("R1: non-numeric id row is skipped and later valid rows still process", async () => {
  const f = fixture([row("not-a-snowflake"), row("200")]);
  expect(await f.run.runOnce()).toEqual({ processed: 1, held: false });
  expect(JSON.parse(readFileSync(join(f.root, "cursor.json"), "utf8"))).toEqual({ after: "200" });
  f.run.close();
});

// ── R2: PID reuse must not wedge startup; live owner and unknown-start still refuse
test("R2: live owner (start time matches lease) is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "maw-p2-lease-"));
  const startedAt = 1_000_000;
  writeFileSync(join(root, "runner.lease"), `4242 ${startedAt} ${Date.now() - 3_600_000}\n`, { mode: 0o600 });
  expect(() => new PersistentLease(root, 30_000, Date.now, () => true, () => startedAt + 1_000)).toThrow("already held");
});
test("R2: recycled pid with stale heartbeat is reclaimed", () => {
  const root = mkdtempSync(join(tmpdir(), "maw-p2-lease-"));
  writeFileSync(join(root, "runner.lease"), `4242 1000000 ${Date.now() - 31_000}\n`, { mode: 0o600 });
  const lease = new PersistentLease(root, 30_000, Date.now, () => true, () => Date.now() - 500);
  expect(existsSync(join(root, "runner.lease"))).toBe(true);
  lease.release();
});
test("R2: recycled pid with fresh heartbeat waits (recovery pending)", () => {
  const root = mkdtempSync(join(tmpdir(), "maw-p2-lease-"));
  writeFileSync(join(root, "runner.lease"), `4242 1000000 ${Date.now() - 1_000}\n`, { mode: 0o600 });
  expect(() => new PersistentLease(root, 30_000, Date.now, () => true, () => Date.now() - 500)).toThrow("recovery pending");
});
test("R2: unreadable start time fails closed as held", () => {
  const root = mkdtempSync(join(tmpdir(), "maw-p2-lease-"));
  writeFileSync(join(root, "runner.lease"), `4242 1000000 ${Date.now() - 3_600_000}\n`, { mode: 0o600 });
  expect(() => new PersistentLease(root, 30_000, Date.now, () => true, () => undefined)).toThrow("already held");
});

// ── Ack reactions: 👀 accepted · ✅ resolved · ❌ rejected · failures never gate
test("ack: owner approve reacts accepted then resolved", async () => {
  const { calls, reactor } = recordingReactor();
  const f = fixture([row("100")], undefined, undefined, reactor);
  expect(await f.run.runOnce()).toEqual({ processed: 1, held: false });
  expect(calls).toEqual([`100:${ACK_ACCEPTED}`, `100:${ACK_RESOLVED}`]);
  f.run.close();
});
test("ack: bot approve reacts accepted then rejected", async () => {
  const { calls, reactor } = recordingReactor();
  const f = fixture([row("100", "approve", "999", { author: { id: "999", bot: true } })], undefined, undefined, reactor);
  await f.run.runOnce();
  expect(calls).toEqual([`100:${ACK_ACCEPTED}`, `100:${ACK_REJECTED}`]);
  f.run.close();
});
test("ack: replay across restart re-reacts resolved (idempotent re-PUT)", async () => {
  const root = mkdtempSync(join(tmpdir(), "maw-p2-replay-"));
  const first = fixture([row("100")], root);
  await first.run.runOnce(); first.run.close();
  writeFileSync(join(root, "cursor.json"), JSON.stringify({ after: undefined }) + "\n", { mode: 0o600 });
  const { calls, reactor } = recordingReactor();
  const second = fixture([row("100")], root, undefined, reactor);
  expect(await second.run.runOnce()).toEqual({ processed: 1, held: false });
  expect(calls).toEqual([`100:${ACK_ACCEPTED}`, `100:${ACK_RESOLVED}`]);
  second.run.close();
});
test("ack: reactor failure neither holds cursor nor blocks resolution", async () => {
  const f = fixture([row("100")], undefined, undefined, { react: async () => { throw new Error("discord down"); } });
  expect(await f.run.runOnce()).toEqual({ processed: 1, held: false });
  expect(f.run.injectionCount).toBe(1);
  f.run.close();
});
test("ack: non-command gets no reaction", async () => {
  const { calls, reactor } = recordingReactor();
  const f = fixture([row("100", "hello")], undefined, undefined, reactor);
  await f.run.runOnce();
  expect(calls).toEqual([]);
  f.run.close();
});

// ── REST reactor: PUT own reaction, no token leak, 401 held
test("REST react PUTs the reaction endpoint without leaking token", async () => {
  let request = "", method = "", auth = "";
  const client = new DiscordRestClient("TOKEN-MUST-NOT-LEAK", async (url, init) => { request = url; method = init.method; auth = init.headers.Authorization; return response(204); });
  await client.react("chan-1", "msg-1", "✅");
  expect(method).toBe("PUT");
  expect(request).toContain("/channels/chan-1/messages/msg-1/reactions/");
  expect(request).toContain("/@me");
  expect(request).not.toContain("TOKEN-MUST-NOT-LEAK");
  expect(auth).toBe("Bot TOKEN-MUST-NOT-LEAK");
});
test("REST react holds 401 without retry", async () => {
  let calls = 0;
  const client = new DiscordRestClient("T", async () => { calls++; return response(401); });
  await expect(client.react("c", "m", "✅")).rejects.toThrow("held");
  expect(calls).toBe(1);
});

// ── Real injector: RECEIVER-PRODUCED evidence via request-reply (constraint E, probe G6 rework)
import type { HttpJson } from "../src/injector-maw";
const fakeRun = (script: Record<string, { rc: number; stdout: string }[]>): CommandRunner => async argv => {
  const verb = argv.slice(0, 2).join(" ");
  const queue = script[verb];
  if (!queue || queue.length === 0) return { rc: 1, stdout: "" };
  return queue.length === 1 ? queue[0]! : queue.shift()!;
};
const fakeHttp = (mint: { ok: boolean; json: unknown }, polls: { ok: boolean; json: unknown }[]): HttpJson => async (method) =>
  method === "POST" ? mint : (polls.length === 1 ? polls[0]! : polls.shift()!);
const registry = new RouteRegistry([route]);
const agentFor = (destination: string) => registry.get(destination)?.agent;
const instant = async () => {};
const T = { attempts: 3, delayMs: 0, sendTimeoutMs: 100 };
const heyOk = { "maw hey": [{ rc: 0, stdout: "delivered" }] };

test("injector acks only after the receiver's own reply flips status to replied", async () => {
  const http = fakeHttp({ ok: true, json: { correlationId: "req-1-x" } }, [{ ok: true, json: { status: "delivered" } }, { ok: true, json: { status: "replied" } }]);
  const inject = createMawInjector(agentFor, fakeRun(heyOk), T, instant, http, "http://test");
  expect(await inject("approve", "42", "thread-1")).toEqual({ messageId: "42", route: "thread-1", accepted: true });
});
test("injector refuses ack while status never reaches replied — delivered pane echo is not receipt", async () => {
  const http = fakeHttp({ ok: true, json: { correlationId: "req-1-x" } }, [{ ok: true, json: { status: "delivered" } }]);
  const inject = createMawInjector(agentFor, fakeRun(heyOk), T, instant, http, "http://test");
  await expect(inject("approve", "42", "thread-1")).rejects.toThrow("no receiver reply");
});
test("injector fails when correlation id cannot be minted", async () => {
  const http = fakeHttp({ ok: false, json: {} }, []);
  const inject = createMawInjector(agentFor, fakeRun(heyOk), T, instant, http, "http://test");
  await expect(inject("approve", "42", "thread-1")).rejects.toThrow("dispatch failed");
});
test("injector fails on nonzero send rc even with a minted correlation id", async () => {
  const http = fakeHttp({ ok: true, json: { correlationId: "req-1-x" } }, [{ ok: true, json: { status: "replied" } }]);
  const inject = createMawInjector(agentFor, fakeRun({ "maw hey": [{ rc: 1, stdout: "" }] }), T, instant, http, "http://test");
  await expect(inject("approve", "42", "thread-1")).rejects.toThrow("dispatch failed");
});
test("injector fails closed for a route with no registered agent", async () => {
  const inject = createMawInjector(() => undefined, fakeRun({}), T, instant, fakeHttp({ ok: true, json: {} }, []), "http://test");
  await expect(inject("approve", "42", "thread-1")).rejects.toThrow("no agent registered");
});
test("injector failure keeps record pending and holds cursor end-to-end", async () => {
  const failing = createMawInjector(agentFor, fakeRun({ "maw hey": [{ rc: 1, stdout: "" }] }), T, instant, fakeHttp({ ok: true, json: { correlationId: "r" } }, []), "http://test");
  const f = fixture([row("100")], undefined, failing);
  expect(await f.run.runOnce()).toEqual({ processed: 0, held: true });
  expect(existsSync(join(f.root, "cursor.json"))).toBe(false);
  f.run.close();
});
test("routes file JSON parse failure raises the named error, not a raw SyntaxError", () => {
  const root = mkdtempSync(join(tmpdir(), "maw-p2-badjson-"));
  const path = join(root, "routes.json");
  writeFileSync(path, "{secret-looking-content!!", { mode: 0o600 });
  expect(() => loadRoutesFile(path)).toThrow("routes file invalid");
});

// ── Audit cap: rotation instead of wedge, chain continuity across files
test("audit at capacity rotates the file and keeps the hash chain across rotation", () => {
  const root = mkdtempSync(join(tmpdir(), "maw-p2-rotate-"));
  const store = new DurableStore(join(root, "store"));
  writeFileSync(store.auditPath, Array.from({ length: 400 }, (_, i) => `line-${i}`).join("\n") + "\n", { mode: 0o600 });
  store.audit({ at: new Date().toISOString(), event: "ignored", messageId: "1", route: "r" });
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const files = readdirSync(join(root, "store")).filter((f: string) => f.startsWith("audit"));
  expect(files.length).toBe(2);
  const fresh = readFileSync(store.auditPath, "utf8").trim().split("\n");
  expect(fresh.length).toBe(1);
  const record = JSON.parse(fresh[0]!);
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  expect(record.prevHash).toBe(createHash("sha256").update("line-399").digest("hex"));
  const archived = files.find((f: string) => f !== "audit.jsonl")!;
  expect(readFileSync(join(root, "store", archived), "utf8").trim().split("\n").length).toBe(400);
});
test("audit below capacity appends to the same file", () => {
  const root = mkdtempSync(join(tmpdir(), "maw-p2-norotate-"));
  const store = new DurableStore(join(root, "store"));
  store.audit({ at: new Date().toISOString(), event: "ignored", messageId: "1", route: "r" });
  store.audit({ at: new Date().toISOString(), event: "ignored", messageId: "2", route: "r" });
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  expect(readdirSync(join(root, "store")).filter((f: string) => f.startsWith("audit")).length).toBe(1);
});

// ── Route launcher config: exact allowlist, fail-closed (constraint A)
import { loadRoutesFile } from "../src/route-launcher";
test("routes file: exactly one discord-text route with numeric destination and agent", () => {
  const root = mkdtempSync(join(tmpdir(), "maw-p2-routes-"));
  const path = join(root, "routes.json");
  writeFileSync(path, JSON.stringify([{ name: "general", transport: "discord-text", destination: "1056224550129508415", agent: "03-canon:0" }]), { mode: 0o600 });
  expect(loadRoutesFile(path)).toEqual([{ name: "general", transport: "discord-text", destination: "1056224550129508415", agent: "03-canon:0" }]);
});
test("routes file rejects wrong mode, two routes, fuzzy destination, missing agent", () => {
  const root = mkdtempSync(join(tmpdir(), "maw-p2-routes-bad-"));
  const good = { name: "general", transport: "discord-text", destination: "1056224550129508415", agent: "03-canon:0" };
  const open = join(root, "open.json"); writeFileSync(open, JSON.stringify([good]), { mode: 0o644 });
  expect(() => loadRoutesFile(open)).toThrow("routes file invalid");
  const two = join(root, "two.json"); writeFileSync(two, JSON.stringify([good, good]), { mode: 0o600 });
  expect(() => loadRoutesFile(two)).toThrow("exactly one route");
  const fuzzy = join(root, "fuzzy.json"); writeFileSync(fuzzy, JSON.stringify([{ ...good, destination: "broker-canary" }]), { mode: 0o600 });
  expect(() => loadRoutesFile(fuzzy)).toThrow("destination invalid");
  const agentless = join(root, "agentless.json"); writeFileSync(agentless, JSON.stringify([{ ...good, agent: "" }]), { mode: 0o600 });
  expect(() => loadRoutesFile(agentless)).toThrow("agent invalid");
});
