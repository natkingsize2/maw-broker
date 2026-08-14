/**
 * Local-only HTTP wrapper for the agent-event ingress (`agent-event-daemon.ts`). Same
 * loopback-only, no-leaked-internals shape as `bridge-server.ts`/`final-event-server.ts` —
 * separate port, separate credential, separate store. Does not import `bridge-server.ts` or
 * `runner.ts`: this daemon has nothing to do with Discord's bridge process.
 *
 * Lease-before-bind and stop-order mirror `final-event-server.ts`'s documented fix (review r1
 * #1/#2) exactly, applied to the lease `AgentEventLedger` already owns internally (constructed
 * with a `path`, it acquires its own writer lease in its constructor — see
 * `agent-event-ledger.ts`'s `Lease` class):
 *   - construct the ledger (acquires the lease) BEFORE binding the port. If the bind then
 *     fails, the lease must not outlive a server that never came up — release immediately
 *     rather than making a successor wait out the stale-heartbeat window.
 *   - on `stop()`: listener FIRST, lease SECOND. Releasing the lease while the old listener
 *     still accepts connections would let a successor acquire the lease and bind a new port
 *     while requests can still reach the old process — two live receivers for one store, the
 *     exact state the lease exists to prevent.
 */
import { AgentEventDaemon, AgentEventLedger, type OutboundEmitter } from "./agent-event-ledger";
import { AgentEventHttpIngress, type AgentEventDaemonConfig } from "./agent-event-daemon";
import type { ProjectRegistry } from "./project-routes";
import { discordMarkerEmitter, type MarkerClientPort } from "./discord-marker-adapter";
import { githubMarkerEmitter, type GitHubRestClient } from "./adapter-github";

const LOOPBACK_ONLY = "127.0.0.1";

export function composeAgentEventEmitter(discordPort: MarkerClientPort, discordSelfId: string, githubClient: GitHubRestClient): OutboundEmitter {
  return { ...discordMarkerEmitter(discordPort, discordSelfId), ...githubMarkerEmitter(githubClient) };
}

export type AgentEventServerOptions = {
  port: number;
  /** Never anything but "127.0.0.1" in real use — a parameter only so the refusal path itself
   *  is directly testable, same convention as bridge-server.ts/final-event-server.ts. */
  hostname?: string;
  registry: ProjectRegistry;
  emitter: OutboundEmitter;
  storePath: string;
  config: AgentEventDaemonConfig;
  /** Dependency-injected only for tests (deterministic timestamps); production never passes
   *  this. */
  now?: () => string;
};

export function startAgentEventServer(options: AgentEventServerOptions) {
  const hostname = options.hostname ?? LOOPBACK_ONLY;
  if (hostname !== LOOPBACK_ONLY) throw new Error("agent-event server refuses to bind outside 127.0.0.1");
  const ledger = new AgentEventLedger(options.registry, options.emitter, options.storePath, options.now, options.config.authority, options.config.storeKey);
  const daemon = new AgentEventDaemon(ledger);
  const ingress = new AgentEventHttpIngress(daemon, options.config);
  const startedAt = new Date().toISOString();

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port: options.port,
      hostname,
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        // Liveness only, deliberately unauthenticated — same reasoning as the sibling
        // servers' /health: pid/startedAt are not secrets, and a probe gated by the
        // credential it exists to help debug is useless during an auth misconfiguration.
        if (req.method === "GET" && url.pathname === "/health") {
          return new Response(JSON.stringify({ status: "ok", pid: process.pid, startedAt }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        // Bounded-body enforcement lives in AgentEventHttpIngress.handle itself
        // (config.maxBodyBytes) — this wrapper adds no second limit, so there is exactly one
        // place that number can drift from what's actually enforced.
        return ingress.handle(req);
      },
    });
  } catch (error) {
    // Bind/start failed (e.g. port in use): the lease must not outlive the server that never
    // existed.
    daemon.close();
    throw error;
  }

  return {
    port: server.port,
    stop(closeActiveConnections?: boolean) {
      try { server.stop(closeActiveConnections); } finally { daemon.close(); }
    },
  };
}

if (import.meta.main) {
  const { loadAgentEventDaemonConfig } = await import("./agent-event-daemon");
  const { loadProjectRoutesFile, ProjectRegistry: Registry } = await import("./project-routes");
  const { loadGitHubMarkerSecrets, GitHubRestClient, githubMarkerEmitter } = await import("./adapter-github");
  const port = Number(process.env.MAW_AGENT_EVENT_PORT ?? "8793");
  const routesPath = process.env.MAW_PROJECT_ROUTES_FILE;
  const storePath = process.env.MAW_AGENT_EVENT_STORE_PATH;
  if (!routesPath || !storePath) throw new Error("agent-event server configuration invalid");
  const config = loadAgentEventDaemonConfig(process.env);
  const registry = new Registry(loadProjectRoutesFile(routesPath));
  const githubClient = new GitHubRestClient(loadGitHubMarkerSecrets().token);
  // Discord sink stays unimplemented/out of scope in THIS entrypoint (owner: "GitHub marker
  // adapter ONLY" — Discord's real OutboundEmitter half is a separate task). Refusing loudly
  // on first use rather than silently no-op-ing matches this codebase's own rule: no emitter
  // method may fail invisibly (see agent-event-ledger.ts's `hasDiscord`/`hasGitHub` guard in
  // its own constructor, which already refuses to construct a durable ledger without both).
  const emitter: OutboundEmitter = {
    ...githubMarkerEmitter(githubClient),
    async emitDiscord() { throw new Error("agent-event server: discord sink not wired in this entrypoint"); },
    async hasDiscord() { throw new Error("agent-event server: discord sink not wired in this entrypoint"); },
  };
  const server = startAgentEventServer({ port, registry, emitter, storePath, config });
  const stop = () => { server.stop(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  console.log(`agent-event listening on 127.0.0.1:${port}`);
}
