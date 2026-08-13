# MAW Broker phase-2 — real Discord route · SPEC

Recorded 2026-08-13 14:4x on owner (Nat) directive, given live in the original room
(`1537363440237289562`, `1537363876545568779`): *"ต้อง route แล้วไปหา broker แล้วไปหา agent"* ·
*"ใครจะคุยได้ต้องมี discord token เป็นชื่อ จะได้ระบุตัวตนได้"* · *"ตรงนี้ จดเป็นสเปคของ broker ด้วยล่ะ"*
Base artifact: pinned `80a90510fe44cdfd2cc41793dec5c1d60be4b68e` (live canary 5/5 PASS 2026-08-13 14:1x).

## Architecture (owner-stated)

```
project room (Discord channel) → broker (identity gate + audit) → owning agent
```

- **Every project room has exactly one owning agent.** The broker holds the routing table
  `channel id → agent target`; a message in a room is dispatched to that room's owner, never broadcast.
- **Every agent that speaks in Discord has its own bot token, named after the agent.**
  Identity comes from the token; tokens are never shared between agents (2026-08-08 incident:
  3 gateways on one token → triple notify, unattributable speech). Token creation is an
  owner-only act in the Discord Developer Portal.
- The human owner is identified by immutable Discord user ID `358970717125214209` only —
  never by username (already enforced in `broker.ts` owner check).

## Acceptance constraints (anvil, 2026-08-13 14:3x — NO OBJECTION under owner authority)

| # | Constraint |
|---|---|
| A | Exact allowlist: channel `1056224550129508415` only for the first route. No name/fuzzy/canary fallback. |
| B | Owner identity from immutable user ID; **every** bot/webhook/foreign rejection writes the symmetric audit row (R3) with no injection. |
| C | Close R1 (non-numeric message-ID crash) and R2 (PID-reuse startup wedge) **before** permanent enablement. |
| D | One enforced single-writer lease + per-message idempotency across restart/replay; reaction ack states idempotent. |
| E | DownstreamInjector success requires **independent receiver-side evidence**, not send return/status. |
| F | Wake-on-message E2E: original-room Nat command → authenticated audit → exactly one dispatch → target receiver proof → resolved ack, with a negative foreign/bot command in the same run. |
| G | Reversible install + rollback byte hashes mandatory; secrets/media/transcript content stay out of logs and agent context. |

## Deliverables of this phase

1. **R3 audit symmetry** — `ingress.handle()` bot/webhook rejection paths call
   `broker.rejectOwnerMismatch()` before returning, exactly like `ignore()`. (Found by probe
   post-canary: scene ③ left zero audit rows; rejection was real but unrecorded.)
2. **R1** — non-numeric message id must isolate the row (rejected at normalize, skipped by the
   poll loop; the cursor passes it when the next valid message advances), never crash the
   `BigInt()` sort in `runner.ts`.
3. **R2** — lease reclaim must distinguish "live owner" from "pid reused by an unrelated
   process": compare the living process's start time against the lease's `startedAt`.
   Mismatch beyond tolerance ⇒ owner is provably dead ⇒ stale-heartbeat reclaim applies.
   When start time cannot be read, fail closed (refuse startup).
4. **Ack reactions** — 👀 on accepted command, ✅ on resolved (including replay — idempotent),
   ❌ on rejected command. Reaction failures never hold the cursor and never write content to logs.
5. **Routing table + real injector** — `Route` gains an `agent` field; the injector dispatches
   the approved plaintext to that agent via `maw hey` and then proves arrival **receiver-side**
   (reads the target's pane/state for the message id) before returning the Ack. No receiver
   evidence ⇒ no Ack ⇒ record stays pending and the cursor holds (existing INJECTOR_FAILURE path).
6. Launcher for the original room under all constraints; install remains pinned + byte-verified
   with archive rollback.

## Recorded limitation — evidence channel is only as strong as maw API authorization
(probe G6 re-review 2026-08-13 15:1x, maw-js `70af8fd0`) The `replied` status the injector
trusts is a **convention, not an enforcement**: `POST /api/reply/:correlationId`
(`src/api/request-reply.ts:99-104`) has no auth and does not check the responder is the
addressed agent; `GET /api/requests` (`:147`) lists every pending correlationId openly; the
API binds `0.0.0.0:3456` when peers exist (`src/core/bind-host.ts:39` — probe reached it
from a LAN IP). Anyone who can reach port 3456 can enumerate pending ids and forge a
reply → the broker marks a command resolved the agent never ran. This is an **intentional**
remote attack path, not the *accidental* self-Ack that G6 closed. **This receipt is
trustworthy only to the degree the maw API is authorized/reachable** — port 3456 exposure is
the ceiling on its strength. Fix belongs in maw-js (auth on `/api/reply`; close or
loopback-bind `/api/requests`), not in this broker.

- Upstream issue (maw hey/capture same-channel echo + unauthenticated reply): _URL recorded in
  acceptance log once filed (patch to `natkingsize2` mirror or owner-owned repo only; per house
  rule no `gh issue create` on third-party repos)._
- G6 residual HOLD: reaction live ordering (👀→✅) and idempotency across restart are proven at
  the unit level only; live Discord ordering not yet exercised.
