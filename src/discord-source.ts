import { DiscordTextAdapter } from "./adapter-discord";
import type { InboundMessage } from "./types";

export type DiscordClient = { getMessages(channelId: string, before?: string, limit?: number): Promise<unknown[]> };

export class DiscordPollSource {
  private readonly adapter = new DiscordTextAdapter();
  constructor(private readonly client: DiscordClient, private readonly channelId: string) {}
  async poll(before?: string): Promise<InboundMessage[]> {
    const rows = await this.client.getMessages(this.channelId, before, 50);
    return rows.map(row => this.adapter.normalize(row));
  }
}
