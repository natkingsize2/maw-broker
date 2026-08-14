import { describe, expect, test } from "bun:test";
import { assertMirrorConfig, resolveStateSource, MIRROR_CHANNEL_ID } from "../src/mirror-launcher";
import { DiscordTextAdapter, admitsDiscordMessage } from "../src/adapter-discord";

/** Gates (2)+(3) of the owner-assigned non-secret closeout, 2026-08-14. */

describe("(2) mirror-launcher main()-construction smoke — the wiring main() actually runs, no live calls", () => {
  const env = {
    MAW_MIRROR_STORE_ROOT: "/tmp/mirror-smoke",
    MAW_MIRROR_CHANNEL_ID: MIRROR_CHANNEL_ID,
    MAW_MIRROR_AGENTS: "canon,probe",
    ARGUS_READ_TOKEN: "fake-token-never-used-live",
    MAW_ARGUS_URL: "http://127.0.0.1:1/never-called",
  };
  test("happy path: config asserts AND resolveStateSource returns a live-shaped source without any network call", async () => {
    const cfg = assertMirrorConfig(env);
    expect(cfg.channel).toBe(MIRROR_CHANNEL_ID);
    const source = await resolveStateSource(env);
    expect(typeof source.collect).toBe("function");   // LiveStateSource constructed; collect() NOT called
  });
  test("fail-closed: missing agents refuses (never mirrors a guessed fleet)", async () => {
    await expect(resolveStateSource({ ...env, MAW_MIRROR_AGENTS: "" })).rejects.toThrow("MAW_MIRROR_AGENTS missing");
  });
  test("fail-closed: no token anywhere (env unset + env-file path nonexistent) refuses", async () => {
    await expect(resolveStateSource({ ...env, ARGUS_READ_TOKEN: undefined, MAW_ARGUS_ENV_FILE: "/nonexistent/.env" })).rejects.toThrow(/ARGUS_READ_TOKEN/);
  });
});

describe("(3) real Discord row → normalize, read-only, nothing posted", () => {
  /** REAL row captured read-only 2026-08-14 17:52 via `maw atlas read 1056224550129508415 --json`
   *  (the production project room): message id 1537377655010107452, author canon-bot, bot:true.
   *  LIMITATION recorded honestly: atlas normalizes away `author.id`/`channel_id`/`timestamp`
   *  from the raw API shape, and fetching the raw v10 object needs the bot token (out of scope
   *  — no token access). Fixture below uses the REAL id/channel/content/bot values and a
   *  placeholder author id; fields that came from the real capture are marked. */
  const REAL_ROW_V10_SHAPE = {
    id: "1537377655010107452",                    // REAL (captured)
    channel_id: "1056224550129508415",            // REAL (the channel queried)
    author: { id: "999999999999999999", bot: true }, // bot:true REAL; author.id placeholder (see note)
    content: "อ๋อ เข้าใจแล้ว — ที่เห็นซ้ำเพราะมี **บริดจ์ Discord สองตัว**ทำงานพร้อมกัน",  // REAL prefix (captured, Thai)
    timestamp: "2026-08-13T15:00:00.000Z",
  };
  test("normalize maps the real row's fields; Thai content survives byte-exact", () => {
    const adapter = new DiscordTextAdapter();
    const m = adapter.normalize(REAL_ROW_V10_SHAPE);
    expect(m.messageId).toBe("1537377655010107452");
    expect(m.route).toBe("1056224550129508415");
    expect(m.authorIsBot).toBe(true);
    expect(m.content).toContain("บริดจ์ Discord สองตัว");
  });
  test("REAL finding: this real row is bot-authored, so the broker correctly refuses to admit it as a command", () => {
    const adapter = new DiscordTextAdapter();
    const m = adapter.normalize(REAL_ROW_V10_SHAPE);
    expect(admitsDiscordMessage(m)).toBe(false);   // digest-bot's own posts can never loop back as commands
  });
});
