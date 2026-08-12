# MAW Broker phase-1 Discord adapter — bounded review plan

Base artifact: pinned `b9c93ddbbb005af47d01264ad336448dec5ec7b5`.

## Current boundary

`DiscordTextAdapter` is currently pure normalization/decision encoding. `Broker.receive` already owns the transport-neutral security seam: owner policy (currently Nat `358970717125214209`), route registry, AES-256-GCM authentication, `new -> pending -> resolved`, replay handling, and a downstream injector callback. There is no Discord REST client, send path, Pipecat path, or production route wiring. Phase 1 will move the owner ID to explicit validated broker configuration (defaulting to the current Nat ID only in a compatibility fixture), rather than a compile-time constant.

## Bounded implementation plan (after Probe GO only)

1. Add a `DiscordPollSource` with an injected REST client. It performs read-only message polling and normalizes one Discord payload into `InboundMessage`; credentials stay in the caller and are never logged.
2. Add a `BrokerIngress` adapter that validates channel/route, the route registry's declared transport, owner ID, exact decision body, and message ID before invoking the broker. It must reject malformed, foreign, webhook/bot-policy-invalid, and wrong-route inputs fail-closed. `InboundMessage` and `DiscordTextAdapter.normalize` must carry `authorIsBot` and `webhookId`; webhook admission uses the existing explicit `allowedWebhookIds` policy rather than author-bot blanket denial. A second transport requires a deliberate core/registry change; phase 1 only admits a route whose declared transport is `discord-text`.
3. This phase changes the core contract: define `DownstreamInjector` as `inject(plaintext, messageId, route) -> Promise<Ack>`, and `Broker.receive` must `await` it. `Ack` is a validated value (`{ messageId, route, accepted: true }`), not merely “did not throw”; mismatched/false acknowledgements keep the record pending. The injector must be idempotent by `messageId`; the broker marks `resolved` only after the validated acknowledgement returns. Ingress must not dedupe or call `store.has()`; authentication and dedupe remain solely in `begin()` inside the broker.
4. Add a cursor/reader wrapper. It advances the Discord cursor after a terminal broker outcome: owner decisions that reach a valid downstream ack resolve and advance; foreign-author and non-project-channel messages are explicitly denied-and-advanced so they cannot wedge the channel; configuration/auth/transport/injector failures hold the cursor and retry. `pending` records are retried after restart. No queue resolution or reply is performed by the adapter itself.
5. Keep audit records metadata-only (message ID, route, decision/outcome, timestamps, hash-chain fields). Never write content, plaintext, token, headers, response bodies, or key material. Store roots are explicit, non-traversal paths with mode 0700 directory / 0600 files; existing audit fd guards (`O_NOFOLLOW|O_NONBLOCK`, regular-file and `nlink===1`) remain mandatory regression cases.

No Pipecat, voice, Android, browser, or ESP32 adapter is included in this phase. No production Discord send/deploy is included.

## Test matrix required before implementation is accepted

- Owner message with exact approve/reject body: inject, acknowledge, resolve, and advance cursor.
- Foreign `OWNER_MISMATCH` and `CHANNEL_NOT_PROJECT` messages: denied, audited, and cursor advanced (must not wedge the channel); configuration/auth/transport/injector failures hold the cursor and retry.
- Wrong channel/route: rejected; no injection.
- Explicit webhook/bot policy: allowed only when policy says so; otherwise rejected.
- Malformed Discord payload and missing author/channel/message IDs: named fail-closed error.
- Tampered envelope/authentication: rejected before any replay response.
- Authenticated resolved message replay: returns replay and does not inject twice.
- Crash/fault before downstream acknowledgement: remains `pending`; restart retries.
- Injector failure: cursor remains unchanged and retry is possible.
- Duplicate Discord delivery: deduped by message ID.
- Route/transport/decision tamper: authenticated mismatch rejected.
- Deny decision: no plaintext returned to caller/injector and no plaintext in audit.
- Audit/log scan: no content, token, key, or plaintext.
- Missing key/config: fail-closed with named error.
- Poll/read errors and rate limits: read-only handling, bounded retry policy, no mutation.
- Rollback: exercise the supported removal command in an isolated install, verify it archives rather than deletes, record archive path and SHA256, then restore the pinned artifact; no production route mutation.
- `Broker.receive` return contract: `pending` is reachable after injector failure/crash, `resolved` only after validated async Ack, and `replay` only after envelope authentication; test all three states.
- Owner configuration: valid configured owner is accepted; missing/malformed owner config fails closed; no username-derived identity.
- Store-root and fd safety: explicit 0700/0600 modes, traversal/symlink/hardlink/FIFO rejection, and post-construction replacement regressions for audit/state files.

## Review gate

The REST client must reuse Atlas retry semantics: honor `Retry-After` on 429 (MAX_RETRIES 5, 60-second backoff cap), fail closed on 401/403 without cursor advance, and retry 5xx with capped backoff then hold. No request/response headers or bodies are logged. Phase 1 deliberately caps the current audit hot-path at **N=400 audit records per store per process lifetime** (roughly 130–200 messages because a message emits 2–3 records; measured baseline ~247 ms / ~212 KB); exceeding N must emit a named `audit capacity exceeded` failure and hold delivery. Rotation/compaction is a later phase, not silently assumed.

The audit/log scan is a manual acceptance step owned by Anvil/Probe: inspect generated JSONL and grep installed artifact/runtime output for content, plaintext, tokens, keys, request headers, and response bodies. `maw broker verify` remains a documented read-only stub in phase 1 and is not treated as proof.

Probe must approve the exact REST-client injection contract, bot/webhook policy, cursor ownership, route-to-transport check, and downstream acknowledgement semantics before any branch implementation starts.
