import { describe, expect, test } from "bun:test";
import { DiscordAuthoritativeMarkerAdapter, MarkerHoldError, type MarkerClientPort } from "../src/discord-marker-adapter";

const CHANNEL = "111222333444555666";
const SELF = "900000000000000001";
const OUTSIDER = "900000000000000002";
const MARKER = "-# ⟦c2-authoritative⟧";

type Row = { id: string; channel_id: string; content: string; author: { id: string; bot?: boolean }; webhook_id?: string; timestamp?: string };

let nextId = 5000;
function row(partial: Partial<Row> & { content: string }): Row {
  return { id: String(nextId++), channel_id: CHANNEL, author: { id: SELF, bot: true }, ...partial } as Row;
}

/** In-memory Discord channel: rows newest-first, `before` pagination by snowflake ordering,
 *  POST really lands the row server-side BEFORE the response can be dropped — that ordering
 *  is the whole point of the accepted-then-disconnect tests. */
class FakeChannelPort implements MarkerClientPort {
  rows: Row[] = []; // newest-first
  getCalls = 0;
  postCalls = 0;
  dropNextPostResponse = false;
  failNextPostBeforeLanding = false;
  async getMessages(channelId: string, _after?: string, limit = 50, before?: string): Promise<unknown[]> {
    this.getCalls++;
    expect(channelId).toBe(CHANNEL); // the adapter must only ever query its configured channel
    let pool = this.rows;
    if (before !== undefined) pool = pool.filter(r => /^\d+$/.test(r.id) && BigInt(r.id) < BigInt(before));
    return pool.slice(0, limit);
  }
  async postMessage(_channelId: string, content: string): Promise<{ messageId: string }> {
    this.postCalls++;
    if (this.failNextPostBeforeLanding) { this.failNextPostBeforeLanding = false; throw new Error("connect refused"); }
    const created = row({ content });
    this.rows.unshift(created); // server accepted
    if (this.dropNextPostResponse) { this.dropNextPostResponse = false; throw new Error("socket closed before response"); }
    return { messageId: created.id };
  }
}

function adapter(port: MarkerClientPort, maxScan = 200) {
  return new DiscordAuthoritativeMarkerAdapter(port, { channelId: CHANNEL, selfBotId: SELF, marker: MARKER, maxScan });
}

describe("configuration fails closed", () => {
  const port = new FakeChannelPort();
  test("empty, multi-line, padded marker and bad maxScan are all refused at construction", () => {
    expect(() => new DiscordAuthoritativeMarkerAdapter(port, { channelId: CHANNEL, selfBotId: SELF, marker: "" })).toThrow();
    expect(() => new DiscordAuthoritativeMarkerAdapter(port, { channelId: CHANNEL, selfBotId: SELF, marker: "a\nb" })).toThrow();
    expect(() => new DiscordAuthoritativeMarkerAdapter(port, { channelId: CHANNEL, selfBotId: SELF, marker: " padded " })).toThrow();
    expect(() => new DiscordAuthoritativeMarkerAdapter(port, { channelId: CHANNEL, selfBotId: SELF, marker: MARKER, maxScan: 0 })).toThrow();
    expect(() => new DiscordAuthoritativeMarkerAdapter(port, { channelId: "", selfBotId: SELF, marker: MARKER })).toThrow();
    expect(() => new DiscordAuthoritativeMarkerAdapter(port, { channelId: CHANNEL, selfBotId: "", marker: MARKER })).toThrow();
  });
});

describe("exact marker", () => {
  test("finds the own message whose content carries the marker as a whole line", async () => {
    const port = new FakeChannelPort();
    const target = row({ content: `digest body\n${MARKER}` });
    port.rows = [row({ content: "noise" }), target];
    const found = await adapter(port).findAuthoritative();
    expect(found).toEqual({ messageId: target.id });
  });
  test("marker-prefix collisions and mid-line embeddings never match (includes() would take all three)", async () => {
    const port = new FakeChannelPort();
    port.rows = [
      row({ content: `x\n${MARKER}-v2` }),        // longer identifier sharing the marker as prefix
      row({ content: `x\nx${MARKER}` }),          // marker glued to other text
      row({ content: `before ${MARKER} after` }), // marker embedded mid-line
    ];
    expect(await adapter(port).findAuthoritative()).toBeUndefined();
  });
});

describe("author, channel and webhook identity", () => {
  test("outsider carrying the exact marker is ignored, silently", async () => {
    const port = new FakeChannelPort();
    port.rows = [row({ content: MARKER, author: { id: OUTSIDER } })];
    expect(await adapter(port).findAuthoritative()).toBeUndefined();
  });
  test("outsider forgery next to the real one does not create ambiguity — own message wins alone", async () => {
    const port = new FakeChannelPort();
    const own = row({ content: MARKER });
    port.rows = [row({ content: MARKER, author: { id: OUTSIDER } }), own];
    expect(await adapter(port).findAuthoritative()).toEqual({ messageId: own.id });
  });
  test("a row from a different channel is ignored even when own-authored and marked", async () => {
    const port = new FakeChannelPort();
    port.rows = [row({ content: MARKER, channel_id: "999888777666555444" })];
    expect(await adapter(port).findAuthoritative()).toBeUndefined();
  });
  test("webhook identity is rejected after normalization even when author.id equals the bot's own id", async () => {
    const port = new FakeChannelPort();
    port.rows = [row({ content: MARKER, webhook_id: "700000000000000009" })];
    expect(await adapter(port).findAuthoritative()).toBeUndefined();
  });
  test("malformed rows are isolated, not fatal", async () => {
    const port = new FakeChannelPort();
    const own = row({ content: MARKER });
    port.rows = [{ id: "not-a-snowflake", channel_id: CHANNEL, content: MARKER, author: { id: SELF } } as Row, own];
    expect(await adapter(port).findAuthoritative()).toEqual({ messageId: own.id });
  });
});

