import { describe, expect, test } from "bun:test";
import {
  ACCEPTED_KIND, ALLOWED_ROUTE, CONTENT_EVENT_TYPE, CONTENT_SOURCE, IDEMPOTENCY_KEY_PREFIX, IDEMPOTENCY_KEY_SEPARATOR,
  OBSOLETE_CONTENT_EVENT_TYPE_PLACEHOLDER, OBSOLETE_CONTENT_SOURCE_PLACEHOLDER, REJECTED_KINDS, SCHEMA,
  FinalEventError, InMemoryFinalEventStore, buildIdempotencyKey, canonicalize, computeContentDigest,
  handleFinalEvent, loadFinalEventSecrets, validateFinalEventRequest,
  type FinalEventAuth, type LiveSiangFinalEventContent,
} from "../src/final-event-contract";

const AUTH: FinalEventAuth = { authorizedToken: "receipt-secret-abc" };
const HEADER = `Bearer ${AUTH.authorizedToken}`;

const EVENT_ID = "evt-1";
function goodContent(overrides: Partial<LiveSiangFinalEventContent> = {}): LiveSiangFinalEventContent {
  return {
    conversation_id: "conv-1", event_id: EVENT_ID, event_type: CONTENT_EVENT_TYPE,
    final_text: "hello world", locale: "en-US", occurred_at: "2026-08-14T01:50:00.000Z",
    schema: SCHEMA, source: CONTENT_SOURCE, turn_id: "turn-1", ...overrides,
  };
}
const content = goodContent();
const digest = computeContentDigest(content);
const IDEM_KEY = buildIdempotencyKey(EVENT_ID);

function goodBody(overrides: Record<string, unknown> = {}) {
  return { schema: SCHEMA, route: ALLOWED_ROUTE, kind: ACCEPTED_KIND, eventId: EVENT_ID, idempotencyKey: IDEM_KEY, contentDigest: digest, content, ...overrides };
}
/** For content overrides: recomputes contentDigest to match, so tests exercise the CONTENT-shape
 *  gate, not accidentally trip DIGEST_MISMATCH first. */
function bodyWithContent(contentOverrides: Partial<LiveSiangFinalEventContent> | Record<string, unknown>) {
  const c = { ...content, ...contentOverrides };
  return goodBody({ content: c, contentDigest: computeContentDigest(c) });
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
  test("non-ASCII (Thai) text is NOT escaped to \\uXXXX — raw UTF-8, for cross-language (Python ensure_ascii=False) parity", () => {
    const out = canonicalize({ final_text: "สวัสดี" });
    expect(out).toContain("สวัสดี");
    expect(out).not.toContain("\\u");
  });
});

describe("validateFinalEventRequest — accepts the well-formed request", () => {
  test("valid body passes and returns the typed request with content intact", () => {
    const req = validateFinalEventRequest(goodBody());
    expect(req.route).toBe("maw-pipecat");
    expect(req.kind).toBe("final");
    expect(req.content.conversation_id).toBe("conv-1");
  });
});

describe("validateFinalEventRequest — envelope malformed body", () => {
  test("non-object body", () => { expect(() => validateFinalEventRequest("not an object")).toThrow(FinalEventError); });
  test("wrong schema string", () => { expect(() => validateFinalEventRequest(goodBody({ schema: "livesiang.broker.final-event.v2" }))).toThrow("schema must be exactly"); });
  test("contentDigest not a valid sha256 hex shape", () => { expect(() => validateFinalEventRequest(goodBody({ contentDigest: "not-hex" }))).toThrow("64-hex-char"); });
  test("missing content key entirely", () => { const b = goodBody(); delete (b as any).content; expect(() => validateFinalEventRequest(b)).toThrow("content missing"); });
});

