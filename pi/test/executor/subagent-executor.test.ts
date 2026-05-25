/**
 * Tests for SubagentExecutor
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { SubagentExecutor } from "../../src/executor/subagent-executor.js";
import type { Task, ExecutionResult } from "../../src/executor/task-executor.js";

describe("SubagentExecutor", () => {
  let tasks: Task[];
  let settings: any;

  beforeEach(() => {
    tasks = [
      { id: "T1", description: "Task 1", status: "pending", priority: "high", dependsOn: [], files: ["a.ts"] },
      { id: "T2", description: "Task 2", status: "pending", priority: "high", dependsOn: ["T1"], files: ["b.ts"] },
    ];
    settings = {
      name: "test",
      maxParallel: 3,
      useSubagent: false,
    };
  });

  describe("getReadyTasks", () => {
    it("should return tasks with no dependencies first", () => {
      const executor = new SubagentExecutor(tasks, settings, "/tmp");
      const ready = executor.getReadyTasks();
      
      expect(ready.length).toBe(1);
      expect(ready[0].id).toBe("T1");
    });

    it("should not return tasks with unmet dependencies", () => {
      const executor = new SubagentExecutor(tasks, settings, "/tmp");
      const ready = executor.getReadyTasks();
      
      expect(ready.find(t => t.id === "T2")).toBeUndefined();
    });
  });

  describe("getProgress", () => {
    it("should return initial progress of zero", () => {
      const executor = new SubagentExecutor(tasks, settings, "/tmp");
      const progress = executor.getProgress();
      
      expect(progress.total).toBe(2);
      expect(progress.completed).toBe(0);
      expect(progress.failed).toBe(0);
      expect(progress.running).toBe(0);
      expect(progress.pending).toBe(2);
    });
  });
});
