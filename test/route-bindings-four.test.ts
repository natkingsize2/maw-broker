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
 * Update 2026-08-14 01:16: per owner contract, `mqtt` is no longer a field `ProjectRoute` can
 * carry at all (see `src/project-routes.ts` — the loader now REJECTS any row with an `mqtt` key,
 * rather than accepting it). The fixture below is the CORRECTED shape — what the live config
 * must look like to load at all now. The separate CONTRACT test further down proves the loader
 * rejects the file's CURRENT on-disk shape (which still has `mqtt` on 2 of 4 rows as of last
 * read) — i.e. the real production config will not load until it is fixed, and that failure is
 * loud, not silent.
 */
const FOUR_PRODUCTION_ROUTES: ProjectRoute[] = [
  { name: "oracle-continuity", transport: "discord-text", destination: "1537404236403581029", agent: "mba:02-anvil", issue: "natkingsize2/anvil-oracle#1" },
  { name: "livesiang", transport: "discord-text", destination: "1537404238861438996", agent: "03-canon:1", issue: "natkingsize2/liveSiang#15" },
  { name: "broker-project-router", transport: "discord-text", destination: "1537404241763639336", agent: "03-canon:1", issue: "natkingsize2/maw-broker#1" },
  { name: "maw-pipecat", transport: "discord-text", destination: "1537405946379243600", agent: "mba:02-anvil", issue: "natkingsize2/liveSiang#95" },
];

/** The file exactly as it sits on disk today (`~/.config/maw-broker/project-routes.json`,
 *  last read 2026-08-13 19:26) — still carrying `mqtt` on 2 rows. Used ONLY to prove the loader
 *  now refuses it; never used for any successful-load assertion. */
const LIVE_CONFIG_SHAPE_AS_OF_TODAY: unknown[] = [
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

  test("CONTRACT: the file's CURRENT on-disk shape (mqtt still on 2 of 4 rows) is refused, loudly, not silently loaded", () => {
    expect(() => loadProjectRoutesFile(routesFile(LIVE_CONFIG_SHAPE_AS_OF_TODAY))).toThrow("mqtt field rejected");
    // Confirms WHICH rows are the problem, so whoever fixes the live file knows exactly what to touch.
    const offenders = LIVE_CONFIG_SHAPE_AS_OF_TODAY.filter((r: any) => r.mqtt !== undefined).map((r: any) => r.name);
    expect(offenders).toEqual(["livesiang", "broker-project-router"]);
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
