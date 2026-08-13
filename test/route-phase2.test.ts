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

// ── Real injector: receiver-side evidence required (constraint E)
const fakeRun = (script: Record<string, { rc: number; stdout: string }[]>): CommandRunner => async argv => {
  const verb = argv.slice(0, 2).join(" ");
  const queue = script[verb];
  if (!queue || queue.length === 0) return { rc: 1, stdout: "" };
  return queue.length === 1 ? queue[0]! : queue.shift()!;
};
const registry = new RouteRegistry([route]);
const agentFor = (destination: string) => registry.get(destination)?.agent;
const instant = async () => {};

test("injector acks only after the marker is visible receiver-side", async () => {
  const inject = createMawInjector(agentFor, fakeRun({ "maw hey": [{ rc: 0, stdout: "delivered" }], "maw capture": [{ rc: 0, stdout: "…[broker#42] approve…" }] }), { attempts: 2, delayMs: 0, sendTimeoutMs: 100 }, instant);
  expect(await inject("approve", "42", "thread-1")).toEqual({ messageId: "42", route: "thread-1", accepted: true });
});
test("injector refuses ack when send succeeds but no receiver evidence appears", async () => {
  const inject = createMawInjector(agentFor, fakeRun({ "maw hey": [{ rc: 0, stdout: "delivered" }], "maw capture": [{ rc: 0, stdout: "nothing here" }], "maw peek": [{ rc: 0, stdout: "nothing here" }] }), { attempts: 2, delayMs: 0, sendTimeoutMs: 100 }, instant);
  await expect(inject("approve", "42", "thread-1")).rejects.toThrow("no receiver-side evidence");
});
test("injector fails on nonzero send rc", async () => {
  const inject = createMawInjector(agentFor, fakeRun({ "maw hey": [{ rc: 1, stdout: "" }] }), { attempts: 1, delayMs: 0, sendTimeoutMs: 100 }, instant);
  await expect(inject("approve", "42", "thread-1")).rejects.toThrow("dispatch failed");
});
test("injector fails closed for a route with no registered agent", async () => {
  const inject = createMawInjector(() => undefined, fakeRun({}), { attempts: 1, delayMs: 0, sendTimeoutMs: 100 }, instant);
  await expect(inject("approve", "42", "thread-1")).rejects.toThrow("no agent registered");
});
test("injector failure keeps record pending and holds cursor end-to-end", async () => {
  const failing = createMawInjector(agentFor, fakeRun({ "maw hey": [{ rc: 1, stdout: "" }] }), { attempts: 1, delayMs: 0, sendTimeoutMs: 100 }, instant);
  const f = fixture([row("100")], undefined, failing);
  expect(await f.run.runOnce()).toEqual({ processed: 0, held: true });
  expect(existsSync(join(f.root, "cursor.json"))).toBe(false);
  f.run.close();
});