describe("validateFinalEventRequest — unknown route / rejected kind (envelope level, unchanged)", () => {
  test("any route other than maw-pipecat is rejected", () => {
    let threw: FinalEventError | undefined;
    try { validateFinalEventRequest(goodBody({ route: "livesiang" })); } catch (e) { threw = e as FinalEventError; }
    expect(threw?.code).toBe("UNKNOWN_ROUTE");
  });
  test("each explicitly-named rejected kind is refused with KIND_REJECTED", () => {
    for (const kind of REJECTED_KINDS) {
      let threw: FinalEventError | undefined;
      try { validateFinalEventRequest(goodBody({ kind })); } catch (e) { threw = e as FinalEventError; }
      expect(threw?.code).toBe("KIND_REJECTED");
    }
  });
});

describe("validateFinalEventRequest — content digest integrity", () => {
  test("digest that doesn't match the content is refused before content shape is even checked", () => {
    let threw: FinalEventError | undefined;
    try { validateFinalEventRequest(goodBody({ contentDigest: computeContentDigest({ different: "content" }) })); } catch (e) { threw = e as FinalEventError; }
    expect(threw?.code).toBe("DIGEST_MISMATCH");
  });
});

describe("validateFinalEventRequest — content strict key set (owner 2026-08-14 02:18)", () => {
  test("missing a required content key is refused, names it in the message", () => {
    const c = { ...content } as any; delete c.locale;
    const body = goodBody({ content: c, contentDigest: computeContentDigest(c) });
    let threw: FinalEventError | undefined;
    try { validateFinalEventRequest(body); } catch (e) { threw = e as FinalEventError; }
    expect(threw?.code).toBe("CONTENT_REJECTED");
    expect(threw?.message).toContain("locale");
  });
  test("an UNKNOWN extra content key is refused, not silently ignored", () => {
    const c = { ...content, extra_field: "smuggled" } as any;
    const body = goodBody({ content: c, contentDigest: computeContentDigest(c) });
    let threw: FinalEventError | undefined;
    try { validateFinalEventRequest(body); } catch (e) { threw = e as FinalEventError; }
    expect(threw?.code).toBe("CONTENT_REJECTED");
    expect(threw?.message).toContain("extra_field");
  });
  test("the OLD ad-hoc shape (turnId/sid/text) is refused outright — not backward compatible", () => {
    const old = { turnId: "t1", sid: "edge:1", text: "hi" };
    const body = goodBody({ content: old, contentDigest: computeContentDigest(old) });
    expect(() => validateFinalEventRequest(body)).toThrow(/content key set invalid/);
  });
});

describe("validateFinalEventRequest — content literal fields (event_type / source / schema)", () => {
  test("wrong content.event_type is rejected (mirrors raw_audio/partial/assistant_tts style rejection at the content layer)", () => {
    for (const bad of ["raw_audio", "partial", "assistant_tts", "not_final"]) {
      let threw: FinalEventError | undefined;
      try { validateFinalEventRequest(bodyWithContent({ event_type: bad })); } catch (e) { threw = e as FinalEventError; }
      expect(threw?.code).toBe("CONTENT_REJECTED");
      expect(threw?.message).toContain(bad);
    }
  });
  test("wrong content.source is rejected", () => {
    let threw: FinalEventError | undefined;
    try { validateFinalEventRequest(bodyWithContent({ source: "some-other-service" })); } catch (e) { threw = e as FinalEventError; }
    expect(threw?.code).toBe("CONTENT_REJECTED");
  });
  test("wrong content.schema (mismatched version) is rejected", () => {
    let threw: FinalEventError | undefined;
    try { validateFinalEventRequest(bodyWithContent({ schema: "livesiang.broker.final-event.v2" })); } catch (e) { threw = e as FinalEventError; }
    expect(threw?.code).toBe("CONTENT_REJECTED");
  });
  test("empty or oversized final_text is rejected", () => {
    expect(() => validateFinalEventRequest(bodyWithContent({ final_text: "" }))).toThrow(FinalEventError);
    expect(() => validateFinalEventRequest(bodyWithContent({ final_text: "x".repeat(5000) }))).toThrow(FinalEventError);
  });
  test("malformed occurred_at (not ISO8601 UTC) is rejected", () => {
    expect(() => validateFinalEventRequest(bodyWithContent({ occurred_at: "yesterday" }))).toThrow(FinalEventError);
    expect(() => validateFinalEventRequest(bodyWithContent({ occurred_at: "2026-08-14" }))).toThrow(FinalEventError); // date-only, no time
  });
});

