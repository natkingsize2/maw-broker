import { open } from "./crypto";
import { DurableStore } from "./store";
import type { Ack, BrokerEnvelope, Decision, DownstreamInjector, InboundMessage, Route } from "./types";
import { RouteRegistry } from "./routes";

export const NAT_USER_ID = "358970717125214209";
export function validatedOwnerId(value = process.env.MAW_BROKER_OWNER_ID ?? NAT_USER_ID): string { if (!/^\d{17,20}$/.test(value)) throw new Error("owner id config invalid"); return value; }

export class Broker {
  constructor(private readonly key: Buffer, routes: ReadonlyMap<string, Route> | RouteRegistry, private readonly store: DurableStore, ownerId?: string) {
    this.routes = routes instanceof RouteRegistry ? routes : new RouteRegistry([...routes.values()]);
    this.ownerId = validatedOwnerId(ownerId);
  }
  private readonly ownerId: string;
  private readonly routes: RouteRegistry;

  async receive(input: InboundMessage, envelope: BrokerEnvelope, decision: Decision, inject: DownstreamInjector): Promise<{ status: "resolved" | "replay" | "pending"; plaintext?: string }> {
    if (decision !== "allow" && decision !== "deny") return this.reject(input, "invalid decision");
    const registered=this.routes.get(input.route); if (!registered || envelope.route !== input.route || envelope.transport !== registered.transport || registered.transport !== "discord-text") return this.reject(input, "wrong route or transport");
    if (input.authorId !== this.ownerId) return this.reject(input, "foreign author");
    if (envelope.messageId !== input.messageId) return this.reject(input, "message id mismatch");
    if (envelope.transport !== "discord-text" || envelope.decision !== decision) return this.reject(input, "decision or transport mismatch");
    let plaintext: string;
    try { plaintext = open(this.key, envelope); } catch { this.store.audit({ at: new Date().toISOString(), event: "error", messageId: input.messageId, route: input.route, reason: "authentication failed" }); throw new Error("envelope authentication failed"); }
    const state=this.store.begin(input.messageId); if(state==="resolved"){this.store.audit({at:new Date().toISOString(),event:"replay",messageId:input.messageId,route:input.route});return {status:"replay"};}
    this.store.audit({ at: new Date().toISOString(), event: "accepted", messageId: input.messageId, route: input.route, decision });
    if (decision === "allow") { let ack: Ack; try { ack=await inject(plaintext, input.messageId, input.route); } catch { return { status: "pending" }; } if (ack.messageId !== input.messageId || ack.route !== input.route || ack.accepted !== true) return { status: "pending" }; }
    this.store.markResolved(input.messageId);
    this.store.audit({ at: new Date().toISOString(), event: "resolved", messageId: input.messageId, route: input.route, decision });
    return decision === "allow" ? { status: "resolved", plaintext } : { status: "resolved" };
  }

  private reject(input: InboundMessage, reason: string): never {
    this.store.audit({ at: new Date().toISOString(), event: "rejected", messageId: input.messageId, route: input.route, reason });
    throw new Error(reason);
  }
}
