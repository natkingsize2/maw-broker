import { DiscordTextAdapter } from "./adapter-discord";
import type { InboundMessage } from "./types";

export type DiscordClient = { getMessages(channelId: string, after?: string, limit?: number): Promise<unknown[]> };

export class DiscordPollSource {
  private readonly adapter = new DiscordTextAdapter();
  constructor(private readonly client: DiscordClient, private readonly channelId: string) {}
  async poll(after?: string): Promise<InboundMessage[]> {
    const rows = await this.client.getMessages(this.channelId, after, 50);
    const out: InboundMessage[] = [];
    for (const row of rows) { try { out.push(this.adapter.normalize(row)); } catch { /* malformed row is isolated; cursor owner audits/advances it */ } }
    return out;
  }
}
