/**
 * Central agent-event ledger — fake-only increment (owner GO 2026-08-14 15:43).
 *
 * Typed AgentEvent kinds `progress|done|blocked` in; the ledger owns strict
 * validation, project binding (via the existing ProjectRegistry — each project
 * already carries its Discord destination AND GitHub issue), hash-chained
 * audit, durable idempotency, and EXACTLY-ONCE outbound emission through an
 * OutboundEmitter interface. No live transport exists in this module — the
 * only emitters are whatever the caller injects; tests inject fakes. The
 * `final` kind stays in the separate maw-pipecat receipt contract
 * (final-event-contract.ts) — this family is deliberately disjoint.
 */
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProjectRegistry } from "./project-routes";

export const AGENT_EVENT_SCHEMA = "maw.broker.agent-event.v1";
export const AGENT_EVENT_KINDS = ["progress", "done", "blocked"] as const;
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];
export const AGENT_EVENT_IDEMPOTENCY_PREFIX = "agent-event-v1";

export type AgentEvent = {
  schema: string;
  project: string;
  kind: string;
  event_id: string;
  agent: string;
  summary: string;
  occurred_at: string;
};
export type AgentEventReceipt = {
  status: "accepted" | "duplicate";
  schema: string;
  project: string;
  kind: AgentEventKind;
  event_id: string;
  idempotencyKey: string;
  receivedAt: string;
  /** Where the accepted event was emitted (from the project route, recorded so
   *  the receipt itself proves WHICH thread/issue got the exactly-once emit). */
  discordDestination: string;
  githubIssue: string;
};

export class AgentEventError extends Error {
  constructor(readonly code: "MALFORMED_EVENT" | "KIND_REJECTED" | "UNKNOWN_PROJECT" | "IDEMPOTENCY_CONFLICT", message: string) {
    super(message); this.name = "AgentEventError";
  }
}

const ID_LIMIT = 256;
const SUMMARY_LIMIT = 2000;
const OCCURRED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const EVENT_KEYS = ["agent", "event_id", "kind", "occurred_at", "project", "schema", "summary"] as const;

export function buildAgentEventIdempotencyKey(project: string, eventId: string): string {
  return `${AGENT_EVENT_IDEMPOTENCY_PREFIX}:${project}:${eventId}`;
}

function bounded(v: unknown, limit: number): v is string { return typeof v === "string" && v.length > 0 && v.length <= limit; }

export function validateAgentEvent(body: unknown, registry: ProjectRegistry): { event: AgentEvent & { kind: AgentEventKind }; idempotencyKey: string; discordDestination: string; githubIssue: string } {
  const b = body as Partial<AgentEvent> | null | undefined;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new AgentEventError("MALFORMED_EVENT", "event must be a JSON object");
  const keys = Object.keys(b).sort();
  const expected = [...EVENT_KEYS].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new AgentEventError("MALFORMED_EVENT", `event key set invalid — expected exactly [${expected.join(",")}], got [${keys.join(",")}]`);
  }
  if (b.schema !== AGENT_EVENT_SCHEMA) throw new AgentEventError("MALFORMED_EVENT", `schema must be exactly "${AGENT_EVENT_SCHEMA}"`);
  if (!bounded(b.project, ID_LIMIT) || !bounded(b.event_id, ID_LIMIT) || !bounded(b.agent, ID_LIMIT)) throw new AgentEventError("MALFORMED_EVENT", "project/event_id/agent missing or invalid");
  if (!bounded(b.summary, SUMMARY_LIMIT)) throw new AgentEventError("MALFORMED_EVENT", "summary missing or over limit");
  if (typeof b.occurred_at !== "string" || !OCCURRED_AT_RE.test(b.occurred_at)) throw new AgentEventError("MALFORMED_EVENT", "occurred_at must be ISO8601 UTC");
  // Kind gate AFTER shape (named reasons stay distinct), fail-closed on anything unlisted —
  // including "final", which belongs to the separate maw-pipecat receipt contract.
  if (!(AGENT_EVENT_KINDS as readonly string[]).includes(b.kind as string)) throw new AgentEventError("KIND_REJECTED", `kind "${b.kind}" rejected — this ledger accepts only [${AGENT_EVENT_KINDS.join("|")}]`);
  const route = registry.project(b.project!);
  if (!route) throw new AgentEventError("UNKNOWN_PROJECT", `project "${b.project}" is not in the project registry`);
  return {
    event: b as AgentEvent & { kind: AgentEventKind },
    idempotencyKey: buildAgentEventIdempotencyKey(b.project!, b.event_id!),
    discordDestination: route.destination,
    githubIssue: route.issue,
  };
}

/** Outbound surface. NO live implementation in this repo yet — live transports
 *  are the remaining gate (owner GO + secrets), exactly like the cutover. */
export interface OutboundEmitter {
  emitDiscord(destination: string, content: string): Promise<void>;
  emitGitHub(issueRef: string, comment: string): Promise<void>;
}

