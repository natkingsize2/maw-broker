import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStateSource } from "../src/mirror-launcher";
import { LiveStateSource, readEnvFileKey } from "../src/state-source-live";

const NOW = 1_786_622_500_000;
const MIN = 60_000;

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

function source(rows: unknown, over: Partial<ConstructorParameters<typeof LiveStateSource>[0]> = {}) {
  return new LiveStateSource({
    argusUrl: "https://example.invalid/api/live",
    token: "t",
    agents: ["canon", "probe"],
    phaseDirs: [],
    fetchImpl: fakeFetch(200, rows),
    now: () => NOW,
    ...over,
  });
}

function row(oracle: string, ageMs: number, extra: Record<string, unknown> = {}) {
  return { oracle, latest_ts: NOW - ageMs, context_used_pct: 17, session_name: "งาน X", short_dir: "canon", ...extra };
}

describe("LiveStateSource — argus rows to AgentState", () => {
  test("newest row per oracle wins; phase from row age; summary carries ctx + measurement age", async () => {
    const states = await source([
      row("canon", 120 * MIN, { session_name: "เก่า" }),
      row("canon", 2 * MIN),
      row("probe", 30 * MIN, { context_used_pct: 71, session_name: "review P2" }),
    ]).collect();
    const canon = states.find(s => s.agent === "canon")!;
    expect(canon.phase).toBe("active");
    expect(canon.summary).toContain("ctx 17%");
    expect(canon.summary).toContain("งาน X");
    expect(canon.summary).toContain("วัด 2m");
    expect(canon.version).toBe(NOW - 2 * MIN);
    const probe = states.find(s => s.agent === "probe")!;
    expect(probe.phase).toBe("idle");           // 30m: past active window, before offline
    expect(probe.summary).toContain("ctx 71%");
  });

  test("row older than offline threshold ⇒ offline", async () => {
    const states = await source([row("canon", 90 * MIN), row("probe", 1 * MIN)]).collect();
    expect(states.find(s => s.agent === "canon")!.phase).toBe("offline");
  });

  test("allowlisted agent with no row is reported unmeasured — never dropped, never healthy-zero", async () => {
    const states = await source([row("canon", 1 * MIN)]).collect();
    const probe = states.find(s => s.agent === "probe")!;
    expect(probe.phase).toBe("offline");
    expect(probe.summary).toContain("วัดไม่ได้");
    expect(states).toHaveLength(2);
  });

  test("unparseable context pct renders as unmeasured, not as a number", async () => {
    const states = await source([row("canon", 1 * MIN, { context_used_pct: "nope" }), row("probe", 1 * MIN)]).collect();
    expect(states.find(s => s.agent === "canon")!.summary).toContain("ctx วัดไม่ได้");
  });

  test("fail-closed: HTTP error, non-array body, and ZERO readable rows all throw", async () => {
    await expect(source([], { fetchImpl: fakeFetch(500, []) }).collect()).rejects.toThrow("argus unreachable");
    await expect(source({ not: "array" }).collect()).rejects.toThrow("argus response invalid");
    await expect(source([]).collect()).rejects.toThrow("no readable rows");
    await expect(source([{ oracle: "", latest_ts: "x" }]).collect()).rejects.toThrow("no readable rows");
  });

  test("roster is required and validated", () => {
    expect(() => source([], { agents: [] })).toThrow("configuration invalid");
    expect(() => source([], { agents: ["a b"] })).toThrow("configuration invalid");
  });
});

describe("LiveStateSource — task-phase overlay", () => {
  function phaseDir(files: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "phases-"));
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
    }
    return dir;
  }
  const fresh = new Date(NOW - 10 * MIN).toISOString();
  const stale = new Date(NOW - 5 * 24 * 60 * MIN).toISOString();

  test("fresh blocked_external flips phase to blocked and rides the summary", async () => {
    const dir = phaseDir({ "7.json": { taskId: 7, phase: "blocked_external", reason: "รอ GPU", assignee: "canon", updatedAt: fresh } });
    const states = await source([row("canon", 1 * MIN), row("probe", 1 * MIN)], { phaseDirs: [dir] }).collect();
    const canon = states.find(s => s.agent === "canon")!;
    expect(canon.phase).toBe("blocked");
    expect(canon.summary).toContain("task#7 blocked_external (รอ GPU)");
  });

  test("fresh awaiting_review rides the summary WITHOUT changing the phase", async () => {
    const dir = phaseDir({ "9.json": { taskId: 9, phase: "awaiting_review", reason: "", assignee: "canon", updatedAt: fresh } });
    const states = await source([row("canon", 1 * MIN), row("probe", 1 * MIN)], { phaseDirs: [dir] }).collect();
    const canon = states.find(s => s.agent === "canon")!;
    expect(canon.phase).toBe("active");
    expect(canon.summary).toContain("task#9 awaiting_review");
  });

  test("stale sidecar is ignored; corrupt sidecar throws (fail-closed, not shrug)", async () => {
    const staleDir = phaseDir({ "5.json": { taskId: 5, phase: "blocked_external", reason: "", assignee: "canon", updatedAt: stale } });
    const ok = await source([row("canon", 1 * MIN), row("probe", 1 * MIN)], { phaseDirs: [staleDir] }).collect();
    expect(ok.find(s => s.agent === "canon")!.phase).toBe("active");

    const corruptDir = phaseDir({ "6.json": "{not json" });
    await expect(source([row("canon", 1 * MIN)], { phaseDirs: [corruptDir] }).collect()).rejects.toThrow("task phase file corrupt");

    const missing = join(mkdtempSync(join(tmpdir(), "phases-")), "does-not-exist");
    await expect(source([row("canon", 1 * MIN)], { phaseDirs: [missing] }).collect()).rejects.toThrow("task phase dir unreadable");
  });
});

describe("resolveStateSource — env wiring (the call-site the placeholder guarded)", () => {
  const base = { MAW_MIRROR_AGENTS: "canon,probe", ARGUS_READ_TOKEN: "tok", HOME: "/nonexistent" };

  test("returns a LiveStateSource when roster + token present", async () => {
    expect(await resolveStateSource(base)).toBeInstanceOf(LiveStateSource);
  });

  test("refuses to run without a roster or without a token — same posture as the placeholder", async () => {
    await expect(resolveStateSource({ ARGUS_READ_TOKEN: "tok" })).rejects.toThrow("MAW_MIRROR_AGENTS missing");
    await expect(resolveStateSource({ MAW_MIRROR_AGENTS: "canon", HOME: "/nonexistent" })).rejects.toThrow("ARGUS_READ_TOKEN missing");
  });

  test("token can come from an env file (the ~/.config/argus/.env shape)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-"));
    mkdirSync(join(dir, ".config/argus"), { recursive: true });
    writeFileSync(join(dir, ".config/argus/.env"), "OTHER=1\nARGUS_READ_TOKEN=file-tok\n");
    expect(readEnvFileKey(join(dir, ".config/argus/.env"), "ARGUS_READ_TOKEN")).toBe("file-tok");
    expect(await resolveStateSource({ MAW_MIRROR_AGENTS: "canon", HOME: dir })).toBeInstanceOf(LiveStateSource);
  });
});
