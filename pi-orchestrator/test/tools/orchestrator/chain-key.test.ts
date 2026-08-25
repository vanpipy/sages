/**
 * chain-key.ts tests — GC-2026-059
 *
 * Covers:
 *  - canonicalJSON: order-independent, handles primitives / arrays / nested objects / null
 *  - chainKey: stable across order, distinct on different inputs
 *  - chainCountMap: counts per chain-key, max detection
 */

import { describe, it, expect } from "bun:test";
import {
  canonicalJSON,
  chainKey,
  tallyChainCounts,
  findMaxChain,
  chainCountAtLeast,
} from "@/chain-key.js";

describe("chain-key: canonicalJSON (GC-2026-059)", () => {
  it("K-01: primitives serialize as their JSON representation", () => {
    expect(canonicalJSON(null)).toBe("null");
    // Note: JSON.stringify(undefined) returns undefined (not a string). The
    // function passes through, so the test asserts that passthrough.
    expect(canonicalJSON(undefined as any)).toBe(undefined as any);
    expect(canonicalJSON(true)).toBe("true");
    expect(canonicalJSON(false)).toBe("false");
    expect(canonicalJSON(42)).toBe("42");
    expect(canonicalJSON("hello")).toBe('"hello"');
    expect(canonicalJSON("")).toBe('""');
  });

  it("K-02: objects with different key order produce same canonical form", () => {
    const a = canonicalJSON({ a: 1, b: 2, c: 3 });
    const b = canonicalJSON({ c: 3, a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("K-03: nested objects are sorted at every level", () => {
    const a = canonicalJSON({ outer: { z: 1, a: 2 }, top: 0 });
    const b = canonicalJSON({ top: 0, outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it("K-04: arrays preserve order (positional semantics)", () => {
    const a = canonicalJSON({ arr: [1, 2, 3] });
    const b = canonicalJSON({ arr: [3, 2, 1] });
    expect(a).not.toBe(b);
  });

  it("K-05: nested arrays + objects compose correctly", () => {
    const a = canonicalJSON({ items: [{ x: 1 }, { y: 2 }] });
    const b = canonicalJSON({ items: [{ x: 1 }, { y: 2 }] });
    expect(a).toBe(b);
  });

  it("K-06: different value types with same key order produce different output", () => {
    expect(canonicalJSON({ a: 1 })).not.toBe(canonicalJSON({ a: "1" }));
    expect(canonicalJSON({ a: 1 })).not.toBe(canonicalJSON({ a: true }));
  });

  it("K-07: empty objects and arrays produce stable output", () => {
    expect(canonicalJSON({})).toBe("{}");
    expect(canonicalJSON([])).toBe("[]");
  });

  it("K-08: nested arrays inside objects are sorted only at object level", () => {
    const a = canonicalJSON({ items: [3, 1, 2] });
    const b = canonicalJSON({ items: [1, 2, 3] });
    expect(a).not.toBe(b);
  });

  it("K-09: deeply nested structures preserve relative order within arrays", () => {
    const a = canonicalJSON({ x: [{ y: [{ z: 1, a: 2 }] }] });
    const b = canonicalJSON({ x: [{ y: [{ a: 2, z: 1 }] }] });
    expect(a).toBe(b);
  });

  it("K-10: returns deterministic output for same input", () => {
    const input = { x: 1, y: [2, 3], z: { a: "foo", b: false } };
    expect(canonicalJSON(input)).toBe(canonicalJSON(input));
  });
});

describe("chain-key: chainKey (GC-2026-059)", () => {
  it("C-01: stable across order (uses canonicalJSON internally)", () => {
    expect(chainKey("read", { a: 1, b: 2 })).toBe(chainKey("read", { b: 2, a: 1 }));
  });

  it("C-02: distinct on different toolName", () => {
    expect(chainKey("read", { path: "/a" })).not.toBe(chainKey("write", { path: "/a" }));
  });

  it("C-03: distinct on different args (even with same shape)", () => {
    expect(chainKey("read", { path: "/a" })).not.toBe(chainKey("read", { path: "/b" }));
  });

  it("C-04: produces a string (the chain-key identifier)", () => {
    const k = chainKey("dag_synthesize", { goal_id: "GC-X" });
    expect(typeof k).toBe("string");
    expect(k.length).toBeGreaterThan(0);
  });

  it("C-05: nested args canonicalize", () => {
    expect(
      chainKey("dag_synthesize", { goal_id: "GC-X", refine: { hint: "expand scope" } }),
    ).toBe(
      chainKey("dag_synthesize", { refine: { hint: "expand scope" }, goal_id: "GC-X" }),
    );
  });
});

describe("chain-key: tallyChainCounts (GC-2026-059)", () => {
  it("T-01: empty array produces empty counts", () => {
    const counts = tallyChainCounts([]);
    expect(counts.size).toBe(0);
  });

  it("T-02: counts identical calls under same chain-key", () => {
    const counts = tallyChainCounts([
      { toolName: "read", input: { path: "/a" } },
      { toolName: "read", input: { path: "/a" } },
      { toolName: "read", input: { path: "/a" } },
    ]);
    expect(counts.size).toBe(1);
    const entries = Array.from(counts.values());
    expect(entries[0]?.count).toBe(3);
  });

  it("T-03: different args produce separate chain-keys", () => {
    const counts = tallyChainCounts([
      { toolName: "read", input: { path: "/a" } },
      { toolName: "read", input: { path: "/b" } },
      { toolName: "read", input: { path: "/c" } },
    ]);
    expect(counts.size).toBe(3);
  });

  it("T-04: same args, different toolName → separate chain-keys", () => {
    const counts = tallyChainCounts([
      { toolName: "read", input: { path: "/a" } },
      { toolName: "bash", input: { path: "/a" } },
    ]);
    expect(counts.size).toBe(2);
  });

  it("T-05: object key order does NOT affect counts", () => {
    const counts = tallyChainCounts([
      { toolName: "dag_synthesize", input: { goal_id: "GC-1", refine: "a" } },
      { toolName: "dag_synthesize", input: { refine: "a", goal_id: "GC-1" } },
      { toolName: "dag_synthesize", input: { goal_id: "GC-1", refine: "a" } },
    ]);
    expect(counts.size).toBe(1);
    expect(Array.from(counts.values())[0]?.count).toBe(3);
  });

  it("T-06: tracks totalCalls (not just unique chains)", () => {
    const counts = tallyChainCounts([
      { toolName: "read", input: { path: "/a" } },
      { toolName: "read", input: { path: "/b" } },
      { toolName: "read", input: { path: "/a" } },
    ]);
    const total = Array.from(counts.values()).reduce((s, e) => s + e.count, 0);
    expect(total).toBe(3);
    expect(counts.size).toBe(2);
  });
});

describe("chain-key: findMaxChain (GC-2026-059)", () => {
  it("M-01: returns null on empty map", () => {
    expect(findMaxChain(new Map())).toBeNull();
  });

  it("M-02: returns the highest-count chain", () => {
    const counts = new Map<string, { count: number; sample: { toolName: string; input: Record<string, unknown> } }>([
      ["a", { count: 3, sample: { toolName: "read", input: { path: "/a" } } }],
      ["b", { count: 5, sample: { toolName: "read", input: { path: "/b" } } }],
      ["c", { count: 2, sample: { toolName: "bash", input: { command: "ls" } } }],
    ]);
    const top = findMaxChain(counts);
    expect(top?.count).toBe(5);
    expect(top?.sample.input).toEqual({ path: "/b" });
  });

  it("M-03: returns first match on tie (Map iteration order)", () => {
    const counts = new Map<string, { count: number; sample: { toolName: string; input: Record<string, unknown> } }>([
      ["first", { count: 3, sample: { toolName: "read", input: { x: 1 } } }],
      ["second", { count: 3, sample: { toolName: "read", input: { x: 2 } } }],
    ]);
    const top = findMaxChain(counts);
    expect(top?.sample.input).toEqual({ x: 1 });
  });
});

describe("chain-key: chainCountAtLeast (GC-2026-059)", () => {
  it("A-01: returns true when any chain meets threshold", () => {
    const counts = new Map<string, { count: number; sample: { toolName: string; input: Record<string, unknown> } }>([
      ["a", { count: 1, sample: { toolName: "read", input: { x: 1 } } }],
      ["b", { count: 5, sample: { toolName: "read", input: { x: 2 } } }],
    ]);
    expect(chainCountAtLeast(counts, 5)).toBe(true);
  });

  it("A-02: returns false when no chain meets threshold", () => {
    const counts = new Map<string, { count: number; sample: { toolName: string; input: Record<string, unknown> } }>([
      ["a", { count: 2, sample: { toolName: "read", input: { x: 1 } } }],
      ["b", { count: 3, sample: { toolName: "read", input: { x: 2 } } }],
    ]);
    expect(chainCountAtLeast(counts, 5)).toBe(false);
  });
});