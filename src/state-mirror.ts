/**
 * Broker phase-3 — agent state MIRROR (owner requirement 2026-08-13 15:2x, anvil architect
 * call: "production room is OUTBOUND STATE MIRROR ONLY"; probe/anvil P2 deep review 15:3x-15:4x).
 *
 * One living digest message in the project room, edited in place, updated only when a state
 * actually changes. No commands, no inbound listener, no chatter, no secrets, no room-wide pings.
 *
 * Hardening carried by this module (each from a named P2 finding):
 *  - source is plain text (no raw control bytes) so the module that decides what reaches a public
 *    room is itself reviewable in a diff;
 *  - persisted snapshot is a one-way HASH per agent, never the plaintext summary;
 *  - summaries are sanitized (control chars + token-shaped secrets stripped, mentions neutralised);
 *  - the single digest survives a crash between post and save via receiver-side recovery;
 *  - reconcile is single-flight so concurrent calls cannot double-post;
 *  - duplicate agents, oversized input, and empty digests are rejected/handled explicitly.
 */

import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type AgentPhase = "active" | "blocked" | "done" | "idle" | "offline";
export type AgentState = {
  /** oracle name, e.g. "canon" — the stable identity, never a session number. */
  agent: string;
  phase: AgentPhase;
  /** short human summary of what it is on; sanitised before it can reach the room. */
  summary: string;
  /** monotonic per-agent version; a higher version with identical render still coalesces. */
  version: number;
};

const PHASE_ICON: Record<AgentPhase, string> = { active: "🟢", blocked: "🔴", done: "✅", idle: "⚪️", offline: "⚫️" };
const MAX_AGENTS = 64;
const SUMMARY_CAP = 120;
const EMPTY_DIGEST = "_(no agent state)_";
/** Stable marker on every digest so crash-recovery can find EXACTLY this message and not some
 *  other message the same bot posted (anvil: the bot has unrelated messages in the room). It is
 *  a visible footer — honest labelling of the one managed message; recovery rejects 0/>1. */
export const MIRROR_MARKER = "-# ⟦agent-state-mirror⟧";
/** Field delimiter for the hash pre-image — a real byte at runtime, written without a raw
 *  control byte in source (probe (ก): a raw separator turns the whole file into a binary blob
 *  that no diff/PR/`git log -p` can review). */
const SEP = String.fromCharCode(31);
const CONTROL_CHARS = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(8) + String.fromCharCode(11) + String.fromCharCode(12) + String.fromCharCode(14) + "-" + String.fromCharCode(31) + String.fromCharCode(127) + "]", "g");
const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
const ZERO_WIDTH = String.fromCharCode(0x200b);

/** Neutralise every Discord ping trigger textually (defense in depth; the payload's
 *  allowed_mentions:{parse:[]} is the authoritative guard). A zero-width space after the trigger
 *  keeps the text readable while breaking the mention. */
function neutralizeMentions(text: string): string {
  return text.replace(/@(everyone|here)/g, "@" + ZERO_WIDTH + "$1").replace(/<(@|#|@&)/g, "<" + ZERO_WIDTH + "$1");
}

/** Redact token-shaped runs so a mis-supplied secret cannot ride a summary into the room
 *  (constraint G; the mirror is the last gate before a public channel). Conservative: dotted
 *  JWT/bot-token shapes and long opaque runs. */
function redactSecrets(text: string): string {
  return text
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g, "[redacted]")
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, "[redacted]");
}

/** A summary is a label, never a payload: strip control chars (NUL is not \s), redact secrets,
 *  neutralise mentions, collapse whitespace, cap length. */
export function sanitizeSummary(summary: string): string {
  const cleaned = redactSecrets(summary.replace(CONTROL_CHARS, ""));
  const oneLine = neutralizeMentions(cleaned).replace(/\s+/g, " ").trim();
  return oneLine.length > SUMMARY_CAP ? oneLine.slice(0, SUMMARY_CAP - 1) + "…" : oneLine;
}

const VALID_PHASES: ReadonlySet<string> = new Set(["active", "blocked", "done", "idle", "offline"]);
const DISCORD_CONTENT_LIMIT = 2000;

