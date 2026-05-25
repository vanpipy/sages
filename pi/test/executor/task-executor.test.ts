/**
 * RED Phase Tests for TaskExecutor
 * Tests for Issue #4: Incomplete Topological Sort
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { TaskExecutor, type Task } from "../../src/executor/task-executor.ts";

describe("TaskExecutor - Issue Fixes", () => {
  describe("Issue #4: Topological Sort for Transitive Dependencies", () => {
    it("should handle A → B → C dependency chain correctly", async () => {
      const tasks: Task[] = [
        { id: "T1", description: "Task 1", status: "pending", priority: "high", dependsOn: [], files: [] },
        { id: "T2", description: "Task 2", status: "pending", priority: "high", dependsOn: ["T1"], files: [] },
        { id: "T3", description: "Task 3", status: "pending", priority: "high", dependsOn: ["T2"], files: [] },
      ];

      const executor = new TaskExecutor(tasks, 3, "/tmp");

      // Get sorted tasks - T3 depends on T2 which depends on T1
      const sorted = (executor as any).getSortedTasks();
      const ids = sorted.map((t: Task) => t.id);

      // T1 should come before T2
      expect(ids.indexOf("T1")).toBeLessThan(ids.indexOf("T2"));
      // T2 should come before T3
      expect(ids.indexOf("T2")).toBeLessThan(ids.indexOf("T3"));
    });

    it("should handle diamond dependencies (A→B, A→C, B→D, C→D)", async () => {
      const tasks: Task[] = [
        { id: "A", description: "A", status: "pending", priority: "high", dependsOn: [], files: [] },
        { id: "B", description: "B", status: "pending", priority: "high", dependsOn: ["A"], files: [] },
        { id: "C", description: "C", status: "pending", priority: "high", dependsOn: ["A"], files: [] },
        { id: "D", description: "D", status: "pending", priority: "high", dependsOn: ["B", "C"], files: [] },
      ];

      const executor = new TaskExecutor(tasks, 3, "/tmp");
      const sorted = (executor as any).getSortedTasks();
      const ids = sorted.map((t: Task) => t.id);

      // A must be first
      expect(ids[0]).toBe("A");
      // D must be last
      expect(ids[ids.length - 1]).toBe("D");
      // B and C can be in any order relative to each other, but both after A
      expect(ids.indexOf("B")).toBeGreaterThan(ids.indexOf("A"));
      expect(ids.indexOf("C")).toBeGreaterThan(ids.indexOf("A"));
      // D after both B and C
      expect(ids.indexOf("D")).toBeGreaterThan(ids.indexOf("B"));
      expect(ids.indexOf("D")).toBeGreaterThan(ids.indexOf("C"));
    });

    it("should handle complex graph with multiple paths", async () => {
      const tasks: Task[] = [
        { id: "START", description: "Start", status: "pending", priority: "high", dependsOn: [], files: [] },
        { id: "A", description: "A", status: "pending", priority: "high", dependsOn: ["START"], files: [] },
        { id: "B", description: "B", status: "pending", priority: "high", dependsOn: ["START"], files: [] },
        { id: "C", description: "C", status: "pending", priority: "high", dependsOn: ["A"], files: [] },
        { id: "D", description: "D", status: "pending", priority: "high", dependsOn: ["A", "B"], files: [] },
        { id: "END", description: "END", status: "pending", priority: "high", dependsOn: ["C", "D"], files: [] },
      ];

      const executor = new TaskExecutor(tasks, 3, "/tmp");
      const sorted = (executor as any).getSortedTasks();
      const ids = sorted.map((t: Task) => t.id);

      // START must be first
      expect(ids[0]).toBe("START");
      // A and B after START
      expect(ids.indexOf("A")).toBeGreaterThan(ids.indexOf("START"));
      expect(ids.indexOf("B")).toBeGreaterThan(ids.indexOf("START"));
      // C after A
      expect(ids.indexOf("C")).toBeGreaterThan(ids.indexOf("A"));
      // D after both A and B
      expect(ids.indexOf("D")).toBeGreaterThan(ids.indexOf("A"));
      expect(ids.indexOf("D")).toBeGreaterThan(ids.indexOf("B"));
      // END after C and D
      expect(ids.indexOf("END")).toBeGreaterThan(ids.indexOf("C"));
      expect(ids.indexOf("END")).toBeGreaterThan(ids.indexOf("D"));
    });

    it("getReadyTasks should respect all dependencies", () => {
      const tasks: Task[] = [
        { id: "T1", description: "Task 1", status: "pending", priority: "high", dependsOn: [], files: [] },
        { id: "T2", description: "Task 2", status: "pending", priority: "high", dependsOn: ["T1"], files: [] },
        { id: "T3", description: "Task 3", status: "pending", priority: "high", dependsOn: ["T2"], files: [] },
      ];

      const executor = new TaskExecutor(tasks, 3, "/tmp");

      // Initially only T1 should be ready
      const ready1 = (executor as any).getReadyTasks();
      expect(ready1.length).toBe(1);
      expect(ready1[0].id).toBe("T1");

      // After T1 completes, both T2 and T3 should be ready (their dependencies are met)
      (executor as any).completedTasks.add("T1");
      const ready2 = (executor as any).getReadyTasks();
      // T2 depends on T1 (completed), T3 depends on T2 (NOT completed yet via task map)
      // But T2 is pending, so T3 is NOT ready until T2 is also in completedTasks
      expect(ready2.length).toBe(1);
      expect(ready2[0].id).toBe("T2");

      // After T2 completes, T3 should be ready
      (executor as any).completedTasks.add("T2");
      const ready3 = (executor as any).getReadyTasks();
      expect(ready3.length).toBe(1);
      expect(ready3[0].id).toBe("T3");
    });
  });
});
