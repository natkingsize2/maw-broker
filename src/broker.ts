import { open } from "./crypto";
import { DurableStore } from "./store";
import type { BrokerEnvelope, Decision, InboundMessage, Route } from "./types";
import { RouteRegistry } from "./routes";

export const NAT_USER_ID = "358970717125214209";

export class Broker {
  constructor(private readonly key: Buffer, routes: ReadonlyMap<string, Route> | RouteRegistry, private readonly store: DurableStore, private readonly ownerId = NAT_USER_ID) {
    this.routes = routes instanceof RouteRegistry ? routes : new RouteRegistry([...routes.values()]);
  }
  private readonly routes: RouteRegistry;

  receive(input: InboundMessage, envelope: BrokerEnvelope, decision: Decision): { status: "resolved" | "replay"; plaintext?: string } {
    if (decision !== "allow" && decision !== "deny") return this.reject(input, "invalid decision");
    if (!this.routes.has(input.route) || envelope.route !== input.route) return this.reject(input, "wrong route");
    if (input.authorId !== this.ownerId) return this.reject(input, "foreign author");
    if (this.store.has(input.messageId)) { this.store.audit({ at: new Date().toISOString(), event: "replay", messageId: input.messageId, route: input.route }); return { status: "replay" }; }
    if (envelope.messageId !== input.messageId) return this.reject(input, "message id mismatch");
    let plaintext: string;
    try { plaintext = open(this.key, envelope); } catch { this.store.audit({ at: new Date().toISOString(), event: "error", messageId: input.messageId, route: input.route, reason: "authentication failed" }); throw new Error("envelope authentication failed"); }
    this.store.audit({ at: new Date().toISOString(), event: "accepted", messageId: input.messageId, route: input.route, decision });
    this.store.markResolved(input.messageId);
    this.store.audit({ at: new Date().toISOString(), event: "resolved", messageId: input.messageId, route: input.route, decision });
    return { status: "resolved", plaintext };
  }

  private reject(input: InboundMessage, reason: string): never {
    this.store.audit({ at: new Date().toISOString(), event: "rejected", messageId: input.messageId, route: input.route, reason });
    throw new Error(reason);
  }
}
