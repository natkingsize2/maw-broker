import type { Decision, InboundMessage, TextAdapter } from "./types";

/** Discord text adapter: pure normalization only; it never sends or owns credentials. */
export class DiscordTextAdapter implements TextAdapter {
  readonly transport = "discord-text";
  normalize(input: any): InboundMessage {
    if (!input?.id || !input?.author?.id || !input?.channel_id) throw new Error("invalid Discord message");
    return { messageId: String(input.id), authorId: String(input.author.id), content: String(input.content ?? ""), route: String(input.channel_id), transport: "discord-text", authorIsBot: input.author.bot === true, webhookId: input.webhook_id ? String(input.webhook_id) : undefined, observedAt: input.timestamp };
  }
  encodeDecision(messageId: string, decision: Decision) { return `${messageId} ${decision}`; }
}

export type WebhookPolicy = { allowedWebhookIds?: ReadonlySet<string> };
export function admitsDiscordMessage(message: InboundMessage, policy: WebhookPolicy = {}): boolean {
  if (message.webhookId) return policy.allowedWebhookIds?.has(message.webhookId) === true;
  return message.authorIsBot !== true;
}
