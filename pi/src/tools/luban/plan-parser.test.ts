/**
 * Tests for plan-parser
 * TDD RED Phase: Tests should FAIL until plan-parser is implemented
 */

import { describe, it, expect } from "bun:test";
import { parseExecutionYaml, resolveDependencies, sortByDependencies } from "./plan-parser.js";
import type { ExecutionPlan, LubanTask } from "./types.js";

describe("parseExecutionYaml", () => {
  it("should exist and be a function", () => {
    expect(typeof parseExecutionYaml).toBe("function");
  });

  it("should parse valid execution.yaml content", () => {
    const yaml = `
name: test-plan

settings:
  maxParallel: 3
  useSubagent: false
  maxRetry: 1
  autoCommit: true

tasks:
  - id: T1
    description: "Task 1"
    plane: Foundation
    priority: 1
    dependsOn: []
    files: ["src/test.ts"]
`;
    const plan = parseExecutionYaml(yaml);
    expect(plan).not.toBeNull();
    expect(plan!.name).toBe("test-plan");
    expect(plan!.tasks.length).toBe(1);
    expect(plan!.tasks[0].id).toBe("T1");
  });

  it("should parse multiple tasks", () => {
    const yaml = `
name: multi-task

settings:
  maxParallel: 2
  useSubagent: false

tasks:
  - id: T1
    description: "Task 1"
    plane: Foundation
    priority: 1
    dependsOn: []
    files: []
  - id: T2
    description: "Task 2"
    plane: Business
    priority: 2
    dependsOn: ["T1"]
    files: []
`;
    const plan = parseExecutionYaml(yaml);
    expect(plan).not.toBeNull();
    expect(plan!.tasks.length).toBe(2);
    expect(plan!.settings.maxParallel).toBe(2);
  });

  it("should return null for invalid content", () => {
    const invalid = "not: [yaml";
    const plan = parseExecutionYaml(invalid);
    expect(plan).toBeNull();
  });
});

describe("resolveDependencies", () => {
  it("should exist and be a function", () => {
    expect(typeof resolveDependencies).toBe("function");
  });

  it("should detect circular dependencies", () => {
    const tasks: LubanTask[] = [
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "high", dependsOn: ["T2"], files: [], status: "pending" },
      { id: "T2", description: "Task 2", plane: "Foundation", priority: "high", dependsOn: ["T1"], files: [], status: "pending" },
    ];
    
    const result = resolveDependencies(tasks);
    expect(result.error).toContain("Circular");
  });

  it("should resolve valid dependencies", () => {
    const tasks: LubanTask[] = [
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "high", dependsOn: [], files: [], status: "pending" },
      { id: "T2", description: "Task 2", plane: "Foundation", priority: "high", dependsOn: ["T1"], files: [], status: "pending" },
      { id: "T3", description: "Task 3", plane: "Foundation", priority: "high", dependsOn: ["T1"], files: [], status: "pending" },
    ];
    
    const result = resolveDependencies(tasks);
    expect(result.error).toBeUndefined();
    expect(result.readyTasks).toContain("T1");
  });

  it("should handle missing dependencies", () => {
    const tasks: LubanTask[] = [
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "high", dependsOn: ["T999"], files: [], status: "pending" },
    ];
    
    const result = resolveDependencies(tasks);
    expect(result.error).toContain("unknown");
  });
});

describe("sortByDependencies", () => {
  it("should exist and be a function", () => {
    expect(typeof sortByDependencies).toBe("function");
  });

  it("should sort tasks with dependencies", () => {
    const tasks: LubanTask[] = [
      { id: "T2", description: "Task 2", plane: "Foundation", priority: "high", dependsOn: ["T1"], files: [], status: "pending" },
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "high", dependsOn: [], files: [], status: "pending" },
      { id: "T3", description: "Task 3", plane: "Foundation", priority: "high", dependsOn: ["T2"], files: [], status: "pending" },
    ];
    
    const sorted = sortByDependencies(tasks);
    
    expect(sorted[0].id).toBe("T1");
    expect(sorted[1].id).toBe("T2");
    expect(sorted[2].id).toBe("T3");
  });

  it("should handle independent tasks", () => {
    const tasks: LubanTask[] = [
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "high", dependsOn: [], files: [], status: "pending" },
      { id: "T2", description: "Task 2", plane: "Foundation", priority: "high", dependsOn: [], files: [], status: "pending" },
    ];
    
    const sorted = sortByDependencies(tasks);
    expect(sorted.length).toBe(2);
  });
});
