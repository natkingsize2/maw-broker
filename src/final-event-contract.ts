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
 * ALIGNED 2026-08-14 02:18: owner specified `content`'s exact key set (see
 * `LiveSiangFinalEventContent` below) plus two cross-field rules (eventId ==
 * content.event_id; idempotencyKey == a fixed prefix + eventId) — a Python builder will
 * implement a mapping against this file's committed test vector
 * (`test/fixtures/final-event-vector-v1.json`), so the canonicalization/digest algorithm is
 * documented precisely enough for byte-identical cross-language reproduction.
 *
 * CORRECTED 2026-08-14 02:45: the 02:18 commit (`8f8fbd17`) DEFINED `event_type`/`source`/the
 * idempotencyKey separator as placeholders, flagged explicitly as unconfirmed. Owner has now
 * supplied the real values — "these are producer constants already tested in liveSiang" — which
 * OVERRIDE those placeholders: `event_type="conversation.user.final"` (was `"final"`),
 * `source="pipecat:1.6.0"` (was `"maw-pipecat"`), idempotencyKey uses a COLON separator (was no
 * separator). The old placeholder values are now explicitly REJECTED, not merely superseded —
 * see the `test/final-event-contract.test.ts` cases proving `event_type: "final"`,
 * `source: "maw-pipecat"`, and a no-colon idempotencyKey each fail closed.
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

/**
 * Content literals — CONFIRMED real liveSiang producer constants (owner, 2026-08-14 02:45):
 * "These are producer constants already tested in liveSiang and override 8f8fbd17 placeholder
 * literals." The 02:18 commit's `event_type="final"` / `source="maw-pipecat"` were explicitly
 * flagged placeholders pending confirmation — this is that confirmation, with different real
 * values. `content.schema` was already correct (owner: "content.schema remains
 * livesiang.broker.final-event.v1").
 */
export const CONTENT_EVENT_TYPE = "conversation.user.final";
export const CONTENT_SOURCE = "pipecat:1.6.0";
/** OLD placeholder values, kept as named constants ONLY so tests can assert they are now
 *  actively rejected (not just "no longer the default") — never used in any accept path. */
export const OBSOLETE_CONTENT_EVENT_TYPE_PLACEHOLDER = "final";
export const OBSOLETE_CONTENT_SOURCE_PLACEHOLDER = "maw-pipecat";

/** idempotencyKey formula — CORRECTED 2026-08-14 02:45: owner's exact wording this round was
 *  "livesiang-final-v1 colon eventId exactly" — a colon separator, explicitly named this time
 *  (the 02:18 round had no separator specified, so none was used; that is now superseded). */
export const IDEMPOTENCY_KEY_PREFIX = "livesiang-final-v1";
export const IDEMPOTENCY_KEY_SEPARATOR = ":";
export function buildIdempotencyKey(eventId: string): string { return `${IDEMPOTENCY_KEY_PREFIX}${IDEMPOTENCY_KEY_SEPARATOR}${eventId}`; }

export type LiveSiangFinalEventContent = {
  conversation_id: string;
  event_id: string;
  event_type: string;
  final_text: string;
  locale: string;
  occurred_at: string;
  schema: string;
  source: string;
  turn_id: string;
};
/** Exact, closed key set — order-independent (checked as a sorted-array equality), and no key
 *  may be missing OR extra. An event carrying any additional key (e.g. a raw-audio byte buffer
 *  smuggled alongside a well-formed final_text) is rejected outright, not stripped-and-accepted. */
const CONTENT_REQUIRED_KEYS = ["conversation_id", "event_id", "event_type", "final_text", "locale", "occurred_at", "schema", "source", "turn_id"] as const;
const OCCURRED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const FINAL_TEXT_LIMIT = 4000; // a completed turn's transcript, not an identifier — larger bound than eventId/idempotencyKey

