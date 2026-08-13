import { describe, expect, test, afterEach } from "bun:test";
import { startBridgeServer, loadBridgeSecrets, type BridgeSecrets } from "../src/bridge-server";
import { BridgeHttpClient } from "../src/bridge-client";

/**
 * Round-trip tests for the bridge daemon: a REAL local HTTP server (`Bun.serve`, bound to
 * 127.0.0.1 on an ephemeral port) talking to a REAL `BridgeHttpClient` over `fetch`, with the
 * bridge's INTERNAL `DiscordRestClient` given a fake fetcher — so the full local IPC round trip
 * is proven end to end without a real Discord token or a real Discord network call, matching the
 * owner's "no deploy, no token, no Discord mutation" scope. Every server started here is
 * `.stop()`-ed at the end of its test (tracked in `servers`, closed in `afterEach` as a backstop)
 * — nothing outlives the test file.
 */
const servers: Array<{ stop(): void }> = [];
afterEach(() => { while (servers.length) servers.pop()!.stop(); });

const SECRETS: BridgeSecrets = { discordBotToken: "fake-token-never-sent-to-real-discord", localAuthToken: "local-secret-abc" };

function fakeDiscordFetcher(handler: (url: string) => { status: number; body: unknown }) {
  return async (url: string) => {
    const { status, body } = handler(url);
    return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body };
  };
}

async function serverOn(port: number, fetcher: any, secrets: BridgeSecrets = SECRETS) {
  const server = startBridgeServer({ port, secrets, fetcher });
  servers.push(server);
  return server;
}

describe("bridge-server + bridge-client — real local HTTP round trip, fake Discord underneath", () => {
  test("postMessage round trip: client → real HTTP → server → (fake) Discord → response back to client", async () => {
    const port = 18791;
    let sawAuth = "";
    await serverOn(port, fakeDiscordFetcher(() => ({ status: 200, body: { id: "9000000000000000001" } })));
    const client = new BridgeHttpClient(`http://127.0.0.1:${port}`, SECRETS.localAuthToken);
    const result = await client.postMessage("1056224550129508415", "hello from the broker side");
    expect(result).toEqual({ messageId: "9000000000000000001" });
  });

  test("getMessages round trip returns the array shape untouched", async () => {
    const port = 18792;
    await serverOn(port, fakeDiscordFetcher((url) => url.includes("/users/@me") ? { status: 200, body: { id: "bot1" } } : { status: 200, body: [{ id: "1", content: "hi" }] }));
    const client = new BridgeHttpClient(`http://127.0.0.1:${port}`, SECRETS.localAuthToken);
    const rows = await client.getMessages("thread-1");
    expect(rows).toEqual([{ id: "1", content: "hi" }]);
  });

  test("editMessage and react round trip (void-returning calls succeed without throwing)", async () => {
    const port = 18793;
    await serverOn(port, fakeDiscordFetcher(() => ({ status: 200, body: {} })));
    const client = new BridgeHttpClient(`http://127.0.0.1:${port}`, SECRETS.localAuthToken);
    await expect(client.editMessage("chan", "msg1", "new text")).resolves.toBeUndefined();
    await expect(client.react("chan", "msg1", "👀")).resolves.toBeUndefined();
  });

  test("findMarkedMessage round trip: found and not-found both survive the HTTP boundary correctly", async () => {
    const port = 18794;
    let call = 0;
    await serverOn(port, fakeDiscordFetcher((url) => {
      if (url.includes("/users/@me")) return { status: 200, body: { id: "bot1" } };
      call++;
      return call === 1 ? { status: 200, body: [{ id: "222", content: "digest\n-# marker", author: { id: "bot1" } }] } : { status: 200, body: [] };
    }));
    const client = new BridgeHttpClient(`http://127.0.0.1:${port}`, SECRETS.localAuthToken);
    const found = await client.findMarkedMessage("chan", "-# marker");
    expect(found).toEqual({ messageId: "222" });
  });

  test("WRONG local auth token is refused with 401 before the fake Discord layer is ever touched", async () => {
    const port = 18795;
    let discordCalls = 0;
    await serverOn(port, fakeDiscordFetcher(() => { discordCalls++; return { status: 200, body: { id: "x" } }; }));
    const client = new BridgeHttpClient(`http://127.0.0.1:${port}`, "WRONG-TOKEN");
    await expect(client.postMessage("chan", "text")).rejects.toThrow("bridge request held");
    expect(discordCalls).toBe(0);
  });

  test("MISSING auth header (raw fetch, not via the client) is refused with 401", async () => {
    const port = 18796;
    await serverOn(port, fakeDiscordFetcher(() => ({ status: 200, body: {} })));
    const res = await fetch(`http://127.0.0.1:${port}/postMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelId: "c", content: "x" }) });
    expect(res.status).toBe(401);
  });

  test("malformed body (missing required field) is a 400, not a 500 that could leak internals", async () => {
    const port = 18797;
    await serverOn(port, fakeDiscordFetcher(() => ({ status: 200, body: {} })));
    const res = await fetch(`http://127.0.0.1:${port}/postMessage`, { method: "POST", headers: { Authorization: `Bearer ${SECRETS.localAuthToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ content: "no channelId" }) });
    expect(res.status).toBe(400);
  });

  test("unknown path is 404", async () => {
    const port = 18798;
    await serverOn(port, fakeDiscordFetcher(() => ({ status: 200, body: {} })));
    const res = await fetch(`http://127.0.0.1:${port}/notARealRoute`, { method: "POST", headers: { Authorization: `Bearer ${SECRETS.localAuthToken}` }, body: "{}" });
    expect(res.status).toBe(404);
  });

  test("Discord-layer failure surfaces as 502 with a message, never a raw stack/token leak", async () => {
    const port = 18799;
    await serverOn(port, async () => { throw new Error("network down"); });
    const res = await fetch(`http://127.0.0.1:${port}/postMessage`, { method: "POST", headers: { Authorization: `Bearer ${SECRETS.localAuthToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ channelId: "c", content: "x" }) });
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).not.toContain(SECRETS.discordBotToken);
  });
});

describe("bridge-server — /health (loopback receiver check, no auth required)", () => {
  test("GET /health returns ok + pid + startedAt without any Authorization header", async () => {
    const port = 18801;
    await serverOn(port, fakeDiscordFetcher(() => ({ status: 200, body: {} })));
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.pid).toBe("number");
    expect(new Date(body.startedAt).toString()).not.toBe("Invalid Date");
  });
  test("/health never touches the Discord layer (no fake-fetcher calls)", async () => {
    const port = 18802;
    let discordCalls = 0;
    await serverOn(port, fakeDiscordFetcher(() => { discordCalls++; return { status: 200, body: {} }; }));
    await fetch(`http://127.0.0.1:${port}/health`);
    expect(discordCalls).toBe(0);
  });
});

describe("bridge-server refuses to bind outside loopback", () => {
  test("startBridgeServer throws for any hostname other than 127.0.0.1", () => {
    expect(() => startBridgeServer({ port: 18800, hostname: "0.0.0.0", secrets: SECRETS })).toThrow("refuses to bind outside 127.0.0.1");
  });
});
