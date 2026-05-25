import { describe, it, expect, beforeEach } from "bun:test";
import { TaskExecutor } from "../../src/executor/task-executor.js";

describe("TaskExecutor - Topological Sort", () => {
  describe("getSortedTasks", () => {
    it("should return tasks in dependency order", () => {
      const tasks = [
        { id: "T1", description: "Task 1", status: "pending" as const, priority: "high" as const, dependsOn: [], files: [] },
        { id: "T2", description: "Task 2", status: "pending" as const, priority: "high" as const, dependsOn: ["T1"], files: [] },
        { id: "T3", description: "Task 3", status: "pending" as const, priority: "high" as const, dependsOn: ["T2"], files: [] },
      ];
      
      const executor = new TaskExecutor(tasks, 3, "/tmp");
      const sorted = executor.getSortedTasks();
      
      expect(sorted.map(t => t.id)).toEqual(["T1", "T2", "T3"]);
    });

    it("should run high priority tasks before medium priority", () => {
      const tasks = [
        { id: "T1", description: "Task 1", status: "pending" as const, priority: "medium" as const, dependsOn: [], files: [] },
        { id: "T2", description: "Task 2", status: "pending" as const, priority: "high" as const, dependsOn: [], files: [] },
        { id: "T3", description: "Task 3", status: "pending" as const, priority: "low" as const, dependsOn: [], files: [] },
      ];
      
      const executor = new TaskExecutor(tasks, 3, "/tmp");
      const sorted = executor.getSortedTasks();
      
      expect(sorted[0].id).toBe("T2"); // high
      expect(sorted[1].id).toBe("T1"); // medium
      expect(sorted[2].id).toBe("T3"); // low
    });

    it("should handle diamond dependencies", () => {
      // T1 -> T3, T2 -> T3 (diamond)
      const tasks = [
        { id: "T1", description: "Task 1", status: "pending" as const, priority: "high" as const, dependsOn: [], files: [] },
        { id: "T2", description: "Task 2", status: "pending" as const, priority: "high" as const, dependsOn: [], files: [] },
        { id: "T3", description: "Task 3", status: "pending" as const, priority: "high" as const, dependsOn: ["T1", "T2"], files: [] },
      ];
      
      const executor = new TaskExecutor(tasks, 3, "/tmp");
      const sorted = executor.getSortedTasks();
      
      const t3Index = sorted.findIndex(t => t.id === "T3");
      const t1Index = sorted.findIndex(t => t.id === "T1");
      const t2Index = sorted.findIndex(t => t.id === "T2");
      
      expect(t1Index).toBeLessThan(t3Index);
      expect(t2Index).toBeLessThan(t3Index);
    });

    it("should handle cyclic dependencies by putting them at end", () => {
      // A -> B -> C -> A (cycle)
      // All tasks are in a dependency cycle: T1->T3->T2->T1
      const tasks = [
        { id: "T1", description: "Task 1", status: "pending" as const, priority: "high" as const, dependsOn: ["T3"], files: [] },
        { id: "T2", description: "Task 2", status: "pending" as const, priority: "high" as const, dependsOn: ["T1"], files: [] },
        { id: "T3", description: "Task 3", status: "pending" as const, priority: "high" as const, dependsOn: ["T2"], files: [] },
      ];
      
      const executor = new TaskExecutor(tasks, 3, "/tmp");
      const sorted = executor.getSortedTasks();
      
      // All tasks should be in result (cycles are appended at end)
      // They will likely fail at runtime since dependencies form a cycle
      expect(sorted.length).toBe(3);
      expect(sorted.map(t => t.id).sort()).toEqual(["T1", "T2", "T3"]);
    });

    it("should include all tasks even with complex cycle", () => {
      // Mix of valid deps and cycle: T1->T2->T3, T3->T1 (cycle with T1, T2)
      const tasks = [
        { id: "T1", description: "Task 1", status: "pending" as const, priority: "high" as const, dependsOn: ["T3"], files: [] },
        { id: "T2", description: "Task 2", status: "pending" as const, priority: "medium" as const, dependsOn: ["T1"], files: [] },
        { id: "T3", description: "Task 3", status: "pending" as const, priority: "low" as const, dependsOn: ["T2"], files: [] },
      ];
      
      const executor = new TaskExecutor(tasks, 3, "/tmp");
      const sorted = executor.getSortedTasks();
      
      // T1, T2, T3 all in cycle - all appended at end
      expect(sorted.length).toBe(3);
    });

    it("should sort independent high-priority tasks first among themselves", () => {
      const tasks = [
        { id: "T1", description: "Task 1", status: "pending" as const, priority: "high" as const, dependsOn: [], files: [] },
        { id: "T2", description: "Task 2", status: "pending" as const, priority: "high" as const, dependsOn: [], files: [] },
        { id: "T3", description: "Task 3", status: "pending" as const, priority: "medium" as const, dependsOn: [], files: [] },
      ];
      
      const executor = new TaskExecutor(tasks, 3, "/tmp");
      const sorted = executor.getSortedTasks();
      
      // T1 and T2 are high priority, should come before T3
      const highPriorityIds = sorted.filter(t => t.priority === "high").map(t => t.id);
      expect(highPriorityIds).toContain("T1");
      expect(highPriorityIds).toContain("T2");
      expect(sorted[2].id).toBe("T3"); // T3 is medium, comes last
    });
  });
});
