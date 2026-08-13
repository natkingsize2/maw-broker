import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectRoutesFile, ProjectRegistry, type ProjectRoute } from "../src/project-routes";
import { buildSummaryContent, postSummary } from "../src/summary-back";

/**
 * Owner-audit test: the FOUR real production route bindings, read structurally from the live
 * config shape (`~/.config/maw-broker/project-routes.json` on macmini, 2026-08-13 19:26) — not
 * fabricated fixtures. Snowflake IDs and issue refs are not secrets; the bot token is not used
 * anywhere in this file (fake transport only, per the owner's "prepare, do not deploy" scope).
 *
 * Finding surfaced by this file (see dossier §Findings): two of the four routes carry an `mqtt`
 * field. The 2026-08-14 owner directive says "No MQTT" for this launch — those fields must be
 * stripped from the real config before any launch gate opens. This test intentionally keeps them
 * in the fixture so the loader's schema behavior is verified against the ACTUAL file shape on
 * disk today, not a sanitized stand-in.
 */
const FOUR_PRODUCTION_ROUTES: ProjectRoute[] = [
  { name: "oracle-continuity", transport: "discord-text", destination: "1537404236403581029", agent: "mba:02-anvil", issue: "natkingsize2/anvil-oracle#1" },
  { name: "livesiang", transport: "discord-text", destination: "1537404238861438996", agent: "03-canon:1", issue: "natkingsize2/liveSiang#15", mqtt: "canon" },
  { name: "broker-project-router", transport: "discord-text", destination: "1537404241763639336", agent: "03-canon:1", issue: "natkingsize2/maw-broker#1", mqtt: "canon" },
  { name: "maw-pipecat", transport: "discord-text", destination: "1537405946379243600", agent: "mba:02-anvil", issue: "natkingsize2/liveSiang#95" },
];

function routesFile(body: unknown, mode = 0o600): string {
  const path = join(mkdtempSync(join(tmpdir(), "proutes4-")), "project-routes.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  chmodSync(path, mode);
  return path;
}

describe("four production route bindings — static load", () => {
  test("all four load and validate against the real project-routes.json shape", () => {
    const routes = loadProjectRoutesFile(routesFile(FOUR_PRODUCTION_ROUTES));
    expect(routes).toHaveLength(4);
    expect(routes.map(r => r.name)).toEqual(["oracle-continuity", "livesiang", "broker-project-router", "maw-pipecat"]);
  });

  test("registry resolves each of the four both ways (name → route, destination → route)", () => {
    const registry = new ProjectRegistry(FOUR_PRODUCTION_ROUTES);
    for (const route of FOUR_PRODUCTION_ROUTES) {
      expect(registry.project(route.name)?.destination).toBe(route.destination);
      expect(registry.destination(route.destination)?.name).toBe(route.name);
    }
    expect(registry.names()).toEqual(["broker-project-router", "livesiang", "maw-pipecat", "oracle-continuity"]);
  });

  test("cross-node agent field survives unmodified (mba:02-anvil vs 03-canon:1) — no substring/derivation", () => {
    const registry = new ProjectRegistry(FOUR_PRODUCTION_ROUTES);
    expect(registry.project("oracle-continuity")?.agent).toBe("mba:02-anvil");
    expect(registry.project("maw-pipecat")?.agent).toBe("mba:02-anvil");
    expect(registry.project("livesiang")?.agent).toBe("03-canon:1");
  });

  test("FINDING: 2 of 4 routes carry mqtt — contradicts 2026-08-14 owner 'No MQTT' scope; must be stripped before launch", () => {
    const registry = new ProjectRegistry(FOUR_PRODUCTION_ROUTES);
    const withMqtt = FOUR_PRODUCTION_ROUTES.filter(r => r.mqtt).map(r => r.name);
    expect(withMqtt).toEqual(["livesiang", "broker-project-router"]);
    expect(registry.project("livesiang")?.mqtt).toBe("canon");
  });
});

describe("four production route bindings — fake-transport outbound (summary-back)", () => {
  test("each of the four routes posts to its OWN destination only, with a fake client (no real Discord call)", async () => {
    const registry = new ProjectRegistry(FOUR_PRODUCTION_ROUTES);
    const posts: Array<{ channelId: string; content: string }> = [];
    const fakeClient = {
      postMessage: async (channelId: string, content: string) => {
        posts.push({ channelId, content });
        return { messageId: `fake-${posts.length}` };
      },
    };
    for (const route of FOUR_PRODUCTION_ROUTES) {
      const result = await postSummary(fakeClient, registry, route.name, `test summary for ${route.name}`);
      expect(result.destination).toBe(route.destination);
      expect(result.issue).toBe(route.issue);
    }
    // No cross-talk: 4 posts landed at 4 distinct destinations, each exactly once.
    expect(posts).toHaveLength(4);
    expect(new Set(posts.map(p => p.channelId)).size).toBe(4);
    expect(posts.map(p => p.channelId).sort()).toEqual(FOUR_PRODUCTION_ROUTES.map(r => r.destination).sort());
  });

  test("a summary for route A never reaches route B's destination (no destination bleed under fake transport)", async () => {
    const registry = new ProjectRegistry(FOUR_PRODUCTION_ROUTES);
    const posts: Array<{ channelId: string; content: string }> = [];
    const fakeClient = { postMessage: async (channelId: string, content: string) => { posts.push({ channelId, content }); return { messageId: "1" }; } };
    await postSummary(fakeClient, registry, "livesiang", "livesiang-only text");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channelId).toBe("1537404238861438996");
    expect(posts[0]!.channelId).not.toBe(registry.project("maw-pipecat")!.destination);
    expect(posts[0]!.channelId).not.toBe(registry.project("oracle-continuity")!.destination);
    expect(posts[0]!.channelId).not.toBe(registry.project("broker-project-router")!.destination);
  });

  test("unknown project name is refused before any fake-transport call is made (fail-closed, zero side effect)", async () => {
    const registry = new ProjectRegistry(FOUR_PRODUCTION_ROUTES);
    let calls = 0;
    const fakeClient = { postMessage: async () => { calls++; return { messageId: "x" }; } };
    await expect(postSummary(fakeClient, registry, "not-a-real-project", "x")).rejects.toThrow("unknown project");
    expect(calls).toBe(0);
  });

  test("content sent to fake transport for each route carries that route's own issue footer, not another's", () => {
    for (const route of FOUR_PRODUCTION_ROUTES) {
      const content = buildSummaryContent(route, "body");
      expect(content.endsWith(route.issue)).toBe(true);
      for (const other of FOUR_PRODUCTION_ROUTES) {
        if (other.name !== route.name) expect(content.includes(other.issue)).toBe(false);
      }
    }
  });
});