type LedgerRecord = { receipt: AgentEventReceipt; summaryHash: string };
type AuditRow = { at: string; event: "accepted" | "replay" | "conflict"; idempotencyKey: string; kind?: string; project?: string; prevHash: string | null; hash: string };
type PersistShape = { records: Record<string, LedgerRecord>; audit: AuditRow[] };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export class AgentEventLedger {
  private records = new Map<string, LedgerRecord>();
  private audit: AuditRow[] = [];
  constructor(
    private readonly registry: ProjectRegistry,
    private readonly emitter: OutboundEmitter,
    /** Optional durable file (0700 dir / 0600 file, atomic write — same idiom
     *  as FileFinalEventStore). Absent ⇒ in-memory (tests). */
    private readonly path?: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    if (path) {
      const root = dirname(path);
      if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error("agent-event ledger path invalid");
      mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
      if (existsSync(path)) {
        const st = lstatSync(path);
        if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o600) throw new Error("agent-event ledger corrupt");
        let parsed: PersistShape;
        try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("agent-event ledger corrupt"); }
        if (!parsed || typeof parsed !== "object" || typeof parsed.records !== "object" || !Array.isArray(parsed.audit)) throw new Error("agent-event ledger corrupt");
        this.records = new Map(Object.entries(parsed.records));
        this.audit = parsed.audit;
        if (!this.verifyAuditChain()) throw new Error("agent-event ledger audit chain broken");
      }
    }
  }

  private persist(): void {
    if (!this.path) return;
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ records: Object.fromEntries(this.records), audit: this.audit } satisfies PersistShape) + "\n", { encoding: "utf8", mode: 0o600 });
    const fd = openSync(tmp, "r"); fsyncSync(fd); closeSync(fd);
    renameSync(tmp, this.path);
    const dirfd = openSync(dirname(this.path), "r"); fsyncSync(dirfd); closeSync(dirfd);
    chmodSync(this.path, 0o600);
  }

  private appendAudit(row: Omit<AuditRow, "prevHash" | "hash">): void {
    const prev = this.audit.at(-1);
    const prevHash = prev ? prev.hash : null;
    const hash = sha(`${prevHash ?? ""}${JSON.stringify(row)}`);
    this.audit.push({ ...row, prevHash, hash });
  }

  /** Recompute every link — true only if no row was altered, dropped, or reordered. */
  verifyAuditChain(): boolean {
    let prevHash: string | null = null;
    for (const row of this.audit) {
      const { prevHash: recordedPrev, hash: recordedHash, ...core } = row;
      if (recordedPrev !== prevHash) return false;
      if (sha(`${prevHash ?? ""}${JSON.stringify(core)}`) !== recordedHash) return false;
      prevHash = recordedHash;
    }
    return true;
  }
  get auditRows(): readonly AuditRow[] { return this.audit; }

  /**
   * Accept an event: validate → idempotency → chained audit → EXACTLY-ONCE
   * emission (both sinks) → persist → receipt. Duplicate (same key, same
   * summary hash) returns the ORIGINAL receipt and emits NOTHING. Same key with
   * a different summary is a conflict — refused, original untouched, audited.
   * Emission happens BEFORE the record is persisted as accepted; an emitter
   * failure therefore leaves the key unrecorded, so a retry re-attempts the
   * emit rather than silently recording an event nobody was told about
   * (at-least-once toward the sinks + idempotent sinks = exactly-once effect;
   * with the fake transports in tests this surfaces as literal exactly-once).
   */
  async accept(body: unknown): Promise<AgentEventReceipt> {
    const { event, idempotencyKey, discordDestination, githubIssue } = validateAgentEvent(body, this.registry);
    const summaryHash = sha(event.summary);
    const existing = this.records.get(idempotencyKey);
    if (existing) {
      if (existing.summaryHash !== summaryHash) {
        this.appendAudit({ at: this.now(), event: "conflict", idempotencyKey });
        this.persist();
        throw new AgentEventError("IDEMPOTENCY_CONFLICT", `idempotencyKey "${idempotencyKey}" already recorded with different content`);
      }
      this.appendAudit({ at: this.now(), event: "replay", idempotencyKey });
      this.persist();
      return { ...existing.receipt, status: "duplicate" };
    }
    const content = `[${event.kind}] ${event.agent} @ ${event.project}: ${event.summary}`;
    await this.emitter.emitDiscord(discordDestination, content);
    await this.emitter.emitGitHub(githubIssue, content);
    const receipt: AgentEventReceipt = {
      status: "accepted", schema: event.schema, project: event.project, kind: event.kind,
      event_id: event.event_id, idempotencyKey, receivedAt: this.now(),
      discordDestination, githubIssue,
    };
    this.records.set(idempotencyKey, { receipt, summaryHash });
    this.appendAudit({ at: this.now(), event: "accepted", idempotencyKey, kind: event.kind, project: event.project });
    this.persist();
    return receipt;
  }
}
