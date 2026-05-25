/**
 * RED Phase Tests for SubagentExecutor
 * These tests verify the fixes for identified issues.
 */

import { describe, it, expect, beforeEach, vi } from "bun:test";

// Mock imports before importing the module
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { SubagentExecutor } from "../../src/executor/subagent-executor.ts";
import type { Task } from "../../src/executor/task-executor.ts";

const mockSpawn = spawn as ReturnType<typeof vi.mock>;

describe("SubagentExecutor - Issue Fixes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Issue #2: Race Condition Fix", () => {
    it("should properly await all spawned tasks before returning", async () => {
      const tasks: Task[] = [
        {
          id: "T1",
          description: "Test task 1",
          status: "pending",
          priority: "high",
          dependsOn: [],
          files: ["src/t1.ts"],
        },
        {
          id: "T2",
          description: "Test task 2",
          status: "pending",
          priority: "medium",
          dependsOn: [],
          files: ["src/t2.ts"],
        },
      ];

      const settings = {
        name: "test",
        maxParallel: 3,
        useSubagent: true,
        subagentConfig: {
          model: "sonnet",
          skills: ["luban"],
          timeout: 30,
        },
      };

      // Track completion
      const completedTasks: string[] = [];

      // Mock successful subagent execution
      mockSpawn.mockImplementation(() => {
        const mockChild = {
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          stdin: { write: vi.fn(), end: vi.fn() },
          on: (event: string, callback: (code: number) => void) => {
            if (event === "close") {
              setTimeout(() => callback(0), 10);
            }
          },
        };
        return mockChild as any;
      });

      const executor = new SubagentExecutor(tasks, settings, "/tmp");

      const results = await executor.executeAll(
        (task) => completedTasks.push(`start:${task.id}`),
        (task) => completedTasks.push(`complete:${task.id}`)
      );

      // All tasks should be tracked properly
      expect(results.size).toBe(2);
      expect(completedTasks).toContain("complete:T1");
      expect(completedTasks).toContain("complete:T2");
    });

    it("should handle parallel execution with proper task tracking", async () => {
      const tasks: Task[] = [
        { id: "T1", description: "Task 1", status: "pending", priority: "high", dependsOn: [], files: [] },
        { id: "T2", description: "Task 2", status: "pending", priority: "high", dependsOn: [], files: [] },
        { id: "T3", description: "Task 3", status: "pending", priority: "high", dependsOn: [], files: [] },
      ];

      const settings = {
        name: "test",
        maxParallel: 2, // Only 2 at a time
        useSubagent: true,
        subagentConfig: { model: "sonnet", skills: ["luban"], timeout: 30 },
      };

      const startOrder: string[] = [];

      mockSpawn.mockImplementation(() => {
        const mockChild = {
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          stdin: { write: vi.fn(), end: vi.fn() },
          on: (event: string, callback: (code: number) => void) => {
            if (event === "close") {
              setTimeout(() => callback(0), 5);
            }
          },
        };
        return mockChild as any;
      });

      const executor = new SubagentExecutor(tasks, settings, "/tmp");

      const results = await executor.executeAll(
        (task) => startOrder.push(task.id),
        () => {}
      );

      // All 3 tasks should complete despite maxParallel=2
      expect(results.size).toBe(3);
    });
  });

  describe("Issue #10: Task Status Updates", () => {
    it("should update task status in the original task array", async () => {
      const tasks: Task[] = [
        { id: "T1", description: "Task", status: "pending", priority: "high", dependsOn: [], files: [] },
      ];

      const settings = {
        name: "test",
        maxParallel: 3,
        useSubagent: true,
        subagentConfig: { model: "sonnet", skills: ["luban"], timeout: 30 },
      };

      mockSpawn.mockImplementation(() => {
        const mockChild = {
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          stdin: { write: vi.fn(), end: vi.fn() },
          on: (event: string, callback: (code: number) => void) => {
            if (event === "close") {
              setTimeout(() => callback(0), 5);
            }
          },
        };
        return mockChild as any;
      });

      const executor = new SubagentExecutor(tasks, settings, "/tmp");
      await executor.executeAll();

      // Task status should be updated to "completed"
      expect(tasks[0].status).toBe("completed");
    });
  });
});
