import { createHash, createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { ProjectRegistry } from "./project-routes";

export const AGENT_EVENT_SCHEMA = "maw.broker.agent-event.v1";
export const AGENT_EVENT_KINDS = ["progress", "done", "blocked"] as const;
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];
export const AGENT_EVENT_IDEMPOTENCY_PREFIX = "agent-event-v1";
export type AgentEvent = { schema:string; project:string; kind:string; event_id:string; agent:string; summary:string; occurred_at:string };
export type AgentEventReceipt = { status:"accepted"|"duplicate"; schema:string; project:string; kind:AgentEventKind; event_id:string; idempotencyKey:string; receivedAt:string; discordDestination:string; githubIssue:string };
export type AuthenticatedAgentEventIngress = { event:unknown; authorId:string; authorIsBot:boolean; channelId:string; projectRoute:string; signature:string };
export type IngressAuthority = { authorId:string; key:Buffer };
export class AgentEventError extends Error { constructor(readonly code:"MALFORMED_EVENT"|"KIND_REJECTED"|"UNKNOWN_PROJECT"|"IDEMPOTENCY_CONFLICT"|"UNAUTHENTICATED_INGRESS",message:string){super(message);this.name="AgentEventError";} }
const EVENT_KEYS=["agent","event_id","kind","occurred_at","project","schema","summary"];
const ID_RE=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/; const TIME_RE=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const sha=(v:string|Buffer)=>createHash("sha256").update(v).digest("hex");
export function canonicalJson(v:unknown):string{if(v===null||typeof v!=="object")return JSON.stringify(v);if(Array.isArray(v))return `[${v.map(canonicalJson).join(",")}]`;return `{${Object.keys(v as object).sort().map(k=>`${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`).join(",")}}`;}
export function buildAgentEventIdempotencyKey(project:string,eventId:string){return `${AGENT_EVENT_IDEMPOTENCY_PREFIX}:${project}:${eventId}`;}
export function validateAgentEvent(body:unknown,registry:ProjectRegistry){const b=body as Partial<AgentEvent>;if(!b||typeof b!=="object"||Array.isArray(b)||Object.keys(b).sort().join("\0")!==EVENT_KEYS.slice().sort().join("\0"))throw new AgentEventError("MALFORMED_EVENT","event key set invalid");if(b.schema!==AGENT_EVENT_SCHEMA||!ID_RE.test(b.project??"")||!ID_RE.test(b.event_id??"")||!ID_RE.test(b.agent??"")||typeof b.summary!=="string"||!b.summary||b.summary.length>2000||!TIME_RE.test(b.occurred_at??"")||!Number.isFinite(Date.parse(b.occurred_at!)))throw new AgentEventError("MALFORMED_EVENT","event fields invalid");if(!(AGENT_EVENT_KINDS as readonly string[]).includes(b.kind!))throw new AgentEventError("KIND_REJECTED","event kind rejected");const route=registry.project(b.project!);if(!route)throw new AgentEventError("UNKNOWN_PROJECT","unknown project");return{event:b as AgentEvent&{kind:AgentEventKind},idempotencyKey:buildAgentEventIdempotencyKey(b.project!,b.event_id!),discordDestination:route.destination,githubIssue:route.issue};}
export interface OutboundEmitter{emitDiscord(destination:string,content:string,idempotencyKey?:string):Promise<void>;emitGitHub(issueRef:string,comment:string,idempotencyKey?:string):Promise<void>}
export function signAgentEventIngress(input:Omit<AuthenticatedAgentEventIngress,"signature">,key:Buffer){return createHmac("sha256",key).update(canonicalJson(input)).digest("hex");}
type Sink="discord"|"github"; type SinkState={status:"pending"|"delivered";idempotencyKey:string;deliveredAt?:string};
type RecordRow={event:AgentEvent&{kind:AgentEventKind};eventDigest:string;receipt:AgentEventReceipt;sinks:Record<Sink,SinkState>};
type AuditRow={at:string;action:"queued"|"sink-delivered"|"accepted"|"replay"|"conflict";idempotencyKey:string;eventDigest:string;sink?:Sink;prevHash:string|null;hash:string};
type Core={version:2;records:Record<string,RecordRow>;audit:AuditRow[]}; type Snapshot=Core&{snapshotDigest:string};
function safeRoot(root:string){if(resolve(root)!==root)throw new Error("agent-event store root must be absolute");if(!existsSync(root))mkdirSync(root,{mode:0o700});const s=lstatSync(root);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)!==0)throw new Error("agent-event store root unsafe");}
function safeRead(path:string){const a=lstatSync(path);if(!a.isFile()||a.isSymbolicLink()||a.uid!==process.getuid()||(a.mode&0o777)!==0o600||a.nlink!==1)throw new Error("agent-event snapshot unsafe");const fd=openSync(path,constants.O_RDONLY|((constants as any).O_NOFOLLOW??0));try{const b=fstatSync(fd);if(b.ino!==a.ino||b.dev!==a.dev||!b.isFile()||b.nlink!==1)throw new Error("agent-event snapshot raced");return readFileSync(fd,"utf8");}finally{closeSync(fd);}}
class Lease {
  private fd!: number;
  readonly path: string;
  constructor(root: string) {
    this.path = `${root}/writer.lease`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.fd = openSync(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | ((constants as any).O_NOFOLLOW ?? 0), 0o600);
        writeFileSync(this.fd, `${process.pid}\n`); fsyncSync(this.fd); return;
      } catch {
        let pid: number | undefined;
        try { const raw = safeRead(this.path).trim(); if (/^[1-9]\d*$/.test(raw)) pid = Number(raw); } catch { throw new Error("agent-event writer lease corrupt"); }
        if (pid !== undefined) { try { process.kill(pid, 0); } catch { unlinkSync(this.path); continue; } }
        throw new Error("agent-event writer lease held");
      }
    }
    throw new Error("agent-event writer lease unavailable");
  }
  close() { try { closeSync(this.fd); } finally { try { unlinkSync(this.path); } catch {} } }
}
export class AgentEventLedger{
 private records=new Map<string,RecordRow>();private audit:AuditRow[]=[];private lease?:Lease;
 constructor(private registry:ProjectRegistry,private emitter:OutboundEmitter,private path?:string,private now:()=>string=()=>new Date().toISOString(),private authority?:IngressAuthority){if(path){const root=dirname(path);safeRoot(root);if(basename(path)!=="ledger.json")throw new Error("agent-event snapshot name invalid");this.lease=new Lease(root);try{if(existsSync(path))this.load();}catch(e){this.close();throw e;}}}
 close(){this.lease?.close();this.lease=undefined;}
 private load(){let p:Snapshot;try{p=JSON.parse(safeRead(this.path!));}catch(e){throw new Error(`agent-event snapshot corrupt: ${e instanceof Error?e.message:"invalid"}`);}if(Object.keys(p).sort().join(",")!=="audit,records,snapshotDigest,version"||p.version!==2||!p.records||!Array.isArray(p.audit))throw new Error("agent-event snapshot schema invalid");const{snapshotDigest,...core}=p;if(sha(canonicalJson(core))!==snapshotDigest)throw new Error("agent-event snapshot digest mismatch");this.records=new Map(Object.entries(p.records));this.audit=p.audit;if(!this.verifyAuditChain())throw new Error("agent-event audit chain broken");}
 private persist(){if(!this.path)return;const core:Core={version:2,records:Object.fromEntries(this.records),audit:this.audit};const out:Snapshot={...core,snapshotDigest:sha(canonicalJson(core))};const tmp=`${this.path}.tmp-${process.pid}-${randomUUID()}`;const fd=openSync(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|((constants as any).O_NOFOLLOW??0),0o600);try{writeFileSync(fd,canonicalJson(out)+"\n");fchmodSync(fd,0o600);fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,this.path);const d=openSync(dirname(this.path),constants.O_RDONLY);try{fsyncSync(d);}finally{closeSync(d);}chmodSync(this.path,0o600);}
 private add(action:AuditRow["action"],key:string,digest:string,sink?:Sink){const prev=this.audit.at(-1)?.hash??null;const core={at:this.now(),action,idempotencyKey:key,eventDigest:digest,...(sink?{sink}:{}),prevHash:prev};this.audit.push({...core,hash:sha(canonicalJson(core))});}
 verifyAuditChain(){let prev:string|null=null;for(const row of this.audit){const{hash,...core}=row;if(row.prevHash!==prev||sha(canonicalJson(core))!==hash)return false;prev=hash;}return true;}get auditRows(){return this.audit as readonly AuditRow[];}
 private authenticate(input:AuthenticatedAgentEventIngress){if(!this.authority)throw new AgentEventError("UNAUTHENTICATED_INGRESS","ingress authority missing");const{signature,...unsigned}=input;const expected=signAgentEventIngress(unsigned,this.authority.key);if(!/^[0-9a-f]{64}$/.test(signature)||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected))||input.authorId!==this.authority.authorId||input.authorIsBot)throw new AgentEventError("UNAUTHENTICATED_INGRESS","ingress authentication failed");const valid=validateAgentEvent(input.event,this.registry);if(input.projectRoute!==valid.event.project||input.channelId!==valid.discordDestination)throw new AgentEventError("UNAUTHENTICATED_INGRESS","ingress route binding failed");return valid;}
 async acceptAuthenticated(input:AuthenticatedAgentEventIngress){return this.acceptValidated(this.authenticate(input));}async accept(body:unknown){if(this.authority)throw new AgentEventError("UNAUTHENTICATED_INGRESS","authenticated ingress required");return this.acceptValidated(validateAgentEvent(body,this.registry));}
 private async acceptValidated(v:ReturnType<typeof validateAgentEvent>):Promise<AgentEventReceipt>{const{event,idempotencyKey,discordDestination,githubIssue}=v;const digest=sha(canonicalJson(event));let row=this.records.get(idempotencyKey);if(row&&row.eventDigest!==digest){this.add("conflict",idempotencyKey,digest);this.persist();throw new AgentEventError("IDEMPOTENCY_CONFLICT","idempotency conflict");}const duplicate=!!row;if(!row){const receipt={status:"accepted" as const,schema:event.schema,project:event.project,kind:event.kind,event_id:event.event_id,idempotencyKey,receivedAt:this.now(),discordDestination,githubIssue};row={event,eventDigest:digest,receipt,sinks:{discord:{status:"pending",idempotencyKey:`${idempotencyKey}:discord`},github:{status:"pending",idempotencyKey:`${idempotencyKey}:github`}}};this.records.set(idempotencyKey,row);this.add("queued",idempotencyKey,digest);this.persist();}const content=`[${event.kind}] ${event.agent} @ ${event.project}: ${event.summary}`;for(const sink of ["discord","github"] as const){if(row.sinks[sink].status==="delivered")continue;if(sink==="discord")await this.emitter.emitDiscord(discordDestination,content,row.sinks[sink].idempotencyKey);else await this.emitter.emitGitHub(githubIssue,content,row.sinks[sink].idempotencyKey);row.sinks[sink]={...row.sinks[sink],status:"delivered",deliveredAt:this.now()};this.add("sink-delivered",idempotencyKey,digest,sink);this.persist();}this.add(duplicate?"replay":"accepted",idempotencyKey,digest);this.persist();return{...row.receipt,status:duplicate?"duplicate":"accepted"};}
}
export class AgentEventDaemon{constructor(readonly ledger:AgentEventLedger){}ingest(input:AuthenticatedAgentEventIngress){return this.ledger.acceptAuthenticated(input)}close(){this.ledger.close()}}
