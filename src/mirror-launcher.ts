import { join } from "node:path";
import { PersistentLease, DiscordRestClient, loadRunnerSecrets } from "./runner";
import { StateMirror, DiscordDigestSink, FileMirrorStateStore, type AgentState } from "./state-mirror";

/** The one place agent states come from. Kept behind an interface so the reconcile loop is
 *  testable without argus/task subprocesses; the concrete adapter lives at the edge. */
export interface StateSource {
  collect(): Promise<AgentState[]>;
}

/** The production project room — the single visible sink for the state mirror (anvil: outbound
 *  state mirror ONLY, no duplication to #canon or anywhere else). Hard-pinned like the command
 *  launcher's channel: the mirror refuses to run against any other channel. */
export const MIRROR_CHANNEL_ID = "1056224550129508415";

export type MirrorServiceOptions = {
  sink: ConstructorParameters<typeof StateMirror>[0];
  store: FileMirrorStateStore;
  source: StateSource;
  /** Directory whose runner.lease enforces one writer across processes (anvil: my per-instance
   *  single-flight is not enough — two processes would both post). */
  leaseRoot: string;
  intervalMs: number;
  maxPolls: number;
};

/**
 * Lease-guarded state-mirror service. Acquiring the PersistentLease in the constructor is what
 * makes the single-writer guarantee cross-process: a second service on the same lease root
 * throws before it can post, so the room never gets a second digest from a second process.
 */
export class MirrorService {
  private readonly lease: PersistentLease;
  private readonly mirror: StateMirror;
  constructor(private readonly options: MirrorServiceOptions) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1000 || !Number.isInteger(options.maxPolls) || options.maxPolls < 1) throw new Error("mirror service configuration invalid");
    this.lease = new PersistentLease(options.leaseRoot);   // throws if another live writer holds it
    this.mirror = new StateMirror(options.sink, options.store);
  }
  /** One reconcile pass: refresh the lease, collect states, reconcile. Never throws out of the
   *  loop for a transient collect/reconcile error — it holds and retries next tick. */
  async tick(): Promise<"posted" | "edited" | "noop" | "held"> {
    this.lease.refresh();
    let states: AgentState[];
    try { states = await this.options.source.collect(); } catch { return "held"; }
    try { return await this.mirror.reconcile(states); } catch { return "held"; }
  }
  async run(): Promise<void> {
    try {
      for (let poll = 1; poll <= this.options.maxPolls; poll++) {
        const r = await this.tick();
        console.log(`mirror poll=${poll}/${this.options.maxPolls} ${r}`);
        if (poll < this.options.maxPolls) await new Promise(resolve => setTimeout(resolve, this.options.intervalMs));
      }
    } finally { this.close(); }
  }
  close() { this.lease.release(); }
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const secrets = loadRunnerSecrets(env);
  const storeRoot = env.MAW_MIRROR_STORE_ROOT;
  const channel = env.MAW_MIRROR_CHANNEL_ID;
  if (!storeRoot) throw new Error("mirror service configuration invalid");
  if (channel !== MIRROR_CHANNEL_ID) throw new Error("mirror channel differs from production pin");
  const intervalMs = Number(env.MIRROR_POLL_INTERVAL_MS ?? "10000");
  const maxPolls = Number(env.MIRROR_MAX_POLLS ?? "120");
  const client = new DiscordRestClient(secrets.discordBotToken);
  const source = await resolveStateSource(env);
  const service = new MirrorService({
    sink: new DiscordDigestSink(client, channel),
    store: new FileMirrorStateStore(join(storeRoot, "mirror.json")),
    source,
    leaseRoot: storeRoot,
    intervalMs,
    maxPolls,
  });
  const stop = () => service.close();
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  await service.run();
}

/** Placeholder resolver: the live argus/task→AgentState adapter is a separate, review-gated
 *  piece (it shells out to telemetry and the task board). Until it lands, main() refuses to run
 *  rather than posting an empty/placeholder digest. */
async function resolveStateSource(_env: Record<string, string | undefined>): Promise<StateSource> {
  throw new Error("live state source not yet wired");
}

if (import.meta.main) { main().catch(error => { console.error(String(error?.message ?? error)); process.exit(1); }); }
