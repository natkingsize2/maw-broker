import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProjectLauncher, loadOrPinIdentity, mawSessionsResolver, routesFileSha256, type ProjectLauncher } from "../src/project-route-launcher";
import type { Ack } from "../src/types";

const OWNER = "900000000000000777";
const OUTSIDER = "900000000000000888";
const KEY = Buffer.alloc(32, 7).toString("base64");
const THREAD_A = "1537404241763639336";
const THREAD_B = "1537404238861438996";

const ROUTES = [
  { name: "broker-project-router", transport: "discord-text", destination: THREAD_A, agent: "03-canon:0", issue: "natkingsize2/maw-broker#1" },
  { name: "livesiang", transport: "discord-text", destination: THREAD_B, agent: "03-canon:0", issue: "natkingsize2/liveSiang#15" },
];

let dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "proj-inbound-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function writeRoutes(dir: string, routes: unknown = ROUTES): string {
  const p = join(dir, "project-routes.json");
  writeFileSync(p, JSON.stringify(routes), { mode: 0o600 });
  return p;
}

/** Fake bridge client: per-channel raw Discord rows + react recorder. Shaped like the two
 *  facets the launcher actually uses (DiscordClient.getMessages + Reactor.react). */
class FakeBridge {
  rows = new Map<string, any[]>();
  reacted: Array<{ channel: string; messageId: string; emoji: string }> = [];
  async getMessages(channelId: string, after?: string): Promise<unknown[]> {
    const all = this.rows.get(channelId) ?? [];
    return after ? all.filter(r => BigInt(r.id) > BigInt(after)) : all;
  }
  async react(channelId: string, messageId: string, emoji: string) { this.reacted.push({ channel: channelId, messageId, emoji }); }
}

let nextId = 9000;
function row(channel: string, content: string, author = OWNER, extra: Record<string, unknown> = {}) {
  return { id: String(nextId++), channel_id: channel, content, author: { id: author }, timestamp: new Date().toISOString(), ...extra };
}

function env(routesPath: string, storeRoot: string): Record<string, string | undefined> {
  return {
    MAW_PROJECT_ROUTES_FILE: routesPath,
    MAW_PROJECT_INBOUND_STORE_ROOT: storeRoot,
    MAW_BROKER_OWNER_ID: OWNER,
    MAW_BROKER_KEY_B64: KEY,
    MAW_BRIDGE_CLIENT_CONFIG_FILE: undefined,
    MAW_BRIDGE_URL: "http://127.0.0.1:65000",
    MAW_BRIDGE_LOCAL_TOKEN: "x".repeat(32),
  };
}

type Deps = NonNullable<Parameters<typeof buildProjectLauncher>[1]>;
function deps(bridge: FakeBridge, injections: Array<{ messageId: string; route: string }>): Deps {
  return {
    resolver: async agent => agent, // every target exists unless a test overrides
    bridgeClient: bridge as any,
    injector: async (_plaintext, messageId, route): Promise<Ack> => { injections.push({ messageId, route }); return { messageId, route, accepted: true }; },
    now: () => "2026-08-15T00:00:00Z",
  };
}

describe("configuration and guards fail closed", () => {
  test("missing env refuses", async () => {
    await expect(buildProjectLauncher({}, {})).rejects.toThrow("project inbound configuration invalid");
  });
  test("mqtt field in any route refuses at load (inherited no-MQTT guard)", async () => {
    const d = tmp();
    const p = writeRoutes(d, [{ ...ROUTES[0], mqtt: { host: "x" } }]);
    await expect(buildProjectLauncher(env(p, join(d, "store")), deps(new FakeBridge(), []))).rejects.toThrow("mqtt field rejected");
  });
  test("absent target refuses the whole launcher, naming the route, BEFORE any store side effect", async () => {
    const d = tmp(); const p = writeRoutes(d); const store = join(d, "store");
    const dead: Deps = { ...deps(new FakeBridge(), []), resolver: async agent => (agent === "03-canon:0" ? undefined : agent) };
    await expect(buildProjectLauncher(env(p, store), dead)).rejects.toThrow("project inbound target missing: broker-project-router→03-canon:0");
    expect(existsSync(join(store, "route-identity.json"))).toBe(false); // refusal happened before pinning
  });
  test("all targets resolve → launcher builds (green leg of the same gate)", async () => {
    const d = tmp(); const p = writeRoutes(d);
    const launcher = await buildProjectLauncher(env(p, join(d, "store")), deps(new FakeBridge(), []));
    expect(launcher.runners).toHaveLength(2);
    launcher.close();
  });
});

