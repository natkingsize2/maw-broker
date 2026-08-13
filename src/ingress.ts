import { admitsDiscordMessage } from "./adapter-discord";
import { BrokerError, type Broker } from "./broker";
import type { BrokerEnvelope, Decision, DownstreamInjector, InboundMessage } from "./types";
import { shouldAdvanceCursor, type CursorOutcome } from "./cursor-policy";

export class BrokerIngress {
  constructor(private readonly broker: Broker, private readonly allowedWebhookIds: ReadonlySet<string> = new Set()) {}
  async handle(input: InboundMessage, envelope: BrokerEnvelope, decision: Decision, inject: DownstreamInjector): Promise<{ outcome: CursorOutcome; cursor: "advance"|"hold" }> {
    if (input.authorIsBot && !input.webhookId) return this.result("OWNER_MISMATCH");
    if (!admitsDiscordMessage(input, { allowedWebhookIds: this.allowedWebhookIds })) return this.result("OWNER_MISMATCH");
    try { const result=await this.broker.receive(input,envelope,decision,inject); return this.result(result.status === "resolved" || result.status === "replay" ? "RESOLVED" : "INJECTOR_FAILURE"); }
    catch (error) { return this.result(error instanceof BrokerError ? error.code : "CONFIG_FAILURE"); }
  }
  async ignore(input: InboundMessage): Promise<{ outcome: CursorOutcome; cursor: "advance"|"hold" }> {
    if (input.authorIsBot && !input.webhookId) { this.broker.rejectOwnerMismatch(input); return this.result("OWNER_MISMATCH"); }
    if (!admitsDiscordMessage(input, { allowedWebhookIds: this.allowedWebhookIds })) { this.broker.rejectOwnerMismatch(input); return this.result("OWNER_MISMATCH"); }
    if (!this.broker.isOwner(input.authorId)) { this.broker.rejectOwnerMismatch(input); return this.result("OWNER_MISMATCH"); }
    this.broker.ignore(input); return this.result("IGNORED");
  }
  private result(outcome: CursorOutcome): { outcome: CursorOutcome; cursor: "advance"|"hold" } { return { outcome, cursor: shouldAdvanceCursor(outcome) ? "advance" : "hold" }; }
}
