# Central broker + bridge — reversible cutover runbook (v1)

Owner directive, 2026-08-14 05:11 +07: a reversible cutover runbook for the central broker plus
bridge, using the reviewed branches from this session only. **No installation, no daemon
start/stop, no Discord/token/live config mutation performed while writing this document** — the
executable proof is `test/cutover-dry-run.test.ts`, a fake-supervisor simulation, not a real
supervisor run.

## Reviewed branches this runbook cuts over (exact SHAs, all `natkingsize2/maw-broker`)

| branch | SHA | delivers |
|---|---|---|
| `test/central-broker-dossier` | `13e1a578deb6a82ad655ff50d00240dbf221bab7` | baseline coverage (not pushed to origin — local only, see that branch's own commit) |
| `feat/enforce-single-bridge-credential` | `9b956fea9ed269de9257af1412af6a8368de6c58` | `bridge-server.ts`/`bridge-client.ts` — single Discord-credential-owner architecture |
| `feat/final-event-receipt-maw-pipecat` | `db4b7560816bca487f480b380d9aa76427753984` | `final-event-server.ts`/`final-event-contract.ts` — maw-pipecat receipt endpoint |
| `feat/central-daemon-cutover-runbook` (this branch) | see commit at end of report | this runbook + `/health` endpoints + dry-run test |

Four daemon roles this runbook covers, all from the branches above:

| daemon | entrypoint | credential | port env var |
|---|---|---|---|
| bridge | `src/bridge-server.ts` | `DISCORD_BOT_TOKEN` (the ONLY holder) | `MAW_BRIDGE_PORT` (default 8791) |
| command broker | `src/route-launcher.ts` | none (talks to bridge via `bridge-client.ts`) | n/a (polls Discord via bridge) |
| state mirror | `src/mirror-launcher.ts` | none (talks to bridge via `bridge-client.ts`) | n/a |
| final-event receiver | `src/final-event-server.ts` | `MAW_PIPECAT_RECEIPT_TOKEN` (3rd, distinct secret) | `MAW_PIPECAT_RECEIPT_PORT` (default 8792) |

`project-poller.ts` (MQTT leg) is explicitly OUT of this runbook — it refuses to start
unconditionally (`feat/enforce-single-bridge-credential`), by owner directive.

---

## Phase 0 — Preflight identity, archive, and hash checks

Run BEFORE touching anything. Every check below is a read, nothing here mutates state.

1. **Exact commit identity.** For each branch in the table above:
   ```bash
   git -C <worktree> rev-parse HEAD          # must equal the SHA in the table
   git -C <worktree> status --short          # must be EMPTY — a dirty tree is not a reviewed commit
   ```
   A worktree whose `rev-parse HEAD` disagrees with the table, or whose `status --short` is
   non-empty, is not what was reviewed — stop, do not proceed on that worktree.

2. **Remote identity (receiver-side, not the local git object store).**
   ```bash
   gh api repos/natkingsize2/maw-broker/commits/<sha> --jq '.sha'
   ```
   must echo the same `<sha>` back. This is the same check used to verify every commit in this
   session's own reports (dossier, credential-split, final-event contract, correction) — GitHub
   confirming the object exists is independent of the local clone's own claim that it pushed.

3. **Test/type identity — re-run, never trust a cached count.**
   ```bash
   cd <worktree> && bunx tsc --noEmit && bun test
   ```
   Record the exact pass/fail/assert counts. A stale "244/244 passed an hour ago" is not
   evidence about the commit you are about to cut to — the counts in Phase 6 of this document
   were produced by running these commands fresh, and so must yours.

4. **Archive/hash the pre-cutover state before touching it.** For each durable store the OLD
   (currently running) daemons own — `runner.lease`, `cursor.json`, `store/` (broker audit),
   `mirror.json` (mirror), `final-event-store.json` (final-event receiver, if a prior version
   ever ran) — record, into a dated evidence file (same pattern as
   `ψ/memory/logs/2026-08-13_2230_evidence-6x-channel-dup.md` elsewhere in this fleet):
   ```bash
   for f in runner.lease cursor.json mirror.json final-event-store.json; do
     [ -f "$root/$f" ] && sha256sum "$root/$f" && stat -f '%N %z %Sm' "$root/$f"
   done
   ```
   This is the reference Phase 5 (rollback) compares against — "did anything shrink or
   disappear" is answered by this snapshot, not by memory of what should be there.

5. **Config identity.** `project-routes.json` must load under the NEW code (owner contract:
   `mqtt` fields are rejected — `loadProjectRoutesFile` throws if any are present). Run:
   ```bash
   bun -e 'import("<worktree>/src/project-routes").then(m => { m.loadProjectRoutesFile(process.argv[1]); console.log("loads clean"); })' "$LIVE_ROUTES_PATH"
   ```
   **Executable form (added 2026-08-14): `bun src/cutover-preflight.ts [path]`** — exit 0 =
   loads clean (prints "read N routes", the denominator); exit 1 = rejected (incl. lingering
   `mqtt` fields) with the loader's own named error; exit 2 = file missing. Uses the REAL
   `loadProjectRoutesFile`, so it cannot drift from daemon startup behavior.
   If this fails, **stop** — the live config is not yet compatible with the code being cut to
   (this was true as of the dossier: 2/4 routes still carried `mqtt`). Fixing the config is a
   precondition of this runbook, not a step inside it — it is a separate, explicit, human
   decision about editing live state.

---

## Phase 1 — One bridge token-owner rule

**Structural proof (static, no process running):**
```bash
bun test test/no-direct-agent-send.test.ts
```
must pass. This test enumerates every file in `src/` and asserts exactly one
(`bridge-server.ts`) constructs a live `DiscordRestClient`; a second credential-holding file
anywhere in the tree turns it red.

**Runtime proof (after a real cutover — described here, not executed by this document):**
```bash
lsof -nP -iTCP -sTCP:LISTEN | grep ":<MAW_BRIDGE_PORT>"   # exactly ONE process bound to the bridge port
ps -eo pid,ppid,command | grep -c "bridge-server.ts"        # exactly 1 (plus the grep itself)
```
Two listeners on the bridge port, or two `bridge-server.ts` processes, is a violation of the
single-owner rule regardless of what the static test says — the static test proves the CODE
can't create a second owner; this proves nothing else DID by some other path (a stray manual
`bun run`, a leftover process from a failed prior cutover).