function assertValidStates(states: readonly AgentState[]): void {
  if (!Array.isArray(states)) throw new Error("invalid agent state");
  if (states.length > MAX_AGENTS) throw new Error("too many agents in state");
  const seen = new Set<string>();
  for (const s of states) {
    if (!s || typeof s.agent !== "string" || !s.agent || /\s/.test(s.agent)) throw new Error("invalid agent identity");
    if (!VALID_PHASES.has(s.phase)) throw new Error("invalid agent phase");
    if (typeof s.summary !== "string") throw new Error("invalid agent summary");
    if (typeof s.version !== "number" || !Number.isFinite(s.version)) throw new Error("invalid agent version");
    if (seen.has(s.agent)) throw new Error("duplicate agent state");   // last-wins would silently drop a change
    seen.add(s.agent);
  }
}

/** One deterministic line per agent (sorted), phase icon, sanitised summary, mention-safe agent
 *  name. Empty input renders an explicit placeholder (never "" — Discord rejects empty content). */
export function renderDigest(states: readonly AgentState[]): string {
  assertValidStates(states);
  const sorted = [...states].sort((a, b) => (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));
  const lines = sorted.map(s => `${PHASE_ICON[s.phase]} **${neutralizeMentions(s.agent)}** — ${sanitizeSummary(s.summary)}`);
  const footer = `\n${MIRROR_MARKER}`;
  // Bound total content to Discord's 2000-char limit: keep as many whole lines as fit and note
  // the elision, so a large fleet never produces an over-limit (rejected) or truncated-mid-line digest.
  let body = states.length === 0 ? EMPTY_DIGEST : lines.join("\n");
  if (body.length + footer.length > DISCORD_CONTENT_LIMIT) {
    const kept: string[] = [];
    let used = footer.length;
    for (let i = 0; i < lines.length; i++) {
      const note = `\n… (${lines.length - kept.length} more)`;
      if (used + lines[i]!.length + 1 + note.length > DISCORD_CONTENT_LIMIT) break;
      kept.push(lines[i]!); used += lines[i]!.length + 1;
    }
    body = kept.join("\n") + `\n… (${lines.length - kept.length} more)`;
  }
  return `${body}${footer}`;
}

/** One-way per-agent fingerprint: what reached the room last time, stored as a hash so the
 *  persisted snapshot never holds the plaintext summary (anvil P2 #1). */
function fingerprint(s: AgentState): string {
  return createHash("sha256").update([s.agent, s.phase, sanitizeSummary(s.summary)].join(SEP)).digest("hex");
}

export type MirrorSnapshot = Map<string, string>;

/** Did the digest change vs the last emitted snapshot? Coalesces identical fingerprints across
 *  all agents (a version bump that renders identically ⇒ no emit). */
export function diffSnapshot(states: readonly AgentState[], last: MirrorSnapshot): { changed: boolean; next: MirrorSnapshot } {
  assertValidStates(states);
  const next: MirrorSnapshot = new Map();
  for (const s of states) next.set(s.agent, fingerprint(s));
  if (next.size !== last.size) return { changed: true, next };
  for (const [agent, fp] of next) if (last.get(agent) !== fp) return { changed: true, next };
  return { changed: false, next };
}

/** Outbound sink: post the single digest, edit it thereafter, and recover its id after a crash
 *  by finding this bot's own existing digest in the room. Never sends commands. */
export interface DigestSink {
  post(text: string): Promise<{ messageId: string }>;
  edit(messageId: string, text: string): Promise<void>;
  /** Receiver-side recovery: the bot's own most-recent message in the channel, if any. */
  recover(): Promise<{ messageId: string } | undefined>;
}

export interface MessagePoster {
  postMessage(channelId: string, content: string): Promise<{ messageId: string }>;
  editMessage(channelId: string, messageId: string, content: string): Promise<void>;
  /** Find the single message in the channel whose content carries `marker`. Must throw on >1
   *  (ambiguous) so recovery never silently adopts the wrong digest. */
  findMarkedMessage(channelId: string, marker: string): Promise<{ messageId: string } | undefined>;
}
/** Binds exactly one channel at construction — the mirror has one visible sink, structurally. */
export class DiscordDigestSink implements DigestSink {
  constructor(private readonly client: MessagePoster, private readonly channelId: string) {
    if (!DISCORD_SNOWFLAKE.test(channelId)) throw new Error("digest channel invalid");
  }
  post(text: string) { return this.client.postMessage(this.channelId, text); }
  edit(messageId: string, text: string) { return this.client.editMessage(this.channelId, messageId, text); }
  recover() { return this.client.findMarkedMessage(this.channelId, MIRROR_MARKER); }
}

