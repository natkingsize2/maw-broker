/**
 * Live argus/task → AgentState adapter — the piece resolveStateSource was refusing to run
 * without (2026-08-13, canon; owner deadline "จบก่อน 23:00").
 *
 * Sources, in layers:
 *  1. argus telemetry (`claude-telemetry` worker, /api/live): newest row per oracle gives
 *     liveness (row age), context %, and the human-readable session name.
 *  2. task-phase sidecars (`~/.maw/teams/<team>/task-phases/*.json`): a FRESH
 *     `blocked_external` flips the phase to blocked; any other fresh phase rides the summary
 *     text only — the digest never claims more than the phase file says.
 *
 * House rules carried by this module:
 *  - fail-closed: unreachable argus, non-array body, ZERO rows, or a corrupt sidecar all throw
 *    (MirrorService turns that into "held" — the room keeps the last true digest, never an
 *    empty/plausible one). "อ่านไม่ได้สักไฟล์" กับ "ไม่มีอะไรผิด" ต้องพิมพ์ไม่เหมือนกัน.
 *  - every value the room sees carries its measurement age (วัด Xm) — a stale row must not
 *    read like a live one.
 *  - an allowlisted agent with no telemetry row is REPORTED as unmeasured, never dropped and
 *    never rendered as a healthy zero.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { StateSource } from "./mirror-launcher";
import type { AgentPhase, AgentState } from "./state-mirror";

export type ArgusRow = {
  oracle: string;
  latest_ts: number;          // epoch ms
  context_used_pct: number;
  session_name: string;
  short_dir: string;
};

export type TaskPhaseFile = {
  taskId: number;
  phase: "active" | "awaiting_review" | "blocked_external";
  reason: string;
  assignee: string;
  updatedAt: string;          // ISO
};

export type LiveSourceOptions = {
  argusUrl: string;
  token: string;
  /** Explicit fleet roster — the digest reports exactly these, no more, no less. */
  agents: readonly string[];
  /** task-phases directories to overlay (each holds <taskId>.json). May be empty. */
  phaseDirs: readonly string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Row newer than this ⇒ active (default 15 min). */
  activeWithinMs?: number;
  /** Row older than this ⇒ offline (default 60 min); between the two ⇒ idle. */
  offlineAfterMs?: number;
  /** Sidecar older than this is ignored — f11 phases from four days ago are history, not state
   *  (default 24 h). */
  phaseFreshMs?: number;
};

const DEFAULT_ACTIVE_MS = 15 * 60 * 1000;
const DEFAULT_OFFLINE_MS = 60 * 60 * 1000;
const DEFAULT_PHASE_FRESH_MS = 24 * 60 * 60 * 1000;
const VALID_TASK_PHASES = new Set(["active", "awaiting_review", "blocked_external"]);

function parseRow(value: unknown): ArgusRow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const oracle = typeof v.oracle === "string" ? v.oracle.trim() : "";
  const latest = Number(v.latest_ts);
  if (!oracle || !Number.isFinite(latest) || latest <= 0) return undefined;
  return {
    oracle,
    latest_ts: latest,
    context_used_pct: Number.isFinite(Number(v.context_used_pct)) ? Number(v.context_used_pct) : NaN,
    session_name: typeof v.session_name === "string" ? v.session_name : "",
    short_dir: typeof v.short_dir === "string" ? v.short_dir : "",
  };
}

function parsePhaseFile(raw: string): TaskPhaseFile {
  let value: any;
  try { value = JSON.parse(raw); } catch { throw new Error("task phase file corrupt"); }
  if (!value || typeof value !== "object" || !Number.isFinite(Number(value.taskId))
    || !VALID_TASK_PHASES.has(value.phase) || typeof value.assignee !== "string"
    || typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))) {
    throw new Error("task phase file corrupt");
  }
  return {
    taskId: Number(value.taskId),
    phase: value.phase,
    reason: typeof value.reason === "string" ? value.reason : "",
    assignee: value.assignee,
    updatedAt: value.updatedAt,
  };
}

export class LiveStateSource implements StateSource {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly activeWithinMs: number;
  private readonly offlineAfterMs: number;
  private readonly phaseFreshMs: number;

