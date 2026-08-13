import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Broker } from "./broker";
import { DiscordPollSource } from "./discord-source";
import { BrokerIngress } from "./ingress";
import { BrokerRunner, DiscordRestClient, DurableCursor, loadRunnerSecrets } from "./runner";
import { createMawInjector } from "./injector-maw";
import { DurableStore } from "./store";
import { RouteRegistry } from "./routes";
import type { Route } from "./types";

/** Phase-2 route launcher. Everything is explicit and fail-closed: no default channel, no
 *  name/fuzzy matching, no canary fallback (SPEC constraint A). The routes file is the exact
 *  allowlist — phase 2 requires exactly one route with a numeric destination and an agent. */
export function loadRoutesFile(path: string): Route[] {
  const state = lstatSync(path);
  if (!state.isFile() || state.isSymbolicLink() || (state.mode & 0o777) !== 0o600) throw new Error("routes file invalid");
  // Named error only: a raw SyntaxError may echo file content into logs (constraint G).
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("routes file invalid"); }
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("routes file must declare exactly one route in phase 2");
  const routes = parsed.map((row: unknown): Route => {
    const candidate = row as Partial<Route>;
    if (typeof candidate?.name !== "string" || !candidate.name) throw new Error("route name invalid");
    if (candidate.transport !== "discord-text") throw new Error("route transport invalid");
    if (typeof candidate.destination !== "string" || !/^\d{17,20}$/.test(candidate.destination)) throw new Error("route destination invalid");
    if (typeof candidate.agent !== "string" || !candidate.agent) throw new Error("route agent invalid");
    return { name: candidate.name, transport: candidate.transport, destination: candidate.destination, agent: candidate.agent };
  });
  return routes;
}

/** Production contract (anvil decision 2026-08-13 on probe finding 5a): the production
 *  artifact is HARD-PINNED to the original room. The library (`loadRoutesFile`) stays
 *  generic, but this launcher refuses startup when the routes file points anywhere else —
 *  a mis-pointed but shape-valid routes file must fail loudly, not run quietly. */
export const PRODUCTION_CHANNEL_ID = "1056224550129508415";
export function assertProductionChannel(routes: Route[]): void {
  if (routes.length !== 1 || routes[0]!.destination !== PRODUCTION_CHANNEL_ID) throw new Error("routes file channel differs from production pin");
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const secrets = loadRunnerSecrets(env);
  const routesFile = env.MAW_BROKER_ROUTES_FILE;
  const storeRoot = env.MAW_BROKER_STORE_ROOT;
  if (!routesFile || !storeRoot) throw new Error("broker route configuration invalid");
  const intervalMs = Number(env.ROUTE_POLL_INTERVAL_MS ?? "5000");
  const maxPolls = Number(env.ROUTE_MAX_POLLS ?? "120");
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || !Number.isInteger(maxPolls) || maxPolls < 1) throw new Error("broker route configuration invalid");

  const routes = loadRoutesFile(routesFile);
  assertProductionChannel(routes);
  const registry = new RouteRegistry(routes);
  const channel = routes[0]!.destination;
  const store = new DurableStore(join(storeRoot, "store"));
  const broker = new Broker(secrets.brokerKey, registry, store, secrets.ownerId);
  const client = new DiscordRestClient(secrets.discordBotToken);
  const runner = new BrokerRunner({
    source: new DiscordPollSource(client, channel),
    ingress: new BrokerIngress(broker),
    cursor: new DurableCursor(join(storeRoot, "cursor.json")),
    key: secrets.brokerKey,
    injector: createMawInjector(destination => registry.get(destination)?.agent),
    reactor: client,
  });

  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    for (let poll = 1; poll <= maxPolls && !stopping; poll++) {
      const result = await runner.runOnce();
      // Counts only — never message content (SPEC constraint G).
      console.log(`poll=${poll}/${maxPolls} processed=${result.processed} held=${result.held} injections=${runner.injectionCount}`);
      if (poll < maxPolls && !stopping) await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  } finally { runner.close(); }
}

if (import.meta.main) { main().catch(error => { console.error(String(error?.message ?? error)); process.exit(1); }); }