export type MirrorState = { messageId: string; snapshot: Record<string, string> };
export interface MirrorStateStore {
  load(): MirrorState | undefined;
  save(state: MirrorState): void;
}

/** File-backed mirror state: 0700 dir / 0600 file, refuses symlinks and non-regular files,
 *  atomic temp+fsync+rename, shape-validated load that fails closed with a named error (never a
 *  raw SyntaxError that could echo file bytes — probe 5b). Holds message id + hashes only. */
export class FileMirrorStateStore implements MirrorStateStore {
  constructor(readonly path: string) {
    const root = dirname(path);
    if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error("mirror state path invalid");
    mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
    if (existsSync(path)) this.assertSafeFile();
  }
  load(): MirrorState | undefined {
    if (!existsSync(this.path)) return undefined;
    this.assertSafeFile();
    let value: any;
    try { value = JSON.parse(readFileSync(this.path, "utf8")); } catch { throw new Error("mirror state corrupt"); }
    if (!value || typeof value !== "object" || !DISCORD_SNOWFLAKE.test(value.messageId ?? "")
      || typeof value.snapshot !== "object" || value.snapshot === null || Array.isArray(value.snapshot)
      || Object.values(value.snapshot).some((v: unknown) => typeof v !== "string")) throw new Error("mirror state corrupt");
    return { messageId: value.messageId, snapshot: value.snapshot };
  }
  save(state: MirrorState): void {
    const temporary = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(state) + "\n", { encoding: "utf8", mode: 0o600 });
    const fd = openSync(temporary, "r"); fsyncSync(fd); closeSync(fd);
    renameSync(temporary, this.path);
    const dirfd = openSync(dirname(this.path), "r"); fsyncSync(dirfd); closeSync(dirfd);
    chmodSync(this.path, 0o600);
  }
  private assertSafeFile() {
    const st = lstatSync(this.path);
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o600) throw new Error("mirror state corrupt");
  }
}

export class StateMirror {
  private last: MirrorSnapshot;
  private messageId: string | undefined;
  /** Single-flight tail: concurrent reconcile calls chain so two cannot both post (anvil P2 #3). */
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly sink: DigestSink, private readonly store?: MirrorStateStore) {
    const persisted = store?.load();
    this.messageId = persisted?.messageId;
    this.last = new Map(Object.entries(persisted?.snapshot ?? {}));
  }

  /** Reconcile the room to `states`. Emits only on real change; returns what it did. */
  reconcile(states: readonly AgentState[]): Promise<"posted" | "edited" | "noop"> {
    const run = this.chain.then(() => this.reconcileOnce(states));
    this.chain = run.catch(() => {});   // a failed reconcile must not wedge the queue
    return run;
  }

  private async reconcileOnce(states: readonly AgentState[]): Promise<"posted" | "edited" | "noop"> {
    const { changed, next } = diffSnapshot(states, this.last);
    if (!changed && this.messageId !== undefined) return "noop";
    // Never post empty content: with no state and nothing posted yet, there is nothing to show.
    if (states.length === 0 && this.messageId === undefined) { this.last = next; return "noop"; }
    const text = renderDigest(states);

    // No in-memory id: a prior process may already have posted before it could save. Ask the room
    // (receiver-side recovery) before posting again, so a crash in the post→save window cannot
    // produce a second visible digest (anvil P2 #2 / probe (ค)).
    if (this.messageId === undefined) {
      const recovered = await this.sink.recover();
      if (recovered) this.messageId = recovered.messageId;
    }

    let action: "posted" | "edited";
    if (this.messageId === undefined) {
      const { messageId } = await this.sink.post(text);
      this.messageId = messageId; action = "posted";
    } else {
      await this.sink.edit(this.messageId, text); action = "edited";
    }
    // Persist BEFORE committing in-memory state, so a save failure cannot leave the process
    // believing it is durable when it is not.
    this.store?.save({ messageId: this.messageId, snapshot: Object.fromEntries(next) });
    this.last = next;
    return action;
  }
}
