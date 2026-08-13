/**
 * Bridge server — the ONE process in this codebase allowed to construct a live, credentialed
 * `DiscordRestClient` (owner contract 2026-08-14: "One bridge daemon is the only Discord token
 * owner"). Every other entrypoint (`route-launcher.ts`, `mirror-launcher.ts`, `summary-back.ts`)
 * talks to THIS server over local-only HTTP via `bridge-client.ts`, never touching
 * `DISCORD_BOT_TOKEN` themselves.
 *
 * Hard invariants:
 *  - binds to 127.0.0.1 ONLY, never a wildcard/LAN address — `startBridgeServer` refuses any
 *    other hostname (constraint: this is a same-machine IPC boundary, not a network service);
 *  - every request requires `Authorization: Bearer <localAuthToken>` (a local-only secret,
 *    distinct from the Discord token) — a missing/wrong header is 401 before any Discord call;
 *  - request bodies are validated field-by-field before being handed to `DiscordRestClient` —
 *    a malformed body is a 400, never a crash that could leak a stack trace with the token in
 *    scope;
 *  - `test/bridge-server.test.ts` proves BOTH sides of this with a fake `DiscordRestClient`
 *    fetcher (dependency-injected), so the whole round trip is verified WITHOUT a real token or
 *    a real Discord call, consistent with the owner's "no deploy, no token, no Discord mutation".
 */
import { lstatSync, statSync, readFileSync } from "node:fs";
import { DiscordRestClient } from "./runner";

type FetchResponse = { ok: boolean; status: number; headers: Headers; json(): Promise<unknown> };
type FetchLike = (url: string, init: { method: "GET" | "PUT" | "POST" | "PATCH"; headers: Record<string, string>; body?: string }) => Promise<FetchResponse>;

export type BridgeSecrets = { discordBotToken: string; localAuthToken: string };

/** Deliberately separate from `loadRunnerSecrets` (`runner.ts`) — that loader returns
 *  `{ brokerKey, ownerId }` and has NO Discord token field at all now. This is the ONLY function
 *  in the codebase that reads `DISCORD_BOT_TOKEN`. */
export function loadBridgeSecrets(env: Record<string, string | undefined> = process.env): BridgeSecrets {
  try {
    let values: Record<string, string | undefined> = env;
    const path = env.MAW_BRIDGE_SECRETS_FILE;
    if (path) {
      if (lstatSync(path).isSymbolicLink() || (statSync(path).mode & 0o777) !== 0o600) throw new Error();
      values = JSON.parse(readFileSync(path, "utf8"));
    }
    const token = values.DISCORD_BOT_TOKEN, localAuthToken = values.MAW_BRIDGE_LOCAL_TOKEN;
    if (typeof token !== "string" || !token || typeof localAuthToken !== "string" || !localAuthToken) throw new Error();
    return { discordBotToken: token, localAuthToken };
  } catch { throw new Error("bridge server configuration invalid"); }
}

type Route = { path: string; run(client: DiscordRestClient, body: any): Promise<unknown> };
const ROUTES: Route[] = [
  { path: "/getMessages", run: async (c, b) => { if (typeof b?.channelId !== "string") throw new Error("bad request"); return c.getMessages(b.channelId, b.after, b.limit ?? 50, b.before); } },
  { path: "/react", run: async (c, b) => { if (typeof b?.channelId !== "string" || typeof b?.messageId !== "string" || typeof b?.emoji !== "string") throw new Error("bad request"); await c.react(b.channelId, b.messageId, b.emoji); return { ok: true }; } },
  { path: "/postMessage", run: async (c, b) => { if (typeof b?.channelId !== "string" || typeof b?.content !== "string") throw new Error("bad request"); return c.postMessage(b.channelId, b.content); } },
  { path: "/editMessage", run: async (c, b) => { if (typeof b?.channelId !== "string" || typeof b?.messageId !== "string" || typeof b?.content !== "string") throw new Error("bad request"); await c.editMessage(b.channelId, b.messageId, b.content); return { ok: true }; } },
  { path: "/findMarkedMessage", run: async (c, b) => { if (typeof b?.channelId !== "string" || typeof b?.marker !== "string") throw new Error("bad request"); const r = await c.findMarkedMessage(b.channelId, b.marker, b.maxScan); return r ?? null; } },
];

export type BridgeServerOptions = {
  port: number;
  /** Never anything but "127.0.0.1" in real use — a parameter only so the refusal path itself
   *  (any other value) is directly testable. */
  hostname?: string;
  secrets: BridgeSecrets;
  /** Dependency-injected only for tests — production never passes this, letting
   *  `DiscordRestClient` fall back to the real `fetch`. */
  fetcher?: FetchLike;
};

const LOOPBACK_ONLY = "127.0.0.1";

export function startBridgeServer(options: BridgeServerOptions) {
  const hostname = options.hostname ?? LOOPBACK_ONLY;
  if (hostname !== LOOPBACK_ONLY) throw new Error("bridge server refuses to bind outside 127.0.0.1");
  const client = new DiscordRestClient(options.secrets.discordBotToken, options.fetcher);

  const server = Bun.serve({
    port: options.port,
    hostname,
    async fetch(req: Request): Promise<Response> {
      const auth = req.headers.get("authorization");
      if (auth !== `Bearer ${options.secrets.localAuthToken}`) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      if (req.method !== "POST") return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      const url = new URL(req.url);
      const route = ROUTES.find(r => r.path === url.pathname);
      if (!route) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      let body: unknown;
      try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "bad request" }), { status: 400 }); }
      try {
        const result = await route.run(client, body);
        return new Response(JSON.stringify(result ?? null), { status: 200, headers: { "Content-Type": "application/json" } });
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        const status = message === "bad request" ? 400 : 502;
        // Never echo the Discord token: DiscordRestClient's own errors never include it
        // (constraint carried over from runner.test.ts), and this layer adds nothing new to leak.
        return new Response(JSON.stringify({ error: message }), { status });
      }
    },
  });
  return server;
}

if (import.meta.main) {
  const port = Number(process.env.MAW_BRIDGE_PORT ?? "8791");
  const secrets = loadBridgeSecrets();
  const server = startBridgeServer({ port, secrets });
  const stop = () => { server.stop(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  console.log(`bridge listening on 127.0.0.1:${port}`);
}
