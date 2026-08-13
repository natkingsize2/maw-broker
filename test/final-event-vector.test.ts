import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryFinalEventStore, canonicalize, computeContentDigest, handleFinalEvent } from "../src/final-event-contract";

/**
 * Self-verifying check on the COMMITTED test vector (`test/fixtures/final-event-vector-v1.json`)
 * a Python builder will implement a mapping against. This file proves the fixture is internally
 * consistent with the REAL TypeScript implementation right now — if `canonicalize()` or
 * `computeContentDigest()` ever changes in a way that would silently break Python interop, this
 * test goes red immediately, not "whenever someone happens to re-check the fixture by eye".
 */
const VECTOR = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "final-event-vector-v1.json"), "utf8"));
const AUTH = { authorizedToken: "vector-test-fake-token" };
const HEADER = `Bearer ${AUTH.authorizedToken}`;

describe("committed final-event test vector (Thai text) — self-verifying against the real implementation", () => {
  test("canonicalize(content) matches the vector's recorded canonicalContentString exactly", () => {
    expect(canonicalize(VECTOR.request.content)).toBe(VECTOR.canonicalContentString);
  });

  test("computeContentDigest(content) matches the vector's recorded contentDigest exactly", () => {
    expect(computeContentDigest(VECTOR.request.content)).toBe(VECTOR.request.contentDigest);
  });

  test("the vector's content preserves the Thai text as raw UTF-8 (not \\uXXXX-escaped)", () => {
    expect(VECTOR.canonicalContentString).toContain("สวัสดีค่ะ");
    expect(VECTOR.canonicalContentString).not.toContain("\\u0e");
  });

  test("first submission of the vector's request produces exactly expectedReceiptOnFirstAccept", () => {
    const store = new InMemoryFinalEventStore();
    const receipt = handleFinalEvent(HEADER, VECTOR.request, store, AUTH, () => VECTOR.expectedReceiptOnFirstAccept.receivedAt);
    expect(receipt).toEqual(VECTOR.expectedReceiptOnFirstAccept);
  });

  test("replaying the identical vector request afterward produces exactly expectedReceiptOnReplay (original receivedAt preserved)", () => {
    const store = new InMemoryFinalEventStore();
    handleFinalEvent(HEADER, VECTOR.request, store, AUTH, () => VECTOR.expectedReceiptOnFirstAccept.receivedAt);
    const replay = handleFinalEvent(HEADER, VECTOR.request, store, AUTH, () => "2099-01-01T00:00:00.000Z"); // a much later clock — must NOT leak into the result
    expect(replay).toEqual(VECTOR.expectedReceiptOnReplay);
  });

  test("the vector's idempotencyKey is the fixed prefix + COLON + eventId (corrected 2026-08-14 02:45)", () => {
    expect(VECTOR.request.idempotencyKey).toBe("livesiang-final-v1:" + VECTOR.request.eventId);
  });
  test("the vector uses the CONFIRMED real producer literals, not the 8f8fbd17 placeholders", () => {
    expect(VECTOR.request.content.event_type).toBe("conversation.user.final");
    expect(VECTOR.request.content.source).toBe("pipecat:1.6.0");
  });
});
