import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectRoutesFile, ProjectRegistry, type ProjectRoute } from "../src/project-routes";
import { buildSummaryContent, postSummary, SUMMARY_MARKER } from "../src/summary-back";

const GOOD: ProjectRoute[] = [
  { name: "livesiang", transport: "discord-text", destination: "1537404238861438996", agent: "03-canon:1", issue: "natkingsize2/liveSiang#15" },
  { name: "broker-project-router", transport: "discord-text", destination: "1537404241763639336", agent: "03-canon:1", issue: "natkingsize2/maw-broker#1" },
];

function routesFile(body: unknown, mode = 0o600): string {
  const path = join(mkdtempSync(join(tmpdir(), "proutes-")), "project-routes.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  chmodSync(path, mode);
  return path;
}

describe("loadProjectRoutesFile", () => {
  test("loads N validated routes (multi-route is the point of phase-4)", () => {
    const routes = loadProjectRoutesFile(routesFile(GOOD));
    expect(routes).toHaveLength(2);
    expect(routes[1]!.issue).toBe("natkingsize2/maw-broker#1");
  });

  test("rejects: wrong mode, bad shape, bad issue ref, duplicates, empty", () => {
    expect(() => loadProjectRoutesFile(routesFile(GOOD, 0o644))).toThrow("project routes file invalid");
    expect(() => loadProjectRoutesFile(routesFile("{not json"))).toThrow("project routes file invalid");
    expect(() => loadProjectRoutesFile(routesFile([]))).toThrow("project routes file empty");
    expect(() => loadProjectRoutesFile(routesFile([{ ...GOOD[0], issue: "no-hash" }]))).toThrow("issue invalid");
    expect(() => loadProjectRoutesFile(routesFile([{ ...GOOD[0], issue: "a/b#0" }]))).toThrow("issue invalid");
    expect(() => loadProjectRoutesFile(routesFile([{ ...GOOD[0], destination: "123" }]))).toThrow("destination invalid");
    expect(() => loadProjectRoutesFile(routesFile([{ ...GOOD[0], name: "Has Space" }]))).toThrow("name invalid");
    expect(() => loadProjectRoutesFile(routesFile([GOOD[0], GOOD[0]]))).toThrow("duplicate");
    expect(() => loadProjectRoutesFile(routesFile([GOOD[0], { ...GOOD[1], destination: GOOD[0]!.destination }]))).toThrow("duplicate");
  });
});

describe("ProjectRegistry", () => {
  const registry = new ProjectRegistry(GOOD);
  test("looks up both ways and lists names sorted", () => {
    expect(registry.project("livesiang")?.issue).toBe("natkingsize2/liveSiang#15");
    expect(registry.destination("1537404241763639336")?.name).toBe("broker-project-router");
    expect(registry.project("nope")).toBeUndefined();
    expect(registry.names()).toEqual(["broker-project-router", "livesiang"]);
  });
  test("refuses to exist empty", () => {
    expect(() => new ProjectRegistry([])).toThrow("project registry empty");
  });
});

describe("summary-back", () => {
  const route = GOOD[1]!;

  test("content = sanitized body + marker footer referencing the issue", () => {
    const content = buildSummaryContent(route, "งานเสร็จแล้ว\n\nรายละเอียด @everyone <@123>");
    expect(content).toContain(SUMMARY_MARKER);
    expect(content).toContain(route.issue);
    expect(content).not.toMatch(/@everyone/);          // neutralised
    expect(content.split("\n").at(-1)).toBe(`-# ${SUMMARY_MARKER} ${route.issue}`);
  });

  test("empty (or sanitised-to-empty) text is refused — never post a blank summary", () => {
    expect(() => buildSummaryContent(route, "   \n ")).toThrow("summary text empty");
  });

  test("body + footer always fit Discord's 2000 limit", () => {
    const content = buildSummaryContent(route, "ก".repeat(5000));
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content.endsWith(`-# ${SUMMARY_MARKER} ${route.issue}`)).toBe(true);
  });

  test("postSummary posts to the project's thread and reports ids; unknown project throws", async () => {
    const posts: Array<{ channelId: string; content: string }> = [];
    const client = { postMessage: async (channelId: string, content: string) => { posts.push({ channelId, content }); return { messageId: "9".repeat(18) }; } };
    const registry = new ProjectRegistry(GOOD);
    const result = await postSummary(client, registry, "broker-project-router", "สรุปงาน");
    expect(posts[0]!.channelId).toBe(route.destination);
    expect(result.issue).toBe(route.issue);
    await expect(postSummary(client, registry, "unknown", "x")).rejects.toThrow("unknown project");
  });
});
