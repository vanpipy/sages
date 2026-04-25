/**
 * Unit Tests for execution utilities
 * Tests parseExecutionYaml and sleep functions
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseExecutionYaml, sleep } from "../../src/utils/execution";
import type { ExecutionPlan } from "../../src/types";

describe("parseExecutionYaml", () => {
  describe("basic YAML parsing", () => {
    it("should parse a simple execution plan", () => {
      const yaml = `
name: TestPlan
timestamp: "2024-01-01T00:00:00Z"
totalEstimatedTime: 30
strategy:
  failFast: true
  maxRetries: 3
  retryDelayMs: 1000
  continueOnFailure: false
tasks:
  - id: T1
    description: Task 1
    priority: high
    estimatedTime: 10
    dependsOn: []
    files: []
    status: pending
phases:
  - name: Phase 1
    tasks:
      - T1
    type: sequential
`;
      const plan = parseExecutionYaml(yaml);
      expect(plan.name).toBe("TestPlan");
      expect(plan.timestamp).toBe("2024-01-01T00:00:00Z");
      expect(plan.totalEstimatedTime).toBe(30);
      expect(plan.tasks.length).toBe(1);
      expect(plan.tasks[0].id).toBe("T1");
      expect(plan.phases.length).toBe(1);
      expect(plan.phases[0].name).toBe("Phase 1");
      expect(plan.phases[0].type).toBe("sequential");
    });

    it("should parse multiple tasks with various priorities", () => {
      const yaml = `
name: MultiTaskPlan
timestamp: "2024-01-01T00:00:00Z"
totalEstimatedTime: 60
strategy:
  failFast: false
  maxRetries: 2
  retryDelayMs: 500
  continueOnFailure: true
tasks:
  - id: T1
    description: High priority task
    priority: high
    estimatedTime: 15
    dependsOn: []
    files: ["src/a.ts"]
    status: pending
  - id: T2
    description: Medium priority task
    priority: medium
    estimatedTime: 20
    dependsOn: ["T1"]
    files: ["src/b.ts"]
    status: pending
  - id: T3
    description: Low priority task
    priority: low
    estimatedTime: 25
    dependsOn: ["T1"]
    files: []
    status: pending
phases:
  - name: Setup
    tasks:
      - T1
    type: sequential
  - name: Implementation
    tasks:
      - T2
      - T3
    type: parallel
`;
      const plan = parseExecutionYaml(yaml);
      expect(plan.tasks.length).toBe(3);
      expect(plan.tasks[0].priority).toBe("high");
      expect(plan.tasks[1].priority).toBe("medium");
      expect(plan.tasks[2].priority).toBe("low");
      expect(plan.tasks[1].dependsOn).toContain("T1");
      expect(plan.phases[1].type).toBe("parallel");
    });

    it("should parse task with result information", () => {
      const yaml = `
name: PlanWithResult
timestamp: "2024-01-01T00:00:00Z"
totalEstimatedTime: 10
strategy:
  failFast: true
  maxRetries: 1
  retryDelayMs: 100
  continueOnFailure: false
tasks:
  - id: T1
    description: Completed task
    priority: high
    estimatedTime: 10
    dependsOn: []
    files: ["src/main.ts"]
    status: completed
    result:
      status: success
      message: Task completed successfully
      filesCreated: ["dist/a.js"]
      filesModified: ["src/main.ts"]
      testCommand: npm test
phases:
  - name: Main
    tasks:
      - T1
    type: sequential
`;
      const plan = parseExecutionYaml(yaml);
      expect(plan.tasks[0].result).toBeDefined();
      expect(plan.tasks[0].result?.status).toBe("success");
      expect(plan.tasks[0].result?.message).toBe("Task completed successfully");
      expect(plan.tasks[0].result?.filesCreated).toContain("dist/a.js");
    });

    it("should parse failed task with error", () => {
      const yaml = `
name: PlanWithFailedTask
timestamp: "2024-01-01T00:00:00Z"
totalEstimatedTime: 10
strategy:
  failFast: true
  maxRetries: 1
  retryDelayMs: 100
  continueOnFailure: false
tasks:
  - id: T1
    description: Failed task
    priority: high
    estimatedTime: 10
    dependsOn: []
    files: []
    status: failed
    result:
      status: failed
      error: "Something went wrong"
phases:
  - name: Main
    tasks:
      - T1
    type: sequential
`;
      const plan = parseExecutionYaml(yaml);
      expect(plan.tasks[0].status).toBe("failed");
      expect(plan.tasks[0].result?.status).toBe("failed");
      expect(plan.tasks[0].result?.error).toBe("Something went wrong");
    });
  });

  describe("strategy parsing", () => {
    it("should parse all strategy options", () => {
      const yaml = `
name: StrategyTest
timestamp: "2024-01-01T00:00:00Z"
totalEstimatedTime: 30
strategy:
  failFast: false
  maxRetries: 5
  retryDelayMs: 2000
  continueOnFailure: true
tasks: []
phases:
  - name: Phase 1
    tasks: []
    type: sequential
`;
      const plan = parseExecutionYaml(yaml);
      expect(plan.strategy.failFast).toBe(false);
      expect(plan.strategy.maxRetries).toBe(5);
      expect(plan.strategy.retryDelayMs).toBe(2000);
      expect(plan.strategy.continueOnFailure).toBe(true);
    });
  });

  describe("error handling", () => {
    it("should return default ExecutionPlan on invalid YAML", () => {
      const invalidYaml = "this is not valid yaml at all {{{";
      const plan = parseExecutionYaml(invalidYaml);
      expect(plan.name).toBe("");
      expect(plan.tasks).toEqual([]);
      expect(plan.phases).toEqual([]);
    });

    it("should return default ExecutionPlan on empty string", () => {
      const emptyYaml = "";
      const plan = parseExecutionYaml(emptyYaml);
      expect(plan.name).toBe("");
      expect(plan.tasks).toEqual([]);
      expect(plan.phases).toEqual([]);
    });

    it("should handle partial YAML with missing fields", () => {
      const partialYaml = `
name: PartialPlan
tasks:
  - id: T1
`;
      const plan = parseExecutionYaml(partialYaml);
      expect(plan.name).toBe("PartialPlan");
      expect(plan.tasks.length).toBe(1);
      expect(plan.strategy).toBeDefined();
      expect(plan.strategy.failFast).toBe(false);
    });

    it("should handle task without dependsOn or files fields", () => {
      const yaml = `
name: MinimalTaskPlan
timestamp: "2024-01-01T00:00:00Z"
totalEstimatedTime: 10
strategy:
  failFast: true
  maxRetries: 1
  retryDelayMs: 100
  continueOnFailure: false
tasks:
  - id: T1
    description: Minimal task
    priority: high
    estimatedTime: 10
    status: pending
phases:
  - name: Main
    tasks:
      - T1
    type: sequential
`;
      const plan = parseExecutionYaml(yaml);
      expect(plan.tasks[0].dependsOn).toEqual([]);
      expect(plan.tasks[0].files).toEqual([]);
    });
  });
});

describe("sleep", () => {
  it("should delay for specified milliseconds", async () => {
    const start = Date.now();
    await sleep(100);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(95);
    expect(elapsed).toBeLessThan(150);
  });

  it("should handle zero milliseconds", async () => {
    const start = Date.now();
    await sleep(0);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it("should handle larger delays", async () => {
    const start = Date.now();
    await sleep(200);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(195);
    expect(elapsed).toBeLessThan(300);
  });

  it("should return a Promise that resolves", async () => {
    const result = await sleep(50);
    expect(result).toBeUndefined();
  });
});