---

## Phase 2 — One broker final-event receiver

**GAP CLOSED (2026-08-14 11:4x, owner-directed):** `startFinalEventServer` now acquires a
`PersistentLease` on `leaseRoot` BEFORE binding — the real daemon path (`main()`) always passes
the store root, so a second receiver on the same store is refused at construction even on a
different port ("the port is not the shared resource, the store is"). Proven by
`test/cutover-blockers.test.ts`. Supervisor single-instance policy (below) remains as
defense-in-depth, no longer the only enforcement. The paragraph below is retained as the
historical record of the gap:

~~**Known gap, stated plainly:**~~ `final-event-contract.ts` does not use a `PersistentLease`
(recorded as a deliberate scope limit in `SPEC-final-event-receipt-v1.md` §Rollback — "today's
scope is a single receiver for a single pipeline"). Enforcement of "one receiver" is therefore
**supervisor-level, not code-level**, for this daemon specifically — unlike the bridge, mirror,
and command broker, which each self-enforce via `PersistentLease`.

- **Supervisor policy (Phase 3) must declare exactly one job for `final-event-server.ts`.** No
  configuration should ever define two.
- **Runtime proof, same shape as Phase 1:**
  ```bash
  lsof -nP -iTCP -sTCP:LISTEN | grep ":<MAW_PIPECAT_RECEIPT_PORT>"   # exactly ONE
  ps -eo pid,ppid,command | grep -c "final-event-server.ts"            # exactly 1 (plus grep)
  ```
- **If a second instance is ever required** (e.g. horizontal scaling), `PersistentLease` must
  be added to `final-event-server.ts`'s `main()` FIRST, following the exact pattern
  `MirrorService`/`BrokerRunner` already use — this is a code change, not a supervisor
  workaround, and is out of scope for this cutover.

---

## Phase 3 — Supervisor policy (launchd, documentation only — nothing installed)

macOS `launchd` per-daemon `.plist`, one per daemon, **never loaded by this runbook**:

```xml
<!-- example: com.natkingsize2.maw-broker.bridge.plist — documentation only, not installed -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.natkingsize2.maw-broker.bridge</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/bun</string><string>run</string><string>src/bridge-server.ts</string></array>
  <key>WorkingDirectory</key><string>/path/to/maw-broker</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MAW_BRIDGE_PORT</key><string>8791</string>
    <!-- MAW_BRIDGE_SECRETS_FILE points at a 0600 file — the token itself is NEVER inlined
         in this plist. launchd plists are frequently world-readable (~/Library/LaunchAgents);
         putting a secret directly in EnvironmentVariables would defeat every 0600/symlink
         guard this codebase's secrets loaders already enforce. -->
    <key>MAW_BRIDGE_SECRETS_FILE</key><string>/path/to/bridge-secrets.json</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <!-- ThrottleInterval: a crash-loop must not hammer PersistentLease.acquire() faster than a
       prior instance's lease can go stale (staleAfterMs default 30s in runner.ts) — a restart
       interval shorter than that risks "runner lease recovery pending" flapping forever. -->
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>/path/to/logs/bridge.log</string>
  <key>StandardErrorPath</key><string>/path/to/logs/bridge.err.log</string>
</dict>
</plist>
```

The same shape applies to `route-launcher.ts` (command broker), `mirror-launcher.ts` (state
mirror), and `final-event-server.ts` (final-event receiver) — four `.plist` files, four
`Label`s, four log paths, **each pointing at its own secrets/config file, never a shared one**.
`final-event-server.ts`'s plist additionally needs `MAW_PIPECAT_RECEIPT_STORE_ROOT` set.

**Not covered by this runbook**: `launchctl load`/`bootstrap`, `launchctl start`, or any
equivalent (systemd unit, pm2, supervisord) actually being installed or started. That is the
cutover's execution step, explicitly out of scope for this "no daemon start/stop" task.

---

## Phase 4 — PID/start-time and loopback health receiver checks

**PID/start-time (self-consistency, matches every process-identity check this session already
performed on Canon Prime itself):**
```bash
ps -o pid,lstart,etime -p <pid>
```
Compare against the daemon's own `PersistentLease` file (`runner.lease` for bridge/broker/mirror
— `<pid> <startedAtMs> <heartbeatMs>`, `runner.ts:168`): the lease's recorded `pid` must equal
the process actually listening, and its `startedAt` must agree with `ps -o lstart` (within the
60s PID-reuse tolerance already tested in `test/lease-pid-reuse.test.ts`). This is the SAME
tradeoff and the SAME check already proven, not a new mechanism.

