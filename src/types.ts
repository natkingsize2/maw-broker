export type Decision = "allow" | "deny";

export type Route = {
  name: string;
  transport: string;
  destination: string;
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
  event: "accepted" | "rejected" | "resolved" | "replay" | "error";
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
  observedAt?: string;
};

export interface TextAdapter {
  readonly transport: string;
  normalize(input: unknown): InboundMessage;
  encodeDecision(messageId: string, decision: Decision): string;
}
