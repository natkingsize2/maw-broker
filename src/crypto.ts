import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { BrokerEnvelope } from "./types";

const AAD = (route: string, messageId: string) => Buffer.from(`maw-broker:v1:${route}:${messageId}`);

export function keyFromBase64(value: string | undefined = process.env.MAW_BROKER_KEY_B64): Buffer {
  if (!value) throw new Error("broker key missing");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("broker key must decode to 32 bytes");
  return key;
}

export function seal(key: Buffer, route: string, messageId: string, plaintext: string): BrokerEnvelope {
  if (key.length !== 32) throw new Error("broker key must be 32 bytes");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(AAD(route, messageId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { version: 1, alg: "AES-256-GCM", route, messageId, nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function open(key: Buffer, envelope: BrokerEnvelope): string {
  if (envelope.version !== 1 || envelope.alg !== "AES-256-GCM") throw new Error("unsupported envelope");
  if (key.length !== 32) throw new Error("broker key must be 32 bytes");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
  decipher.setAAD(AAD(envelope.route, envelope.messageId));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
}
