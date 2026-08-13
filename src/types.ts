export type Decision = "allow" | "deny";

export type Route = {
  name: string;
  transport: string;
  destination: string;
  /** maw target that owns this room (e.g. "03-canon:0" or "mba:02-anvil"); phase-2 routing table. */
  agent?: string;
  /** git issue this room is the human face of, e.g. "natkingsize2/maw-broker#1" — the owner's
   *  phase-4 data model: git issue = source of truth, the Discord room references it. */
  issue?: string;
};

export type BrokerEnvelope = {
  version: 1;
  alg: "AES-256-GCM";
  route: string;
  messageId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
  transport: string;
  decision: Decision;
};

export type AuditRecord = {
  at: string;
  event: "accepted" | "rejected" | "resolved" | "replay" | "error" | "ignored";
  messageId?: string;
  route?: string;
  decision?: Decision;
  reason?: string;
};

export type InboundMessage = {
  messageId: string;
  authorId: string;
  content: string;
  route: string;
  transport?: string;
  authorIsBot?: boolean;
  webhookId?: string;
  observedAt?: string;
};

export type Ack = { messageId: string; route: string; accepted: true };
export type DownstreamInjector = (plaintext: string, messageId: string, route: string) => Promise<Ack>;

export interface TextAdapter {
  readonly transport: string;
  normalize(input: unknown): InboundMessage;
  encodeDecision(messageId: string, decision: Decision): string;
}