describe("bounded pagination", () => {
  test("finds a marker deeper than the first page of 50", async () => {
    const port = new FakeChannelPort();
    const older = row({ content: MARKER });
    const noise: Row[] = [];
    for (let i = 0; i < 70; i++) noise.push(row({ content: `noise ${i}`, author: { id: OUTSIDER } }));
    port.rows = [...noise.sort((a, b) => Number(BigInt(b.id) - BigInt(a.id))), older];
    const found = await adapter(port).findAuthoritative();
    expect(found).toEqual({ messageId: older.id });
    expect(port.getCalls).toBeGreaterThanOrEqual(2);
  });
  test("full pages through maxScan HOLD because absence is not authoritative", async () => {
    const port = new FakeChannelPort();
    const buried = row({ content: MARKER });
    const noise: Row[] = [];
    for (let i = 0; i < 110; i++) noise.push(row({ content: `noise ${i}`, author: { id: OUTSIDER } }));
    port.rows = [...noise.sort((a, b) => Number(BigInt(b.id) - BigInt(a.id))), buried];
    await expect(adapter(port, 100).findAuthoritative()).rejects.toThrow("pagination exhausted");
    expect(port.getCalls).toBe(2); // 100/50 pages, not one more
  });
  test("a port that repeats the same page cannot loop the adapter past its bound", async () => {
    const stuck: MarkerClientPort = {
      getMessages: async () => [row({ content: "noise", author: { id: OUTSIDER } })].map(r => ({ ...r, id: "4999" })),
      postMessage: async () => { throw new Error("unused"); },
    };
    expect(await adapter(stuck, 200).findAuthoritative()).toBeUndefined();
  });
});

describe(">1 own match is a HOLD", () => {
  test("two own marked messages on one page throw MarkerHoldError carrying both ids", async () => {
    const port = new FakeChannelPort();
    const a = row({ content: MARKER });
    const b = row({ content: `body\n${MARKER}` });
    port.rows = [b, a];
    await expect(adapter(port).findAuthoritative()).rejects.toBeInstanceOf(MarkerHoldError);
    try { await adapter(port).findAuthoritative(); } catch (e) {
      expect((e as MarkerHoldError).code).toBe("MARKER_HOLD");
      expect((e as MarkerHoldError).messageIds).toEqual([b.id, a.id]);
    }
  });
  test("ambiguity split across pages is still a HOLD", async () => {
    const port = new FakeChannelPort();
    const older = row({ content: MARKER });
    const noise: Row[] = [];
    for (let i = 0; i < 60; i++) noise.push(row({ content: `noise ${i}`, author: { id: OUTSIDER } }));
    const newer = row({ content: MARKER });
    port.rows = [newer, ...noise.sort((a, b) => Number(BigInt(b.id) - BigInt(a.id))), older];
    await expect(adapter(port).findAuthoritative()).rejects.toBeInstanceOf(MarkerHoldError);
  });
});

describe("ensureAuthoritative: idempotent establishment", () => {
  test("creates once with the marker as its own line, then reuses forever", async () => {
    const port = new FakeChannelPort();
    const first = await adapter(port).ensureAuthoritative("hello room");
    expect(first.created).toBe(true);
    expect(port.postCalls).toBe(1);
    expect(port.rows[0]!.content).toBe(`hello room\n${MARKER}`);
    const second = await adapter(port).ensureAuthoritative("hello again");
    expect(second).toEqual({ messageId: first.messageId, created: false });
    expect(port.postCalls).toBe(1); // no second post
  });
  test("POST accepted then disconnect → recovery by lookup, never a blind repost", async () => {
    const port = new FakeChannelPort();
    port.dropNextPostResponse = true; // server lands the row, response never arrives
    const result = await adapter(port).ensureAuthoritative("digest v1");
    expect(port.postCalls).toBe(1);          // exactly one POST — the recovery path did not repost
    expect(port.rows).toHaveLength(1);       // exactly one message in the room
    expect(result.messageId).toBe(port.rows[0]!.id);
    const again = await adapter(port).ensureAuthoritative("digest v1");
    expect(again.created).toBe(false);
    expect(port.postCalls).toBe(1);
  });
  test("POST that genuinely never landed propagates its error after lookup proves absence", async () => {
    const port = new FakeChannelPort();
    port.failNextPostBeforeLanding = true;
    await expect(adapter(port).ensureAuthoritative("x")).rejects.toThrow("connect refused");
    expect(port.rows).toHaveLength(0);
    expect(await adapter(port).findAuthoritative()).toBeUndefined();
  });
});
