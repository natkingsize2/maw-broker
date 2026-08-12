import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { BrokerEnvelope, Decision } from "./types";

const AAD = (route: string, messageId: string, transport: string, decision: Decision) => Buffer.from(`maw-broker:v1:${route}:${messageId}:${transport}:${decision}`);
const b64 = (v: string, name: string) => { if (!/^[A-Za-z0-9+/]*={0,2}$/.test(v)) throw new Error(`${name} invalid encoding`); return Buffer.from(v, "base64"); };

export function keyFromBase64(value: string | undefined = process.env.MAW_BROKER_KEY_B64): Buffer {
  if (!value) throw new Error("broker key missing");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("broker key must decode to 32 bytes");
  return key;
}

export function seal(key: Buffer, route: string, messageId: string, plaintext: string, transport = "discord-text", decision: Decision = "allow"): BrokerEnvelope {
  if (key.length !== 32) throw new Error("broker key must be 32 bytes");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(AAD(route, messageId, transport, decision));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { version: 1, alg: "AES-256-GCM", route, messageId, nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64"), transport, decision };
}

export function open(key: Buffer, envelope: BrokerEnvelope): string {
  if (envelope.version !== 1 || envelope.alg !== "AES-256-GCM") throw new Error("unsupported envelope");
  if (key.length !== 32) throw new Error("broker key must be 32 bytes");
  if (!envelope.transport || (envelope.decision !== "allow" && envelope.decision !== "deny")) throw new Error("envelope fields invalid");
  const nonce=b64(envelope.nonce,"nonce"), tag=b64(envelope.tag,"tag"), ciphertext=b64(envelope.ciphertext,"ciphertext");
  if (nonce.length !== 12) throw new Error("nonce must be 12 bytes");
  if (tag.length !== 16) throw new Error("tag must be 16 bytes");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(AAD(envelope.route, envelope.messageId, envelope.transport, envelope.decision));
  decipher.setAuthTag(tag);
  try { return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"); } catch { throw new Error("envelope authentication failed"); }
}
