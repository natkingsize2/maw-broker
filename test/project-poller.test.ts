import { describe, expect, test } from "bun:test";
import { ProjectPoller, type CursorLike, type WakePublisher } from "../src/project-poller";
import type { ProjectRoute } from "../src/project-routes";

const OWNER = "111111111111111111";
const ROUTE: ProjectRoute = {
  name: "livesiang", transport: "discord-text", destination: "1537404238861438996",
  agent: "03-canon:1", issue: "natkingsize2/liveSiang#15", mqtt: "canon",
};

function row(id: string, authorId: string, content: string, extra: Record<string, unknown> = {}) {
  return { id, author: { id: authorId, bot: false }, content, timestamp: "2026-08-13T19:30:00+07:00", channel_id: ROUTE.destination, ...extra };
}

class MemoryCursor implements CursorLike {
  after: string | undefined;
  read() { return this.after; }
  advance(after: string) { this.after = after; }
}

class RecordingPublisher implements WakePublisher {
  published: Array<{ topic: string; payload: string }> = [];
  failTimes = 0;
  async publish(topic: string, payload: string) {
    if (this.failTimes > 0) { this.failTimes--; throw new Error("mqtt publish failed"); }
    this.published.push({ topic, payload });
  }
}

function makeClient(rows: unknown[]) {
  const reactions: Array<{ messageId: string; emoji: string }> = [];
  return {
    reactions,
    asked: [] as Array<string | undefined>,
    async getMessages(_channel: string, after?: string) { this.asked.push(after); return rows; },
    async react(_channel: string, messageId: string, emoji: string) { reactions.push({ messageId, emoji }); },
  };
}

describe("ProjectPoller", () => {
  test("forwards owner text to <mqtt>/<project>/in with the arra-mqtt contract, advances cursor, reacts 👀", async () => {
    const client = makeClient([row("100000000000000002", OWNER, "สั่งงานสอง"), row("100000000000000001", OWNER, "สั่งงานหนึ่ง")]);
    const publisher = new RecordingPublisher();
    const cursor = new MemoryCursor();
    const poller = new ProjectPoller(client, OWNER, publisher, () => cursor);
    const outcome = await poller.pollOnce(ROUTE);

    expect(outcome).toEqual({ forwarded: 2, skipped: 0, held: 0 });
    expect(publisher.published[0]!.topic).toBe("canon/livesiang/in");
    const first = JSON.parse(publisher.published[0]!.payload);
    expect(first.content).toBe("สั่งงานหนึ่ง");                    // oldest first, not Discord's newest-first
    expect(first.meta.chat_id).toBe("livesiang");
    expect(first.meta.message_id).toBe("100000000000000001");
    expect(cursor.after).toBe("100000000000000002");
    expect(client.reactions.map(r => r.emoji)).toEqual(["👀", "👀"]);
  });

  test("bot, webhook, and non-owner messages are skipped but still advance the cursor", async () => {
    const client = makeClient([
      row("100000000000000001", "222222222222222222", "คนอื่น"),
      row("100000000000000002", OWNER, "bot", { author: { id: OWNER, bot: true } }),
      row("100000000000000003", OWNER, "webhook", { webhook_id: "333333333333333333" }),
    ]);
    const publisher = new RecordingPublisher();
    const cursor = new MemoryCursor();
    const outcome = await new ProjectPoller(client, OWNER, publisher, () => cursor).pollOnce(ROUTE);
    expect(outcome).toEqual({ forwarded: 0, skipped: 3, held: 0 });
    expect(publisher.published).toHaveLength(0);
    expect(cursor.after).toBe("100000000000000003");
  });

  test("publish failure holds the cursor at the failed message — at-least-once, no loss", async () => {
    const client = makeClient([row("100000000000000002", OWNER, "สอง"), row("100000000000000001", OWNER, "หนึ่ง")]);
    const publisher = new RecordingPublisher();
    publisher.failTimes = 1;
    const cursor = new MemoryCursor();
    const poller = new ProjectPoller(client, OWNER, publisher, () => cursor);

    const held = await poller.pollOnce(ROUTE);
    expect(held).toEqual({ forwarded: 0, skipped: 0, held: 1 });
    expect(cursor.after).toBeUndefined();                          // nothing committed past the failure

    const retry = await poller.pollOnce(ROUTE);                    // next cycle re-reads from the same cursor
    expect(retry.forwarded).toBe(2);
    expect(cursor.after).toBe("100000000000000002");
  });

  test("a failed 👀 after a committed cursor loses the eye, never the forward", async () => {
    const client = makeClient([row("100000000000000001", OWNER, "หนึ่ง")]);
    client.react = async () => { throw new Error("no reaction perms"); };
    const publisher = new RecordingPublisher();
    const cursor = new MemoryCursor();
    const outcome = await new ProjectPoller(client, OWNER, publisher, () => cursor).pollOnce(ROUTE);
    expect(outcome.forwarded).toBe(1);
    expect(cursor.after).toBe("100000000000000001");
  });

  test("refuses a route without mqtt prefix and a malformed owner id", async () => {
    const client = makeClient([]);
    const poller = new ProjectPoller(client, OWNER, new RecordingPublisher(), () => new MemoryCursor());
    await expect(poller.pollOnce({ ...ROUTE, mqtt: undefined })).rejects.toThrow("no mqtt prefix");
    expect(() => new ProjectPoller(client, "not-a-snowflake", new RecordingPublisher(), () => new MemoryCursor())).toThrow("owner invalid");
  });
});
