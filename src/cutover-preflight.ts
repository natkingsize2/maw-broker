/**
 * Cutover preflight — Phase 0.5 of RUNBOOK-central-daemon-cutover-v1.md as an
 * executable gate instead of prose. Read-only: loads the routes file through
 * the REAL `loadProjectRoutesFile` (so the check cannot drift from what the
 * daemons will actually do at startup) and reports fail-closed:
 *
 *   exit 0 — file loads clean under the new contract; prints "read N routes"
 *            (the denominator, so "0 problems" can never mean "read nothing")
 *   exit 1 — file rejected (including lingering `mqtt` fields, the known
 *            live-config blocker) with the loader's own named error
 *   exit 2 — file missing/unreadable (a different failure than "invalid")
 *
 * Usage: bun src/cutover-preflight.ts [path]   (default: the live config path)
 * Never edits anything — the fix for a rejection is a human decision.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadProjectRoutesFile } from "./project-routes";

/** Review r1 #5: broker/mirror/final-event each guard their store with a
 *  `runner.lease` file in THEIR OWN root. If an operator points two daemons at
 *  the same root, they fight over one lease file — first one wins, the other
 *  flaps forever with "already held" for the wrong reason. Reject that
 *  configuration before any cutover. Only DEFINED roots are compared (a daemon
 *  not being deployed is not a collision). */
export function assertDistinctLeaseRoots(roots: Record<string, string | undefined>): { code: 0 | 1; message: string } {
  const seen = new Map<string, string>();
  for (const [name, root] of Object.entries(roots)) {
    if (!root) continue;
    const norm = resolve(root);
    const prior = seen.get(norm);
    if (prior) return { code: 1, message: `preflight REJECTED: lease-root collision — ${prior} and ${name} both use ${norm}` };
    seen.set(norm, name);
  }
  return { code: 0, message: `preflight OK: ${seen.size} lease root(s) distinct` };
}

export function runCutoverPreflight(path: string): { code: 0 | 1 | 2; message: string } {
  if (!existsSync(path)) return { code: 2, message: `preflight: routes file missing: ${path}` };
  try {
    const routes = loadProjectRoutesFile(path);
    return { code: 0, message: `preflight OK: read ${routes.length} routes from ${path} — [${routes.map(r => r.name).join(", ")}]` };
  } catch (error) {
    return { code: 1, message: `preflight REJECTED: ${path} — ${String((error as Error)?.message ?? error)}` };
  }
}

if (import.meta.main) {
  const path = process.argv[2] ?? `${process.env.HOME}/.config/maw-broker/project-routes.json`;
  const routesResult = runCutoverPreflight(path);
  console.log(routesResult.message);
  const leaseResult = assertDistinctLeaseRoots({
    MAW_BROKER_STORE_ROOT: process.env.MAW_BROKER_STORE_ROOT,
    MAW_MIRROR_STORE_ROOT: process.env.MAW_MIRROR_STORE_ROOT,
    MAW_PIPECAT_RECEIPT_STORE_ROOT: process.env.MAW_PIPECAT_RECEIPT_STORE_ROOT,
  });
  console.log(leaseResult.message);
  process.exit(routesResult.code !== 0 ? routesResult.code : leaseResult.code);
}
