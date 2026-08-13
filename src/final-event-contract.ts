/**
 * Broker final-event receipt contract — route `maw-pipecat` ONLY.
 *
 * Owner directive 2026-08-14 01:44 +07: a receipt endpoint matching schema
 * `livesiang.broker.final-event.v1` that validates route/event id/idempotency key/content
 * digest/credential, then returns an "accepted" or "duplicate" receipt. No existing schema by
 * this name was found anywhere in the fleet's repos or oracle (searched liveSiang, maw-broker,
 * canon's ψ/, oracle_search — nothing) — the shape below is therefore DESIGNED from the owner's
 * explicit constraints, not matched against a pre-existing spec. Full shape recorded in
 * `SPEC-final-event-receipt-v1.md` alongside this file.
 *
 * Deliberately standalone: imports NOTHING from `runner.ts`/`bridge-server.ts`/
 * `bridge-client.ts` — no Discord credential, no broker daemon, no live config anywhere in this
 * module's reachable graph (owner: "Do not use real token Discord broker daemon or live
 * config").
 */
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A THIRD, distinct credential from this refactor round — not the Discord bot token
 * (`bridge-server.ts`), not the local bridge auth token (`bridge-client.ts`), not the broker
 * envelope key (`runner.ts`). `MAW_PIPECAT_RECEIPT_TOKEN` authenticates a caller to THIS
 * contract only. Same 0600/no-symlink file-or-env pattern as every other secret in this repo.
 */
export type FinalEventSecrets = { authorizedToken: string };
export function loadFinalEventSecrets(env: Record<string, string | undefined> = process.env): FinalEventSecrets {
  try {
    let values: Record<string, string | undefined> = env;
    const path = env.MAW_PIPECAT_RECEIPT_SECRETS_FILE;
    if (path) {
      if (lstatSync(path).isSymbolicLink() || (statSync(path).mode & 0o777) !== 0o600) throw new Error();
      values = JSON.parse(readFileSync(path, "utf8"));
    }
    const token = values.MAW_PIPECAT_RECEIPT_TOKEN;
    if (typeof token !== "string" || !token) throw new Error();
    return { authorizedToken: token };
  } catch { throw new Error("final-event receipt configuration invalid"); }
}

export const SCHEMA = "livesiang.broker.final-event.v1";
export const ALLOWED_ROUTE = "maw-pipecat";
/** Event kinds this endpoint explicitly refuses — it exists for FINAL events only. Streaming
 *  audio/partial-transcript/TTS-chunk events belong on a different (unbuilt, out of scope) path;
 *  accepting them here would let a partial turn masquerade as a completed one downstream. */
export const REJECTED_KINDS = ["raw_audio", "partial", "assistant_tts"] as const;
export const ACCEPTED_KIND = "final";

export class FinalEventError extends Error {
  constructor(readonly code: "UNAUTHORIZED" | "MALFORMED_BODY" | "UNKNOWN_ROUTE" | "KIND_REJECTED" | "DIGEST_MISMATCH" | "IDEMPOTENCY_CONFLICT", message: string) {
    super(message); this.name = "FinalEventError";
  }
}

export type FinalEventRequest = {
  schema: string;
  route: string;
  kind: string;
  eventId: string;
  idempotencyKey: string;
  contentDigest: string;
  content: unknown;
};

export type FinalEventReceipt = {
  status: "accepted" | "duplicate";
  schema: string;
  route: string;
  eventId: string;
  idempotencyKey: string;
  contentDigest: string;
  receivedAt: string;
};

const DIGEST_RE = /^[a-f0-9]{64}$/;
const NONEMPTY_STRING_LIMIT = 256; // eventId/idempotencyKey are identifiers, not payloads

/** Deterministic digest independent of object key insertion order — two logically-identical
 *  content payloads built in different code paths must produce the SAME digest, or every
 *  legitimate retry would look like a conflict. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(",")}}`;
}
export function computeContentDigest(content: unknown): string {
  return createHash("sha256").update(canonicalize(content)).digest("hex");
}

function isNonEmptyBoundedString(v: unknown): v is string { return typeof v === "string" && v.length > 0 && v.length <= NONEMPTY_STRING_LIMIT; }

/** Validates shape/route/kind/digest-integrity — auth is checked by the caller BEFORE this runs
 *  (see `handleFinalEvent`), so a malformed body from an unauthenticated caller never gets this
 *  far, keeping the auth boundary the very first gate always. */
