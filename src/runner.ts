import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { keyFromBase64, seal } from "./crypto";
import { DiscordPollSource, type DiscordClient } from "./discord-source";
import { BrokerIngress } from "./ingress";
import { retryAfterMs, retryDecision } from "./retry";
import type { DownstreamInjector, InboundMessage } from "./types";

type FetchResponse = { ok: boolean; status: number; headers: Headers; json(): Promise<unknown> };
type FetchLike = (url: string, init: { method: "GET" | "PUT"; headers: Record<string, string> }) => Promise<FetchResponse>;
type Sleep = (ms: number) => Promise<void>;
const wait: Sleep = async ms => { await new Promise<void>(resolve => setTimeout(resolve, ms)); };

export class DiscordRestClient implements DiscordClient {
  constructor(private readonly token: string, private readonly fetcher: FetchLike = fetch as FetchLike, private readonly sleep: Sleep = wait) { if (!token) throw new Error("Discord client configuration invalid"); }
  async getMessages(channelId: string, after?: string, limit = 50): Promise<unknown[]> {
    const query = new URLSearchParams({ limit: String(limit) }); if (after) query.set("after", after);
    const url = `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages?${query}`;
    for (let attempt = 0;; attempt++) {
      let response: FetchResponse;
      try { response = await this.fetcher(url, { method: "GET", headers: { Authorization: `Bot ${this.token}` } }); } catch { throw new Error("Discord REST request failed"); }
      if (response.ok) { const body = await response.json(); if (!Array.isArray(body)) throw new Error("Discord REST response invalid"); return body; }
      const policy = retryDecision(response.status, attempt);
      if (!policy.retry) throw new Error("Discord REST request held");
      await this.sleep(response.status === 429 ? retryAfterMs(response.headers, attempt) : policy.delayMs ?? retryAfterMs(response.headers, attempt));
    }
  }
  /** PUT own reaction; idempotent on Discord's side (re-PUT of same emoji is a no-op). */
  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    const url = `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`;
    for (let attempt = 0;; attempt++) {
      let response: FetchResponse;
      try { response = await this.fetcher(url, { method: "PUT", headers: { Authorization: `Bot ${this.token}` } }); } catch { throw new Error("Discord REST request failed"); }
      if (response.ok) return;
      const policy = retryDecision(response.status, attempt);
      if (!policy.retry) throw new Error("Discord REST request held");
      await this.sleep(response.status === 429 ? retryAfterMs(response.headers, attempt) : policy.delayMs ?? retryAfterMs(response.headers, attempt));
    }
  }
}

export type RunnerSecrets = { discordBotToken: string; brokerKey: Buffer; ownerId: string };
type Environment = Record<string, string | undefined>;
export function loadRunnerSecrets(env: Environment = process.env): RunnerSecrets {
  let values = env;
  try {
    if (env.MAW_BROKER_SECRETS_FILE) { const path = env.MAW_BROKER_SECRETS_FILE; if (lstatSync(path).isSymbolicLink() || (statSync(path).mode & 0o777) !== 0o600) throw new Error(); values = JSON.parse(readFileSync(path, "utf8")); }
    const token = values.DISCORD_BOT_TOKEN, ownerId = values.MAW_BROKER_OWNER_ID, encodedKey = values.MAW_BROKER_KEY_B64;
    if (typeof token !== "string" || typeof ownerId !== "string" || typeof encodedKey !== "string" || !token || !/^\d{17,20}$/.test(ownerId)) throw new Error();
    return { discordBotToken: token, brokerKey: keyFromBase64(encodedKey), ownerId };
  } catch { throw new Error("broker runner configuration invalid"); }
}

