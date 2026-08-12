import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuditRecord } from "./types";

export class DurableStore {
  readonly auditPath: string;
  readonly statePath: string;
  private resolved: Set<string>;

  constructor(root: string) {
    this.auditPath = join(root, "audit.jsonl");
    this.statePath = join(root, "resolved.json");
    this.resolved = existsSync(this.statePath) ? new Set(JSON.parse(readFileSync(this.statePath, "utf8"))) : new Set();
  }

  has(messageId: string) { return this.resolved.has(messageId); }

  audit(record: AuditRecord) {
    appendFileSync(this.auditPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
  }

  markResolved(messageId: string) {
    this.resolved.add(messageId);
    const tmp = `${this.statePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify([...this.resolved].sort()) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.statePath);
  }
}
