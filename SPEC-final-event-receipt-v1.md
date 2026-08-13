# Final-event receipt contract — `livesiang.broker.final-event.v1`

Owner directive, 2026-08-14 01:44 +07: implement and test a broker final-event receipt contract
for route `maw-pipecat` only. **No existing schema by this name was found** — searched
`liveSiang`, `maw-broker`, canon's `ψ/`, and `oracle_search` — so this document is the
authoritative definition, designed from the owner's explicit constraints, not matched against a
prior spec. Code: `src/final-event-contract.ts` (pure logic) + `src/final-event-server.ts`
(local-only HTTP wrapper).

**Standalone by construction**: this contract imports nothing from `runner.ts`,
`bridge-server.ts`, or `bridge-client.ts`. It holds no Discord credential, starts no Discord
bridge, touches no live config. It is a separate local HTTP service on its own port with its
own credential.

**ALIGNED 2026-08-14 02:18 +07**: the owner specified `content`'s exact key set and two
cross-field rules. A Python builder will implement an independent mapping against this document
and the committed test vector `test/fixtures/final-event-vector-v1.json` — every algorithmic
detail below is written for that: precise enough to reproduce byte-identical digests across
languages, not just "close enough".

## Scope

- Route: `maw-pipecat` **only**. Any other route value is refused.
- Event kind: `final` **only**. `raw_audio`, `partial`, `assistant_tts`, and any other kind are
  refused — this endpoint exists for completed turns, not streaming/intermediate events.

## Request

```
POST /final-event
Authorization: Bearer <MAW_PIPECAT_RECEIPT_TOKEN>
Content-Type: application/json

{
  "schema": "livesiang.broker.final-event.v1",
  "route": "maw-pipecat",
  "kind": "final",
  "eventId": "<must equal content.event_id, see cross-field rules>",
  "idempotencyKey": "<must equal 'livesiang-final-v1' + eventId, see cross-field rules>",
  "contentDigest": "<sha256 hex, 64 chars, of the canonical form of `content`>",
  "content": { "...": "see § content schema below — a CLOSED 9-key object, not opaque" }
}
```

`contentDigest` = `sha256(canonicalize(content))`, where `canonicalize` recursively sorts object
keys before serializing (see `canonicalize()` in the code) — so two logically-identical payloads
built by different code paths always produce the same digest, regardless of key insertion order.

### content schema (owner-specified key set, 2026-08-14 02:18)

Exactly these 9 keys — no more, no fewer. Extra or missing keys are refused (`CONTENT_REJECTED`).

