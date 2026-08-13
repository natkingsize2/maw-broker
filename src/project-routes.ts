/**
 * Phase-4 — project route registry (owner data model, 2026-08-13 17:0x, confirmed verbatim):
 *
 *   { project: "liveSiang", discord: "<thread id>", issue: "natkingsize2/fleet#45", agent: "02-mason:0" }
 *
 * One entry binds all four per project: the Discord thread is the HUMAN FACE, the git issue is
 * the SOURCE OF TRUTH, the agent is who works it. The broker is the central registry — an agent
 * that reads a route knows where to summarise (thread), where to record (issue), and who owns it.
 *
 * This module deliberately does NOT touch the phase-2 command launcher: that stays hard-pinned
 * to its single production room. Project routes are a separate file with a separate loader —
 * multi-route by design, every field validated, fail-closed like everything else here.
 */

import { lstatSync, readFileSync } from "node:fs";
import type { Route } from "./types";

export type ProjectRoute = Required<Pick<Route, "name" | "transport" | "destination" | "agent" | "issue">> & {
  /** MQTT topic prefix of the agent's arra-mqtt channel (its oracle name), when the agent is
   *  woken over the bus (owner redirect 2026-08-13 19:0x: reuse arra-mqtt, not send-keys).
   *  EXPLICIT, never derived from `agent` — deriving a name from "mba:02-anvil" is exactly the
   *  substring game the house has been bitten by three times. Absent ⇒ this route is not
   *  MQTT-forwarded (and the poller must SAY so, not skip silently). */
  mqtt?: string;
};

const SNOWFLAKE = /^\d{17,20}$/;
/** owner/repo#N — bounded so an issue reference can never smuggle text into a room. */
const ISSUE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}#[1-9][0-9]{0,6}$/;
const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function loadProjectRoutesFile(path: string): ProjectRoute[] {
  const state = lstatSync(path);
  if (!state.isFile() || state.isSymbolicLink() || (state.mode & 0o777) !== 0o600) throw new Error("project routes file invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("project routes file invalid"); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("project routes file empty");
  const seenProject = new Set<string>();
  const seenDestination = new Set<string>();
  return parsed.map((row: unknown): ProjectRoute => {
    const c = row as Partial<ProjectRoute>;
    if (typeof c?.name !== "string" || !PROJECT_NAME_RE.test(c.name)) throw new Error("project route name invalid");
    if (c.transport !== "discord-text") throw new Error("project route transport invalid");
    if (typeof c.destination !== "string" || !SNOWFLAKE.test(c.destination)) throw new Error("project route destination invalid");
    if (typeof c.agent !== "string" || !c.agent) throw new Error("project route agent invalid");
    if (typeof c.issue !== "string" || !ISSUE_RE.test(c.issue)) throw new Error("project route issue invalid");
    if (c.mqtt !== undefined && (typeof c.mqtt !== "string" || !PROJECT_NAME_RE.test(c.mqtt))) throw new Error("project route mqtt prefix invalid");
    if (seenProject.has(c.name) || seenDestination.has(c.destination)) throw new Error("project route duplicate");
    seenProject.add(c.name); seenDestination.add(c.destination);
    return { name: c.name, transport: c.transport, destination: c.destination, agent: c.agent, issue: c.issue, ...(c.mqtt !== undefined ? { mqtt: c.mqtt } : {}) };
  });
}

/** Lookup both ways: by project name (an agent asking "where do I summarise?") and by
 *  destination (a poller asking "whose room did this message arrive in?"). */
export class ProjectRegistry {
  private readonly byName = new Map<string, ProjectRoute>();
  private readonly byDest = new Map<string, ProjectRoute>();
  constructor(routes: Iterable<ProjectRoute>) {
    for (const route of routes) { this.byName.set(route.name, route); this.byDest.set(route.destination, route); }
    if (this.byName.size === 0) throw new Error("project registry empty");
  }
  project(name: string): ProjectRoute | undefined { return this.byName.get(name); }
  destination(id: string): ProjectRoute | undefined { return this.byDest.get(id); }
  names(): string[] { return [...this.byName.keys()].sort(); }
}