describe("validateFinalEventRequest — cross-field rules (owner 2026-08-14 02:18)", () => {
  test("eventId must equal content.event_id — mismatch is refused with EVENT_ID_MISMATCH", () => {
    const body = goodBody({ eventId: "evt-DIFFERENT" }); // idempotencyKey now also mismatches format, but event-id check runs first
    let threw: FinalEventError | undefined;
    try { validateFinalEventRequest(body); } catch (e) { threw = e as FinalEventError; }
    expect(threw?.code).toBe("EVENT_ID_MISMATCH");
  });
  test("idempotencyKey must equal the fixed prefix + COLON + eventId (corrected 2026-08-14 02:45 — owner named the colon explicitly)", () => {
    expect(IDEMPOTENCY_KEY_SEPARATOR).toBe(":");
    expect(IDEM_KEY).toBe("livesiang-final-v1:evt-1");
    let threw: FinalEventError | undefined;
    try { validateFinalEventRequest(goodBody({ idempotencyKey: "livesiang-final-v1evt-1" })); } catch (e) { threw = e as FinalEventError; } // the OLD (02:18) no-colon format
    expect(threw?.code).toBe("IDEMPOTENCY_KEY_FORMAT");
    expect(threw?.message).toContain(IDEM_KEY);
  });
  test("REJECTED: the OLD no-colon idempotencyKey format from the 8f8fbd17 placeholder round no longer validates", () => {
    const oldFormatKey = IDEMPOTENCY_KEY_PREFIX + EVENT_ID; // "livesiang-final-v1evt-1", no separator
    expect(oldFormatKey).not.toBe(IDEM_KEY);
    let threw: FinalEventError | undefined;
    try { validateFinalEventRequest(goodBody({ idempotencyKey: oldFormatKey })); } catch (e) { threw = e as FinalEventError; }
    expect(threw?.code).toBe("IDEMPOTENCY_KEY_FORMAT");
  });
  test("correct idempotencyKey for a different eventId is accepted on its own terms", () => {
    const c2 = goodContent({ event_id: "evt-2" });
    const body = { schema: SCHEMA, route: ALLOWED_ROUTE, kind: ACCEPTED_KIND, eventId: "evt-2", idempotencyKey: buildIdempotencyKey("evt-2"), contentDigest: computeContentDigest(c2), content: c2 };
    const req = validateFinalEventRequest(body);
    expect(req.eventId).toBe("evt-2");
  });
});

describe("REJECTED: the OLD 8f8fbd17 placeholder literals no longer validate (owner corrected 2026-08-14 02:45)", () => {
  test("content.event_type = \"final\" (old placeholder) is now refused — real value is \"conversation.user.final\"", () => {
    let threw: FinalEventError | undefined;
    try { validateFinalEventRequest(bodyWithContent({ event_type: OBSOLETE_CONTENT_EVENT_TYPE_PLACEHOLDER })); } catch (e) { threw = e as FinalEventError; }
    expect(threw?.code).toBe("CONTENT_REJECTED");
    expect(OBSOLETE_CONTENT_EVENT_TYPE_PLACEHOLDER).not.toBe(CONTENT_EVENT_TYPE);
  });
  test("content.source = \"maw-pipecat\" (old placeholder, same string as the route name) is now refused — real value is \"pipecat:1.6.0\"", () => {
    let threw: FinalEventError | undefined;
    try { validateFinalEventRequest(bodyWithContent({ source: OBSOLETE_CONTENT_SOURCE_PLACEHOLDER })); } catch (e) { threw = e as FinalEventError; }
    expect(threw?.code).toBe("CONTENT_REJECTED");
    expect(OBSOLETE_CONTENT_SOURCE_PLACEHOLDER).not.toBe(CONTENT_SOURCE);
    expect(OBSOLETE_CONTENT_SOURCE_PLACEHOLDER).toBe(ALLOWED_ROUTE); // confirms it WAS the route-name-reuse guess
  });
  test("the CORRECT real producer literals are accepted", () => {
    const req = validateFinalEventRequest(bodyWithContent({ event_type: CONTENT_EVENT_TYPE, source: CONTENT_SOURCE }));
    expect(req.content.event_type).toBe("conversation.user.final");
    expect(req.content.source).toBe("pipecat:1.6.0");
  });
});

