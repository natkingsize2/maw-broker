import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentLease } from "../src/runner";

/**
 * Gap this file closes: `runner.test.ts` already proves (a) a live owner blocks a second lease,
 * (b) a dead owner (pid not alive) with a stale heartbeat is reclaimed, and (c) two REAL spawned
 * OS processes contend correctly (SIGKILL one, the other reclaims). It does NOT exercise the
 * PID-REUSE branch that `runner.ts:150-161` names as a deliberate, documented tradeoff
 * ("RECORDED TRADEOFF (probe G6): closing R2 makes the theft surface nonzero") — a lease whose
 * recorded pid IS alive right now, but whose `startedAt` disagrees with that live process's real
 * start time by more than the 60s tolerance, must be treated as belonging to a DIFFERENT process
 * that happens to be wearing a recycled pid, not as the genuine owner. This is exactly a
 * cross-process contention scenario: "the pid column says busy, is it actually busy?"
 */
describe("cross-process lease contention — PID-reuse branch (runner.ts PersistentLease.acquire)", () => {
  test("recorded owner pid is alive but startedAt disagrees by >60s + stale heartbeat ⇒ reclaimed (not a live blocker)", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-lease-reuse-reclaim-"));
    const path = join(root, "runner.lease");
    const recordedStartedAt = Date.now() - 10 * 60_000; // lease claims the owner started 10 min ago
    const staleHeartbeat = Date.now() - 31_000;          // and hasn't heartbeat in >30s (staleAfterMs default)
    Bun.write(path, `4242 ${recordedStartedAt} ${staleHeartbeat}\n`);
    // alive(4242) = true (something IS running at that pid right now) but startTimeOf(4242) says
    // that live process actually started just now — a completely different startedAt from the
    // lease record. That mismatch is what distinguishes "the real owner is alive" from "an
    // unrelated process now wears this pid".
    const acquirer = new PersistentLease(root, 30_000, Date.now, () => true, () => Date.now());
    expect(acquirer.path).toBe(path);
    acquirer.release();
  });

  test("recorded owner pid is alive, startedAt matches within 60s tolerance, heartbeat fresh ⇒ genuinely held, refused", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-lease-reuse-genuine-"));
    const path = join(root, "runner.lease");
    const startedAt = Date.now() - 5_000;
    Bun.write(path, `4242 ${startedAt} ${Date.now()}\n`); // fresh heartbeat
    // Same pid, startTimeOf agrees (within tolerance) ⇒ this IS the real live owner.
    expect(() => new PersistentLease(root, 30_000, Date.now, () => true, () => startedAt + 200)).toThrow("runner lease already held");
  });

  test("recorded owner pid alive + startedAt mismatched, but heartbeat still FRESH ⇒ recovery pending, not reclaimed yet", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-lease-reuse-pending-"));
    const path = join(root, "runner.lease");
    const recordedStartedAt = Date.now() - 10 * 60_000;
    Bun.write(path, `4242 ${recordedStartedAt} ${Date.now()}\n`); // heartbeat is FRESH (just written)
    // pid reused (startTimeOf disagrees) so it's not blocked as a "live owner" on that basis alone —
    // but the heartbeat is still within staleAfterMs, so acquire must not snatch it out from under
    // a process that (from the file's own timestamp) was just here. Fail closed: pending, not stolen.
    expect(() => new PersistentLease(root, 30_000, Date.now, () => true, () => Date.now())).toThrow("runner lease recovery pending");
  });

  test("startTimeOf returns undefined (ps unreadable) ⇒ treated as unknown, live pid still blocks (fail closed toward the alive pid)", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-lease-reuse-unknown-"));
    const path = join(root, "runner.lease");
    const startedAt = Date.now() - 5_000;
    Bun.write(path, `4242 ${startedAt} ${Date.now()}\n`);
    // startTimeOf → undefined models `ps` failing to read /proc/etime for a pid we can still signal.
    // pidReused is only computed when startTimeOf() succeeds — undefined means "not proven reused",
    // so the alive() check alone governs: it must still refuse, never silently reclaim on an
    // unreadable clock.
    expect(() => new PersistentLease(root, 30_000, Date.now, () => true, () => undefined)).toThrow("runner lease already held");
  });

  test("reclaimed-through-pid-reuse lease is fully usable afterward (writes a fresh owner record)", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-lease-reuse-usable-"));
    const path = join(root, "runner.lease");
    const recordedStartedAt = Date.now() - 10 * 60_000;
    Bun.write(path, `4242 ${recordedStartedAt} ${Date.now() - 31_000}\n`);
    const acquirer = new PersistentLease(root, 30_000, Date.now, () => true, () => Date.now());
    const owner = readFileSync(path, "utf8").trim().split(/\s+/);
    expect(Number(owner[0])).toBe(process.pid); // the new lease record is ours, not the stale 4242
    acquirer.release();
  });
});
