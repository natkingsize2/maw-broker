import { describe, expect, test } from "bun:test";
import {
  ACCEPTED_KIND, ALLOWED_ROUTE, REJECTED_KINDS, SCHEMA,
  FinalEventError, InMemoryFinalEventStore, canonicalize, computeContentDigest,
  handleFinalEvent, loadFinalEventSecrets, validateFinalEventRequest,
  type FinalEventAuth,
} from "../src/final-event-contract";

const AUTH: FinalEventAuth = { authorizedToken: "receipt-secret-abc" };
const HEADER = `Bearer ${AUTH.authorizedToken}`;
const content = { turnId: "t1", sid: "edge:03-canon-1", text: "hello world" };
const digest = computeContentDigest(content);

function goodBody(overrides: Record<string, unknown> = {}) {
  return { schema: SCHEMA, route: ALLOWED_ROUTE, kind: ACCEPTED_KIND, eventId: "evt-1", idempotencyKey: "idem-1", contentDigest: digest, content, ...overrides };
}

describe("canonicalize / computeContentDigest — deterministic regardless of key order", () => {
  test("same object, different key insertion order, same digest", () => {
    const a = { x: 1, y: 2, z: { nested: true, val: "a" } };
    const b = { z: { val: "a", nested: true }, y: 2, x: 1 };
    expect(computeContentDigest(a)).toBe(computeContentDigest(b));
  });
  test("different content, different digest", () => {
    expect(computeContentDigest({ a: 1 })).not.toBe(computeContentDigest({ a: 2 }));
  });
  test("canonicalize handles arrays, null, primitives", () => {
    expect(canonicalize([1, "a", null, true])).toBe('[1,"a",null,true]');
    expect(canonicalize(null)).toBe("null");
  });
});

describe("validateFinalEventRequest — accepts the well-formed request", () => {
  test("valid body passes and returns the typed request", () => {
    const req = validateFinalEventRequest(goodBody());
    expect(req.route).toBe("maw-pipecat");
    expect(req.kind).toBe("final");
  });
});

describe("validateFinalEventRequest — malformed body", () => {
  test("non-object body", () => { expect(() => validateFinalEventRequest("not an object")).toThrow(FinalEventError); });
  test("wrong schema string", () => { expect(() => validateFinalEventRequest(goodBody({ schema: "livesiang.broker.final-event.v2" }))).toThrow("schema must be exactly"); });
  test("missing schema entirely", () => { const b = goodBody(); delete (b as any).schema; expect(() => validateFinalEventRequest(b)).toThrow("schema must be exactly"); });
  test("missing eventId", () => { const b = goodBody(); delete (b as any).eventId; expect(() => validateFinalEventRequest(b)).toThrow("eventId"); });
  test("missing idempotencyKey", () => { const b = goodBody(); delete (b as any).idempotencyKey; expect(() => validateFinalEventRequest(b)).toThrow("idempotencyKey"); });
  test("contentDigest not a valid sha256 hex shape", () => { expect(() => validateFinalEventRequest(goodBody({ contentDigest: "not-hex" }))).toThrow("64-hex-char"); });
  test("missing content key entirely", () => { const b = goodBody(); delete (b as any).content; expect(() => validateFinalEventRequest(b)).toThrow("content missing"); });
  test("eventId longer than the bound is refused, not silently truncated", () => { expect(() => validateFinalEventRequest(goodBody({ eventId: "x".repeat(300) }))).toThrow("eventId"); });
  test("all malformed-body errors carry the MALFORMED_BODY code", () => {
    try { validateFinalEventRequest({}); } catch (e) { expect((e as FinalEventError).code).toBe("MALFORMED_BODY"); }
  });
});

describe("validateFinalEventRequest — unknown route", () => {
  test("any route other than maw-pipecat is rejected", () => {
    for (const route of ["livesiang", "oracle-continuity", "broker-project-router", "", "maw-pipecat ", "MAW-PIPECAT"]) {
      let threw: FinalEventError | undefined;
      try { validateFinalEventRequest(goodBody({ route })); } catch (e) { threw = e as FinalEventError; }
      expect(threw?.code).toBe(route === "" ? "MALFORMED_BODY" : "UNKNOWN_ROUTE"); // empty route is caught by the presence check first
    }
  });
});

describe("validateFinalEventRequest — rejected event kinds", () => {
  test("each explicitly-named rejected kind is refused with the KIND_REJECTED code", () => {
    for (const kind of REJECTED_KINDS) {
      let threw: FinalEventError | undefined;
      try { validateFinalEventRequest(goodBody({ kind })); } catch (e) { threw = e as FinalEventError; }
      expect(threw?.code).toBe("KIND_REJECTED");
      expect(threw?.message).toContain(kind);
    }
  });
  test("an UNLISTED kind (not in REJECTED_KINDS, not 'final') is ALSO refused — fail closed, not an allowlist gap", () => {
    expect(() => validateFinalEventRequest(goodBody({ kind: "system_event_nobody_thought_of" }))).toThrow("rejected");
  });
});

describe("validateFinalEventRequest — content digest integrity", () => {
  test("digest that doesn't match the content is refused (tamper/bug detection, not just idempotency)", () => {
    let threw: FinalEventError | undefined;
    try { validateFinalEventRequest(goodBody({ contentDigest: computeContentDigest({ different: "content" }) })); } catch (e) { threw = e as FinalEventError; }
    expect(threw?.code).toBe("DIGEST_MISMATCH");
  });
});

