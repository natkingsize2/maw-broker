/**
 * Local-only HTTP wrapper for the final-event receipt contract (`final-event-contract.ts`).
 * Same loopback-only, bearer-auth, no-leaked-internals shape as `bridge-server.ts` — but a
 * SEPARATE server, SEPARATE credential, SEPARATE port. It does not import `bridge-server.ts` or
 * `runner.ts`: this contract has nothing to do with Discord.
 */
import { FinalEventError, handleFinalEvent, type FinalEventSecrets, type FinalEventStore } from "./final-event-contract";

const LOOPBACK_ONLY = "127.0.0.1";

export type FinalEventServerOptions = {
  port: number;
  hostname?: string;
  store: FinalEventStore;
  secrets: FinalEventSecrets;
};

const STATUS_FOR_CODE: Record<string, number> = {
  UNAUTHORIZED: 401,
  MALFORMED_BODY: 400,
  UNKNOWN_ROUTE: 400,
  KIND_REJECTED: 400,
  DIGEST_MISMATCH: 400,
  CONTENT_REJECTED: 400,
  EVENT_ID_MISMATCH: 400,
  IDEMPOTENCY_KEY_FORMAT: 400,
  IDEMPOTENCY_CONFLICT: 409,
};

export function startFinalEventServer(options: FinalEventServerOptions) {
  const hostname = options.hostname ?? LOOPBACK_ONLY;
  if (hostname !== LOOPBACK_ONLY) throw new Error("final-event server refuses to bind outside 127.0.0.1");
  const startedAt = new Date().toISOString();

  return Bun.serve({
    port: options.port,
    hostname,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      // Liveness only, deliberately unauthenticated — same reasoning as bridge-server.ts's
      // /health: pid/startedAt are not secrets, and a probe gated by the credential it exists
      // to help debug is useless during an auth misconfiguration.
      if (req.method === "GET" && url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok", pid: process.pid, startedAt }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (req.method !== "POST" || url.pathname !== "/final-event") return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      let body: unknown;
      try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "malformed body" }), { status: 400 }); }
      try {
        const receipt = handleFinalEvent(req.headers.get("authorization"), body, options.store, options.secrets);
        return new Response(JSON.stringify(receipt), { status: 200, headers: { "Content-Type": "application/json" } });
      } catch (error) {
        if (error instanceof FinalEventError) {
          return new Response(JSON.stringify({ error: error.code, message: error.message }), { status: STATUS_FOR_CODE[error.code] ?? 400 });
        }
        return new Response(JSON.stringify({ error: "INTERNAL" }), { status: 500 });
      }
    },
  });
}

if (import.meta.main) {
  const { loadFinalEventSecrets, FileFinalEventStore } = await import("./final-event-contract");
  const port = Number(process.env.MAW_PIPECAT_RECEIPT_PORT ?? "8792");
  const storeRoot = process.env.MAW_PIPECAT_RECEIPT_STORE_ROOT;
  if (!storeRoot) throw new Error("final-event receipt configuration invalid");
  const secrets = loadFinalEventSecrets();
  const store = new FileFinalEventStore(`${storeRoot}/final-event-store.json`);
  const server = startFinalEventServer({ port, store, secrets });
  const stop = () => { server.stop(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  console.log(`final-event receipt listening on 127.0.0.1:${port}`);
}
