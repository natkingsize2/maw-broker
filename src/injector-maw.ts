import { execFile } from "node:child_process";
import type { Ack, DownstreamInjector } from "./types";

/** Runs an argv (no shell) and resolves rc/stdout; rejects only on spawn failure. */
export type CommandRunner = (argv: string[], timeoutMs: number) => Promise<{ rc: number; stdout: string }>;

export const execFileRunner: CommandRunner = (argv, timeoutMs) =>
  new Promise(resolve => {
    const [cmd, ...args] = argv;
    execFile(cmd!, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      const rc = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? (error as unknown as { code: number }).code : 1) : 0;
      resolve({ rc, stdout: stdout ?? "" });
    });
  });

/** Minimal JSON-over-HTTP surface, injectable for tests. */
export type HttpJson = (method: "GET" | "POST", url: string, body?: unknown) => Promise<{ ok: boolean; json: unknown }>;
export const fetchJson: HttpJson = async (method, url, body) => {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed: unknown = undefined;
  try { parsed = await response.json(); } catch { /* body shape is validated by the caller */ }
  return { ok: response.ok, json: parsed };
};

export type InjectorTimings = { attempts: number; delayMs: number; sendTimeoutMs: number };
const DEFAULT_TIMINGS: InjectorTimings = { attempts: 6, delayMs: 2_000, sendTimeoutMs: 30_000 };

/**
 * Real downstream injector with RECEIVER-PRODUCED evidence (SPEC constraint E, tightened per
 * probe G6 finding 2026-08-13: pane capture is an echo of the send itself — `maw hey` types
 * into the target pane and `maw capture` reads that same pane, so a dead or hung agent still
 * "shows" the marker, and anyone in the Discord room can pre-plant a snowflake-derived marker).
 *
 * Evidence here is the maw request-reply protocol instead:
 *   1. POST /api/request mints a server-side correlationId (never visible in the room).
 *   2. `maw hey` delivers the command + correlationId + reply instruction into the agent pane
 *      (send rc gates dispatch only — it is never treated as receipt).
 *   3. The Ack is returned ONLY when GET /api/request/<id> reports status "replied" — a state
 *      transition only the receiver's own `maw reply <id>` invocation can produce.
 * No reply within the window ⇒ throw ⇒ record stays pending and the cursor holds
 * (existing INJECTOR_FAILURE path); the runner retries on a later poll.
 *
 * Idempotency: the broker dedupes by messageId before this runs, and every retry carries the
 * same [broker#messageId] tag so the receiver can recognise duplicates of the same command.
 */
export function createMawInjector(
  agentForRoute: (route: string) => string | undefined,
  run: CommandRunner = execFileRunner,
  timings: InjectorTimings = DEFAULT_TIMINGS,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  http: HttpJson = fetchJson,
  mawUrl: string = `http://localhost:${process.env.MAW_PORT || "3456"}`,
): DownstreamInjector {
  return async (plaintext: string, messageId: string, route: string): Promise<Ack> => {
    const agent = agentForRoute(route);
    if (!agent) throw new Error("no agent registered for route");

    const minted = await http("POST", `${mawUrl}/api/request`, { to: agent, from: "maw-broker", message: `[broker#${messageId}] ${plaintext}` });
    const correlationId = (minted.json as { correlationId?: unknown } | undefined)?.correlationId;
    if (!minted.ok || typeof correlationId !== "string" || !correlationId) throw new Error("dispatch failed");

    const send = await run(["maw", "hey", agent, `[broker#${messageId}][request:${correlationId}] ${plaintext} — ยืนยันรับด้วย: maw reply ${correlationId} ok`], timings.sendTimeoutMs);
    if (send.rc !== 0) throw new Error("dispatch failed");

    for (let attempt = 0; attempt < timings.attempts; attempt++) {
      const polled = await http("GET", `${mawUrl}/api/request/${correlationId}`);
      const status = (polled.json as { status?: unknown } | undefined)?.status;
      if (polled.ok && status === "replied") return { messageId, route, accepted: true };
      await sleep(timings.delayMs);
    }
    throw new Error("no receiver reply");
  };
}
