import { chmodSync, closeSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, constants, fchmodSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuditRecord } from "./types";
import { createHash } from "node:crypto";

export class DurableStore {
  static readonly MAX_AUDIT_RECORDS = 400;
  readonly auditPath: string;
  readonly statePath: string;
  private states: Map<string, "pending"|"resolved">;
  private static readonly activeAttempts = new Set<string>();

  constructor(root: string) {
    if (root.includes("..")) throw new Error("invalid store path"); if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error("store path must not be symlink"); createPrivateStoreRoot(root);
    this.auditPath = join(root, "audit.jsonl");
    this.statePath = join(root, "resolved.json");
    for (const p of [this.auditPath,this.statePath]) if (existsSync(p)) { const st=lstatSync(p); if(st.isSymbolicLink()||!st.isFile()) throw new Error(`unsafe store file: ${p}`); const fd=openSync(p, constants.O_RDONLY|((constants as any).O_NOFOLLOW??0)); closeSync(fd); }
    if (existsSync(this.statePath)) { const parsed=JSON.parse(readFileSync(this.statePath,"utf8")); if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)||Object.values(parsed).some(x=>x!=="pending"&&x!=="resolved")) throw new Error("resolved state corrupt"); this.states=new Map(Object.entries(parsed) as [string,"pending"|"resolved"][]); } else this.states=new Map();
  }

  has(messageId: string) { return this.states.get(messageId)==="resolved"; }
  begin(messageId: string): "new"|"pending"|"resolved" { let result:"new"|"pending"|"resolved"="new"; this.withLock(()=>{ const current=this.readStates(); const state=current[messageId]??"new"; if(state==="resolved"){result="resolved"; return;} if(state==="new"){current[messageId]="pending";this.writeStates(current);} const attempt=this.attemptKey(messageId); if(DurableStore.activeAttempts.has(attempt)){result="pending";return;} DurableStore.activeAttempts.add(attempt); result="new"; this.states=new Map(Object.entries(current) as [string,"pending"|"resolved"][]); }); return result; }

  finishAttempt(messageId: string) { DurableStore.activeAttempts.delete(this.attemptKey(messageId)); }

  audit(record: AuditRecord) {
    this.withLock(()=>{ let fd:number|undefined; try { try { fd=openSync(this.auditPath, constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NONBLOCK|((constants as any).O_NOFOLLOW??0),0o600); } catch { throw new Error("unsafe audit file"); } const st=fstatSync(fd); if(!st.isFile()||st.nlink!==1) throw new Error("unsafe audit file"); const raw=readFileSync(this.auditPath,"utf8"); const count=raw.split("\n").filter(Boolean).length; if(count>=DurableStore.MAX_AUDIT_RECORDS) throw new Error("audit capacity exceeded"); const prior=raw.split("\n").filter(Boolean).at(-1)??""; const hash=cryptoHash(prior+JSON.stringify(record)); const line=`${JSON.stringify({...record, prevHash:prior?cryptoHash(prior):null, hash})}\n`; fchmodSync(fd,0o600); writeFileSync(fd,line,"utf8"); fsyncSync(fd); } finally { if(fd!==undefined) closeSync(fd); } });
  }

  markResolved(messageId: string) {
    this.withLock(()=>{ const current=this.readStates(); current[messageId]="resolved"; this.writeStates(current); this.states=new Map(Object.entries(current) as any); }); this.finishAttempt(messageId);
  }

  private readStates(): Record<string,"pending"|"resolved"> { if(!existsSync(this.statePath)) return {}; const x=JSON.parse(readFileSync(this.statePath,"utf8")); if(!x||typeof x!=="object"||Array.isArray(x)||Object.values(x).some((v:any)=>v!=="pending"&&v!=="resolved")) throw new Error("resolved state corrupt"); return x; }
  private attemptKey(messageId: string) { return `${this.statePath}\u0000${messageId}`; }
  private writeStates(current: Record<string,"pending"|"resolved">) { const tmp=`${this.statePath}.tmp-${process.pid}`; writeFileSync(tmp,JSON.stringify(current,null,2)+"\n",{encoding:"utf8",mode:0o600}); const fd=openSync(tmp,"r"); fsyncSync(fd); closeSync(fd); renameSync(tmp,this.statePath); const dirfd=openSync(dirname(this.statePath),"r"); fsyncSync(dirfd); closeSync(dirfd); chmodSync(this.statePath,0o600); }

  private withLock(fn:()=>void) { const lock=this.statePath+".lock"; let fd:number|undefined; for(let i=0;i<100;i++){try{fd=openSync(lock,"wx",0o600);writeFileSync(fd,`${process.pid} ${Date.now()}`);break}catch{try{const raw=readFileSync(lock,"utf8").trim();const s=raw.split(/\s+/);const valid=s.length===2&&/^\d+$/.test(s[0])&&/^\d+$/.test(s[1]);const stale=!valid||Date.now()-Number(s[1])>30000;let dead=false;if(valid){try{process.kill(Number(s[0]),0)}catch{dead=true}}if(stale||dead)unlinkSync(lock)}catch{} Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2)}} if(fd===undefined) throw new Error("store lock timeout"); try{fn()}finally{closeSync(fd);unlinkSync(lock)}}
}
type MakeDirectory = (path: string, options: { recursive: true; mode: number }) => unknown;
type ChangeMode = (path: string, mode: number) => void;
export function createPrivateStoreRoot(root: string, makeDirectory: MakeDirectory = (path, options) => mkdirSync(path, options), changeMode: ChangeMode = chmodSync) { makeDirectory(root, { recursive: true, mode: 0o700 }); changeMode(root, 0o700); }
function cryptoHash(s:string){return createHash("sha256").update(s).digest("hex")}
