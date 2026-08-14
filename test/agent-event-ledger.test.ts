import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_EVENT_SCHEMA, AgentEventError, AgentEventLedger, buildAgentEventIdempotencyKey, type OutboundEmitter } from "../src/agent-event-ledger";
import { ProjectRegistry, type ProjectRoute } from "../src/project-routes";

const ROUTES: ProjectRoute[] = [
  { name: "livesiang", transport: "discord-text", destination: "1537404238861438996", agent: "03-canon:1", issue: "natkingsize2/liveSiang#15" },
  { name: "maw-pipecat", transport: "discord-text", destination: "1537405946379243600", agent: "mba:02-anvil", issue: "natkingsize2/liveSiang#95" },
];
const registry = new ProjectRegistry(ROUTES);

function fakeEmitter() {
  const discord: Array<{ destination: string; content: string }> = [];
  const github: Array<{ issueRef: string; comment: string }> = [];
  const emitter: OutboundEmitter = {
    emitDiscord: async (destination, content) => { discord.push({ destination, content }); },
    emitGitHub: async (issueRef, comment) => { github.push({ issueRef, comment }); },
  };
  return { emitter, discord, github };
}
const ev = (overrides: Record<string, unknown> = {}) => ({
  schema: AGENT_EVENT_SCHEMA, project: "livesiang", kind: "progress", event_id: "e1",
  agent: "canon", summary: "งานคืบหน้า ครึ่งทางแล้ว", occurred_at: "2026-08-14T15:45:00.000Z", ...overrides,
});

describe("strict schema", () => {
  test("all three kinds accepted; anything else (incl. 'final') rejected fail-closed", async () => {
    const { emitter } = fakeEmitter();
    const l = new AgentEventLedger(registry, emitter);
    for (const kind of ["progress", "done", "blocked"]) {
      const r = await l.accept(ev({ kind, event_id: `k-${kind}` }));
      expect(r.status).toBe("accepted");
    }
    for (const kind of ["final", "raw_audio", "unknown_future"]) {
      await expect(l.accept(ev({ kind, event_id: `bad-${kind}` }))).rejects.toThrow("rejected");
    }
  });
  test("extra/missing keys, wrong schema, bad occurred_at, unknown project — each refused with its own code", async () => {
    const { emitter } = fakeEmitter();
    const l = new AgentEventLedger(registry, emitter);
    const cases: Array<[unknown, string]> = [
      [ev({ extra: "x" }), "MALFORMED_EVENT"],
      [(() => { const e: any = ev(); delete e.agent; return e; })(), "MALFORMED_EVENT"],
      [ev({ schema: "v2" }), "MALFORMED_EVENT"],
      [ev({ occurred_at: "yesterday" }), "MALFORMED_EVENT"],
      [ev({ project: "not-registered" }), "UNKNOWN_PROJECT"],
    ];
    for (const [body, code] of cases) {
      let threw: AgentEventError | undefined;
      try { await l.accept(body); } catch (e) { threw = e as AgentEventError; }
      expect(threw?.code).toBe(code as any);
    }
  });
});

describe("exactly-once emission + idempotency", () => {
  test("first accept emits to BOTH sinks with the project's OWN destination+issue; replay emits NOTHING and returns the ORIGINAL receipt", async () => {
    const { emitter, discord, github } = fakeEmitter();
    const l = new AgentEventLedger(registry, emitter, undefined, () => "2026-08-14T15:45:01.000Z");
    const first = await l.accept(ev());
    expect(first.status).toBe("accepted");
    expect(first.idempotencyKey).toBe(buildAgentEventIdempotencyKey("livesiang", "e1"));
    expect(discord).toEqual([{ destination: "1537404238861438996", content: "[progress] canon @ livesiang: งานคืบหน้า ครึ่งทางแล้ว" }]);
    expect(github).toEqual([{ issueRef: "natkingsize2/liveSiang#15", comment: discord[0]!.content }]);
    const replay = await l.accept(ev());
    expect(replay.status).toBe("duplicate");
    expect(replay.receivedAt).toBe(first.receivedAt);
    expect(discord.length).toBe(1);   // exactly once
    expect(github.length).toBe(1);
  });
  test("same key + different summary = conflict; original record and emission count untouched", async () => {
    const { emitter, discord } = fakeEmitter();
    const l = new AgentEventLedger(registry, emitter);
    await l.accept(ev());
    await expect(l.accept(ev({ summary: "DIFFERENT" }))).rejects.toThrow("IDEMPOTENCY_CONFLICT".length ? /different content/ : "");
    expect(discord.length).toBe(1);
  });
  test("emitter failure leaves the key UNRECORDED — a retry re-emits instead of silently recording an untold event", async () => {
    const discord: string[] = [];
    let fail = true;
    const l = new AgentEventLedger(registry, {
      emitDiscord: async (_d, c) => { if (fail) throw new Error("sink down"); discord.push(c); },
      emitGitHub: async () => {},
    });
    await expect(l.accept(ev())).rejects.toThrow("sink down");
    fail = false;
    const r = await l.accept(ev());
    expect(r.status).toBe("accepted");   // NOT duplicate — first attempt never became a record
    expect(discord.length).toBe(1);
  });
});

describe("durable restart + chained audit", () => {
  test("across restart: replay is duplicate (no re-emit), audit chain survives and verifies", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-ael-"));
    const path = join(root, "ledger.json");
    const a = fakeEmitter();
    const l1 = new AgentEventLedger(registry, a.emitter, path, () => "2026-08-14T15:46:00.000Z");
    const first = await l1.accept(ev());
    expect(a.discord.length).toBe(1);

    const b = fakeEmitter();
    const l2 = new AgentEventLedger(registry, b.emitter, path);   // fresh process, same file
    const replay = await l2.accept(ev());
    expect(replay.status).toBe("duplicate");
    expect(replay.receivedAt).toBe(first.receivedAt);
    expect(b.discord.length).toBe(0);   // exactly-once holds ACROSS restart
    expect(l2.verifyAuditChain()).toBe(true);
    expect(l2.auditRows.map(r => r.event)).toEqual(["accepted", "replay"]);
  });
  test("tampered audit row is detected at load (chain refuses to verify)", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-ael-tamper-"));
    const path = join(root, "ledger.json");
    const a = fakeEmitter();
    const l1 = new AgentEventLedger(registry, a.emitter, path);
    await l1.accept(ev());
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.audit[0].kind = "done";   // rewrite history: progress → done
    writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
    expect(() => new AgentEventLedger(registry, a.emitter, path)).toThrow("audit chain broken");
  });
});