  constructor(private readonly options: LiveSourceOptions) {
    if (!options.argusUrl || !options.token) throw new Error("live source configuration invalid");
    if (!Array.isArray(options.agents) || options.agents.length === 0
      || options.agents.some(a => typeof a !== "string" || !a.trim() || /\s/.test(a.trim()))) {
      throw new Error("live source configuration invalid");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.activeWithinMs = options.activeWithinMs ?? DEFAULT_ACTIVE_MS;
    this.offlineAfterMs = options.offlineAfterMs ?? DEFAULT_OFFLINE_MS;
    this.phaseFreshMs = options.phaseFreshMs ?? DEFAULT_PHASE_FRESH_MS;
    if (this.activeWithinMs >= this.offlineAfterMs) throw new Error("live source configuration invalid");
  }

  async collect(): Promise<AgentState[]> {
    const [rows, phases] = [await this.fetchRows(), this.readPhases()];
    const newest = new Map<string, ArgusRow>();
    for (const row of rows) {
      const held = newest.get(row.oracle);
      if (!held || row.latest_ts > held.latest_ts) newest.set(row.oracle, row);
    }
    const at = this.now();
    return this.options.agents.map(name => {
      const agent = name.trim();
      const row = newest.get(agent);
      const overlay = phases.get(agent);
      if (!row) {
        return {
          agent,
          phase: "offline" as AgentPhase,
          summary: "ไม่มีแถว telemetry — วัดไม่ได้ ไม่ใช่ว่าง" + (overlay ? ` · ${overlay}` : ""),
          version: 0,
        };
      }
      const ageMs = Math.max(0, at - row.latest_ts);
      let phase: AgentPhase = ageMs <= this.activeWithinMs ? "active" : ageMs <= this.offlineAfterMs ? "idle" : "offline";
      if (overlay?.startsWith("task#") && overlay.includes("blocked_external")) phase = "blocked";
      const ctx = Number.isFinite(row.context_used_pct) ? `ctx ${row.context_used_pct}%` : "ctx วัดไม่ได้";
      const doing = row.session_name || row.short_dir || "?";
      const ageMin = Math.round(ageMs / 60000);
      const parts = [ctx, doing, `วัด ${ageMin}m`];
      if (overlay) parts.push(overlay);
      return { agent, phase, summary: parts.join(" · "), version: row.latest_ts };
    });
  }

  private async fetchRows(): Promise<ArgusRow[]> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.argusUrl, {
        headers: { authorization: `Bearer ${this.options.token}` },
      });
    } catch { throw new Error("argus unreachable"); }
    if (!response.ok) throw new Error("argus unreachable");
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error("argus response invalid"); }
    if (!Array.isArray(body)) throw new Error("argus response invalid");
    const rows = body.map(parseRow).filter((r): r is ArgusRow => r !== undefined);
    // อ่านได้ N จาก M: zero readable rows is "cannot measure", never "all quiet".
    if (rows.length === 0) throw new Error("argus returned no readable rows");
    return rows;
  }

  /** newest FRESH sidecar per assignee, rendered as a short overlay string. A corrupt file
   *  throws — this module decides what a public room asserts, so it must not shrug. */
  private readPhases(): Map<string, string> {
    const newestPerAgent = new Map<string, TaskPhaseFile>();
    for (const dir of this.options.phaseDirs) {
      let names: string[];
      try { names = readdirSync(dir).filter(n => n.endsWith(".json")); } catch { throw new Error("task phase dir unreadable"); }
      for (const name of names) {
        const file = parsePhaseFile(readFileSync(join(dir, name), "utf8"));
        if (this.now() - Date.parse(file.updatedAt) > this.phaseFreshMs) continue;
        const held = newestPerAgent.get(file.assignee);
        if (!held || Date.parse(file.updatedAt) > Date.parse(held.updatedAt)) newestPerAgent.set(file.assignee, file);
      }
    }
    const overlays = new Map<string, string>();
    for (const [agent, f] of newestPerAgent) overlays.set(agent, `task#${f.taskId} ${f.phase}${f.reason ? ` (${f.reason})` : ""}`);
    return overlays;
  }
}

/** Parse `KEY=value` lines (the ~/.config/argus/.env shape). Returns undefined when absent. */
export function readEnvFileKey(path: string, key: string): string | undefined {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return undefined; }
  for (const line of text.split("\n")) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim() || undefined;
  }
  return undefined;
}
