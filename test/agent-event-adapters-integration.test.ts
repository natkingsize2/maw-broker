import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_EVENT_SCHEMA, AgentEventDaemon, AgentEventLedger, signAgentEventIngress } from "../src/agent-event-ledger";
import { composeAgentEventEmitter } from "../src/agent-event-server";
import type { MarkerClientPort } from "../src/discord-marker-adapter";
import type { GitHubRestClient } from "../src/adapter-github";
import { ProjectRegistry } from "../src/project-routes";

const channel="1537404238861438996",self="1056224550129508415",issue="natkingsize2/liveSiang#15";
const registry=new ProjectRegistry([{name:"livesiang",transport:"discord-text",destination:channel,agent:"03-canon:1",issue}]);
const event={schema:AGENT_EVENT_SCHEMA,project:"livesiang",kind:"done",event_id:"integrated-1",agent:"canon",summary:"ครบทั้งสอง sink",occurred_at:"2026-08-14T16:00:00.000Z"};

describe("authoritative adapter composition",()=>{
  test("daemon uses Canon Discord + Nexus GitHub adapters; restart drains only pending GitHub",async()=>{
    const discordRows:any[]=[];let discordGets=0,discordPosts=0;
    const discord:MarkerClientPort={
      async getMessages(_c,_a,limit=50){discordGets++;return discordRows.slice(0,limit)},
      async postMessage(_c,content){discordPosts++;const id=String(9000+discordPosts);discordRows.unshift({id,channel_id:channel,content,author:{id:self,bot:true},timestamp:"2026-08-14T16:00:00.000Z"});return{messageId:id}},
    };
    const githubMarkers=new Set<string>();let githubFinds=0,githubPosts=0,drop=true;
    const github={
      async findMarkedComment(_issue:string,key:string){githubFinds++;return githubMarkers.has(key)?{commentId:1}:undefined},
      async postComment(_issue:string,body:string){githubPosts++;const marker=/<!-- ([^ ]+) -->/.exec(body)?.[1];if(marker)githubMarkers.add(marker);if(drop){drop=false;throw new Error("accepted then response dropped")}return{commentId:1}},
    } as unknown as GitHubRestClient;
    const store=join(realpathSync(mkdtempSync(join(tmpdir(),"ael-integrated-"))),"ledger.json"),key=Buffer.from(Array.from({length:32},(_,i)=>i+1)),authKey=Buffer.from(Array.from({length:32},(_,i)=>i+65)),authority={authorId:self,key:authKey};
    const unsigned={event,authorId:self,authorIsBot:false,channelId:channel,projectRoute:"livesiang",nonce:"integration-nonce",issuedAt:"2026-08-14T16:00:00.000Z"},request={...unsigned,signature:signAgentEventIngress(unsigned,authKey)};
    const first=new AgentEventLedger(registry,composeAgentEventEmitter(discord,self,github),store,()=>"2026-08-14T16:00:01.000Z",authority,key);
    await expect(new AgentEventDaemon(first).ingest(request)).rejects.toThrow("response dropped");
    expect({discordPosts,githubPosts}).toEqual({discordPosts:1,githubPosts:1});first.close();
    const discordGetsBefore=discordGets;
    const second=new AgentEventLedger(registry,composeAgentEventEmitter(discord,self,github),store,()=>"2026-08-14T16:20:01.000Z",authority,key);
    expect((await new AgentEventDaemon(second).ingest(request)).status).toBe("duplicate");
    expect(discordGets).toBe(discordGetsBefore); // delivered Discord sink was skipped entirely
    expect(githubFinds).toBeGreaterThan(1);      // pending GitHub reconciled accepted marker
    expect(githubPosts).toBe(1);                // no repost after lost acknowledgement
    second.close();
  });
});
