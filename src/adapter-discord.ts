import type { Decision, InboundMessage, TextAdapter } from "./types";

/** Discord text adapter: pure normalization only; it never sends or owns credentials. */
export class DiscordTextAdapter implements TextAdapter {
  readonly transport = "discord-text";
  normalize(input: any): InboundMessage {
    if (!input?.id || !input?.author?.id || !input?.channel_id) throw new Error("invalid Discord message");
    return { messageId: String(input.id), authorId: String(input.author.id), content: String(input.content ?? ""), route: String(input.channel_id), observedAt: input.timestamp };
  }
  encodeDecision(messageId: string, decision: Decision) { return `${messageId} ${decision}`; }
}