describe("checkAuth / handleFinalEvent — credential boundary is the FIRST gate", () => {
  test("missing Authorization header is refused before body is even looked at", () => {
    const store = new InMemoryFinalEventStore();
    expect(() => handleFinalEvent(null, "not even valid json shape", store, AUTH)).toThrow(FinalEventError);
    try { handleFinalEvent(null, {}, store, AUTH); } catch (e) { expect((e as FinalEventError).code).toBe("UNAUTHORIZED"); }
  });
  test("wrong token is refused", () => {
    const store = new InMemoryFinalEventStore();
    try { handleFinalEvent("Bearer wrong-token", goodBody(), store, AUTH); } catch (e) { expect((e as FinalEventError).code).toBe("UNAUTHORIZED"); }
  });
  test("a malformed body under a WRONG auth header reports UNAUTHORIZED, never leaking that the body was also bad", () => {
    const store = new InMemoryFinalEventStore();
    try { handleFinalEvent("Bearer wrong", { totally: "wrong shape" }, store, AUTH); } catch (e) { expect((e as FinalEventError).code).toBe("UNAUTHORIZED"); }
  });
});

describe("handleFinalEvent — accept / duplicate / conflict", () => {
  test("first request with a new idempotencyKey is ACCEPTED and stored", () => {
    const store = new InMemoryFinalEventStore();
    const receipt = handleFinalEvent(HEADER, goodBody(), store, AUTH, () => "2026-08-14T01:50:00.000Z");
    expect(receipt).toEqual({ status: "accepted", schema: SCHEMA, route: ALLOWED_ROUTE, eventId: "evt-1", idempotencyKey: "idem-1", contentDigest: digest, receivedAt: "2026-08-14T01:50:00.000Z" });
  });

  test("SAME idempotencyKey + SAME contentDigest replayed later ⇒ DUPLICATE, with the ORIGINAL receivedAt (not a new timestamp)", () => {
    const store = new InMemoryFinalEventStore();
    const first = handleFinalEvent(HEADER, goodBody(), store, AUTH, () => "2026-08-14T01:50:00.000Z");
    const second = handleFinalEvent(HEADER, goodBody(), store, AUTH, () => "2026-08-14T01:55:00.000Z"); // "later" clock
    expect(second.status).toBe("duplicate");
    expect(second.receivedAt).toBe(first.receivedAt); // proves it returned the STORED receipt, not a fresh one
    expect(second.eventId).toBe(first.eventId);
  });

  test("SAME idempotencyKey + DIFFERENT contentDigest ⇒ CONFLICT, original receipt is NOT overwritten", () => {
    const store = new InMemoryFinalEventStore();
    handleFinalEvent(HEADER, goodBody(), store, AUTH, () => "2026-08-14T01:50:00.000Z");
    const differentContent = { turnId: "t1", sid: "edge:03-canon-1", text: "DIFFERENT TEXT ENTIRELY" };
    let threw: FinalEventError | undefined;
    try {
      handleFinalEvent(HEADER, goodBody({ contentDigest: computeContentDigest(differentContent), content: differentContent }), store, AUTH, () => "2026-08-14T01:55:00.000Z");
    } catch (e) { threw = e as FinalEventError; }
    expect(threw?.code).toBe("IDEMPOTENCY_CONFLICT");
    // The original record must still be exactly what it was — a conflict must never mutate it.
    const stillOriginal = store.lookup("idem-1");
    expect(stillOriginal?.contentDigest).toBe(digest);
  });

  test("two DIFFERENT idempotencyKeys for the same content both get their own ACCEPTED receipt (no cross-key interference)", () => {
    const store = new InMemoryFinalEventStore();
    const r1 = handleFinalEvent(HEADER, goodBody({ idempotencyKey: "idem-A" }), store, AUTH);
    const r2 = handleFinalEvent(HEADER, goodBody({ idempotencyKey: "idem-B" }), store, AUTH);
    expect(r1.status).toBe("accepted"); expect(r2.status).toBe("accepted");
    expect(r1.idempotencyKey).not.toBe(r2.idempotencyKey);
  });

  test("kind rejection happens even with correct auth and a real idempotencyKey — never partially recorded", () => {
    const store = new InMemoryFinalEventStore();
    for (const kind of REJECTED_KINDS) {
      expect(() => handleFinalEvent(HEADER, goodBody({ kind, idempotencyKey: `idem-${kind}` }), store, AUTH)).toThrow(FinalEventError);
      expect(store.lookup(`idem-${kind}`)).toBeUndefined(); // nothing recorded for a rejected kind
    }
  });
});

describe("loadFinalEventSecrets — credential loader, isolated third secret", () => {
  test("missing token is refused", () => {
    expect(() => loadFinalEventSecrets({})).toThrow("final-event receipt configuration invalid");
  });
  test("empty-string token is refused", () => {
    expect(() => loadFinalEventSecrets({ MAW_PIPECAT_RECEIPT_TOKEN: "" })).toThrow("final-event receipt configuration invalid");
  });
  test("valid env token loads", () => {
    expect(loadFinalEventSecrets({ MAW_PIPECAT_RECEIPT_TOKEN: "abc" })).toEqual({ authorizedToken: "abc" });
  });
});
