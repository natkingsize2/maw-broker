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

export type InjectorTimings = { attempts: number; delayMs: number; sendTimeoutMs: number };
const DEFAULT_TIMINGS: InjectorTimings = { attempts: 6, delayMs: 2_000, sendTimeoutMs: 30_000 };

/**
 * Real downstream injector: dispatches the approved plaintext to the agent that owns the
 * route (channel), then requires RECEIVER-SIDE evidence — the marker must be visible in the
 * target's pane (`maw capture`/`maw peek`) — before returning the Ack. Send rc/status alone
 * never resolves a record (SPEC constraint E); missing evidence throws, the record stays
 * pending, and the cursor holds via the existing INJECTOR_FAILURE path.
 *
 * Idempotency: the broker dedupes by messageId before this runs (begin()/resolved), and the
 * marker carries the messageId so a replayed dispatch is visibly the same command.
 */
export function createMawInjector(
  agentForRoute: (route: string) => string | undefined,
  run: CommandRunner = execFileRunner,
  timings: InjectorTimings = DEFAULT_TIMINGS,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): DownstreamInjector {
  return async (plaintext: string, messageId: string, route: string): Promise<Ack> => {
    const agent = agentForRoute(route);
    if (!agent) throw new Error("no agent registered for route");
    const marker = `[broker#${messageId}]`;
    const send = await run(["maw", "hey", agent, `${marker} ${plaintext}`], timings.sendTimeoutMs);
    if (send.rc !== 0) throw new Error("dispatch failed");
    for (let attempt = 0; attempt < timings.attempts; attempt++) {
      for (const verb of [["maw", "capture", agent, "--full"], ["maw", "peek", agent]]) {
        const seen = await run(verb, timings.sendTimeoutMs);
        if (seen.rc === 0 && seen.stdout.includes(marker)) return { messageId, route, accepted: true };
      }
      await sleep(timings.delayMs);
    }
    throw new Error("no receiver-side evidence of dispatch");
  };
}
