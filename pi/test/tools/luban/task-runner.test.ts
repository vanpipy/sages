/**
 * Tests for task-runner
 * TDD RED Phase: Tests should FAIL until task-runner is implemented
 */

import { describe, it, expect } from "bun:test";
import { runTask, runTDDCycle } from "../../../src/tools/luban/task-runner.js";
import type { TDDConfig, TaskResult } from "../../../src/tools/luban/types.js";

describe("runTask", () => {
  it("should exist and be a function", () => {
    expect(typeof runTask).toBe("function");
  });

  it("should accept TDDConfig and return TaskResult", async () => {
    const config: TDDConfig = {
      taskId: "T1",
      taskDescription: "Test task",
      sourceFiles: ["src/test.ts"],
      testFiles: ["src/test.test.ts"],
      testCommand: "bun test",
      cwd: "/tmp",
      subagent: false,
    };
    
    // This will fail because files don't exist, but we're testing the signature
    const result = await runTask(config);
    
    expect(result).toBeDefined();
    expect(result.taskId).toBe("T1");
  });
});

describe("runTDDCycle", () => {
  it("should exist and be a function", () => {
    expect(typeof runTDDCycle).toBe("function");
  });

  it("should return phases array", async () => {
    // This will fail but we're testing the signature
    const result = await runTDDCycle({
      taskId: "T1",
      taskDescription: "Test",
      sourceFiles: ["nonexistent.ts"],
      testFiles: ["nonexistent.test.ts"],
      testCommand: "echo test",
      cwd: "/tmp",
    });
    
    expect(result).toBeDefined();
    // Result is an array of TDDPhaseResult
    expect(Array.isArray(result)).toBe(true);
  });
});