describe("write-once route identity", () => {
  test("pins on first build; refuses when the routes file changes; human rotation (delete) re-pins", async () => {
    const d = tmp(); const p = writeRoutes(d); const store = join(d, "store");
    const first = await buildProjectLauncher(env(p, store), deps(new FakeBridge(), []));
    first.close();
    const identityPath = join(store, "route-identity.json");
    expect(JSON.parse(readFileSync(identityPath, "utf8")).routesFileSha256).toBe(routesFileSha256(p));

    writeRoutes(d, [ROUTES[0]]); // same path, different bytes
    await expect(buildProjectLauncher(env(p, store), deps(new FakeBridge(), []))).rejects.toThrow("route identity mismatch");

    unlinkSync(identityPath); // the sanctioned human rotation
    const again = await buildProjectLauncher(env(p, store), deps(new FakeBridge(), []));
    expect(again.identity.routesFileSha256).toBe(routesFileSha256(p));
    again.close();
  });
  test("loadOrPinIdentity readback returns the pinned copy verbatim", () => {
    const d = tmp();
    const identity = { routesFileSha256: "a".repeat(64), targets: [], pinnedAt: "2026-08-15T00:00:00Z" };
    const p = join(d, "route-identity.json");
    expect(loadOrPinIdentity(p, identity)).toEqual(identity);
    expect(loadOrPinIdentity(p, identity)).toEqual(identity); // second load reads, not rewrites
  });
});

describe("per-route lease", () => {
  test("second launcher on the same store root is refused at the lease; close() releases", async () => {
    const d = tmp(); const p = writeRoutes(d); const store = join(d, "store");
    const first = await buildProjectLauncher(env(p, store), deps(new FakeBridge(), []));
    await expect(buildProjectLauncher(env(p, store), deps(new FakeBridge(), []))).rejects.toThrow("lease");
    first.close();
    const second = await buildProjectLauncher(env(p, store), deps(new FakeBridge(), []));
    second.close();
  });
});

describe("admission end-to-end per route (reviewed stack, untouched)", () => {
  async function build(bridge: FakeBridge) {
    const d = tmp(); const p = writeRoutes(d);
    const injections: Array<{ messageId: string; route: string }> = [];
    const launcher = await buildProjectLauncher(env(p, join(d, "store")), deps(bridge, injections));
    return { launcher, injections };
  }
  function runnerFor(launcher: ProjectLauncher, name: string) {
    return launcher.runners.find(r => r.route.name === name)!.runner;
  }

  test("owner 'approve' in thread A injects exactly once, with route=thread A; thread B never sees it", async () => {
    const bridge = new FakeBridge();
    const approve = row(THREAD_A, "approve");
    bridge.rows.set(THREAD_A, [approve]);
    const { launcher, injections } = await build(bridge);
    const a = await runnerFor(launcher, "broker-project-router").runOnce();
    const b = await runnerFor(launcher, "livesiang").runOnce();
    expect(a.processed).toBe(1);
    expect(injections).toEqual([{ messageId: approve.id, route: THREAD_A }]);
    expect(b.processed).toBe(0);
    expect(bridge.reacted.some(r => r.channel === THREAD_A && r.messageId === approve.id)).toBe(true); // ack path fired
    launcher.close();
  });

  test("inert owner text is ignored and the cursor advances past it (the C9 regression, pinned)", async () => {
    const bridge = new FakeBridge();
    const inert = row(THREAD_A, "เห็นหรอยัง");
    bridge.rows.set(THREAD_A, [inert]);
    const { launcher, injections } = await build(bridge);
    const first = await runnerFor(launcher, "broker-project-router").runOnce();
    expect(first.processed).toBe(0);
    expect(injections).toHaveLength(0);
    bridge.rows.set(THREAD_A, [inert]); // same backlog again — an advanced cursor must skip it
    const second = await runnerFor(launcher, "broker-project-router").runOnce();
    expect(second.processed).toBe(0);
    expect(second.held).toBe(false);
    launcher.close();
  });

  test("bot 'approve' and foreign-author 'approve' never reach the injector", async () => {
    const bridge = new FakeBridge();
    bridge.rows.set(THREAD_A, [
      row(THREAD_A, "approve", OWNER, { author: { id: OWNER, bot: true } }),
      row(THREAD_A, "approve", OUTSIDER),
    ]);
    const { launcher, injections } = await build(bridge);
    await runnerFor(launcher, "broker-project-router").runOnce();
    expect(injections).toHaveLength(0);
    launcher.close();
  });
});

describe("mawSessionsResolver", () => {
  const sessions = { sessions: [{ name: "03-canon", windows: [{ index: 0 }] }] };
  const fetcher = (payload: unknown, ok = true) => async () => ({ ok, json: async () => payload });

  test("resolves an existing numeric window; refuses an absent index and a name-form local target", async () => {
    const resolve = mawSessionsResolver("http://x", fetcher(sessions) as any);
    expect(await resolve("03-canon:0")).toBe("03-canon:0");
    expect(await resolve("03-canon:1")).toBeUndefined();      // the exact C9 failure class
    expect(await resolve("03-canon:canon")).toBeUndefined();  // ambiguous name form refused locally
  });
  test("cross-node alias passes through; transport failure resolves to undefined (fail closed)", async () => {
    const resolve = mawSessionsResolver("http://x", fetcher(sessions) as any);
    expect(await resolve("mba:02-anvil")).toBe("mba:02-anvil");
    const dead = mawSessionsResolver("http://x", (async () => { throw new Error("refused"); }) as any);
    expect(await dead("03-canon:0")).toBeUndefined();
  });
});
