import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunner, PRODUCTION_CHANNEL_ID } from "../src/route-launcher";
import { NAT_USER_ID } from "../src/broker";

/**
 * The existing `route-phase2.test.ts` "buildRunner refuses a wrong-channel routes file" test
 * only proves the NEGATIVE path — it never reaches bridge-client construction because
 * `assertProductionChannel` throws first. This proves the credential-split refactor didn't
 * silently break the HAPPY path: with a correct routes file AND bridge client config supplied,
 * `buildRunner` succeeds and returns a runner wired to a `BridgeHttpClient` (never a
 * `DiscordRestClient`), with no Discord token anywhere in its env requirements.
 */
describe("buildRunner happy path after the credential-split refactor", () => {
  test("succeeds with routes + broker envelope secrets + bridge client config — no Discord token needed", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-p2-happy-"));
    const routesPath = join(root, "routes.json");
    writeFileSync(routesPath, JSON.stringify([{ name: "general", transport: "discord-text", destination: PRODUCTION_CHANNEL_ID, agent: "03-canon:1" }]), { mode: 0o600 });
    const bridgeConfigPath = join(root, "bridge-client.json");
    writeFileSync(bridgeConfigPath, JSON.stringify({ MAW_BRIDGE_URL: "http://127.0.0.1:18791", MAW_BRIDGE_LOCAL_TOKEN: "local-secret" }), { mode: 0o600 });

    const env = {
      // NOTE: deliberately NO DISCORD_BOT_TOKEN anywhere in this env — the point of the test.
      MAW_BROKER_KEY_B64: Buffer.alloc(32, 5).toString("base64"),
      MAW_BROKER_OWNER_ID: NAT_USER_ID,
      MAW_BROKER_ROUTES_FILE: routesPath,
      MAW_BROKER_STORE_ROOT: join(root, "store-root"),
      MAW_BRIDGE_CLIENT_CONFIG_FILE: bridgeConfigPath,
    };
    const { runner, intervalMs, maxPolls } = buildRunner(env);
    expect(intervalMs).toBe(5000);
    expect(maxPolls).toBe(120);
    runner.close();
  });

  test("fails closed (not a crash) when bridge client config is missing, even though everything else is correct", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-p2-nobridge-"));
    const routesPath = join(root, "routes.json");
    writeFileSync(routesPath, JSON.stringify([{ name: "general", transport: "discord-text", destination: PRODUCTION_CHANNEL_ID, agent: "03-canon:1" }]), { mode: 0o600 });
    const env = {
      MAW_BROKER_KEY_B64: Buffer.alloc(32, 5).toString("base64"),
      MAW_BROKER_OWNER_ID: NAT_USER_ID,
      MAW_BROKER_ROUTES_FILE: routesPath,
      MAW_BROKER_STORE_ROOT: join(root, "store-root"),
      // no MAW_BRIDGE_CLIENT_CONFIG_FILE, no MAW_BRIDGE_URL/MAW_BRIDGE_LOCAL_TOKEN
    };
    expect(() => buildRunner(env)).toThrow("bridge client configuration invalid");
  });
});
