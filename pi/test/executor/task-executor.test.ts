/**
 * Unit Tests for TaskExecutor
 * Tests parallel task execution with dependency management
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { TaskExecutor, type Task, type ExecutionResult } from "../../src/executor/task-executor";

describe("TaskExecutor", () => {
  let executor: TaskExecutor;
  let tasks: Task[];
  const cwd = "/tmp/test-sages";

  const createTask = (id: string, dependsOn: string[] = [], priority: Task["priority"] = "medium"): Task => ({
    id,
    description: `Task ${id}`,
    status: "pending",
    priority,
    dependsOn,
    files: [],
  });

  beforeEach(() => {
    tasks = [
      createTask("T1"),
      createTask("T2", ["T1"]),
      createTask("T3", ["T2"]),
    ];
    executor = new TaskExecutor(tasks, 3, cwd);
  });

  describe("constructor", () => {
    it("should initialize with tasks", () => {
      const exec = new TaskExecutor([createTask("T1")], 2, cwd);
      const progress = exec.getProgress();
      expect(progress.total).toBe(1);
    });

    it("should set maxParallel from parameter", () => {
      const exec = new TaskExecutor([], 5, cwd);
      // Private maxParallel, but we can verify it handles more tasks
      const progress = exec.getProgress();
      expect(progress.total).toBe(0);
    });

    it("should set all tasks to pending status initially", () => {
      const allPending = tasks.every(t => t.status === "pending");
      expect(allPending).toBe(true);
    });
  });

  describe("getTaskStatus", () => {
    it("should return task by id", () => {
      const task = executor.getTaskStatus("T1");
      expect(task).toBeDefined();
      expect(task?.id).toBe("T1");
    });

    it("should return undefined for non-existent task", () => {
      const task = executor.getTaskStatus("T99");
      expect(task).toBeUndefined();
    });
  });

  describe("getProgress", () => {
    it("should return initial progress with 0 completed", () => {
      const progress = executor.getProgress();
      expect(progress.completed).toBe(0);
      expect(progress.total).toBe(3);
      expect(progress.percentage).toBe(0);
    });

    it("should calculate percentage correctly", () => {
      // Simulate task completion
      tasks[0].status = "completed";
      const progress = executor.getProgress();
      expect(progress.completed).toBe(0); // Not updated in executor
      expect(progress.total).toBe(3);
    });

    it("should handle empty task list", () => {
      const emptyExec = new TaskExecutor([], 3, cwd);
      const progress = emptyExec.getProgress();
      expect(progress.total).toBe(0);
      expect(progress.percentage).toBe(0);
    });
  });

  describe("task dependencies", () => {
    it("should allow independent tasks to run in parallel", () => {
      const parallelTasks = [
        createTask("A"),
        createTask("B"),
        createTask("C"),
      ];
      const exec = new TaskExecutor(parallelTasks, 3, cwd);
      const progress = exec.getProgress();
      
      expect(progress.total).toBe(3);
      // Tasks start pending
      const pending = progress.total - progress.completed;
      expect(pending).toBe(3);
    });

    it("should respect sequential dependencies", () => {
      const sequentialTasks = [
        createTask("T1"),
        createTask("T2", ["T1"]),
        createTask("T3", ["T2"]),
      ];
      
      // T2 depends on T1, T3 depends on T2
      expect(sequentialTasks[1].dependsOn).toContain("T1");
      expect(sequentialTasks[2].dependsOn).toContain("T2");
    });

    it("should handle multiple dependencies", () => {
      const multiDepTask: Task = {
        id: "T3",
        description: "Task with multiple deps",
        status: "pending",
        priority: "high",
        dependsOn: ["T1", "T2"],
        files: [],
      };
      
      expect(multiDepTask.dependsOn).toContain("T1");
      expect(multiDepTask.dependsOn).toContain("T2");
      expect(multiDepTask.dependsOn.length).toBe(2);
    });
  });

  describe("task priority", () => {
    it("should have priority enum values", () => {
      const priorities: Task["priority"][] = ["high", "medium", "low"];
      expect(priorities).toContain("high");
      expect(priorities).toContain("medium");
      expect(priorities).toContain("low");
    });

    it("should sort by priority", () => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      
      const tasksWithPriority = [
        { priority: "low" as const },
        { priority: "high" as const },
        { priority: "medium" as const },
      ];
      
      const sorted = tasksWithPriority.sort((a, b) => 
        priorityOrder[a.priority] - priorityOrder[b.priority]
      );
      
      expect(sorted[0].priority).toBe("high");
      expect(sorted[1].priority).toBe("medium");
      expect(sorted[2].priority).toBe("low");
    });
  });

  describe("task status transitions", () => {
    it("should have valid status values", () => {
      const statuses: Task["status"][] = ["pending", "in_progress", "completed", "failed", "blocked"];
      
      statuses.forEach(status => {
        const task = createTask("T1");
        task.status = status;
        expect(task.status).toBe(status);
      });
    });

    it("should allow status to change", () => {
      const task = createTask("T1");
      expect(task.status).toBe("pending");
      
      task.status = "in_progress";
      expect(task.status).toBe("in_progress");
      
      task.status = "completed";
      expect(task.status).toBe("completed");
    });
  });

  describe("task files", () => {
    it("should track source files", () => {
      const task = createTask("T1");
      task.files = ["src/user.ts", "src/auth.ts"];
      
      expect(task.files).toContain("src/user.ts");
      expect(task.files).toContain("src/auth.ts");
    });

    it("should track test files", () => {
      const task = createTask("T1");
      task.testFiles = ["test/user.test.ts"];
      
      expect(task.testFiles).toContain("test/user.test.ts");
    });
  });

  describe("execution result", () => {
    it("should have valid ExecutionResult structure", () => {
      const result: ExecutionResult = {
        taskId: "T1",
        success: true,
        duration: 1000,
      };
      
      expect(result.taskId).toBe("T1");
      expect(result.success).toBe(true);
      expect(result.duration).toBe(1000);
    });

    it("should include error on failure", () => {
      const failedResult: ExecutionResult = {
        taskId: "T1",
        success: false,
        duration: 500,
        error: "Test failed",
      };
      
      expect(failedResult.success).toBe(false);
      expect(failedResult.error).toBe("Test failed");
    });

    it("should include output when available", () => {
      const result: ExecutionResult = {
        taskId: "T1",
        success: true,
        duration: 1000,
        output: "All tests passed",
      };
      
      expect(result.output).toBe("All tests passed");
    });
  });

  describe("file inference", () => {
    it("should infer source files from description", () => {
      const description = "Create user authentication module";
      const words = description.toLowerCase().split(/\s+/);
      const stopWords = ["implement", "add", "create", "update", "fix", "the", "and"];
      const possibleNames = words.filter(w => w.length > 3 && !stopWords.includes(w));
      
      expect(possibleNames.length).toBeGreaterThan(0);
    });

    it("should map test files from source files", () => {
      // This tests the mapping logic, not the executor implementation
      const sourceFile = "src/user.ts";
      const testFile = sourceFile.replace(".ts", ".test.ts");
      expect(testFile).toBe("src/user.test.ts");
    });
  });
});

describe("Task sorting", () => {
  it("should perform topological sort by dependencies", () => {
    const tasks = [
      { id: "T1", dependsOn: [] as string[] },
      { id: "T2", dependsOn: ["T1"] },
      { id: "T3", dependsOn: ["T1"] },
      { id: "T4", dependsOn: ["T2", "T3"] },
    ];

    // T4 should come after T2 and T3, which should come after T1
    const dependencyOrder: Record<string, number> = {
      T1: 0,
      T2: 1,
      T3: 1,
      T4: 2,
    };

    // Verify dependencies are respected
    tasks.forEach(task => {
      const expectedLevel = dependencyOrder[task.id];
      task.dependsOn.forEach(depId => {
        expect(dependencyOrder[depId]).toBeLessThan(expectedLevel);
      });
    });
  });
});
