import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import type { AuditRecord } from "./types";
import { createHash } from "node:crypto";

export class DurableStore {
  readonly auditPath: string;
  readonly statePath: string;
  private states: Map<string, "pending"|"resolved">;

  constructor(root: string) {
    if (root.includes("..")) throw new Error("invalid store path"); if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error("store path must not be symlink"); mkdirSync(root, { recursive: true });
    this.auditPath = join(root, "audit.jsonl");
    this.statePath = join(root, "resolved.json");
    for (const p of [this.auditPath,this.statePath]) if (existsSync(p)) { const st=lstatSync(p); if(st.isSymbolicLink()||!st.isFile()) throw new Error(`unsafe store file: ${p}`); const fd=openSync(p, constants.O_RDONLY|((constants as any).O_NOFOLLOW??0)); closeSync(fd); }
    if (existsSync(this.statePath)) { const parsed=JSON.parse(readFileSync(this.statePath,"utf8")); if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)||Object.values(parsed).some(x=>x!=="pending"&&x!=="resolved")) throw new Error("resolved state corrupt"); this.states=new Map(Object.entries(parsed) as [string,"pending"|"resolved"][]); } else this.states=new Map();
  }

  has(messageId: string) { return this.states.get(messageId)==="resolved"; }
  begin(messageId: string): "new"|"pending"|"resolved" { let result:"new"|"pending"|"resolved"="new"; this.withLock(()=>{ const current=this.readStates(); result=current[messageId]??"new"; if(result==="new"){current[messageId]="pending";this.writeStates(current)} this.states=new Map(Object.entries(current) as any); }); return result; }

  audit(record: AuditRecord) {
    this.withLock(()=>{ const prior=existsSync(this.auditPath)?readFileSync(this.auditPath,"utf8").split("\n").filter(Boolean).at(-1):""; const hash=cryptoHash(prior+JSON.stringify(record)); appendFileSync(this.auditPath, `${JSON.stringify({...record, prevHash:prior?cryptoHash(prior):null, hash})}\n`, {encoding:"utf8",flag:"a",mode:0o600}); const fd=openSync(this.auditPath,"r"); fsyncSync(fd); closeSync(fd); chmodSync(this.auditPath,0o600); });
  }

  markResolved(messageId: string) {
    this.withLock(()=>{ const current=this.readStates(); current[messageId]="resolved"; this.writeStates(current); this.states=new Map(Object.entries(current) as any); });
  }

  private readStates(): Record<string,"pending"|"resolved"> { if(!existsSync(this.statePath)) return {}; const x=JSON.parse(readFileSync(this.statePath,"utf8")); if(!x||typeof x!=="object"||Array.isArray(x)||Object.values(x).some((v:any)=>v!=="pending"&&v!=="resolved")) throw new Error("resolved state corrupt"); return x; }
  private writeStates(current: Record<string,"pending"|"resolved">) { const tmp=`${this.statePath}.tmp-${process.pid}`; writeFileSync(tmp,JSON.stringify(current,null,2)+"\n",{encoding:"utf8",mode:0o600}); const fd=openSync(tmp,"r"); fsyncSync(fd); closeSync(fd); renameSync(tmp,this.statePath); const dirfd=openSync(dirname(this.statePath),"r"); fsyncSync(dirfd); closeSync(dirfd); chmodSync(this.statePath,0o600); }

  private withLock(fn:()=>void) { const lock=this.statePath+".lock"; let fd:number|undefined; for(let i=0;i<100;i++){try{fd=openSync(lock,"wx",0o600);writeFileSync(fd,`${process.pid} ${Date.now()}`);break}catch{try{const s=readFileSync(lock,"utf8").split(/\s+/);const stale=Date.now()-Number(s[1])>30000;let dead=false;try{process.kill(Number(s[0]),0)}catch{dead=true}if(stale||dead)unlinkSync(lock)}catch{} Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2)}} if(fd===undefined) throw new Error("store lock timeout"); try{fn()}finally{closeSync(fd);unlinkSync(lock)}}
}
function cryptoHash(s:string){return createHash("sha256").update(s).digest("hex")}
