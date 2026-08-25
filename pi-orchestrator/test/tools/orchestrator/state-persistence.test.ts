import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  atomicWriteOrchestratorFile,
  loadYamlOrchestratorFile,
} from "@/state-persistence.js";
import {
  assertOrchestratorNamespaceOwner,
  classifyOrchestratorNamespace,
} from "@/namespace-ownership.js";

describe("shared orchestrator state persistence", () => {
  it("writes atomically with runtime validation and leaves no temporary file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sages-state-"));
    try {
      atomicWriteOrchestratorFile(cwd, "goal-GC-test.yaml", "id: GC-test\ntitle: test\n", {
        owner: "l3",
        validate: (value): value is { id: string; title: string } =>
          typeof value === "object" && value !== null && (value as any).id === "GC-test" && typeof (value as any).title === "string",
      });
      const loaded = loadYamlOrchestratorFile(cwd, "goal-GC-test.yaml", {
        owner: "l3",
        validate: (value): value is { id: string; title: string } =>
          typeof value === "object" && value !== null && (value as any).id === "GC-test" && typeof (value as any).title === "string",
      });
      expect(loaded).toEqual({ id: "GC-test", title: "test" });
      expect(readFileSync(join(cwd, ".pi/orchestrator/goal-GC-test.yaml"), "utf8")).toContain("GC-test");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects malformed state instead of returning an unchecked cast", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sages-state-"));
    try {
      mkdirSync(join(cwd, ".pi/orchestrator"), { recursive: true });
      writeFileSync(join(cwd, ".pi/orchestrator/dag-DAG-test.yaml"), "tasks: nope\n");
      expect(() => loadYamlOrchestratorFile(cwd, "dag-DAG-test.yaml", {
        owner: "l3",
        validate: (value): value is { tasks: unknown[] } =>
          typeof value === "object" && value !== null && Array.isArray((value as any).tasks),
      })).toThrow(/malformed/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects an orchestrator directory symlink and path traversal", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sages-state-"));
    const outside = mkdtempSync(join(tmpdir(), "sages-outside-"));
    try {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      symlinkSync(outside, join(cwd, ".pi/orchestrator"));
      expect(() => atomicWriteOrchestratorFile(cwd, "goal-GC-test.yaml", "id: GC-test\n", {
        owner: "l3",
        validate: (_value: unknown): _value is unknown => true,
      })).toThrow(/symlink/i);
      expect(() => atomicWriteOrchestratorFile(cwd, "../escape.yaml", "x: 1\n", {
        owner: "l3",
        validate: (_value: unknown): _value is unknown => true,
      })).toThrow(/contained|path/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe(".pi/orchestrator namespace ownership", () => {
  it("classifies L3, developer, and auditor namespaces", () => {
    expect(classifyOrchestratorNamespace("goal-GC-test.yaml")).toBe("l3");
    expect(classifyOrchestratorNamespace("dag-DAG-test.yaml")).toBe("l3");
    expect(classifyOrchestratorNamespace("audit-state-DAG-test.yaml")).toBe("l3");
    expect(classifyOrchestratorNamespace("audit-workflow.md")).toBe("l3");
    expect(classifyOrchestratorNamespace("task-P1-report.md")).toBe("developer");
    expect(classifyOrchestratorNamespace("handoff/W1/P1-handoff.md")).toBe("developer");
    expect(classifyOrchestratorNamespace("audit-P1.md")).toBe("auditor");
  });

  it("rejects cross-namespace overwrite attempts and unowned names", () => {
    expect(() => assertOrchestratorNamespaceOwner("task-P1-report.md", "l3")).toThrow(/owned by developer/i);
    expect(() => assertOrchestratorNamespaceOwner("audit-P1.md", "developer")).toThrow(/owned by auditor/i);
    expect(() => assertOrchestratorNamespaceOwner("goal-GC-test.yaml", "auditor")).toThrow(/owned by l3/i);
    expect(() => assertOrchestratorNamespaceOwner("misc.txt", "developer")).toThrow(/unowned/i);
  });
});
