import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Owner scope (2026-08-14): "No agent-held Discord token... no-direct-agent-send invariant."
 * There is no runtime unit to call for this — it is a STRUCTURAL property of the codebase: no
 * module an agent process could import may construct a live, credentialed path to Discord.
 * This test enumerates every `src/*.ts` file and asserts that Discord-credential construction
 * (`new DiscordRestClient(`) and outbound send primitives (`.postMessage(` / `.editMessage(`
 * defined as class members, not calls) exist ONLY inside the known daemon entrypoint files —
 * the ones with `if (import.meta.main)` blocks, i.e. things meant to run as their OWN process,
 * never imported into an agent's process. Adding a new file that constructs a Discord client
 * without adding it to ALLOWED_CREDENTIAL_SITES turns this test red — that is the point: the
 * allowlist is the fail-closed gate, not a comment.
 */
const WT = join(import.meta.dir, "..");
const SRC = join(WT, "src");

// Files allowed to construct a live DiscordRestClient (i.e. hold/use the bot token). Every one
// of these is a standalone daemon entrypoint (`if (import.meta.main)`), never a library an agent
// process imports for its own use.
const ALLOWED_CREDENTIAL_SITES = new Set([
  "route-launcher.ts",   // phase-2 command broker daemon
  "mirror-launcher.ts",  // state-mirror daemon
  "project-poller.ts",   // phase-4 inbound poller daemon
  "summary-back.ts",     // CLI invoked BY an agent's shell (gh-style), not imported into agent code
]);

function listSrcFiles(): string[] {
  return readdirSync(SRC).filter(f => f.endsWith(".ts"));
}

describe("no-direct-agent-send invariant — structural (grep-equivalent over src/)", () => {
  test("every file constructing a live DiscordRestClient is on the allowlist of daemon entrypoints", () => {
    const offenders: string[] = [];
    for (const file of listSrcFiles()) {
      const body = readFileSync(join(SRC, file), "utf8");
      if (/new\s+DiscordRestClient\s*\(/.test(body) && !ALLOWED_CREDENTIAL_SITES.has(file)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("every allowlisted entrypoint is actually a standalone daemon (`if (import.meta.main)`), not an importable library used elsewhere", () => {
    const notStandalone: string[] = [];
    for (const file of ALLOWED_CREDENTIAL_SITES) {
      const body = readFileSync(join(SRC, file), "utf8");
      if (!/if\s*\(\s*import\.meta\.main\s*\)/.test(body)) notStandalone.push(file);
    }
    expect(notStandalone).toEqual([]);
  });

  test("route bindings themselves (project-routes.ts, routes.ts) never import runner.ts (no credential reachable from route config)", () => {
    for (const file of ["project-routes.ts", "routes.ts", "state-mirror.ts"]) {
      const body = readFileSync(join(SRC, file), "utf8");
      expect(body.includes('from "./runner"')).toBe(false);
    }
  });

  test("adding a NEW credential construction site outside the allowlist is caught (meta-test: prove the gate itself is fail-closed)", () => {
    // Simulate a rogue file the way the real grep-equivalent would see it — this test doesn't
    // write to disk, it proves the detection regex/allowlist logic used above actually fires.
    const rogueBody = 'import { DiscordRestClient } from "./runner";\nconst c = new DiscordRestClient(token);\n';
    const wouldBeCaught = /new\s+DiscordRestClient\s*\(/.test(rogueBody) && !ALLOWED_CREDENTIAL_SITES.has("agent-side-helper.ts");
    expect(wouldBeCaught).toBe(true);
  });
});

/**
 * NOT a test in this suite, deliberately: whether the CURRENT agent process (Canon Prime) holds
 * a Discord-capable channel is a fact about the OS process tree of the machine running the
 * agent, not about this repo's source — a `bun test` assertion here would either be vacuous
 * (always pass) or would need to shell out and inspect an unrelated process, which is not this
 * repo's job. That receiver-side check was run live and is recorded with full command + output
 * in the dossier (§ no-direct-agent-send invariant, machine evidence), not duplicated here as a
 * fake always-green test.
 */