export function validateFinalEventRequest(body: unknown): FinalEventRequest {
  const b = body as Partial<FinalEventRequest> | null | undefined;
  if (!b || typeof b !== "object") throw new FinalEventError("MALFORMED_BODY", "body must be a JSON object");
  if (b.schema !== SCHEMA) throw new FinalEventError("MALFORMED_BODY", `schema must be exactly "${SCHEMA}"`);
  if (typeof b.route !== "string" || !b.route) throw new FinalEventError("MALFORMED_BODY", "route missing");
  if (typeof b.kind !== "string" || !b.kind) throw new FinalEventError("MALFORMED_BODY", "kind missing");
  if (!isNonEmptyBoundedString(b.eventId)) throw new FinalEventError("MALFORMED_BODY", "eventId missing or invalid");
  if (!isNonEmptyBoundedString(b.idempotencyKey)) throw new FinalEventError("MALFORMED_BODY", "idempotencyKey missing or invalid");
  if (typeof b.contentDigest !== "string" || !DIGEST_RE.test(b.contentDigest)) throw new FinalEventError("MALFORMED_BODY", "contentDigest must be a 64-hex-char sha256 digest");
  if (!("content" in b)) throw new FinalEventError("MALFORMED_BODY", "content missing");

  // Route check happens AFTER basic shape validation (a malformed body is malformed regardless
  // of route) but BEFORE kind check — "unknown route" and "kind rejected" are reported as
  // distinct, named reasons, never collapsed into one generic 400.
  if (b.route !== ALLOWED_ROUTE) throw new FinalEventError("UNKNOWN_ROUTE", `route "${b.route}" is not accepted here — only "${ALLOWED_ROUTE}"`);
  // Any kind other than "final" is rejected — including but not limited to the three the owner
  // named explicitly (REJECTED_KINDS documents the known/expected ones; this check is not
  // limited to that list, so an unlisted future kind fails closed too, not open).
  if (b.kind !== ACCEPTED_KIND) throw new FinalEventError("KIND_REJECTED", `event kind "${b.kind}" rejected — only "${ACCEPTED_KIND}" is accepted on this contract`);

  const actualDigest = computeContentDigest(b.content);
  if (actualDigest !== b.contentDigest) throw new FinalEventError("DIGEST_MISMATCH", "contentDigest does not match sha256 of content");

  return { schema: b.schema, route: b.route, kind: b.kind, eventId: b.eventId, idempotencyKey: b.idempotencyKey, contentDigest: b.contentDigest, content: b.content };
}

// ── durable idempotency store — same filesystem-safety idiom as FileMirrorStateStore/DurableCursor
type StoredRecord = { contentDigest: string; receipt: FinalEventReceipt };
export interface FinalEventStore {
  lookup(idempotencyKey: string): StoredRecord | undefined;
  record(idempotencyKey: string, value: StoredRecord): void;
}
export class FileFinalEventStore implements FinalEventStore {
  private cache: Map<string, StoredRecord>;
  constructor(readonly path: string) {
    const root = dirname(path);
    if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error("final-event store path invalid");
    mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
    this.cache = this.load();
  }
  private load(): Map<string, StoredRecord> {
    if (!existsSync(this.path)) return new Map();
    const st = lstatSync(this.path);
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o600) throw new Error("final-event store corrupt");
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.path, "utf8")); } catch { throw new Error("final-event store corrupt"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("final-event store corrupt");
    return new Map(Object.entries(parsed as Record<string, StoredRecord>));
  }
  lookup(idempotencyKey: string): StoredRecord | undefined { return this.cache.get(idempotencyKey); }
  record(idempotencyKey: string, value: StoredRecord): void {
    this.cache.set(idempotencyKey, value);
    const obj = Object.fromEntries(this.cache);
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(obj) + "\n", { encoding: "utf8", mode: 0o600 });
    const fd = openSync(tmp, "r"); fsyncSync(fd); closeSync(fd);
    renameSync(tmp, this.path);
    const dirfd = openSync(dirname(this.path), "r"); fsyncSync(dirfd); closeSync(dirfd);
    chmodSync(this.path, 0o600);
  }
}
export class InMemoryFinalEventStore implements FinalEventStore {
  private readonly map = new Map<string, StoredRecord>();
  lookup(idempotencyKey: string) { return this.map.get(idempotencyKey); }
  record(idempotencyKey: string, value: StoredRecord) { this.map.set(idempotencyKey, value); }
}

export type FinalEventAuth = { authorizedToken: string };
export function checkAuth(headerValue: string | null | undefined, auth: FinalEventAuth): void {
  if (headerValue !== `Bearer ${auth.authorizedToken}`) throw new FinalEventError("UNAUTHORIZED", "missing or wrong credential");
}

/**
 * Core handler — auth FIRST (never even parse/validate the body for an unauthenticated caller),
 * then shape/route/kind/digest validation, then idempotency resolution:
 *   - unseen idempotencyKey ⇒ ACCEPT, store, return a fresh receipt
 *   - seen idempotencyKey + SAME contentDigest ⇒ DUPLICATE, return the ORIGINAL stored receipt
 *     verbatim (same receivedAt) — the caller gets proof this is a safe replay, not new work
 *   - seen idempotencyKey + DIFFERENT contentDigest ⇒ CONFLICT — refused, never silently
 *     overwritten (silently accepting the new body would mean the first accepted receipt no
 *     longer describes what's stored under that key, breaking every consumer that trusted it)
 */
export function handleFinalEvent(
  authHeader: string | null | undefined,
  body: unknown,
  store: FinalEventStore,
  auth: FinalEventAuth,
  now: () => string = () => new Date().toISOString(),
): FinalEventReceipt {
  checkAuth(authHeader, auth);
  const req = validateFinalEventRequest(body);
  const existing = store.lookup(req.idempotencyKey);
  if (existing) {
    if (existing.contentDigest !== req.contentDigest) throw new FinalEventError("IDEMPOTENCY_CONFLICT", `idempotencyKey "${req.idempotencyKey}" already recorded with a different contentDigest`);
    return { ...existing.receipt, status: "duplicate" };
  }
  const receipt: FinalEventReceipt = { status: "accepted", schema: req.schema, route: req.route, eventId: req.eventId, idempotencyKey: req.idempotencyKey, contentDigest: req.contentDigest, receivedAt: now() };
  store.record(req.idempotencyKey, { contentDigest: req.contentDigest, receipt });
  return receipt;
}
