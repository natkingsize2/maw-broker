import { admitsDiscordMessage } from "./adapter-discord";
import type { Broker } from "./broker";
import type { BrokerEnvelope, Decision, DownstreamInjector, InboundMessage } from "./types";
import { shouldAdvanceCursor, type CursorOutcome } from "./cursor-policy";

export class BrokerIngress {
  constructor(private readonly broker: Broker, private readonly allowedWebhookIds: ReadonlySet<string> = new Set()) {}
  async handle(input: InboundMessage, envelope: BrokerEnvelope, decision: Decision, inject: DownstreamInjector): Promise<{ outcome: CursorOutcome; cursor: "advance"|"hold" }> {
    if (input.authorIsBot && !input.webhookId) return { outcome: "OWNER_MISMATCH", cursor: "advance" };
    if (!admitsDiscordMessage(input, { allowedWebhookIds: this.allowedWebhookIds })) return { outcome: "OWNER_MISMATCH", cursor: "advance" };
    try { const result=await this.broker.receive(input,envelope,decision,inject); if(result.status === "resolved" || result.status === "replay") return {outcome:"RESOLVED",cursor:"advance"}; return {outcome:"INJECTOR_FAILURE",cursor:"hold"}; }
    catch (error) { const reason=String(error); if(reason.includes("foreign author")) return {outcome:"OWNER_MISMATCH",cursor:"advance"}; if(reason.includes("wrong route")) return {outcome:"CHANNEL_NOT_PROJECT",cursor:"advance"}; if(reason.includes("transport mismatch")) return {outcome:"TRANSPORT_FAILURE",cursor:"hold"}; return {outcome:"AUTH_FAILURE",cursor:"hold"}; }
  }
}
