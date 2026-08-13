/**
 * Phase-4 inbound — project-thread poller → MQTT wake (owner redirect 2026-08-13 19:0x:
 * "Repo มันมี arra bridge mqtt ไม่เอามาใช้" — the wake leg reuses arra-mqtt-channel, NOT
 * tmux send-keys, so delivery is a real channel message with receiver-side semantics).
 *
 *   owner types in a project thread → poller (owner-only, per-project durable cursor)
 *   → publish to `<route.mqtt>/<route.name>/in` with the arra-mqtt inbound contract
 *   → the agent's arra-mqtt channel wakes it; the agent replies on .../out.
 *
 * Ordering per message: publish (QoS 1) → advance cursor → react 👀. A failed publish holds
 * the cursor, so retry is at-least-once and meta.message_id lets the receiver dedupe. A failed
 * 👀 after a committed cursor is a missing eye, never a lost forward.
 * Routes WITHOUT an mqtt prefix are counted and reported every cycle — a silently skipped
 * route is how "covered everything" gets written over a hole.
 */

import { join } from "node:path";
import { DiscordPollSource, type DiscordClient } from "./discord-source";
import { DiscordRestClient, DurableCursor, loadRunnerSecrets } from "./runner";
import { loadProjectRoutesFile, type ProjectRoute } from "./project-routes";

export interface WakePublisher {
  publish(topic: string, payload: string): Promise<void>;
}

/** Ships with the mosquitto we run (loopback-only listener); payload rides stdin (-s), never
 *  argv, so message text cannot leak into `ps`. No new npm dependency this review round. */
export class MosquittoPublisher implements WakePublisher {
  constructor(private readonly host = "127.0.0.1") {}
  async publish(topic: string, payload: string): Promise<void> {
    const child = Bun.spawn(["mosquitto_pub", "-h", this.host, "-q", "1", "-t", topic, "-s"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    child.stdin.write(payload);
    await child.stdin.end();
    if ((await child.exited) !== 0) throw new Error("mqtt publish failed");
  }
}

export type Reactor = { react(channelId: string, messageId: string, emoji: string): Promise<void> };
export type CursorLike = { read(): string | undefined; advance(after: string): void };

export type PollOutcome = { forwarded: number; skipped: number; held: number };

export class ProjectPoller {
  constructor(
    private readonly client: DiscordClient & Reactor,
    private readonly ownerId: string,
    private readonly publisher: WakePublisher,
    private readonly cursorFor: (route: ProjectRoute) => CursorLike,
  ) {
    if (!/^\d{17,20}$/.test(ownerId)) throw new Error("project poller owner invalid");
  }

  /** One pass over one MQTT-enabled route. Throws only on cursor corruption; a publish failure
   *  is counted as held and stops THIS route's advance (retry next cycle). */
  async pollOnce(route: ProjectRoute): Promise<PollOutcome> {
    if (!route.mqtt) throw new Error("route has no mqtt prefix");
    const cursor = this.cursorFor(route);
    const source = new DiscordPollSource(this.client, route.destination);
    const messages = (await source.poll(cursor.read()))
      .sort((a, b) => (BigInt(a.messageId) < BigInt(b.messageId) ? -1 : 1));
    const outcome: PollOutcome = { forwarded: 0, skipped: 0, held: 0 };
    for (const message of messages) {
      if (message.authorIsBot || message.webhookId || message.authorId !== this.ownerId) {
        outcome.skipped++;
        cursor.advance(message.messageId);
        continue;
      }
      const payload = JSON.stringify({
        content: message.content,
        meta: { chat_id: route.name, user: message.authorId, message_id: message.messageId, ts: message.observedAt ?? "" },
      });
      try {
        await this.publisher.publish(`${route.mqtt}/${route.name}/in`, payload);
      } catch {
        outcome.held++;
        return outcome;              // hold the cursor: at-least-once, receiver dedupes by message_id
      }
      cursor.advance(message.messageId);
      try { await this.client.react(route.destination, message.messageId, "👀"); } catch { /* eye only */ }
      outcome.forwarded++;
    }
    return outcome;
  }
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const routesFile = env.MAW_PROJECT_ROUTES_FILE;
  const storeRoot = env.MAW_PROJECT_STORE_ROOT;
  if (!routesFile || !storeRoot) throw new Error("project poller configuration invalid");
  const intervalMs = Number(env.PROJECT_POLL_INTERVAL_MS ?? "5000");
  const maxPolls = Number(env.PROJECT_MAX_POLLS ?? "120");
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || !Number.isInteger(maxPolls) || maxPolls < 1) throw new Error("project poller configuration invalid");

  const routes = loadProjectRoutesFile(routesFile);
  const wired = routes.filter(r => r.mqtt);
  const secrets = loadRunnerSecrets(env);
  const client = new DiscordRestClient(secrets.discordBotToken);
  const poller = new ProjectPoller(client, secrets.ownerId, new MosquittoPublisher(),
    route => new DurableCursor(join(storeRoot, `${route.name}.cursor.json`)));

  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  for (let poll = 1; poll <= maxPolls && !stopping; poll++) {
    let forwarded = 0, skipped = 0, held = 0;
    for (const route of wired) {
      try {
        const r = await poller.pollOnce(route);
        forwarded += r.forwarded; skipped += r.skipped; held += r.held;
      } catch { held++; }            // counted and printed — never a silent shrug
    }
    // Counts only, never content (constraint G) — and the un-wired routes are named every line
    // so a hole in coverage cannot read as coverage.
    console.log(`project poll=${poll}/${maxPolls} routes=${routes.length} mqtt=${wired.length} no-mqtt=[${routes.filter(r => !r.mqtt).map(r => r.name).join(",") || "-"}] forwarded=${forwarded} skipped=${skipped} held=${held}`);
    if (poll < maxPolls && !stopping) await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

if (import.meta.main) { main().catch(error => { console.error(String(error?.message ?? error)); process.exit(1); }); }
