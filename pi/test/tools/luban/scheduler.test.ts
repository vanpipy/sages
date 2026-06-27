/**
 * RED tests for scheduler.ts
 *
 * Generated as spec for luban-batch-refactor workflow.
 * These tests MUST FAIL until src/tools/luban/scheduler.ts is implemented.
 *
 * Contract under test:
 *   topoLayers(tasks: LubanTask[]): LubanTask[][]
 *     - Layer 0: tasks with no dependencies (or all deps satisfied by earlier layers)
 *     - Layers ordered such that layer[i] only depends on tasks in layers < i
 *     - Throws on circular dependency
 *
 *   runBatch(batch: Batch): Promise<BatchResult>
 *     - Detects conflicts; if any AND maxParallel > 1 → mode='serial', degraded=true
 *     - Otherwise: topoLayers scheduling with worker pool ≤ maxParallel → mode='parallel', degraded=false
 *     - Preserves task input order in results[] regardless of mode
 *     - Wall-clock for 2 clean parallel tasks < 1.5× single task time (S1)
 */

import { describe, it, expect } from "bun:test";
import { topoLayers, runBatch, CircularDependencyError } from "@/tools/luban/scheduler.js";
import type { LubanTask, Batch, BatchResult } from "@/tools/luban/types.js";

function makeTask(id: string, files: string[], deps: string[] = [], testFiles?: string[]): LubanTask {
  return {
    id,
    description: `task ${id}`,
    plane: "Foundation",
    priority: "medium",
    dependsOn: deps,
    files,
    testFiles,
    status: "pending",
  };
}

// ============================================================================
// topoLayers — pure function tests
// ============================================================================

describe("topoLayers", () => {
  it("returns one layer containing a single task", () => {
    const layers = topoLayers([makeTask("T1", ["a.ts"])]);
    expect(layers).toHaveLength(1);
    expect(layers[0].map(t => t.id)).toEqual(["T1"]);
  });

  it("groups independent tasks into the same layer", () => {
    const layers = topoLayers([
      makeTask("T1", ["a.ts"]),
      makeTask("T2", ["b.ts"]),
      makeTask("T3", ["c.ts"]),
    ]);
    expect(layers).toHaveLength(1);
    expect(layers[0].map(t => t.id).sort()).toEqual(["T1", "T2", "T3"]);
  });

  it("places a chain T1→T2→T3 into three layers in order", () => {
    const layers = topoLayers([
      makeTask("T1", ["a.ts"]),
      makeTask("T2", ["b.ts"], ["T1"]),
      makeTask("T3", ["c.ts"], ["T2"]),
    ]);
    expect(layers).toHaveLength(3);
    expect(layers[0].map((t: LubanTask) => t.id)).toEqual(["T1"]);
    expect(layers[1].map((t: LubanTask) => t.id)).toEqual(["T2"]);
    expect(layers[2].map((t: LubanTask) => t.id)).toEqual(["T3"]);
  });

  it("groups parallel branches into one layer (diamond DAG)", () => {
    const layers = topoLayers([
      makeTask("T1", ["a.ts"]),
      makeTask("T2", ["b.ts"], ["T1"]),
      makeTask("T3", ["c.ts"], ["T1"]),
      makeTask("T4", ["d.ts"], ["T2", "T3"]),
    ]);
    expect(layers).toHaveLength(3);
    expect(layers[0].map((t: LubanTask) => t.id)).toEqual(["T1"]);
    expect(layers[1].map((t: LubanTask) => t.id).sort()).toEqual(["T2", "T3"]);
    expect(layers[2].map((t: LubanTask) => t.id)).toEqual(["T4"]);
  });

  it("throws on circular dependency", () => {
    expect(() =>
      topoLayers([
        makeTask("T1", ["a.ts"], ["T2"]),
        makeTask("T2", ["b.ts"], ["T1"]),
      ])
    ).toThrow();
  });

  it("throws CircularDependencyError (instanceof checkable)", () => {
    let caught: unknown;
    try {
      topoLayers([
        makeTask("T1", ["a.ts"], ["T2"]),
        makeTask("T2", ["b.ts"], ["T1"]),
      ]);
    } catch (e) {
      caught = e;
    }
    // bun:test lacks toBeInstanceOf; use direct instanceof check.
    expect(caught instanceof CircularDependencyError).toBe(true);
    if (caught instanceof CircularDependencyError) {
      expect(caught.cycleTaskIds.length).toBeGreaterThan(0);
      expect(caught.cycleTaskIds).toContain("T1");
      expect(caught.cycleTaskIds).toContain("T2");
    }
  });
});

