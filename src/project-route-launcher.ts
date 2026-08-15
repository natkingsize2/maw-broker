import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { BridgeHttpClient, loadBridgeClientConfig } from "./bridge-client";
import { Broker } from "./broker";
import { DiscordPollSource } from "./discord-source";
import { BrokerIngress } from "./ingress";
import { createMawInjector } from "./injector-maw";
import { ProjectRegistry, loadProjectRoutesFile, type ProjectRoute } from "./project-routes";
import { RouteRegistry } from "./routes";
import { BrokerRunner, DurableCursor, loadRunnerSecrets } from "./runner";
import { DurableStore } from "./store";

/** Project-thread inbound launcher (C9 contract repair, plan P1 — additive).
 *
 *  The original `route-launcher.ts` stays untouched with its single-route production pin;
 *  this launcher is the ProjectRegistry-aware counterpart: one BrokerRunner per project
 *  route, each polling its own Discord thread through the bridge (no Discord credential in
 *  this process) with its own durable cursor and per-route lease. Admission reuses the
 *  reviewed Broker/BrokerIngress stack unchanged, so the owner/bot/webhook/channel guards
 *  and the approve/reject grammar are inherited, not reimplemented.
 *
 *  Two additions this file owns (anvil requirements, 2026-08-15):
 *    - absent-target refusal: every route's agent target must resolve against the maw
 *      registry BEFORE any polling starts — a route pointing at a window that does not
 *      exist refuses the whole launcher loudly (the exact failure C9 surfaced).
 *    - write-once route identity: the resolved bindings are pinned to
 *      `<storeRoot>/route-identity.json` with the routes-file sha256. A later start with a
 *      different routes file refuses until a HUMAN rotates the pin by deleting the file —
 *      rotation is a mutation with an owner, never automatic. `--identity` prints the pin
 *      and exits (read-only readback). */

export type TargetResolver = (agent: string) => Promise<string | undefined>;

/** Default resolver: ask the local maw API which sessions/windows exist and resolve
 *  "session:windowIndex" (numeric form, exact index match — the only unambiguous local form
 *  per the 2026-08-07 find-window lesson) or a cross-node "node:session" name (presence is
 *  the node's responsibility; we only require the alias to be non-local). Fails closed:
 *  any transport error resolves to undefined, and undefined refuses startup. */
export function mawSessionsResolver(
  mawUrl: string = `http://localhost:${process.env.MAW_PORT || "3456"}`,
  fetcher: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }> = fetch as any,
): TargetResolver {
  return async (agent: string) => {
    const colon = agent.indexOf(":");
    if (colon <= 0) return undefined;
    const head = agent.slice(0, colon);
    const rest = agent.slice(colon + 1);
    try {
      const response = await fetcher(`${mawUrl}/api/sessions`);
      if (!response.ok) return undefined;
      const body = await response.json() as { sessions?: Array<{ name?: unknown; windows?: Array<{ index?: unknown }> }> } | Array<{ name?: unknown; windows?: Array<{ index?: unknown }> }>;
      const sessions = Array.isArray(body) ? body : body?.sessions;
      if (!Array.isArray(sessions)) return undefined;
      const local = sessions.find(s => s?.name === head);
      if (local) {
        if (!/^\d+$/.test(rest)) return undefined; // local form must be numeric index — names are ambiguous
        const idx = Number(rest);
        const window = (local.windows ?? []).find(w => w?.index === idx);
        return window ? `${head}:${idx}` : undefined;
      }
      // not a local session name → treat head as a peer node alias; local registry cannot
      // attest presence, so only accept when the head is genuinely non-local.
      return `${head}:${rest}`;
    } catch { return undefined; }
  };
}

export type RouteIdentity = {
  routesFileSha256: string;
  targets: Array<{ name: string; destination: string; agent: string; resolved: string }>;
  pinnedAt: string;
};

export function routesFileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Write-once pin. Existing pin must match the current routes-file sha byte-for-byte;
 *  a mismatch refuses with the one sanctioned remedy spelled out. */
export function loadOrPinIdentity(identityPath: string, candidate: RouteIdentity): RouteIdentity {
  if (existsSync(identityPath)) {
    const pinned = JSON.parse(readFileSync(identityPath, "utf8")) as RouteIdentity;
    if (pinned.routesFileSha256 !== candidate.routesFileSha256)
      throw new Error(`route identity mismatch: pinned ${pinned.routesFileSha256.slice(0, 16)}… vs routes file ${candidate.routesFileSha256.slice(0, 16)}… — a human must rotate by deleting ${identityPath}`);
    return pinned;
  }
  const fd = openSync(identityPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeSync(fd, JSON.stringify(candidate, null, 2)); } finally { closeSync(fd); }
  return candidate;
}

