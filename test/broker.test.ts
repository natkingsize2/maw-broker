import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broker, NAT_USER_ID } from "../src/broker";
import { keyFromBase64, seal } from "../src/crypto";
import { DurableStore } from "../src/store";
import type { InboundMessage, Route } from "../src/types";

const key = Buffer.alloc(32, 7); const route: Route = { name: "gate", transport: "discord-text", destination: "thread-1" };
const msg = (id = "m-1", authorId = NAT_USER_ID, routeName = "thread-1"): InboundMessage => ({ messageId: id, authorId, content: "approve", route: routeName });
function fixture(root = mkdtempSync(join(tmpdir(), "maw-broker-"))) { const routes = new Map([["thread-1", route]]); return { root, broker: new Broker(key, routes, new DurableStore(root)) }; }

test("owner allow resolves and survives restart dedupe", () => { const f=fixture(); const e=seal(key,"thread-1","m-1","payload"); expect(f.broker.receive(msg(),e,"allow")).toMatchObject({status:"resolved",plaintext:"payload"}); const restarted=new Broker(key,new Map([["thread-1",route]]),new DurableStore(f.root)); expect(restarted.receive(msg(),e,"allow").status).toBe("replay"); });
test("foreign author is rejected", () => { const f=fixture(); expect(()=>f.broker.receive(msg("m-2","foreign"),seal(key,"thread-1","m-2","x"),"allow")).toThrow("foreign author"); });
test("tampered ciphertext is rejected", () => { const f=fixture(); const e=seal(key,"thread-1","m-3","x"); e.ciphertext=e.ciphertext.slice(0,-2)+"AA"; expect(()=>f.broker.receive(msg("m-3"),e,"allow")).toThrow("authentication failed"); });
test("wrong route is rejected", () => { const f=fixture(); const e=seal(key,"other","m-4","x"); expect(()=>f.broker.receive(msg("m-4",NAT_USER_ID,"other"),e,"allow")).toThrow("wrong route"); });
test("missing key fails closed", () => { expect(()=>keyFromBase64(undefined)).toThrow("broker key missing"); });
test("invalid decision is rejected explicitly", () => { const f=fixture(); const e=seal(key,"thread-1","m-6","x"); expect(()=>f.broker.receive(msg("m-6"),e,"maybe" as any)).toThrow("invalid decision"); });
test("audit is durable and contains no plaintext", () => { const f=fixture(); const e=seal(key,"thread-1","m-5","secret payload","discord-text","deny"); const result=f.broker.receive(msg("m-5"),e,"deny"); expect(result).not.toHaveProperty("plaintext"); const audit=readFileSync(new DurableStore(f.root).auditPath,"utf8"); expect(audit).not.toContain("secret payload"); expect(audit).toContain('"event":"resolved"'); });
test("nonce and tag truncation fail closed", () => { const f=fixture(); const e=seal(key,"thread-7","m-7","x"); e.nonce=e.nonce.slice(0,-2); expect(()=>f.broker.receive(msg("m-7",NAT_USER_ID,"thread-1"),e,"allow")).toThrow(); });
test("transport and decision tamper is rejected", () => { const f=fixture(); const e=seal(key,"thread-1","m-8","x"); e.transport="voice"; expect(()=>f.broker.receive(msg("m-8"),e,"allow")).toThrow("decision or transport mismatch"); });
test("symlink store path is rejected", () => { const root=mkdtempSync(join(tmpdir(),"maw-broker-link-")); const target=mkdtempSync(join(tmpdir(),"maw-broker-target-")); const link=join(root,"store"); symlinkSync(target,link); expect(()=>new DurableStore(link)).toThrow("symlink"); });
test("corrupt resolved state is named", () => { const root=mkdtempSync(join(tmpdir(),"maw-broker-corrupt-")); require("node:fs").writeFileSync(join(root,"resolved.json"),'{"bad":true}'); expect(()=>new DurableStore(root)).toThrow("resolved state corrupt"); });
test("concurrent store instances retain both IDs", () => { const root=mkdtempSync(join(tmpdir(),"maw-broker-concurrent-")); const a=new DurableStore(root); const b=new DurableStore(root); a.markResolved("a"); b.markResolved("b"); expect(new DurableStore(root).has("a")).toBe(true); expect(new DurableStore(root).has("b")).toBe(true); });
