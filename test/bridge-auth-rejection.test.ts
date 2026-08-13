import { describe, expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRunnerSecrets, DiscordRestClient } from "../src/runner";
import { NAT_USER_ID } from "../src/broker";

/**
 * Gap this file closes vs `runner.test.ts`: that file proves secret errors never leak the token
 * value and that a 0644 secrets file is refused. It does not isolate each individual required
 * field, does not test the symlink guard on the secrets file (present in source, `runner.ts:106`,
 * untested), and does not test the bridge daemon's own client-construction guard
 * (`DiscordRestClient` refuses an empty token). Every case here must fail CLOSED — the bridge
 * daemon refusing to start on bad config/auth, never falling back to a guessed or partial value.
 */
const GOOD_KEY_B64 = Buffer.alloc(32, 7).toString("base64");

describe("bridge auth/config — individual required fields, each isolated", () => {
  test("missing DISCORD_BOT_TOKEN alone is refused", () => {
    expect(() => loadRunnerSecrets({ MAW_BROKER_KEY_B64: GOOD_KEY_B64, MAW_BROKER_OWNER_ID: NAT_USER_ID })).toThrow("broker runner configuration invalid");
  });
  test("missing MAW_BROKER_OWNER_ID alone is refused", () => {
    expect(() => loadRunnerSecrets({ DISCORD_BOT_TOKEN: "t", MAW_BROKER_KEY_B64: GOOD_KEY_B64 })).toThrow("broker runner configuration invalid");
  });
  test("missing MAW_BROKER_KEY_B64 alone is refused", () => {
    expect(() => loadRunnerSecrets({ DISCORD_BOT_TOKEN: "t", MAW_BROKER_OWNER_ID: NAT_USER_ID })).toThrow("broker runner configuration invalid");
  });
  test("ownerId shorter than 17 digits or longer than 20 digits is refused (not just non-numeric)", () => {
    expect(() => loadRunnerSecrets({ DISCORD_BOT_TOKEN: "t", MAW_BROKER_KEY_B64: GOOD_KEY_B64, MAW_BROKER_OWNER_ID: "123" })).toThrow("broker runner configuration invalid");
    expect(() => loadRunnerSecrets({ DISCORD_BOT_TOKEN: "t", MAW_BROKER_KEY_B64: GOOD_KEY_B64, MAW_BROKER_OWNER_ID: "1".repeat(21) })).toThrow("broker runner configuration invalid");
  });
  test("key that decodes to the wrong byte length is refused (not silently padded/truncated)", () => {
    expect(() => loadRunnerSecrets({ DISCORD_BOT_TOKEN: "t", MAW_BROKER_KEY_B64: Buffer.alloc(16).toString("base64"), MAW_BROKER_OWNER_ID: NAT_USER_ID })).toThrow("broker runner configuration invalid");
  });
  test("empty-string token (present key, empty value) is refused, not treated as 'unset ⇒ skip'", () => {
    expect(() => loadRunnerSecrets({ DISCORD_BOT_TOKEN: "", MAW_BROKER_KEY_B64: GOOD_KEY_B64, MAW_BROKER_OWNER_ID: NAT_USER_ID })).toThrow("broker runner configuration invalid");
  });
});

describe("bridge auth/config — secrets FILE path, adversarial filesystem states", () => {
  const goodBody = () => JSON.stringify({ DISCORD_BOT_TOKEN: "file-token", MAW_BROKER_KEY_B64: GOOD_KEY_B64, MAW_BROKER_OWNER_ID: NAT_USER_ID });

  test("symlinked secrets file is refused even when the symlink TARGET is well-formed and 0600", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-bridge-secret-symlink-"));
    const real = join(root, "real-secrets.json");
    const link = join(root, "secrets.json");
    writeFileSync(real, goodBody(), { mode: 0o600 });
    symlinkSync(real, link);
    expect(() => loadRunnerSecrets({ MAW_BROKER_SECRETS_FILE: link })).toThrow("broker runner configuration invalid");
  });

  test("world-readable (0644) secrets file is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-bridge-secret-0644-"));
    const path = join(root, "secrets.json");
    writeFileSync(path, goodBody(), { mode: 0o644 });
    expect(() => loadRunnerSecrets({ MAW_BROKER_SECRETS_FILE: path })).toThrow("broker runner configuration invalid");
  });

  test("group/other-writable (0620) secrets file is refused, not just world-readable", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-bridge-secret-0620-"));
    const path = join(root, "secrets.json");
    writeFileSync(path, goodBody(), { mode: 0o600 });
    chmodSync(path, 0o620);
    expect(() => loadRunnerSecrets({ MAW_BROKER_SECRETS_FILE: path })).toThrow("broker runner configuration invalid");
  });

  test("secrets file with valid JSON but missing a required key is refused (named error, not a raw undefined-access crash)", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-bridge-secret-partial-"));
    const path = join(root, "secrets.json");
    writeFileSync(path, JSON.stringify({ DISCORD_BOT_TOKEN: "t" }), { mode: 0o600 });
    expect(() => loadRunnerSecrets({ MAW_BROKER_SECRETS_FILE: path })).toThrow("broker runner configuration invalid");
  });

  test("secrets file that is not valid JSON is refused with the named error, not a raw SyntaxError (constraint G — never echo file bytes)", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-bridge-secret-badjson-"));
    const path = join(root, "secrets.json");
    writeFileSync(path, "{not json at all", { mode: 0o600 });
    let threw: unknown;
    try { loadRunnerSecrets({ MAW_BROKER_SECRETS_FILE: path }); } catch (error) { threw = error; }
    expect(String(threw)).toContain("broker runner configuration invalid");
    expect(String(threw)).not.toContain("not json at all");
  });

  test("nonexistent secrets file path is refused, not silently falling back to process.env", () => {
    expect(() => loadRunnerSecrets({ MAW_BROKER_SECRETS_FILE: "/nonexistent/path/secrets.json", DISCORD_BOT_TOKEN: "would-be-used-if-fallback-happened", MAW_BROKER_KEY_B64: GOOD_KEY_B64, MAW_BROKER_OWNER_ID: NAT_USER_ID })).toThrow("broker runner configuration invalid");
  });
});

describe("bridge daemon's own Discord client construction guard", () => {
  test("DiscordRestClient refuses construction with an empty token — the bridge cannot half-start with no credential", () => {
    expect(() => new DiscordRestClient("")).toThrow("Discord client configuration invalid");
  });
});