describe("checkAuth / handleFinalEvent — credential boundary is the FIRST gate", () => {
  test("missing Authorization header is refused before body is even looked at", () => {
    const store = new InMemoryFinalEventStore();
    try { handleFinalEvent(null, {}, store, AUTH); } catch (e) { expect((e as FinalEventError).code).toBe("UNAUTHORIZED"); }
  });
  test("wrong token is refused", () => {
    const store = new InMemoryFinalEventStore();
    try { handleFinalEvent("Bearer wrong-token", goodBody(), store, AUTH); } catch (e) { expect((e as FinalEventError).code).toBe("UNAUTHORIZED"); }
  });
});

describe("handleFinalEvent — accept / duplicate / conflict", () => {
  test("first request with a new idempotencyKey is ACCEPTED and stored", () => {
    const store = new InMemoryFinalEventStore();
    const receipt = handleFinalEvent(HEADER, goodBody(), store, AUTH, () => "2026-08-14T01:50:00.000Z");
    expect(receipt).toEqual({ status: "accepted", schema: SCHEMA, route: ALLOWED_ROUTE, eventId: EVENT_ID, idempotencyKey: IDEM_KEY, contentDigest: digest, receivedAt: "2026-08-14T01:50:00.000Z" });
  });

  test("SAME idempotencyKey + SAME contentDigest replayed later ⇒ DUPLICATE, with the ORIGINAL receivedAt", () => {
    const store = new InMemoryFinalEventStore();
    const first = handleFinalEvent(HEADER, goodBody(), store, AUTH, () => "2026-08-14T01:50:00.000Z");
    const second = handleFinalEvent(HEADER, goodBody(), store, AUTH, () => "2026-08-14T01:55:00.000Z");
    expect(second.status).toBe("duplicate");
    expect(second.receivedAt).toBe(first.receivedAt);
  });

  test("SAME idempotencyKey + DIFFERENT contentDigest ⇒ CONFLICT, original receipt is NOT overwritten", () => {
    const store = new InMemoryFinalEventStore();
    handleFinalEvent(HEADER, goodBody(), store, AUTH, () => "2026-08-14T01:50:00.000Z");
    const differentText = goodContent({ final_text: "DIFFERENT TEXT ENTIRELY" });
    let threw: FinalEventError | undefined;
    try {
      handleFinalEvent(HEADER, goodBody({ contentDigest: computeContentDigest(differentText), content: differentText }), store, AUTH, () => "2026-08-14T01:55:00.000Z");
    } catch (e) { threw = e as FinalEventError; }
    expect(threw?.code).toBe("IDEMPOTENCY_CONFLICT");
    const stillOriginal = store.lookup(IDEM_KEY);
    expect(stillOriginal?.contentDigest).toBe(digest);
  });

  test("content-layer rejection happens even with correct auth — never partially recorded", () => {
    const store = new InMemoryFinalEventStore();
    expect(() => handleFinalEvent(HEADER, bodyWithContent({ event_type: "partial" }), store, AUTH)).toThrow(FinalEventError);
    expect(store.lookup(IDEM_KEY)).toBeUndefined();
  });
});

describe("loadFinalEventSecrets — credential loader, isolated third secret", () => {
  test("missing token is refused", () => {
    expect(() => loadFinalEventSecrets({})).toThrow("final-event receipt configuration invalid");
  });
  test("valid env token loads", () => {
    expect(loadFinalEventSecrets({ MAW_PIPECAT_RECEIPT_TOKEN: "abc" })).toEqual({ authorizedToken: "abc" });
  });
});
