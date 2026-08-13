import { describe, expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRunnerSecrets, DiscordRestClient } from "../src/runner";
import { loadBridgeSecrets } from "../src/bridge-server";
import { NAT_USER_ID } from "../src/broker";

/**
 * Updated 2026-08-14 for the credential split (owner contract: "Broker owns route audit dedupe
 * mirror and has no Discord credential. One bridge daemon is the only Discord token owner."):
 * `loadRunnerSecrets` (envelope auth: brokerKey + ownerId) and `loadBridgeSecrets` (the ONLY
 * loader that reads DISCORD_BOT_TOKEN, plus the local bridge auth token) are now two separate
 * functions in two separate files, and each gets its own adversarial matrix below. Every case
 * must fail CLOSED — refusing to start on bad config/auth, never falling back to a guessed or
 * partial value.
 */
const GOOD_KEY_B64 = Buffer.alloc(32, 7).toString("base64");

describe("broker envelope secrets (loadRunnerSecrets) — no Discord token involved at all", () => {
  test("missing MAW_BROKER_OWNER_ID alone is refused", () => {
    expect(() => loadRunnerSecrets({ MAW_BROKER_KEY_B64: GOOD_KEY_B64 })).toThrow("broker runner configuration invalid");
  });
  test("missing MAW_BROKER_KEY_B64 alone is refused", () => {
    expect(() => loadRunnerSecrets({ MAW_BROKER_OWNER_ID: NAT_USER_ID })).toThrow("broker runner configuration invalid");
  });
  test("ownerId shorter than 17 digits or longer than 20 digits is refused (not just non-numeric)", () => {
    expect(() => loadRunnerSecrets({ MAW_BROKER_KEY_B64: GOOD_KEY_B64, MAW_BROKER_OWNER_ID: "123" })).toThrow("broker runner configuration invalid");
    expect(() => loadRunnerSecrets({ MAW_BROKER_KEY_B64: GOOD_KEY_B64, MAW_BROKER_OWNER_ID: "1".repeat(21) })).toThrow("broker runner configuration invalid");
  });
  test("key that decodes to the wrong byte length is refused (not silently padded/truncated)", () => {
    expect(() => loadRunnerSecrets({ MAW_BROKER_KEY_B64: Buffer.alloc(16).toString("base64"), MAW_BROKER_OWNER_ID: NAT_USER_ID })).toThrow("broker runner configuration invalid");
  });
  test("symlinked secrets file is refused even when the symlink TARGET is well-formed and 0600", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-broker-secret-symlink-"));
    const real = join(root, "real-secrets.json"), link = join(root, "secrets.json");
    writeFileSync(real, JSON.stringify({ MAW_BROKER_KEY_B64: GOOD_KEY_B64, MAW_BROKER_OWNER_ID: NAT_USER_ID }), { mode: 0o600 });
    symlinkSync(real, link);
    expect(() => loadRunnerSecrets({ MAW_BROKER_SECRETS_FILE: link })).toThrow("broker runner configuration invalid");
  });
  test("world-readable (0644) secrets file is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-broker-secret-0644-"));
    const path = join(root, "secrets.json");
    writeFileSync(path, JSON.stringify({ MAW_BROKER_KEY_B64: GOOD_KEY_B64, MAW_BROKER_OWNER_ID: NAT_USER_ID }), { mode: 0o644 });
    expect(() => loadRunnerSecrets({ MAW_BROKER_SECRETS_FILE: path })).toThrow("broker runner configuration invalid");
  });
  test("nonexistent secrets file path is refused, not silently falling back to process.env", () => {
    expect(() => loadRunnerSecrets({ MAW_BROKER_SECRETS_FILE: "/nonexistent/path/secrets.json", MAW_BROKER_KEY_B64: GOOD_KEY_B64, MAW_BROKER_OWNER_ID: NAT_USER_ID })).toThrow("broker runner configuration invalid");
  });
});