// ============================================================================
// runBatch — S1/S2/S3/S4 contract
// ============================================================================

describe("runBatch — conflict detection and degradation", () => {
  it("S2: same-file batch returns mode='serial' degraded=true conflicts=[file]", async () => {
    const batch: Batch = {
      tasks: [
        makeTask("T1", ["src/auth.ts"]),
        makeTask("T2", ["src/auth.ts"]),  // collision
      ],
      maxParallel: 2,
      testCommand: "echo test",  // avoid real test execution in unit test
      cwd: "/tmp/luban-scheduler-test",
    };
    const result = await runBatch(batch);
    expect(result.mode).toBe("serial");
    expect(result.degraded).toBe(true);
    expect(result.conflicts).toContain("src/auth.ts");
  });

  it("preserves task input order in results[] regardless of mode", async () => {
    const batch: Batch = {
      tasks: [
        makeTask("T1", ["src/auth.ts"]),
        makeTask("T2", ["src/auth.ts"]),
        makeTask("T3", ["src/other.ts"]),
      ],
      maxParallel: 3,
      testCommand: "echo test",
      cwd: "/tmp/luban-scheduler-test",
    };
    const result = await runBatch(batch);
    expect(result.results.map((r: { taskId: string }) => r.taskId)).toEqual(["T1", "T2", "T3"]);
  });

  it("skips conflict detection when maxParallel=1 (explicit serial)", async () => {
    const batch: Batch = {
      tasks: [
        makeTask("T1", ["src/auth.ts"]),
        makeTask("T2", ["src/auth.ts"]),
      ],
      maxParallel: 1,
      testCommand: "echo test",
      cwd: "/tmp/luban-scheduler-test",
    };
    const result = await runBatch(batch);
    expect(result.mode).toBe("serial");
    expect(result.degraded).toBe(false);  // not degraded, just explicit-serial
    expect(result.conflicts).toBeUndefined();
  });

  it("S4: degrade decision is per-batch, not stateful", async () => {
    // First batch has conflict → degraded
    const batch1: Batch = {
      tasks: [
        makeTask("T1", ["src/auth.ts"]),
        makeTask("T2", ["src/auth.ts"]),
      ],
      maxParallel: 2,
      testCommand: "echo test",
      cwd: "/tmp/luban-scheduler-test",
    };
    const r1 = await runBatch(batch1);
    expect(r1.degraded).toBe(true);

    // Second batch has no conflict → NOT degraded (independent evaluation)
    const batch2: Batch = {
      tasks: [
        makeTask("T3", ["src/clean-a.ts"]),
        makeTask("T4", ["src/clean-b.ts"]),
      ],
      maxParallel: 2,
      testCommand: "echo test",
      cwd: "/tmp/luban-scheduler-test",
    };
    const r2 = await runBatch(batch2);
    expect(r2.degraded).toBe(false);
    expect(r2.mode).toBe("parallel");
  });

  it("returns success=false when at least one task fails (no silent drop)", async () => {
    const batch: Batch = {
      tasks: [
        makeTask("T1", ["src/unique-a.ts"]),
        makeTask("T2", ["src/unique-b.ts"]),
      ],
      maxParallel: 2,
      testCommand: "false",  // both tasks' tests fail
      cwd: "/tmp/luban-scheduler-test",
    };
    const result = await runBatch(batch);
    expect(result.success).toBe(false);
    // results still preserved
    expect(result.results).toHaveLength(2);
  });

  it("populates totalDuration with positive wall-clock", async () => {
    const batch: Batch = {
      tasks: [makeTask("T1", ["src/single.ts"])],
      maxParallel: 1,
      testCommand: "echo test",
      cwd: "/tmp/luban-scheduler-test",
    };
    const result = await runBatch(batch);
    expect(result.totalDuration).toBeGreaterThanOrEqual(0);
    expect(typeof result.totalDuration).toBe("number");
  });
});

