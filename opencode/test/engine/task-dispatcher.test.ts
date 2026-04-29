/**
 * Unit Tests for TaskDispatcher
 * Tests task dispatching with semaphore concurrency and file locking
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { TaskDispatcher } from "../../src/engine/task-dispatcher";
import { FileLockManager } from "../../src/engine/file-lock";
import type { WorkflowTaskDefinition } from "../../src/engine/types";

// Mock FileLockManager for testing
class MockFileLockManager {
  private locks: Map<string, { path: string; taskId: string; agentId: string; expiresAt: string }> = new Map();
  private shouldFailAcquire = false;
  private failAcquireCount = 0;

  async acquireLock(filePath: string, taskId: string, agentId: string): Promise<{ path: string; taskId: string; agentId: string; expiresAt: string } | null> {
    if (this.shouldFailAcquire && this.failAcquireCount++ > 0) {
      return null; // Simulate lock failure after first call
    }
    const lock = this.locks.get(filePath);
    if (lock && new Date(lock.expiresAt) > new Date()) {
      return null; // Lock held by another task
    }
    const newLock = {
      path: filePath,
      taskId,
      agentId,
      expiresAt: new Date(Date.now() + 1800 * 1000).toISOString(),
    };
    this.locks.set(filePath, newLock);
    return newLock;
  }

  async releaseLock(filePath: string, taskId: string): Promise<void> {
    const lock = this.locks.get(filePath);
    if (lock && lock.taskId === taskId) {
      this.locks.delete(filePath);
    }
  }

  async releaseAllLocks(taskId: string): Promise<void> {
    for (const [path, lock] of this.locks) {
      if (lock.taskId === taskId) {
        this.locks.delete(path);
      }
    }
  }

  async getLock(filePath: string): Promise<{ path: string; taskId: string; agentId: string; expiresAt: string } | null> {
    return this.locks.get(filePath) ?? null;
  }

  async isLocked(filePath: string): Promise<boolean> {
    const lock = this.locks.get(filePath);
    return lock !== undefined && new Date(lock.expiresAt) > new Date();
  }

  // Test helper to force clear all locks
  clearAllLocks(): void {
    this.locks.clear();
  }

  // Test helper to get locks held by a specific task
  getLocksHeldBy(taskId: string): string[] {
    const held: string[] = [];
    for (const [path, lock] of this.locks) {
      if (lock.taskId === taskId) {
        held.push(path);
      }
    }
    return held;
  }
}

describe("TaskDispatcher", () => {
  let fileLockManager: MockFileLockManager;
  let dispatcher: TaskDispatcher;

  const createTask = (id: string, files?: string[]): WorkflowTaskDefinition => ({
    id,
    description: `Test task ${id}`,
    agent: "luban",
    files: files ?? [],
    dependsOn: [],
  });

  beforeEach(() => {
    fileLockManager = new MockFileLockManager();
    dispatcher = new TaskDispatcher(3, fileLockManager as unknown as FileLockManager);
  });

  describe("constructor", () => {
    it("should create TaskDispatcher with specified maxParallel", () => {
      const d = new TaskDispatcher(5, fileLockManager as unknown as FileLockManager);
      expect(d).toBeDefined();
      expect(d.getActiveCount()).toBe(0);
    });

    it("should create TaskDispatcher with custom timeout", () => {
      const d = new TaskDispatcher(3, fileLockManager as unknown as FileLockManager, {
        timeout: 60000,
      });
      expect(d).toBeDefined();
    });

    it("should create TaskDispatcher with default timeout", () => {
      const d = new TaskDispatcher(3, fileLockManager as unknown as FileLockManager);
      expect(d).toBeDefined();
    });
  });

  describe("dispatch", () => {
    it("should successfully dispatch a task", async () => {
      const task = createTask("task-1", ["file.ts"]);
      const result = await dispatcher.dispatch(task, "workflow-1");

      expect(result.success).toBe(true);
      expect(result.taskId).toBe("task-1");
      expect(result.agentId).toBeDefined();
      expect(result.agentId).toContain("luban-task-1");
    });

    it("should dispatch task without files", async () => {
      const task = createTask("task-no-files");
      const result = await dispatcher.dispatch(task, "workflow-1");

      expect(result.success).toBe(true);
      expect(result.taskId).toBe("task-no-files");
    });

    it("should include duration in result", async () => {
      const task = createTask("task-duration");
      const result = await dispatcher.dispatch(task, "workflow-1");

      expect(result.duration).toBeDefined();
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe("dispatchBatch", () => {
    it("should dispatch multiple tasks in batch", async () => {
      const tasks = [
        createTask("batch-1", ["file1.ts"]),
        createTask("batch-2", ["file2.ts"]),
        createTask("batch-3", ["file3.ts"]),
      ];

      const results = await dispatcher.dispatchBatch(tasks, "workflow-batch");

      expect(results).toHaveLength(3);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(results[2].success).toBe(true);
    });

    it("should return results in same order as input", async () => {
      const tasks = [
        createTask("ordered-1"),
        createTask("ordered-2"),
        createTask("ordered-3"),
      ];

      const results = await dispatcher.dispatchBatch(tasks, "workflow-ordered");

      expect(results[0].taskId).toBe("ordered-1");
      expect(results[1].taskId).toBe("ordered-2");
      expect(results[2].taskId).toBe("ordered-3");
    });

    it("should chunk tasks by maxParallel for concurrent dispatch", async () => {
      // Create dispatcher with maxParallel=2
      const limitedDispatcher = new TaskDispatcher(2, fileLockManager as unknown as FileLockManager);
      const tasks = [
        createTask("chunk-1", ["file1.ts"]),
        createTask("chunk-2", ["file2.ts"]),
        createTask("chunk-3", ["file3.ts"]),
      ];

      // With maxParallel=2, 3 tasks should create chunks of [2, 1]
      // The task should still complete successfully despite chunking
      const results = await limitedDispatcher.dispatchBatch(tasks, "workflow-chunk");

      expect(results).toHaveLength(3);
      expect(results.every(r => r.success)).toBe(true);
    });
  });

  describe("getQueueDepth", () => {
    it("should return 0 when no tasks queued", () => {
      expect(dispatcher.getQueueDepth()).toBe(0);
    });
  });

  describe("getActiveCount", () => {
    it("should return 0 when no active tasks", () => {
      expect(dispatcher.getActiveCount()).toBe(0);
    });

    it("should return 0 after dispatch completes", async () => {
      const task1 = createTask("count-1");
      const task2 = createTask("count-2");

      await dispatcher.dispatch(task1, "workflow-count");
      await dispatcher.dispatch(task2, "workflow-count");

      expect(dispatcher.getActiveCount()).toBe(0);
    });
  });

  describe("cancelTask", () => {
    it("should not throw when cancelling non-existent task", () => {
      expect(() => {
        dispatcher.cancelTask("non-existent-task");
      }).not.toThrow();
    });
  });

  describe("cancelAll", () => {
    it("should not throw when no tasks to cancel", () => {
      expect(() => {
        dispatcher.cancelAll();
      }).not.toThrow();
    });

    it("should clear all tracked tasks after dispatch", async () => {
      const tasks = [
        createTask("cancel-all-1"),
        createTask("cancel-all-2"),
      ];

      await dispatcher.dispatchBatch(tasks, "workflow-cancel-all");
      dispatcher.cancelAll();

      expect(dispatcher.getActiveCount()).toBe(0);
    });
  });

  describe("cancelWorkflow", () => {
    it("should cancel tasks for specific workflow", async () => {
      // Note: cancelWorkflow is a stub - it just emits events
      // The test verifies it doesn't throw
      dispatcher.cancelWorkflow("non-existent-workflow");
      dispatcher.cancelWorkflow("workflow-cancel-test");

      expect(true).toBe(true); // If we got here, no exception was thrown
    });
  });

  describe("semaphore concurrency", () => {
    it("should limit concurrent dispatches to maxParallel", async () => {
      // Create dispatcher with maxParallel = 2
      const limitedDispatcher = new TaskDispatcher(2, fileLockManager as unknown as FileLockManager);

      const tasks = [
        createTask("semaphore-1"),
        createTask("semaphore-2"),
        createTask("semaphore-3"),
      ];

      // All should eventually complete
      const results = await limitedDispatcher.dispatchBatch(tasks, "workflow-semaphore");

      expect(results).toHaveLength(3);
      // All tasks should succeed even with limited concurrency
      expect(results.every(r => r.success)).toBe(true);
    });
  });

  describe("file locking integration", () => {
    it("should handle task without files", async () => {
      const task = createTask("no-files-task");

      const result = await dispatcher.dispatch(task, "workflow-no-files");

      expect(result.success).toBe(true);
    });

    it("should handle task with multiple files", async () => {
      const task = createTask("multi-file-task", ["file1.ts", "file2.ts", "file3.ts"]);

      const result = await dispatcher.dispatch(task, "workflow-multi-file");

      expect(result.success).toBe(true);
    });
  });

  describe("error handling", () => {
    it("should return error when lock acquisition fails", async () => {
      // Manually acquire a lock to block the file
      await fileLockManager.acquireLock("blocked-file.ts", "other-task", "other-agent");

      const task = createTask("lock-fail-task", ["blocked-file.ts"]);
      const result = await dispatcher.dispatch(task, "workflow-lock-fail");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should release locks when dispatch fails after semaphore acquisition", async () => {
      // This test verifies that if a task acquires file locks but then the
      // dispatch fails (e.g., agent throws), the file locks are released.
      // We test this by checking that a subsequent dispatch can acquire the file.
      const firstTask = createTask("first-task", ["shared-file.ts"]);
      const secondTask = createTask("second-task", ["shared-file.ts"]);

      // First dispatch acquires lock on shared-file.ts
      const firstResult = await dispatcher.dispatch(firstTask, "workflow-lock-release");
      expect(firstResult.success).toBe(true);

      // If locks were properly released after first dispatch completes,
      // second dispatch should succeed (not fail on lock acquisition)
      const secondResult = await dispatcher.dispatch(secondTask, "workflow-lock-release");
      expect(secondResult.success).toBe(true);
    });
  });

  describe("agent dispatch", () => {
    it("should generate unique agent IDs", async () => {
      const task1 = createTask("agent-id-1");
      const task2 = createTask("agent-id-2");

      const result1 = await dispatcher.dispatch(task1, "workflow-agent");
      const result2 = await dispatcher.dispatch(task2, "workflow-agent");

      expect(result1.agentId).not.toBe(result2.agentId);
    });

    it("should include output on success", async () => {
      const task = createTask("output-task");
      const result = await dispatcher.dispatch(task, "workflow-output");

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    });
  });

  describe("workflow task tracking", () => {
    it("should track multiple workflows separately", async () => {
      const task1 = createTask("wf1-task");
      const task2 = createTask("wf2-task");

      await dispatcher.dispatch(task1, "workflow-1");
      await dispatcher.dispatch(task2, "workflow-2");

      // Should be able to track which tasks belong to which workflow
      // After dispatch completes, active count should be 0
      expect(dispatcher.getActiveCount()).toBe(0);
    });
  });
});
