/**
 * Bridge client — talks to the ONE bridge daemon (`bridge-server.ts`) over local HTTP. Holds NO
 * Discord credential: `localAuthToken` authenticates this process to the LOCAL bridge server
 * only, and is a materially different secret from the Discord bot token (owner contract
 * 2026-08-14: broker/summary-back/route-launcher must have no Discord credential at all).
 *
 * Implements the exact same call shapes `DiscordRestClient` already exposed
 * (`getMessages`/`react`/`postMessage`/`editMessage`/`findMarkedMessage`), so every existing
 * caller (`DiscordPollSource`, `DiscordDigestSink`, `summary-back.ts`, the `Reactor`/`DigestSink`
 * interfaces) swaps in this class in place of `DiscordRestClient` with no other change.
 */
export type BridgeFetchLike = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class BridgeHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly localAuthToken: string,
    private readonly fetcher: BridgeFetchLike = fetch as unknown as BridgeFetchLike,
  ) {
    if (!baseUrl) throw new Error("bridge client configuration invalid");
    if (!localAuthToken) throw new Error("bridge client configuration invalid");
  }

  private async call(path: string, body: unknown): Promise<unknown> {
    let response: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.localAuthToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch { throw new Error("bridge request failed"); }
    if (!response.ok) throw new Error(`bridge request held: ${path} ${response.status}`);
    return response.json();
  }

  async getMessages(channelId: string, after?: string, limit = 50, before?: string): Promise<unknown[]> {
    const result = await this.call("/getMessages", { channelId, after, limit, before });
    if (!Array.isArray(result)) throw new Error("bridge response invalid");
    return result;
  }
  async react(channelId: string, messageId: string, emoji: string): Promise<void> { await this.call("/react", { channelId, messageId, emoji }); }
  async postMessage(channelId: string, content: string): Promise<{ messageId: string }> {
    const result = await this.call("/postMessage", { channelId, content }) as { messageId?: unknown };
    if (typeof result?.messageId !== "string") throw new Error("bridge response invalid");
    return { messageId: result.messageId };
  }
  async editMessage(channelId: string, messageId: string, content: string): Promise<void> { await this.call("/editMessage", { channelId, messageId, content }); }
  async findMarkedMessage(channelId: string, marker: string, maxScan?: number): Promise<{ messageId: string } | undefined> {
    const result = await this.call("/findMarkedMessage", { channelId, marker, maxScan }) as { messageId?: unknown } | null;
    if (result === null) return undefined;
    if (typeof result?.messageId !== "string") throw new Error("bridge response invalid");
    return { messageId: result.messageId };
  }
}

/** Local (non-Discord) config a broker-side process needs to reach the bridge — its URL and the
 *  shared local auth token. Same 0600/no-symlink file guard as every other secret in this repo,
 *  via the shared helper in `runner.ts`, so it drifts with that guard rather than around it. */
export type BridgeClientConfig = { bridgeUrl: string; localAuthToken: string };
export function loadBridgeClientConfig(env: Record<string, string | undefined> = process.env): BridgeClientConfig {
  const { readSecretsSource } = require("./runner") as typeof import("./runner");
  try {
    const values = readSecretsSource(env, "MAW_BRIDGE_CLIENT_CONFIG_FILE");
    const bridgeUrl = values.MAW_BRIDGE_URL, token = values.MAW_BRIDGE_LOCAL_TOKEN;
    if (typeof bridgeUrl !== "string" || !bridgeUrl || typeof token !== "string" || !token) throw new Error();
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(bridgeUrl)) throw new Error(); // never a remote/non-loopback bridge
    return { bridgeUrl, localAuthToken: token };
  } catch { throw new Error("bridge client configuration invalid"); }
}