export type ProjectLauncher = {
  runners: Array<{ route: ProjectRoute; runner: BrokerRunner }>;
  identity: RouteIdentity;
  intervalMs: number;
  maxPolls: number;
  close(): void;
};

export type BuildDeps = {
  resolver?: TargetResolver;
  bridgeClient?: BridgeHttpClient;
  injector?: import("./types").DownstreamInjector;
  now?: () => string;
};

export async function buildProjectLauncher(env: Record<string, string | undefined> = process.env, deps: BuildDeps = {}): Promise<ProjectLauncher> {
  const routesPath = env.MAW_PROJECT_ROUTES_FILE;
  const storeRoot = env.MAW_PROJECT_INBOUND_STORE_ROOT;
  if (!routesPath || !storeRoot) throw new Error("project inbound configuration invalid");
  const intervalMs = Number(env.PROJECT_INBOUND_POLL_INTERVAL_MS ?? "5000");
  const maxPolls = Number(env.PROJECT_INBOUND_MAX_POLLS ?? "120");
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || !Number.isInteger(maxPolls) || maxPolls < 1) throw new Error("project inbound configuration invalid");

  const secrets = loadRunnerSecrets(env);                    // envelope auth only — no Discord credential
  const routes = loadProjectRoutesFile(routesPath);          // mqtt-field rejection lives in this loader
  const registry = new ProjectRegistry(routes);
  const resolver = deps.resolver ?? mawSessionsResolver();

  // absent-target refusal BEFORE any store/lease/poll side effect
  const resolvedTargets: RouteIdentity["targets"] = [];
  const missing: string[] = [];
  for (const route of routes) {
    const resolved = await resolver(route.agent);
    if (!resolved) missing.push(`${route.name}→${route.agent}`);
    else resolvedTargets.push({ name: route.name, destination: route.destination, agent: route.agent, resolved });
  }
  if (missing.length > 0) throw new Error(`project inbound target missing: ${missing.join(", ")} — fix the route map or the window layout before starting`);

  mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
  const identity = loadOrPinIdentity(join(storeRoot, "route-identity.json"), {
    routesFileSha256: routesFileSha256(routesPath),
    targets: resolvedTargets,
    pinnedAt: (deps.now ?? (() => new Date().toISOString()))(),
  });

  const { bridgeUrl, localAuthToken } = loadBridgeClientConfig(env);
  const client = deps.bridgeClient ?? new BridgeHttpClient(bridgeUrl, localAuthToken);
  const routeRegistry = new RouteRegistry(routes);
  const injector = deps.injector ?? createMawInjector(destination => registry.destination(destination)?.agent);

  const runners = routes.map(route => {
    const dir = join(storeRoot, route.name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const broker = new Broker(secrets.brokerKey, routeRegistry, new DurableStore(join(dir, "store")), secrets.ownerId);
    const runner = new BrokerRunner({
      source: new DiscordPollSource(client, route.destination),
      ingress: new BrokerIngress(broker),
      cursor: new DurableCursor(join(dir, "cursor.json")),   // per-route cursor ⇒ per-route lease (dirname)
      key: secrets.brokerKey,
      injector,
      reactor: client,
    });
    return { route, runner };
  });

  return { runners, identity, intervalMs, maxPolls, close() { for (const r of runners) r.runner.close(); } };
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  if (process.argv.includes("--identity")) {
    const storeRoot = env.MAW_PROJECT_INBOUND_STORE_ROOT;
    if (!storeRoot) throw new Error("project inbound configuration invalid");
    const identityPath = join(storeRoot, "route-identity.json");
    if (!existsSync(identityPath)) { console.log("no identity pinned"); return; }
    console.log(readFileSync(identityPath, "utf8"));
    return;
  }
  const launcher = await buildProjectLauncher(env);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    for (let poll = 1; poll <= launcher.maxPolls && !stopping; poll++) {
      for (const { route, runner } of launcher.runners) {
        const result = await runner.runOnce();
        // Counts only — never message content (same SPEC constraint G as route-launcher).
        console.log(`project-inbound poll=${poll}/${launcher.maxPolls} route=${route.name} processed=${result.processed} held=${result.held} injections=${runner.injectionCount}`);
      }
      if (poll < launcher.maxPolls && !stopping) await new Promise(resolve => setTimeout(resolve, launcher.intervalMs));
    }
  } finally { launcher.close(); }
}

if (import.meta.main) { main().catch(error => { console.error(String(error?.message ?? error)); process.exit(1); }); }
