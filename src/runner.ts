import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { keyFromBase64, seal } from "./crypto";
import { DiscordPollSource, type DiscordClient } from "./discord-source";
import { BrokerIngress } from "./ingress";
import { retryAfterMs, retryDecision } from "./retry";
import type { DownstreamInjector, InboundMessage } from "./types";

type FetchResponse = { ok: boolean; status: number; headers: Headers; json(): Promise<unknown> };
type FetchLike = (url: string, init: { method: "GET"; headers: Record<string, string> }) => Promise<FetchResponse>;
type Sleep = (ms: number) => Promise<void>;
const wait: Sleep = async ms => { await new Promise<void>(resolve => setTimeout(resolve, ms)); };

export class DiscordRestClient implements DiscordClient {
  constructor(private readonly token: string, private readonly fetcher: FetchLike = fetch as FetchLike, private readonly sleep: Sleep = wait) { if (!token) throw new Error("Discord client configuration invalid"); }
  async getMessages(channelId: string, before?: string, limit = 50): Promise<unknown[]> {
    const query = new URLSearchParams({ limit: String(limit) }); if (before) query.set("before", before);
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
  read(): string | undefined { if (!existsSync(this.path)) return undefined; this.assertSafeFile(); const value = JSON.parse(readFileSync(this.path, "utf8")); if (!value || typeof value !== "object" || (value.before !== undefined && typeof value.before !== "string")) throw new Error("cursor state invalid"); return value.before; }
  advance(before: string) { const temporary = `${this.path}.tmp-${process.pid}`; writeFileSync(temporary, JSON.stringify({ before }) + "\n", { encoding: "utf8", mode: 0o600 }); const fd = openSync(temporary, "r"); fsyncSync(fd); closeSync(fd); renameSync(temporary, this.path); const dirfd = openSync(dirname(this.path), "r"); fsyncSync(dirfd); closeSync(dirfd); chmodSync(this.path, 0o600); }
  private assertSafeFile() { const state = lstatSync(this.path); if (!state.isFile() || state.isSymbolicLink() || (state.mode & 0o777) !== 0o600) throw new Error("cursor state invalid"); }
}

export class PersistentLease {
  readonly path: string;
  private readonly pid = process.pid;
  private readonly startedAt = Date.now();
  constructor(root: string, private readonly staleAfterMs = 30_000) { this.path = `${root}/runner.lease`; this.acquire(); }
  release() { try { const owner = this.readOwner(); if (owner?.pid === this.pid && owner?.startedAt === this.startedAt) unlinkSync(this.path); } catch { /* a replaced lease is never removed by a prior owner */ } }
  private acquire() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const fd = openSync(this.path, "wx", 0o600); writeFileSync(fd, `${this.pid} ${this.startedAt}\n`); fsyncSync(fd); closeSync(fd); return; }
      catch {
        const owner = this.readOwner();
        if (!owner || Date.now() - owner.startedAt > this.staleAfterMs || !this.isAlive(owner.pid)) { try { unlinkSync(this.path); } catch {} continue; }
        throw new Error("runner lease already held");
      }
    }
    throw new Error("runner lease unavailable");
  }
  private readOwner(): { pid: number; startedAt: number } | undefined { try { const [pid, startedAt, ...rest] = readFileSync(this.path, "utf8").trim().split(/\s+/); if (rest.length || !/^\d+$/.test(pid ?? "") || !/^\d+$/.test(startedAt ?? "")) return undefined; return { pid: Number(pid), startedAt: Number(startedAt) }; } catch { return undefined; } }
  private isAlive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
}

export type RunnerOptions = { source: DiscordPollSource; ingress: BrokerIngress; cursor: DurableCursor; key: Buffer; injector?: DownstreamInjector };
export class BrokerRunner {
  private injections = 0;
  private readonly injector: DownstreamInjector;
  private readonly lease: PersistentLease;
  constructor(private readonly options: RunnerOptions) { this.lease = new PersistentLease(dirname(options.cursor.path)); this.injector = options.injector ?? (async (_plaintext, messageId, route) => { this.injections++; return { messageId, route, accepted: true }; }); }
  close() { this.lease.release(); }
  get injectionCount() { return this.injections; }
  async runOnce(): Promise<{ processed: number; held: boolean }> {
    let messages: InboundMessage[];
    try { messages = await this.options.source.poll(this.options.cursor.read()); } catch { return { processed: 0, held: true }; }
    messages.sort((a, b) => (a.observedAt ?? a.messageId).localeCompare(b.observedAt ?? b.messageId));
    let processed = 0;
    for (const message of messages) {
      const decision = message.content === "approve" ? "allow" : message.content === "reject" ? "deny" : undefined;
      if (!decision) return { processed, held: true };
      const envelope = seal(this.options.key, message.route, message.messageId, message.content, "discord-text", decision);
      const result = await this.options.ingress.handle(message, envelope, decision, this.injector);
      if (result.cursor !== "advance") return { processed, held: true };
      this.options.cursor.advance(message.messageId); processed++;
    }
    return { processed, held: false };
  }
}
