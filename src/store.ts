import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuditRecord } from "./types";
import { createHash } from "node:crypto";

export class DurableStore {
  readonly auditPath: string;
  readonly statePath: string;
  private resolved: Set<string>;

  constructor(root: string) {
    if (root.includes("..")) throw new Error("invalid store path"); if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error("store path must not be symlink"); mkdirSync(root, { recursive: true });
    this.auditPath = join(root, "audit.jsonl");
    this.statePath = join(root, "resolved.json");
    if (existsSync(this.statePath)) { const parsed=JSON.parse(readFileSync(this.statePath,"utf8")); if(!Array.isArray(parsed)||parsed.some(x=>typeof x!=="string")) throw new Error("resolved state corrupt"); this.resolved=new Set(parsed); } else this.resolved=new Set();
  }

  has(messageId: string) { return this.resolved.has(messageId); }

  audit(record: AuditRecord) {
    this.withLock(()=>{ const prior=existsSync(this.auditPath)?readFileSync(this.auditPath,"utf8").split("\n").filter(Boolean).at(-1):""; const hash=cryptoHash(prior+JSON.stringify(record)); appendFileSync(this.auditPath, `${JSON.stringify({...record, prevHash:prior?cryptoHash(prior):null, hash})}\n`, {encoding:"utf8",flag:"a",mode:0o600}); const fd=openSync(this.auditPath,"r"); fsyncSync(fd); closeSync(fd); chmodSync(this.auditPath,0o600); });
  }

  markResolved(messageId: string) {
    this.withLock(()=>{ const current=existsSync(this.statePath)?JSON.parse(readFileSync(this.statePath,"utf8")):[]; if(!Array.isArray(current)||current.some((x:any)=>typeof x!=="string")) throw new Error("resolved state corrupt"); this.resolved=new Set(current); this.resolved.add(messageId); const tmp=`${this.statePath}.tmp-${process.pid}`; writeFileSync(tmp,JSON.stringify([...this.resolved].sort())+"\n",{encoding:"utf8",mode:0o600}); const fd=openSync(tmp,"r"); fsyncSync(fd); closeSync(fd); renameSync(tmp,this.statePath); const dirfd=openSync(dirname(this.statePath),"r"); fsyncSync(dirfd); closeSync(dirfd); chmodSync(this.statePath,0o600); });
  }

  private withLock(fn:()=>void) { const lock=this.statePath+".lock"; let fd:number|undefined; for(let i=0;i<100;i++){try{fd=openSync(lock,"wx",0o600);break}catch{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2)}} if(fd===undefined) throw new Error("store lock timeout"); try{fn()}finally{closeSync(fd);unlinkSync(lock)}}
}
function cryptoHash(s:string){return createHash("sha256").update(s).digest("hex")}