`final-event-server.ts` has no lease file (Phase 2's known gap) — its PID identity check is
`ps` against the supervisor's own record only (no independent durable cross-check exists for
this daemon yet).

**Loopback health receiver checks — real HTTP, from OUTSIDE the process (field rule 2: verify
outside the tool, never by its own status):**
```bash
curl -sf http://127.0.0.1:<MAW_BRIDGE_PORT>/health
curl -sf http://127.0.0.1:<MAW_PIPECAT_RECEIPT_PORT>/health
```
Both return `{"status":"ok","pid":<n>,"startedAt":"<iso8601>"}`, **unauthenticated** (added this
commit — neither server had a health route before; see `src/bridge-server.ts` and
`src/final-event-server.ts`). Cross-check the returned `pid` against the `ps`/lease check above
— a health endpoint answering with the WRONG pid (e.g. an old process still bound to the port
because the new one failed to start) is exactly the failure mode this comparison catches, and a
health check that only asked "did curl get a 200" would miss it entirely.

`route-launcher.ts`/`mirror-launcher.ts` are poll loops with no HTTP surface of their own — their
liveness check is the `runner.lease` file's heartbeat freshness (`now - heartbeat <= 30_000`,
same field `PersistentLease.refresh()` already writes every tick).

---

## Phase 5 — Rollback, preserving durable stores

**The single rule every rollback path in this codebase already follows** (stated once here,
inherited from `SPEC-final-event-receipt-v1.md` and the dossier's own rollback-precondition
table): **a rollback replaces the CODE, never the DURABLE STORE.**

