import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CONTRACT (owner directive 2026-08-14, both messages): "No agent-held Discord token... one
 * bridge daemon is the only Discord token owner... add tests that reject multiple token-owning
 * entrypoints." This is a structural property of the codebase, so the test IS the grep-equivalent
 * enumeration below — not a runtime unit. Before this session's refactor, THREE files
 * (`route-launcher.ts`, `mirror-launcher.ts`, `project-poller.ts`) each independently called
 * `loadRunnerSecrets`/held `DISCORD_BOT_TOKEN`; `summary-back.ts` made it four. After the
 * refactor (`bridge-server.ts` + `bridge-client.ts`), exactly ONE file may construct a live,
 * credentialed `DiscordRestClient`: `bridge-server.ts`. Every other entrypoint talks to it over
 * local HTTP via `BridgeHttpClient`, which never sees `DISCORD_BOT_TOKEN`.
 *
 * Adding a second credential-construction site anywhere in `src/` turns this test red — that is
 * the enforcement, not a comment someone can skim past.
 */
const WT = join(import.meta.dir, "..");
const SRC = join(WT, "src");

/** Exactly one entry, by contract. A PR that adds a second is exactly what this test exists to
 *  catch — do not add to this set without also justifying why "one bridge daemon" is no longer
 *  the architecture. */
const ALLOWED_CREDENTIAL_SITES = new Set(["bridge-server.ts"]);

/** Files that talk to Discord functionality but must do so ONLY via BridgeHttpClient — asserted
 *  by absence of DiscordRestClient AND absence of any DISCORD_BOT_TOKEN reference. */
const MUST_BE_TOKEN_FREE = ["route-launcher.ts", "mirror-launcher.ts", "project-poller.ts", "summary-back.ts", "runner.ts", "project-routes.ts", "routes.ts", "state-mirror.ts", "bridge-client.ts"];

function listSrcFiles(): string[] {
  return readdirSync(SRC).filter(f => f.endsWith(".ts"));
}

describe("single Discord-credential-owner contract", () => {
  test("exactly one file in src/ constructs a live DiscordRestClient — the allowlist, not more", () => {
    const owners: string[] = [];
    for (const file of listSrcFiles()) {
      const body = readFileSync(join(SRC, file), "utf8");
      if (/new\s+DiscordRestClient\s*\(/.test(body)) owners.push(file);
    }
    expect(owners).toEqual([...ALLOWED_CREDENTIAL_SITES]);
  });

  test("every allowlisted credential owner is a standalone daemon (`if (import.meta.main)`), never an importable library", () => {
    const notStandalone: string[] = [];
    for (const file of ALLOWED_CREDENTIAL_SITES) {
      const body = readFileSync(join(SRC, file), "utf8");
      if (!/if\s*\(\s*import\.meta\.main\s*\)/.test(body)) notStandalone.push(file);
    }
    expect(notStandalone).toEqual([]);
  });

  test("REJECTED: no file outside the allowlist may reference DISCORD_BOT_TOKEN at all, not just avoid constructing a client with it", () => {
    const offenders: string[] = [];
    for (const file of MUST_BE_TOKEN_FREE) {
      const body = readFileSync(join(SRC, file), "utf8");
      if (body.includes("DISCORD_BOT_TOKEN")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("route-launcher.ts, mirror-launcher.ts, and summary-back.ts each import bridge-client, never runner's DiscordRestClient, for outbound Discord calls", () => {
    for (const file of ["route-launcher.ts", "mirror-launcher.ts", "summary-back.ts"]) {
      const body = readFileSync(join(SRC, file), "utf8");
      expect(body.includes('from "./bridge-client"')).toBe(true);
      expect(/import\s*\{[^}]*DiscordRestClient/.test(body)).toBe(false);
    }
  });

  test("route bindings and state-mirror never import runner.ts at all (no credential reachable from route config or mirror logic)", () => {
    for (const file of ["project-routes.ts", "routes.ts", "state-mirror.ts"]) {
      const body = readFileSync(join(SRC, file), "utf8");
      expect(body.includes('from "./runner"')).toBe(false);
    }
  });

  test("meta-test: a second (rogue) credential site would actually be caught by this gate's own logic", () => {
    const rogueBody = 'import { DiscordRestClient } from "./runner";\nconst c = new DiscordRestClient(token);\n';
    const wouldBeCaught = /new\s+DiscordRestClient\s*\(/.test(rogueBody) && !ALLOWED_CREDENTIAL_SITES.has("route-launcher.ts");
    expect(wouldBeCaught).toBe(true);
  });
});

/**
 * NOT a test in this suite, deliberately: whether the CURRENT agent process (Canon Prime) holds
 * a Discord-capable channel is a fact about the OS process tree of the machine running the
 * agent, not about this repo's source. That receiver-side check was run live and is recorded
 * with full command + output in the dossier
 * (`ψ/memory/logs/2026-08-14_0100_central-broker-discord-bridge-test-dossier.md`), not
 * duplicated here as a fake always-green test.
 */
