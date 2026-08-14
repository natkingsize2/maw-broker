import { timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AgentEventDaemon, signAgentEventIngress, type AgentEvent, type AuthenticatedAgentEventIngress, type IngressAuthority } from "./agent-event-ledger";

const SNOWFLAKE=/^[1-9]\d{16,19}$/; const TOKEN=/^[A-Za-z0-9._~+\/-]{32,4096}$/;
export type AgentEventDaemonConfig={httpToken:string;authority:IngressAuthority;storeKey:Buffer;maxBodyBytes:number};
function decodeKey(value:string|undefined){if(!value||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw Error();const key=Buffer.from(value,"base64");if(key.length!==32||key.toString("base64")!==value||new Set(key).size<8)throw Error();return key;}
function readSecretFile(path:string){if(resolve(path)!==path)throw Error();for(let p=dirname(path);;){const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink())throw Error();const next=dirname(p);if(next===p)break;p=next;}const a=lstatSync(path);if(a.isSymbolicLink()||!a.isFile()||a.uid!==(process.getuid?.()??-1)||(a.mode&0o777)!==0o600)throw Error();const fd=openSync(path,constants.O_RDONLY|((constants as any).O_NOFOLLOW??0));try{const b=fstatSync(fd);if(b.ino!==a.ino||b.dev!==a.dev||b.nlink!==1)throw Error();return JSON.parse(readFileSync(fd,"utf8"));}finally{closeSync(fd)}}
export function loadAgentEventDaemonConfig(env:Record<string,string|undefined>):AgentEventDaemonConfig{
  try{const source=env.MAW_AGENT_EVENT_SECRETS_FILE?readSecretFile(env.MAW_AGENT_EVENT_SECRETS_FILE):env;const token=source.MAW_AGENT_EVENT_HTTP_TOKEN,authorId=source.MAW_AGENT_EVENT_AUTHOR_ID,authority=decodeKey(source.MAW_AGENT_EVENT_INGRESS_KEY_B64),storeKey=decodeKey(source.MAW_AGENT_EVENT_STORE_KEY_B64);if(!token||!TOKEN.test(token)||!authorId||!SNOWFLAKE.test(authorId)||authority.equals(storeKey))throw Error();return{httpToken:token,authority:{authorId,key:authority},storeKey,maxBodyBytes:64*1024};}catch{throw new Error("agent-event daemon configuration invalid");}
}
export type TrustedDiscordRow={authorId:string;authorIsBot:boolean;webhookId:string|null;channelId:string;projectRoute:string;messageId:string;timestamp:string;event:AgentEvent};
export function signTrustedDiscordRow(row:TrustedDiscordRow,authority:IngressAuthority):AuthenticatedAgentEventIngress{
  if(row.authorId!==authority.authorId||row.authorIsBot||row.webhookId!==null||!SNOWFLAKE.test(row.channelId)||!SNOWFLAKE.test(row.messageId))throw new Error("trusted Discord row rejected");
  const unsigned={event:row.event,authorId:row.authorId,authorIsBot:false,channelId:row.channelId,projectRoute:row.projectRoute,nonce:`discord:${row.channelId}:${row.messageId}`,issuedAt:row.timestamp};
  return{...unsigned,signature:signAgentEventIngress(unsigned,authority.key)};
}
export class AgentEventHttpIngress{
  constructor(private daemon:AgentEventDaemon,private config:AgentEventDaemonConfig){}
  async handle(request:Request):Promise<Response>{
    if(request.method!=="POST"||new URL(request.url).pathname!=="/agent-event")return new Response("not found",{status:404});
    const supplied=request.headers.get("authorization")?.replace(/^Bearer /,"")??"";
    if(supplied.length!==this.config.httpToken.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(this.config.httpToken)))return new Response("unauthorized",{status:401});
    let raw:string;try{const chunks:Uint8Array[]=[];let size=0;const reader=request.body?.getReader();if(!reader)throw Error();for(;;){const{done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>this.config.maxBodyBytes){await reader.cancel();throw Error();}chunks.push(value);}raw=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));}catch{return new Response("invalid",{status:400});}
    let body:unknown;try{body=JSON.parse(raw);}catch{return new Response("invalid",{status:400});}
    try{const receipt=await this.daemon.ingest(body as AuthenticatedAgentEventIngress);return Response.json(receipt,{status:receipt.status==="accepted"?202:200});}catch{return new Response("rejected",{status:400});}
  }
}
export function startAgentEventLoopback(daemon:AgentEventDaemon,config:AgentEventDaemonConfig,port:number,serve:typeof Bun.serve=Bun.serve){if(!Number.isInteger(port)||port<1||port>65535)throw new Error("agent-event port invalid");const ingress=new AgentEventHttpIngress(daemon,config);let server:ReturnType<typeof Bun.serve>;try{server=serve({hostname:"127.0.0.1",port,fetch:(r:Request)=>ingress.handle(r)} as any);}catch(e){daemon.close();throw e;}let stopped=false;return{port:server.port,async stop(){if(stopped)return;stopped=true;try{await server.stop(true);}finally{daemon.close();}}};}

export type DiscordMarkerClient={listOwnMessages(channel:string,before?:string):Promise<Array<{id:string;authorId:string;webhookId:string|null;marker:string}>>};
export class DiscordMarkerAdapter{constructor(private client:DiscordMarkerClient,private ownActor:string){}async has(destination:string,key:string){let before:string|undefined,terminal=false;const hits:string[]=[];for(let page=0;page<5;page++){const rows=await this.client.listOwnMessages(destination,before);for(const r of rows)if(r.authorId===this.ownActor&&r.webhookId===null&&r.marker===key)hits.push(r.id);if(hits.length>1)throw new Error("Discord marker ambiguous");if(rows.length<50){terminal=true;break;}before=rows.at(-1)?.id;}if(!terminal&&hits.length===0)throw new Error("Discord marker pagination exhausted");return hits.length===1;}}
export type GitHubMarkerClient={listComments(repo:string,issue:number,page:number):Promise<Array<{id:string;actor:string;marker:string}>>};
export class GitHubMarkerAdapter{constructor(private client:GitHubMarkerClient,private ownActor:string){}async has(issueRef:string,key:string){const m=/^([^#]+)#([1-9]\d*)$/.exec(issueRef);if(!m)throw new Error("GitHub issue invalid");const hits:string[]=[];let terminal=false;for(let page=1;page<=5;page++){const rows=await this.client.listComments(m[1]!,Number(m[2]),page);for(const r of rows)if(r.actor===this.ownActor&&r.marker===key)hits.push(r.id);if(hits.length>1)throw new Error("GitHub marker ambiguous");if(rows.length<100){terminal=true;break;}}if(!terminal&&hits.length===0)throw new Error("GitHub marker pagination exhausted");return hits.length===1;}}