1. Stop the NEW supervisor job (`launchctl unload`/equivalent — not executed by this document).
2. Confirm the lease is released: `runner.lease` absent, or present with a `heartbeat` older
   than `staleAfterMs` AND a dead `pid` (same three-part check `PersistentLease.acquire()` itself
   runs — do not just "look" at the file, run the same test the code runs:
   `ps -p <pid>` should fail).
3. **Do not touch** `cursor.json`, `mirror.json`, `final-event-store.json`, or the audit
   `store/` directory. Compare their hashes/mtimes against the Phase 0 archive — they must be
   **equal or newer**, never smaller/older/absent. A shrunk or missing file at this point means
   something already went wrong upstream of the rollback itself; the rollback must halt and be
   investigated, not paper over it by starting the old code anyway.
4. Start the OLD supervisor job, pointed at the SAME store paths recorded in Phase 0.
5. Verify the old daemon resumes correctly, not as a fresh instance:
   - mirror: next reconcile with unchanged state must be `noop`, not `posted` — a second post
     means the store didn't actually carry over (proven possible in
     `test/mirror-restart-full-cycle.test.ts`, the same property, same assertion).
   - final-event receiver: replaying the last-known idempotencyKey must return `status:
     "duplicate"` with the ORIGINAL `receivedAt`, not `"accepted"` again (proven in
     `test/final-event-vector.test.ts`).
   - command broker: `cursor.json`'s `after` value must be unchanged from the Phase 0 snapshot
     until the old process actually processes new messages — an advancing cursor with no new
     Discord activity would mean it's re-reading history, not resuming.

**Rollback never touches Discord, the bridge's credential, or live config** (`bridge-server.ts`
is the only file with Discord I/O at all; the command broker/mirror/final-event receiver hold no
Discord credential to begin with — see `feat/enforce-single-bridge-credential`). The blast
radius of any rollback in this architecture is contained to which LOCAL process is running and
which LOCAL store files it reads — never a remote-state question.

---

## Phase 6 — Dry-run / fake-supervisor test

`test/cutover-dry-run.test.ts` — a `FakeSupervisor` (new, this commit) models launchd's
single-instance-per-label semantics (refuses a second `start()` of the same label before a
`stop()`) and drives the REAL `bridge-server.ts`/`final-event-server.ts` instances (real
`Bun.serve`, real `fetch`, fake Discord fetcher underneath — same pattern as every other server
test this session) through:

1. preflight (fake "old" daemon registered as already running)
2. cutover: stop old → start new (bridge + final-event, via the fake supervisor) → verify
   `FakeSupervisor` refuses a duplicate `start()` of either label (Phase 1 + 2, at the
   supervisor level) → verify `/health` on both (Phase 4, real HTTP)
3. simulated failure → rollback: stop new → snapshot the durable store files byte-for-byte
   before/after → start old (fake) → verify resumption is `noop`/`duplicate`, never a fresh
   accept (Phase 5)

Every state transition asserted; nothing here starts a REAL supervisor, REAL launchd job, or
touches Discord/a real token/live config — the "fake" in `FakeSupervisor` is load-bearing.

```
$ bun test test/cutover-dry-run.test.ts

 4 pass
 0 fail
 28 expect() calls
Ran 4 tests across 1 file. [22.00ms]
```

Full suite at the commit this runbook ships with: **256 pass, 0 fail, 560 asserts, 20 files**,
`tsc --noEmit` clean (up from 252 before the dry-run test file; +4 tests/+28 asserts for this
file specifically, the rest already existed from the reviewed branches this runbook cuts over).


## Amendment log — archive/rollback for post-f960470 changes

- **2026-08-14 11:4x** (this commit): final-event lease (Phase 2 gap closed) + executable
  Phase 0.5 preflight (`src/cutover-preflight.ts`) + 7 tests (`test/cutover-blockers.test.ts`).
  **Archive**: the pre-change state is exactly commit `f960470e58036d4fe551d901f93cb11b93667689`
  on this same branch — `git archive f960470e...` reproduces it byte-for-byte; no separate
  tarball needed for a clean committed tree. **Rollback**: `git checkout f960470e...` (or revert
  this commit). No durable-store format changed; a rollback needs no store migration. Nothing
  here creates secrets, edits live routes, starts daemons, or touches Discord/token config.