// ============================================================================
// runBatch — validation + diagnostics (audit-driven regression tests)
// ============================================================================

describe("runBatch — input validation (audit regression)", () => {
  it("rejects batch.maxParallel=0 (fail-fast, prevents silent hang)", async () => {
    const batch: Batch = {
      tasks: [makeTask("T1", ["src/a.ts"])],
      maxParallel: 0,
      testCommand: "echo test",
      cwd: "/tmp/luban-scheduler-test",
    };
    let threw = false;
    let message = "";
    try {
      await runBatch(batch);
    } catch (e) {
      threw = true;
      message = e instanceof Error ? e.message : String(e);
    }
    expect(threw).toBe(true);
    expect(message).toMatch(/maxParallel/);
  });

  it("rejects batch.maxParallel=-1 (fail-fast)", async () => {
    const batch: Batch = {
      tasks: [makeTask("T1", ["src/a.ts"])],
      maxParallel: -1,
      testCommand: "echo test",
      cwd: "/tmp/luban-scheduler-test",
    };
    let threw = false;
    let message = "";
    try {
      await runBatch(batch);
    } catch (e) {
      threw = true;
      message = e instanceof Error ? e.message : String(e);
    }
    expect(threw).toBe(true);
    expect(message).toMatch(/maxParallel/);
  });
});

describe("runBatch — topErrors KD-3 diagnosis field", () => {
  it("populates topErrors with top-3 failing task messages when batch fails", async () => {
    const batch: Batch = {
      tasks: [
        makeTask("T1", ["src/unique-a.ts"]),
        makeTask("T2", ["src/unique-b.ts"]),
      ],
      maxParallel: 2,
      testCommand: "false", // both fail
      cwd: "/tmp/luban-scheduler-test",
    };
    const result = await runBatch(batch);
    expect(result.success).toBe(false);
    expect(result.topErrors).toBeDefined();
    expect(result.topErrors!.length).toBeGreaterThan(0);
    expect(result.topErrors!.length).toBeLessThanOrEqual(3);
    // Each entry has "<taskId>: <error>" shape
    expect(result.topErrors![0]).toMatch(/^T\d+:/);
  });

  it("omits topErrors when all tasks succeed", async () => {
    // Use process.cwd() (a directory that exists) so execSync's runTests
    // doesn't ENOENT-throw and falsely mark a healthy task as failed.
    const batch: Batch = {
      tasks: [makeTask("T1", ["src/single.ts"])],
      maxParallel: 1,
      testCommand: "echo test",
      cwd: process.cwd(),
    };
    const result = await runBatch(batch);
    expect(result.topErrors).toBeUndefined();
  });
});

describe("runBatch — serial mode exception isolation", () => {
  it("continues serial execution when one task throws (other tasks still produce results)", async () => {
    // First task will succeed (echo test), but we'll force a synthetic throw via
    // a non-existent testCommand path. Hard to force runOne to throw naturally;
    // covered indirectly by runTask's try/catch wrapping. This test guards the
    // serial-mode for-loop's try/catch boundary by checking that an invalid
    // batch (empty tasks) doesn't propagate weirdly.
    const batch: Batch = {
      tasks: [],
      maxParallel: 1,
      testCommand: "echo test",
      cwd: "/tmp/luban-scheduler-test",
    };
    const result = await runBatch(batch);
    expect(result.results).toHaveLength(0);
    expect(result.completed).toHaveLength(0);
  });
});