export class DurableCursor {
  constructor(readonly path: string) { const root = dirname(path); if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error("cursor path invalid"); mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700); if (existsSync(path)) this.assertSafeFile(); }
  read(): string | undefined { if (!existsSync(this.path)) return undefined; this.assertSafeFile(); const value = JSON.parse(readFileSync(this.path, "utf8")); if (!value || typeof value !== "object" || (value.after !== undefined && typeof value.after !== "string")) throw new Error("cursor state invalid"); return value.after; }
  advance(after: string) { const temporary = `${this.path}.tmp-${process.pid}`; writeFileSync(temporary, JSON.stringify({ after }) + "\n", { encoding: "utf8", mode: 0o600 }); const fd = openSync(temporary, "r"); fsyncSync(fd); closeSync(fd); renameSync(temporary, this.path); const dirfd = openSync(dirname(this.path), "r"); fsyncSync(dirfd); closeSync(dirfd); chmodSync(this.path, 0o600); }
  private assertSafeFile() { const state = lstatSync(this.path); if (!state.isFile() || state.isSymbolicLink() || (state.mode & 0o777) !== 0o600) throw new Error("cursor state invalid"); }
}

/** Wall-clock ms when `pid` started, or undefined when unreadable. Used to detect PID reuse:
 *  a lease whose recorded startedAt disagrees with the living process's start time belongs to
 *  a dead owner whose pid was recycled by an unrelated process. */
export function processStartTimeMs(pid: number): number | undefined {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execFileSync("ps", ["-p", String(pid), "-o", "etime="], { encoding: "utf8" }).trim();
    const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(out);
    if (!match) return undefined;
    const [, days, hours, minutes, seconds] = match;
    const elapsedMs = (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
    return Date.now() - elapsedMs;
  } catch { return undefined; }
}

export class PersistentLease {
  readonly path: string;
  private readonly pid = process.pid;
  private readonly startedAt = Date.now();
  // PID-reuse tolerance: ps etime has 1s granularity and the lease is written after process start.
  private static readonly START_TIME_TOLERANCE_MS = 60_000;
  constructor(root: string, private readonly staleAfterMs = 30_000, private readonly now: () => number = Date.now, private readonly alive: (pid: number) => boolean = pid => { try { process.kill(pid, 0); return true; } catch { return false; } }, private readonly startTimeOf: (pid: number) => number | undefined = processStartTimeMs) { this.path = `${root}/runner.lease`; this.acquire(); }
  refresh() { const owner = this.readOwner(); if (!owner || owner.pid !== this.pid || owner.startedAt !== this.startedAt) throw new Error("runner lease lost"); this.writeOwner(this.now()); }
  release() { try { const owner = this.readOwner(); if (owner?.pid === this.pid && owner?.startedAt === this.startedAt) unlinkSync(this.path); } catch { /* a replaced lease is never removed by a prior owner */ } }
  private acquire() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const fd = openSync(this.path, "wx", 0o600); closeSync(fd); this.writeOwner(this.now()); return; }
      catch {
        const owner = this.readOwner();
        if (!owner) { if (!existsSync(this.path)) continue; throw new Error("runner lease corrupt"); }
        if (this.alive(owner.pid)) {
          // A live pid is only a live OWNER if its start time matches the lease. A recycled
          // pid (unrelated process) must not wedge startup forever; unknown start time fails closed.
          // RECORDED TRADEOFF (probe G6): closing R2 makes the theft surface nonzero — a lease
          // whose startedAt drifts >60s from the live process's real start AND whose heartbeat
          // is stale can now be reclaimed. A real runner writes startedAt at construction
          // (ms from its own start) and heartbeats every poll, so both conditions together
          // mean the recorded owner is not the process wearing that pid.
          const started = this.startTimeOf(owner.pid);
          const pidReused = started !== undefined && Math.abs(started - owner.startedAt) > PersistentLease.START_TIME_TOLERANCE_MS;
          if (!pidReused) throw new Error("runner lease already held");
        }
        if (this.now() - owner.heartbeat <= this.staleAfterMs) throw new Error("runner lease recovery pending");
        try { unlinkSync(this.path); } catch {}
      }
    }
    throw new Error("runner lease unavailable");
  }
  private writeOwner(heartbeat: number) { const fd = openSync(this.path, "w", 0o600); writeFileSync(fd, `${this.pid} ${this.startedAt} ${heartbeat}\n`); fsyncSync(fd); closeSync(fd); chmodSync(this.path, 0o600); }
  private readOwner(): { pid: number; startedAt: number; heartbeat: number } | undefined { try { const [pid, startedAt, heartbeat, ...rest] = readFileSync(this.path, "utf8").trim().split(/\s+/); if (rest.length || !/^\d+$/.test(pid ?? "") || !/^\d+$/.test(startedAt ?? "") || !/^\d+$/.test(heartbeat ?? "")) return undefined; return { pid: Number(pid), startedAt: Number(startedAt), heartbeat: Number(heartbeat) }; } catch { return undefined; } }
}