describe("bridge Discord secrets (loadBridgeSecrets) — the ONLY function in the codebase that reads DISCORD_BOT_TOKEN", () => {
  test("missing DISCORD_BOT_TOKEN alone is refused", () => {
    expect(() => loadBridgeSecrets({ MAW_BRIDGE_LOCAL_TOKEN: "local-secret" })).toThrow("bridge server configuration invalid");
  });
  test("missing MAW_BRIDGE_LOCAL_TOKEN alone is refused — a bridge with no local auth would accept ANY loopback caller", () => {
    expect(() => loadBridgeSecrets({ DISCORD_BOT_TOKEN: "t" })).toThrow("bridge server configuration invalid");
  });
  test("empty-string token (present key, empty value) is refused, not treated as 'unset ⇒ skip'", () => {
    expect(() => loadBridgeSecrets({ DISCORD_BOT_TOKEN: "", MAW_BRIDGE_LOCAL_TOKEN: "local-secret" })).toThrow("bridge server configuration invalid");
    expect(() => loadBridgeSecrets({ DISCORD_BOT_TOKEN: "t", MAW_BRIDGE_LOCAL_TOKEN: "" })).toThrow("bridge server configuration invalid");
  });
  test("secret configuration errors never include the supplied token", () => {
    const token = "TOKEN-MUST-NOT-LEAK";
    let threw: unknown;
    try { loadBridgeSecrets({ DISCORD_BOT_TOKEN: token }); } catch (error) { threw = error; }
    expect(String(threw)).not.toContain(token);
  });
  test("symlinked bridge secrets file is refused even when the target is well-formed and 0600", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-bridge-secret-symlink-"));
    const real = join(root, "real-secrets.json"), link = join(root, "secrets.json");
    writeFileSync(real, JSON.stringify({ DISCORD_BOT_TOKEN: "t", MAW_BRIDGE_LOCAL_TOKEN: "local-secret" }), { mode: 0o600 });
    symlinkSync(real, link);
    expect(() => loadBridgeSecrets({ MAW_BRIDGE_SECRETS_FILE: link })).toThrow("bridge server configuration invalid");
  });
  test("world-readable (0644) bridge secrets file is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-bridge-secret-0644-"));
    const path = join(root, "secrets.json");
    writeFileSync(path, JSON.stringify({ DISCORD_BOT_TOKEN: "t", MAW_BRIDGE_LOCAL_TOKEN: "local-secret" }), { mode: 0o644 });
    expect(() => loadBridgeSecrets({ MAW_BRIDGE_SECRETS_FILE: path })).toThrow("bridge server configuration invalid");
  });
  test("group/other-writable (0620) bridge secrets file is refused, not just world-readable", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-bridge-secret-0620-"));
    const path = join(root, "secrets.json");
    writeFileSync(path, JSON.stringify({ DISCORD_BOT_TOKEN: "t", MAW_BRIDGE_LOCAL_TOKEN: "local-secret" }), { mode: 0o600 });
    chmodSync(path, 0o620);
    expect(() => loadBridgeSecrets({ MAW_BRIDGE_SECRETS_FILE: path })).toThrow("bridge server configuration invalid");
  });
  test("bridge secrets file with valid JSON but a missing key is refused (named error, not a raw crash)", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-bridge-secret-partial-"));
    const path = join(root, "secrets.json");
    writeFileSync(path, JSON.stringify({ DISCORD_BOT_TOKEN: "t" }), { mode: 0o600 });
    expect(() => loadBridgeSecrets({ MAW_BRIDGE_SECRETS_FILE: path })).toThrow("bridge server configuration invalid");
  });
  test("bridge secrets file that is not valid JSON is refused with the named error, file bytes never echoed", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-bridge-secret-badjson-"));
    const path = join(root, "secrets.json");
    writeFileSync(path, "{not json at all", { mode: 0o600 });
    let threw: unknown;
    try { loadBridgeSecrets({ MAW_BRIDGE_SECRETS_FILE: path }); } catch (error) { threw = error; }
    expect(String(threw)).toContain("bridge server configuration invalid");
    expect(String(threw)).not.toContain("not json at all");
  });
  test("valid env-based bridge secrets load correctly", () => {
    expect(loadBridgeSecrets({ DISCORD_BOT_TOKEN: "t", MAW_BRIDGE_LOCAL_TOKEN: "local-secret" })).toEqual({ discordBotToken: "t", localAuthToken: "local-secret" });
  });
});

describe("bridge daemon's own Discord client construction guard", () => {
  test("DiscordRestClient refuses construction with an empty token — the bridge cannot half-start with no credential", () => {
    expect(() => new DiscordRestClient("")).toThrow("Discord client configuration invalid");
  });
});
