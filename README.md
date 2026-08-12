# MAW Broker — phase 1

Local-only scaffold; not installed, deployed, or connected to Discord. The broker has a transport-neutral core and a pure Discord text adapter. The adapter normalizes inbound Discord messages but deliberately does not own credentials or send messages.

Policy is explicit: only Nat user `358970717125214209` may resolve a registered route, and every decision is `allow` or `deny`. Payloads use AES-256-GCM with route/message ID as authenticated data. Audit is append-only JSONL; resolved IDs are atomically persisted for restart-safe replay dedupe. Keys are supplied out-of-band (`MAW_BROKER_KEY_B64`) and never logged.

Future adapters implement `TextAdapter` for Pipecat, voice, Android, browser, and ESP32. No GitHub repository or remote was created; authority is required before publishing.

Delivery is intentionally **at-least-once**: the downstream injector must be idempotent on `messageId`, and the broker retries `pending` deliveries after restart until an injector acknowledgement is recorded. The phase-1 Discord adapter is normalization-only; transport enforcement and the `verify` command are stubs pending integration, and no migration of existing MAW/Discord state is performed.