/** Ack surface for the human in the room. Failures are swallowed by the runner: acks are UX,
 *  never a gate — a failed reaction must not hold the cursor or block resolution. */
export type Reactor = { react(channelId: string, messageId: string, emoji: string): Promise<void> };
export const ACK_ACCEPTED = "👀", ACK_RESOLVED = "✅", ACK_REJECTED = "❌";

export type RunnerOptions = { source: DiscordPollSource; ingress: BrokerIngress; cursor: DurableCursor; key: Buffer; injector?: DownstreamInjector; reactor?: Reactor };
export class BrokerRunner {
  private injections = 0;
  private readonly injector: DownstreamInjector;
  private readonly lease: PersistentLease;
  constructor(private readonly options: RunnerOptions) { this.lease = new PersistentLease(dirname(options.cursor.path)); this.injector = options.injector ?? (async (_plaintext, messageId, route) => { this.injections++; return { messageId, route, accepted: true }; }); }
  private async ack(message: InboundMessage, emoji: string) { try { await this.options.reactor?.react(message.route, message.messageId, emoji); } catch { /* ack is UX only; see Reactor */ } }
  close() { this.lease.release(); }
  get injectionCount() { return this.injections; }
  async runOnce(): Promise<{ processed: number; held: boolean }> {
    let messages: InboundMessage[];
    this.lease.refresh();
    try { messages = await this.options.source.poll(this.options.cursor.read()); } catch { return { processed: 0, held: true }; }
    messages.sort((a, b) => BigInt(a.messageId) < BigInt(b.messageId) ? -1 : BigInt(a.messageId) > BigInt(b.messageId) ? 1 : 0);
    let processed = 0;
    for (const message of messages) {
      const decision = message.content === "approve" ? "allow" : message.content === "reject" ? "deny" : undefined;
      if (!decision) { const ignored = await this.options.ingress.ignore(message); if (ignored.cursor !== "advance") return { processed, held: true }; this.options.cursor.advance(message.messageId); continue; }
      const envelope = seal(this.options.key, message.route, message.messageId, message.content, "discord-text", decision);
      const result = await this.options.ingress.handle(message, envelope, decision, this.injector);
      // 👀 fires ONLY after durable acceptance (probe G6: firing it before ingress.handle gave
      // foreign/bot commands a "broker accepted" signal and let any outsider poke the bot).
      // Post-acceptance outcomes are exactly RESOLVED (owner command resolved) and
      // INJECTOR_FAILURE (owner command accepted, awaiting receiver) — both got past every auth
      // gate and wrote an "accepted" audit row. OWNER_MISMATCH is a pre-acceptance reject → ❌ only.
      if (result.outcome === "RESOLVED") { await this.ack(message, ACK_ACCEPTED); await this.ack(message, ACK_RESOLVED); }
      else if (result.outcome === "INJECTOR_FAILURE") await this.ack(message, ACK_ACCEPTED);
      else if (result.outcome === "OWNER_MISMATCH") await this.ack(message, ACK_REJECTED);
      if (result.cursor !== "advance") return { processed, held: true };
      this.options.cursor.advance(message.messageId); processed++;
    }
    return { processed, held: false };
  }
}