export class FinalEventError extends Error {
  constructor(readonly code: "UNAUTHORIZED" | "MALFORMED_BODY" | "UNKNOWN_ROUTE" | "KIND_REJECTED" | "DIGEST_MISMATCH" | "CONTENT_REJECTED" | "EVENT_ID_MISMATCH" | "IDEMPOTENCY_KEY_FORMAT" | "IDEMPOTENCY_CONFLICT", message: string) {
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
  content: LiveSiangFinalEventContent;
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

function isNonEmptyBoundedField(v: unknown, limit: number): v is string { return typeof v === "string" && v.length > 0 && v.length <= limit; }

/** Validates the content object's OWN shape/literals — called only after the envelope's digest
 *  has already been confirmed to match (see `validateFinalEventRequest`), so a structurally
 *  invalid content object is reported distinctly from a merely-tampered one. */
function validateContent(content: unknown): LiveSiangFinalEventContent {
  if (!content || typeof content !== "object" || Array.isArray(content)) throw new FinalEventError("CONTENT_REJECTED", "content must be a JSON object");
  const c = content as Record<string, unknown>;
  const actualKeys = Object.keys(c).sort();
  const expectedKeys = [...CONTENT_REQUIRED_KEYS].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((k, i) => k !== expectedKeys[i])) {
    const missing = expectedKeys.filter(k => !actualKeys.includes(k));
    const unknown = actualKeys.filter(k => !expectedKeys.includes(k as typeof CONTENT_REQUIRED_KEYS[number]));
    throw new FinalEventError("CONTENT_REJECTED", `content key set invalid — missing: [${missing.join(",")}] unknown: [${unknown.join(",")}]`);
  }
  for (const key of ["conversation_id", "event_id", "locale", "turn_id"] as const) {
    if (!isNonEmptyBoundedField(c[key], NONEMPTY_STRING_LIMIT)) throw new FinalEventError("CONTENT_REJECTED", `content.${key} missing or invalid`);
  }
  if (!isNonEmptyBoundedField(c.final_text, FINAL_TEXT_LIMIT)) throw new FinalEventError("CONTENT_REJECTED", "content.final_text missing or invalid");
  if (typeof c.occurred_at !== "string" || !OCCURRED_AT_RE.test(c.occurred_at)) throw new FinalEventError("CONTENT_REJECTED", "content.occurred_at must be an ISO8601 UTC timestamp");
  if (c.event_type !== CONTENT_EVENT_TYPE) throw new FinalEventError("CONTENT_REJECTED", `content.event_type "${c.event_type}" rejected — only "${CONTENT_EVENT_TYPE}" is accepted`);
  if (c.source !== CONTENT_SOURCE) throw new FinalEventError("CONTENT_REJECTED", `content.source "${c.source}" rejected — only "${CONTENT_SOURCE}" is accepted`);
  if (c.schema !== SCHEMA) throw new FinalEventError("CONTENT_REJECTED", `content.schema must be exactly "${SCHEMA}"`);
  return c as unknown as LiveSiangFinalEventContent;
}

/** Validates envelope shape/route/kind/digest-integrity, then the content object's own strict
 *  shape, then the two cross-field rules the owner added 2026-08-14 02:18 (eventId must equal
 *  content.event_id; idempotencyKey must equal the fixed prefix + eventId). Auth is checked by
 *  the caller BEFORE this runs (see `handleFinalEvent`), so a malformed body from an
 *  unauthenticated caller never gets this far, keeping the auth boundary the very first gate
 *  always. */
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

  const content = validateContent(b.content);

  if (b.eventId !== content.event_id) throw new FinalEventError("EVENT_ID_MISMATCH", "eventId must equal content.event_id");
  const expectedIdempotencyKey = buildIdempotencyKey(b.eventId);
  if (b.idempotencyKey !== expectedIdempotencyKey) throw new FinalEventError("IDEMPOTENCY_KEY_FORMAT", `idempotencyKey must equal "${IDEMPOTENCY_KEY_PREFIX}${IDEMPOTENCY_KEY_SEPARATOR}" + eventId (expected "${expectedIdempotencyKey}")`);

  return { schema: b.schema, route: b.route, kind: b.kind, eventId: b.eventId, idempotencyKey: b.idempotencyKey, contentDigest: b.contentDigest, content };
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
