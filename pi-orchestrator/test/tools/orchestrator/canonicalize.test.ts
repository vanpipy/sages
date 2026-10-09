/**
 * canonicalize tests — extracted shared canonicalization helper.
 *
 * The same algorithm was previously duplicated in two places with a
 * critical divergence:
 *   - pi-orchestrator/src/goal-lock.ts:canonicalize() — skips `undefined`
 *     recursively (per GC-2026-091, "undefined values are skipped
 *     recursively (not just at the top level)")
 *   - pi-orchestrator/src/chain-key.ts:canonicalJSON() — does NOT skip
 *     `undefined`; would serialize as `"undefined"` literal via
 *     `JSON.stringify(undefined)` → string "undefined" leaking into
 *     the canonical form
 *
 * The unified canonicalize() module reconciles these by always skipping
 * `undefined` recursively (the correct, GC-2026-091-mandated behavior)
 * and serves as the single source of truth for both goal-lock.ts and
 * chain-key.ts callers.
 *
 * Covers:
 *  - primitives (string/number/boolean/null)
 *  - arrays preserve order (positional semantics)
 *  - objects sort keys at every level
 *  - nested composition
 *  - empty objects and arrays
 *  - undefined skipping (recursive — the latent bug fix)
 *  - determinism
 */

import { describe, it, expect } from "bun:test";
import { canonicalize } from "@/canonicalize.js";

describe("canonicalize: primitives", () => {
  it("P-01: string primitives serialize as their JSON string form", () => {
    expect(canonicalize("hello")).toBe(JSON.stringify("hello"));
    expect(canonicalize("")).toBe(JSON.stringify(""));
  });

  it("P-02: number primitives serialize as their JSON number form", () => {
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize(0)).toBe("0");
    expect(canonicalize(-1.5)).toBe("-1.5");
  });

  it("P-03: boolean primitives serialize as their JSON boolean form", () => {
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
  });

  it("P-04: null serializes as JSON null", () => {
    expect(canonicalize(null)).toBe("null");
  });
});

describe("canonicalize: arrays preserve order (positional semantics)", () => {
  it("A-01: arrays preserve element order", () => {
    expect(canonicalize([1, 2, 3])).toBe("[1,2,3]");
  });

  it("A-02: arrays with different orders produce different output", () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it("A-03: empty arrays produce stable output", () => {
    expect(canonicalize([])).toBe("[]");
  });
});

describe("canonicalize: objects sort keys at every level", () => {
  it("O-01: object keys are sorted", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("O-02: nested object keys are sorted at every level", () => {
    expect(canonicalize({ b: { d: 4, c: 3 }, a: 1 })).toBe('{"a":1,"b":{"c":3,"d":4}}');
  });

  it("O-03: objects with different key orders produce the same canonical form", () => {
    const a = { x: 1, y: 2 };
    const b = { y: 2, x: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("O-04: empty objects produce stable output", () => {
    expect(canonicalize({})).toBe("{}");
  });
});

describe("canonicalize: nested composition", () => {
  it("N-01: nested arrays + objects compose correctly", () => {
    expect(canonicalize([{ b: 1, a: 2 }, { d: 4, c: 3 }])).toBe(
      '[{"a":2,"b":1},{"c":3,"d":4}]',
    );
  });

  it("N-02: deeply nested structures preserve relative order within arrays", () => {
    const input = { z: [{ y: 1, x: 2 }, { w: 3, v: 4 }], a: "end" };
    expect(canonicalize(input)).toBe(
      '{"a":"end","z":[{"x":2,"y":1},{"v":4,"w":3}]}',
    );
  });
});

describe("canonicalize: undefined skipping (GC-2026-091, latent bug fix)", () => {
  it("U-01: undefined at top level produces an empty string", () => {
    expect(canonicalize(undefined)).toBe("");
  });

  it("U-02: undefined object value skips that key entirely", () => {
    expect(canonicalize({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it("U-03: undefined is skipped recursively inside nested objects", () => {
    expect(canonicalize({ a: { b: 1, c: undefined, d: 3 }, e: 2 })).toBe(
      '{"a":{"b":1,"d":3},"e":2}',
    );
  });

  it("U-04: undefined inside arrays is also skipped recursively", () => {
    // Arrays preserve positional order; undefined elements become ""
    // and JSON.stringify joins with comma. The element position is
    // preserved (we do NOT compact undefined elements out of arrays —
    // that would change positional semantics).
    expect(canonicalize([1, undefined, 3])).toBe("[1,,3]");
  });

  it("U-05: an object containing only undefined values produces an empty object", () => {
    expect(canonicalize({ a: undefined, b: undefined })).toBe("{}");
  });
});

describe("canonicalize: determinism + collision-resistance", () => {
  it("D-01: same input produces same output (deterministic)", () => {
    const input = { a: 1, b: [1, 2, { c: 3 }] };
    expect(canonicalize(input)).toBe(canonicalize(input));
  });

  it("D-02: different value types with same shape produce different output", () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: "1" }));
    expect(canonicalize([1])).not.toBe(canonicalize(["1"]));
  });

  it("D-03: string-key collisions across object boundaries produce distinct forms", () => {
    // {"ab":1,"c":2} vs {"a":1,"bc":2} — different keys → different canonical
    expect(canonicalize({ "ab": 1, "c": 2 })).not.toBe(
      canonicalize({ "a": 1, "bc": 2 }),
    );
  });
});
