import { describe, expect, test } from "bun:test";
import { assertMqttPollerOutOfScope, main, MQTT_POLLER_REJECTED_REASON } from "../src/project-poller";

/**
 * Replaces the old MQTT-forwarding test suite (ProjectPoller/MosquittoPublisher), which tested
 * behavior that no longer exists — `ProjectRoute` cannot carry an `mqtt` field anymore
 * (`src/project-routes.ts`), and this file's job is now solely to refuse to run, unconditionally.
 */
describe("MQTT poller — rejected outright (owner contract 2026-08-14)", () => {
  test("assertMqttPollerOutOfScope always throws, citing the owner directive", () => {
    expect(() => assertMqttPollerOutOfScope()).toThrow(MQTT_POLLER_REJECTED_REASON);
  });

  test("main() refuses immediately regardless of env — no config can make it run", async () => {
    await expect(main({})).rejects.toThrow("out of scope");
    // A plausible-looking, even well-formed, legacy env still gets refused — it is not a missing
    // env var that triggers the rejection, it is unconditional.
    await expect(main({
      MAW_PROJECT_ROUTES_FILE: "/some/path/project-routes.json",
      MAW_PROJECT_STORE_ROOT: "/some/store",
      DISCORD_BOT_TOKEN: "would-be-a-real-token",
    })).rejects.toThrow("out of scope");
  });

  test("main() refuses before doing any filesystem or network work (no side effect on rejection)", async () => {
    // Nonexistent paths would normally throw a DIFFERENT error (file not found) if the function
    // got as far as touching them. It must not — the scope refusal comes first, always.
    let threw: unknown;
    try { await main({ MAW_PROJECT_ROUTES_FILE: "/definitely/does/not/exist.json", MAW_PROJECT_STORE_ROOT: "/definitely/does/not/exist" }); }
    catch (error) { threw = error; }
    expect(String(threw)).toContain("out of scope");
    expect(String(threw)).not.toContain("ENOENT");
  });
});
