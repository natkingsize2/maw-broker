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
import { loadProjectRoutesFile } from "./project-routes";

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
  const result = runCutoverPreflight(path);
  console.log(result.message);
  process.exit(result.code);
}
