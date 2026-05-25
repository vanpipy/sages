/**
 * Tests for Luban Types
 * TDD RED Phase: Tests should FAIL until types are implemented
 */

import { describe, it, expect } from "bun:test";
import type { LubanTask, TDDConfig, TaskResult, TDDPhase } from "./types.js";

describe("LubanTask interface", () => {
  it("should have correct structure", () => {
    const task: LubanTask = {
      id: "T1",
      description: "Test task",
      plane: "Foundation",
      priority: "high",
      dependsOn: ["T0"],
      files: ["src/test.ts"],
      status: "pending",
    };
    
    expect(task.id).toMatch(/^[A-Z]\d+$/);
    expect(task.description.length).toBeGreaterThan(0);
    expect(["high", "medium", "low"]).toContain(task.priority);
    expect(["pending", "running", "completed", "failed"]).toContain(task.status);
  });
});

describe("TDDConfig interface", () => {
  it("should have correct structure", () => {
    const config: TDDConfig = {
      taskId: "T1",
      taskDescription: "Test task",
      sourceFiles: ["src/index.ts"],
      testFiles: ["src/index.test.ts"],
      testCommand: "bun test",
      cwd: "/tmp",
      subagent: false,
    };
    
    expect(config.taskId.length).toBeGreaterThan(0);
    expect(config.subagent).toBe(false);
  });
});

describe("TaskResult interface", () => {
  it("should have correct structure", () => {
    const result: TaskResult = {
      taskId: "T1",
      success: true,
      duration: 1000,
      phases: [
        { name: "RED", status: "completed" },
        { name: "GREEN", status: "completed" },
        { name: "REFACTOR", status: "completed" },
      ],
    };
    
    expect(result.taskId.length).toBeGreaterThan(0);
    expect(typeof result.success).toBe("boolean");
    expect(result.phases.length).toBe(3);
  });
});

describe("TDDPhase type", () => {
  it("should allow valid phase names", () => {
    const phase: TDDPhase = "RED";
    expect(["RED", "GREEN", "REFACTOR"]).toContain(phase);
  });
});
