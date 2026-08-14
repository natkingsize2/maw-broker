import { DiscordTextAdapter } from "./adapter-discord";
import type { InboundMessage } from "./types";

/** Discord authoritative-marker adapter (C2 ROUND3).
 *
 *  Finds — or idempotently creates — THE single authoritative marked message in one channel.
 *  Differences from `DiscordRestClient.findMarkedMessage` (runner.ts), each one a hole this
 *  adapter exists to close:
 *    - exact marker: the marker must occupy a whole line of the message content. `includes()`
 *      would let marker "X" match a message carrying "X-v2" (identifier-prefix collision).
 *    - normalized webhook identity rejection: rows are normalized through DiscordTextAdapter
 *      first; any row with a webhook_id is never a candidate even when its author.id equals
 *      the bot's own id — webhooks can impersonate name/avatar and some proxies echo ids.
 *    - exact channel: a row whose channel_id differs from the configured channel is ignored
 *      even if the transport handed it back for this channel's query.
 *    - >1 own match is a HOLD (typed error), never a silent pick.
 *
 *  The adapter holds no credential and never constructs a live client: the port is injected,
 *  and `selfBotId` is a constructor argument, not a live `/users/@me` call. */

export type MarkerClientPort = {
  /** Page of raw Discord message rows, newest-first, honoring `before` for pagination. */
  getMessages(channelId: string, after?: string, limit?: number, before?: string): Promise<unknown[]>;
  /** POST a message; returns the created id. May throw AFTER the server accepted (disconnect). */
  postMessage(channelId: string, content: string): Promise<{ messageId: string }>;
};

/** >1 of our own marked messages: ambiguous authority. Fail-closed — callers must stop, not choose. */
export class MarkerHoldError extends Error {
  readonly code = "MARKER_HOLD";
  constructor(readonly messageIds: readonly string[]) { super(`marker HOLD: ${messageIds.length} own marked messages`); }
}

export type MarkerAdapterOptions = { channelId: string; selfBotId: string; marker: string; maxScan?: number };

export class DiscordAuthoritativeMarkerAdapter {
  private readonly normalizer = new DiscordTextAdapter();
  private readonly channelId: string;
  private readonly selfBotId: string;
  private readonly marker: string;
  private readonly maxScan: number;

  constructor(private readonly port: MarkerClientPort, options: MarkerAdapterOptions) {
    const { channelId, selfBotId, marker } = options;
    if (!channelId || !selfBotId) throw new Error("marker adapter configuration invalid");
    // A marker that is empty, multi-line, or padded cannot be matched as "a whole line" unambiguously.
    if (typeof marker !== "string" || marker.length === 0 || /\r|\n/.test(marker) || marker !== marker.trim()) throw new Error("marker adapter configuration invalid");
    this.channelId = channelId; this.selfBotId = selfBotId; this.marker = marker;
    this.maxScan = options.maxScan ?? 200;
    if (!Number.isInteger(this.maxScan) || this.maxScan < 1) throw new Error("marker adapter configuration invalid");
  }

  /** Exact-line match: the marker is a whole line of the content. "marker-v2" or "xmarker" never match. */
  private contentCarriesExactMarker(content: string): boolean {
    return content.split(/\r?\n/).some(line => line === this.marker);
  }

  /** true only for: normalizes cleanly · same channel · authored by our bot id · NOT a webhook · exact marker line. */
  private isOwnAuthoritativeRow(row: unknown): { messageId: string } | undefined {
    let m: InboundMessage;
    try { m = this.normalizer.normalize(row); } catch { return undefined; } // malformed row is isolated, same policy as DiscordPollSource
    if (m.route !== this.channelId) return undefined;          // exact channel
    if (m.webhookId !== undefined) return undefined;           // webhook identity rejected even if author.id matches
    if (m.authorId !== this.selfBotId) return undefined;       // own-bot author only; outsiders ignored
    if (!this.contentCarriesExactMarker(m.content)) return undefined;
    return { messageId: m.messageId };
  }

  /** Bounded backward pagination (pages of 50, up to maxScan rows). Returns the single own
   *  marked message, undefined when none, throws MarkerHoldError on more than one. */
  async findAuthoritative(): Promise<{ messageId: string } | undefined> {
    const matches: string[] = [];
    let before: string | undefined;
    for (let scanned = 0; scanned < this.maxScan; scanned += 50) {
      const rows = await this.port.getMessages(this.channelId, undefined, 50, before);
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) {
        const hit = this.isOwnAuthoritativeRow(row);
        if (hit) matches.push(hit.messageId);
      }
      if (matches.length > 1) throw new MarkerHoldError(matches);
      const oldest = rows[rows.length - 1] as { id?: unknown };
      if (typeof oldest?.id !== "string" || oldest.id === before) break; // no cursor progress → stop, stay bounded
      before = oldest.id;
    }
    return matches.length === 1 ? { messageId: matches[0]! } : undefined;
  }

  /** Idempotently establish the authoritative message: reuse the existing one when present;
   *  otherwise POST `body` with the marker appended as its own line. When the POST throws
   *  (accepted-then-disconnect), recover by lookup — never blind-repost: if the message
   *  landed, return it; only when lookup proves it did not land does the error propagate. */
  async ensureAuthoritative(body: string): Promise<{ messageId: string; created: boolean }> {
    const existing = await this.findAuthoritative();
    if (existing) return { messageId: existing.messageId, created: false };
    const content = body.length > 0 ? `${body}\n${this.marker}` : this.marker;
    try {
      const posted = await this.port.postMessage(this.channelId, content);
      return { messageId: posted.messageId, created: true };
    } catch (error) {
      const recovered = await this.findAuthoritative(); // MarkerHoldError from here propagates: >1 after a failed POST is a real HOLD
      if (recovered) return { messageId: recovered.messageId, created: true };
      throw error; // lookup says nothing landed → the POST genuinely failed
    }
  }
}