| key | type | constraint |
|---|---|---|
| `conversation_id` | string | non-empty, ≤256 chars |
| `event_id` | string | non-empty, ≤256 chars, **must equal the envelope's `eventId`** |
| `event_type` | string | **must equal exactly `"final"`** |
| `final_text` | string | non-empty, ≤4000 chars — the completed turn's text (may be any language, e.g. Thai) |
| `locale` | string | non-empty, ≤256 chars, e.g. `"th-TH"` |
| `occurred_at` | string | ISO8601 UTC, e.g. `"2026-08-14T02:20:00.000Z"` (regex: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$`) |
| `schema` | string | **must equal exactly `"livesiang.broker.final-event.v1"`** (same identifier as the envelope's own `schema`) |
| `source` | string | **must equal exactly `"maw-pipecat"`** |
| `turn_id` | string | non-empty, ≤256 chars |

⚠️ **The owner gave the key NAMES but not the required literal VALUES for `event_type`,
`source`, and `content.schema`.** No prior liveSiang schema exists anywhere to read these from
(confirmed absent — see file header). The three literal values above (`event_type: "final"`,
`source: "maw-pipecat"`, `schema` reusing the one identifier the owner did give) are **DEFINED
by this document, not matched against a prior spec** — they are the most defensible reading of
the owner's constraints (mirrors the envelope's own `kind: "final"`; reuses the exact route name
the owner already gave verbatim), but they are a design decision requiring confirmation, not a
fact. If the Python builder's real liveSiang code emits different literal values here, that is
the signal to correct — this document, not silently — not evidence this document is wrong on
its own.

### Cross-field rules (owner 2026-08-14 02:18)

- **`eventId` must equal `content.event_id`.** Mismatch ⇒ `EVENT_ID_MISMATCH` (400).
- **`idempotencyKey` must equal `"livesiang-final-v1"` concatenated directly with `eventId` —
  literal string concatenation, NO separator.** The owner's exact wording was *"idempotencyKey
  must equal livesiang-final-v1 plus eventId"* — no separator character was specified, so none
  is used. For `eventId = "evt-th-0001"`, the required `idempotencyKey` is
  `"livesiang-final-v1evt-th-0001"` (see the committed test vector — this exact string is in
  it). A plausible-but-wrong guess with a separator (e.g. `"livesiang-final-v1:evt-th-0001"`)
  is refused with `IDEMPOTENCY_KEY_FORMAT` (400), naming the expected value in the error message.

### Digest algorithm — precise enough for cross-language (Python) reproduction

`canonicalize(content)`: recursively sort object keys, then serialize with **compact separators**
(`,` between items, `:` between key and value — no spaces), strings via standard JSON string
escaping, **non-ASCII characters emitted RAW (UTF-8), never escaped to `\uXXXX`**. Then
`sha256(utf8_bytes_of_that_string)`, hex-encoded lowercase.

A Python implementation MUST use:
```python
import json, hashlib
canonical = json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
```
**`ensure_ascii=False` is not optional.** Python's `json.dumps` defaults to escaping non-ASCII
to `\uXXXX` — the committed test vector's Thai `final_text` will produce a **different (wrong)**
digest if that default is left on. This is exactly the kind of cross-language footgun a Thai-text
test vector exists to catch immediately, not eventually.

## Receipt (success, HTTP 200)

```json
{
  "status": "accepted",
  "schema": "livesiang.broker.final-event.v1",
  "route": "maw-pipecat",
  "eventId": "evt-1",
  "idempotencyKey": "idem-1",
  "contentDigest": "…64 hex…",
  "receivedAt": "2026-08-14T01:50:00.000Z"
}
```

or, for a replay of an already-accepted `idempotencyKey` with the **same** `contentDigest`:

```json
{ "status": "duplicate", "...": "same fields, receivedAt is the ORIGINAL timestamp, not now" }
```

A `duplicate` receipt is byte-for-byte the original `accepted` receipt except `status`. The
caller can trust `receivedAt` as proof this is a safe replay of prior work, not new work.

## Rejections

| condition | HTTP | `error` code | notes |
|---|---|---|---|
| missing/wrong `Authorization` | 401 | `UNAUTHORIZED` | checked **before** the body is parsed for validation — an unauthenticated caller never learns whether their body was even well-formed |
| not valid JSON | 400 | (server: `"malformed body"`) | |
| wrong/missing `schema`, missing/invalid `eventId`/`idempotencyKey`/`contentDigest`/`content` | 400 | `MALFORMED_BODY` | |
| `route` ≠ `"maw-pipecat"` | 400 | `UNKNOWN_ROUTE` | |
| `kind` ≠ `"final"` | 400 | `KIND_REJECTED` | includes `raw_audio`/`partial`/`assistant_tts` AND any unlisted kind — fail closed, not an allowlist gap |
| `contentDigest` doesn't match `sha256(canonicalize(content))` | 400 | `DIGEST_MISMATCH` | integrity check, distinct from idempotency conflict below — checked BEFORE content shape, so tampered bytes are caught before their structure is even inspected |
| `content` has missing/unknown/extra keys vs the exact 9-key set | 400 | `CONTENT_REJECTED` | names the specific missing/unknown keys in the message |
| `content.event_type` ≠ `"final"`, `content.source` ≠ `"maw-pipecat"`, or `content.schema` ≠ `"livesiang.broker.final-event.v1"` | 400 | `CONTENT_REJECTED` | includes `raw_audio`/`partial`/`assistant_tts` as `event_type` values, same rejection reasoning as the envelope `kind` field |
| `content.final_text` empty or >4000 chars, `content.occurred_at` not ISO8601 UTC, or any other content field empty/oversized | 400 | `CONTENT_REJECTED` | |
| `eventId` ≠ `content.event_id` | 400 | `EVENT_ID_MISMATCH` | |
| `idempotencyKey` ≠ `"livesiang-final-v1" + eventId` | 400 | `IDEMPOTENCY_KEY_FORMAT` | names the expected value in the error message |
| same `idempotencyKey`, **different** `contentDigest` than what's stored | 409 | `IDEMPOTENCY_CONFLICT` | the ALREADY-STORED record is never overwritten or mutated |
| unknown path / wrong method | 404 | — | |

A rejected request (any code above) records **nothing** in the idempotency store — a bad request
retried correctly later is a first accept, not stuck behind a half-written record.

## Idempotency semantics

| `idempotencyKey` seen before? | `contentDigest` matches stored? | result |
|---|---|---|
| no | — | **accept**, store `{idempotencyKey → {contentDigest, receipt}}` |
| yes | yes | **duplicate** — return the stored receipt verbatim (status swapped to `duplicate`) |
| yes | no | **conflict** (409) — refused, stored record untouched |

## Credential

`MAW_PIPECAT_RECEIPT_TOKEN` — a **third**, distinct secret from this refactor round: not the
Discord bot token (`bridge-server.ts`), not the local bridge auth token (`bridge-client.ts`),
not the broker envelope key (`runner.ts`). Loaded via `loadFinalEventSecrets()`, same
0600/no-symlink file-or-env pattern as every other secret in this repo
(`MAW_PIPECAT_RECEIPT_SECRETS_FILE` optional override, else raw env vars).

## Transport

Local-only HTTP (`startFinalEventServer`, `src/final-event-server.ts`): binds `127.0.0.1` only
(refuses any other hostname at construction), its own port
(`MAW_PIPECAT_RECEIPT_PORT`, default `8792`), fully independent of the Discord bridge's port
and credential. Tested with a real `Bun.serve` + real `fetch` round trip and an in-memory fake
store — no real token, no Discord call, no live config, per the owner's "local in-memory HTTP
only" scope.

## Durable store

`FileFinalEventStore` (`src/final-event-contract.ts`): one JSON file,
`{idempotencyKey → {contentDigest, receipt}}`, 0700 dir / 0600 file, atomic write (tmp + fsync +
rename, directory fsync), symlink-refusing, corrupt-shape-refusing — same safety idiom as
`FileMirrorStateStore` and `DurableCursor` elsewhere in this repo. `InMemoryFinalEventStore` is
provided for tests and for any caller that intentionally wants no cross-restart durability.

## Test vector (Thai text, exact contentDigest)

`test/fixtures/final-event-vector-v1.json` — a real request built from the schema above, with a
Thai `final_text` ("สวัสดีค่ะ วันนี้อากาศดีมากเลย พรุ่งนี้ฝนจะตกไหมคะ"), its exact `contentDigest`
computed by the real `computeContentDigest()`, and both expected receipts (first accept, and a
replay). `test/final-event-vector.test.ts` proves the fixture is self-consistent with the actual
TypeScript implementation — recomputes the digest from the fixture's own `content` and asserts
it matches, and runs the fixture's request through `handleFinalEvent` twice to confirm the exact
accept-then-duplicate receipts. This is the vector the Python builder should target: if a Python
implementation of `canonicalize`/digest/idempotency-key-formula produces this file's
`contentDigest` and `idempotencyKey` from this file's `content`, the mapping is correct.

## Rollback condition

This component can be rolled back (code reverted, process stopped) safely as long as:

1. **The durable store file is never deleted on rollback.** Deleting it would let a previously
   `accepted` `idempotencyKey` be treated as new on the next request, breaking the
   exactly-once guarantee any downstream consumer of a `final` event relies on. A rollback
   replaces the *code*; the *store* travels with it unchanged.
2. **The `schema` version pin makes cross-version drift fail loudly, not silently.** A future
   `v2` payload sent to this `v1` code is rejected as `MALFORMED_BODY` (wrong `schema` string),
   never partially interpreted. A rollback from v2 code to v1 code is therefore safe against
   version-shaped payloads already in flight — they simply get refused with a clear reason,
   not silently misprocessed.
3. **Blast radius is contained to this contract's own store.** This module holds no Discord
   credential and starts no Discord bridge, so rolling it back — at any point, for any reason —
   never touches Discord state, the broker's envelope key, or the bridge daemon. The only state
   a rollback needs to reason about is the one JSON file this contract itself owns.
4. **A rollback must not restart the process while an old instance may still hold the port.**
   Not lease-guarded today (single-instance-by-design: nothing in this contract's use case
   expects more than one final-event receiver per pipeline) — if this contract is ever run with
   more than one process expected to share a store, it needs the same `PersistentLease`
   treatment as `BrokerRunner`/`MirrorService` before that becomes safe. Recorded here as an
   explicit **blocker for that future case**, not implemented, because today's scope is a single
   receiver for a single pipeline.
