/**
 * MQTT wake leg — REJECTED, out of scope.
 *
 * Owner contract, 2026-08-14 01:16 +07: "MQTT routes and poller are out of scope and must be
 * rejected by config." This file previously forwarded owner messages in a project thread onto
 * an MQTT topic so an agent's arra-mqtt channel could wake it (`mosquitto_pub`, per-route
 * `PollOutcome`). That entire mechanism is retired for this launch.
 *
 * This is not merely "unwired" — `ProjectRoute` (src/project-routes.ts) no longer HAS an `mqtt`
 * field at all, so there is no config shape that could make this poller do anything even if
 * someone called it. `main()` still refuses immediately and unconditionally, before touching
 * secrets, routes, or the filesystem, so the refusal is visible in a log line rather than a
 * type error someone could "fix" by re-adding the field.
 *
 * If MQTT forwarding is ever back in scope, the replacement MUST acquire a `PersistentLease`
 * (`src/runner.ts`) as the FIRST thing its constructor does — exactly the pattern
 * `MirrorService` (`src/mirror-launcher.ts:37`) and `BrokerRunner` (`src/runner.ts:182`) already
 * use, both proven by tests to refuse a second instance on the same lease root before either can
 * do any work. That is what "a persistent cross-process lease before any poller-like worker can
 * start" means operationally in this codebase; it is not a new mechanism to invent, it is the
 * existing one, applied.
 */
export const MQTT_POLLER_REJECTED_REASON = "MQTT poller is out of scope (owner directive 2026-08-14) — no route can carry an mqtt field, and this entrypoint refuses to run regardless of config";

export function assertMqttPollerOutOfScope(): never {
  throw new Error(MQTT_POLLER_REJECTED_REASON);
}

export async function main(_env: Record<string, string | undefined> = process.env): Promise<void> {
  assertMqttPollerOutOfScope();
}

if (import.meta.main) { main().catch(error => { console.error(String(error?.message ?? error)); process.exit(1); }); }
