# MAW Broker — phase 1

Local-only phase-1 branch; not deployed or connected to production Discord. The broker has a transport-neutral core and an injected, read-only Discord text poll source. The adapter normalizes inbound Discord messages but deliberately does not own credentials or send messages.

Policy is explicit: only Nat user `358970717125214209` may resolve a registered route, and every decision is `allow` or `deny`. Payloads use AES-256-GCM with route/message ID as authenticated data. Audit is append-only JSONL; resolved IDs are atomically persisted for restart-safe replay dedupe. Keys are supplied out-of-band (`MAW_BROKER_KEY_B64`) and never logged.

Future adapters implement `TextAdapter` for Pipecat, voice, Android, browser, and ESP32. No GitHub repository or remote was created; authority is required before publishing.

Delivery is intentionally **at-least-once**: the downstream injector must be idempotent on `messageId`, and the broker retries `pending` deliveries after restart until an injector acknowledgement is recorded. The phase-1 Discord adapter is normalization-only; transport enforcement and the `verify` command are stubs pending integration, and no migration of existing MAW/Discord state is performed.

The adapter phase keeps this at-least-once/idempotent boundary: `inject` is awaited and must return `{messageId, route, accepted:true}` before resolution. Foreign/non-project messages advance the cursor after denial; configuration, authentication, transport, and injector failures hold it. Audit capacity is deliberately capped at 400 records per process; manual Anvil/Probe audit scans are the acceptance tool while `maw broker verify` remains a stub.

Single-writer invariant: never start two runners for the same cursor/store root. A persistent 0600 lease records its owner PID and heartbeat; a live owner is always refused, while a dead owner is reclaimable only after its heartbeat is stale. Per-message leases remain deferred.
