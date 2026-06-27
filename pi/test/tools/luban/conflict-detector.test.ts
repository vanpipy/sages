/**
 * RED tests for conflict-detector.ts
 *
 * Generated as spec for luban-batch-refactor workflow.
 * These tests MUST FAIL until src/tools/luban/conflict-detector.ts is implemented.
 *
 * Contract under test:
 *   detectFileConflicts(tasks: LubanTask[]): ConflictReport
 *   - Pure function (no I/O, no side effects, deterministic)
 *   - Considers BOTH sourceFiles and testFiles as conflict surface (S5)
 *   - Returns empty conflicts when no overlaps; lists all conflicting paths
 */

import { describe, it, expect } from "bun:test";
import { detectFileConflicts } from "@/tools/luban/conflict-detector.js";
import type { LubanTask, ConflictReport } from "@/tools/luban/types.js";

// Minimal factory — only fields the detector needs.
function makeTask(id: string, files: string[], testFiles?: string[]): LubanTask {
  return {
    id,
    description: "",
    plane: "Foundation",
    priority: "medium",
    dependsOn: [],
    files,
    testFiles,
    status: "pending",
  };
}

describe("detectFileConflicts — S6 pure function contract", () => {
  it("returns empty conflicts for empty task list", () => {
    const report = detectFileConflicts([]);
    expect(report.conflicts).toEqual([]);
    expect(report.owners.size).toBe(0);
  });

  it("returns empty conflicts for a single task (no overlap possible)", () => {
    const report = detectFileConflicts([makeTask("T1", ["src/a.ts"])]);
    expect(report.conflicts).toEqual([]);
    // owners records ALL file→task mappings, not just conflicts
    expect(report.owners.size).toBe(1);
    expect(report.owners.get("src/a.ts")).toEqual(["T1"]);
  });

  it("returns empty conflicts for two tasks with disjoint source files", () => {
    const report = detectFileConflicts([
      makeTask("T1", ["src/a.ts"]),
      makeTask("T2", ["src/b.ts"]),
    ]);
    expect(report.conflicts).toEqual([]);
    expect(report.owners.size).toBe(2);
    expect(report.owners.get("src/a.ts")).toEqual(["T1"]);
    expect(report.owners.get("src/b.ts")).toEqual(["T2"]);
  });

  it("detects conflict when two tasks share the same source file", () => {
    const report = detectFileConflicts([
      makeTask("T1", ["src/auth.ts"]),
      makeTask("T2", ["src/auth.ts"]),
    ]);
    expect(report.conflicts).toContain("src/auth.ts");
    expect(report.owners.get("src/auth.ts")).toEqual(["T1", "T2"]);
  });

  it("detects conflict when source file of T1 collides with test file of T2 (S5)", () => {
    const report = detectFileConflicts([
      makeTask("T1", ["src/auth.ts"]),
      makeTask("T2", ["src/other.ts"], ["src/auth.ts"]),  // test file collides
    ]);
    expect(report.conflicts).toContain("src/auth.ts");
  });

  it("is pure: calling twice with the same input returns structurally equal output", () => {
    const tasks = [
      makeTask("T1", ["src/auth.ts"]),
      makeTask("T2", ["src/auth.ts"]),
    ];
    const r1 = detectFileConflicts(tasks);
    const r2 = detectFileConflicts(tasks);
    expect(r1.conflicts).toEqual(r2.conflicts);
    expect([...r1.owners.entries()]).toEqual([...r2.owners.entries()]);
  });

  it("does not mutate the input task list", () => {
    const tasks = [
      makeTask("T1", ["src/auth.ts"]),
      makeTask("T2", ["src/auth.ts"]),
    ];
    const snapshot = JSON.stringify(tasks);
    detectFileConflicts(tasks);
    expect(JSON.stringify(tasks)).toBe(snapshot);
  });

  it("reports all conflicting files when multiple overlaps exist", () => {
    const report = detectFileConflicts([
      makeTask("T1", ["src/auth.ts", "src/user.ts"]),
      makeTask("T2", ["src/auth.ts", "src/user.ts", "src/extra.ts"]),
    ]);
    expect(report.conflicts).toContain("src/auth.ts");
    expect(report.conflicts).toContain("src/user.ts");
    expect(report.conflicts).not.toContain("src/extra.ts"); // only T2 owns this
  });
});