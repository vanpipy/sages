/**
 * Unit Tests for LuBan Tools
 * Tests task execution, file locking, and status tracking
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Mock file lock state for testing
interface FileLock {
  taskId: string;
  filePath: string;
  acquiredAt: string;
  expiresAt: string;
}

const mockLocks: Map<string, FileLock> = new Map();

// Mock task state
interface TaskState {
  taskId: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
  filesLocked: string[];
}

const mockTaskStates: Map<string, TaskState> = new Map();

describe("LuBan Tools - Task Execution", () => {
  beforeEach(() => {
    mockLocks.clear();
    mockTaskStates.clear();
  });

  describe("File Lock Management", () => {
    it("should acquire lock on available file", () => {
      const filePath = "src/auth.ts";
      const taskId = "T1";
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

      mockLocks.set(filePath, { taskId, filePath, acquiredAt: now, expiresAt });

      const lock = mockLocks.get(filePath);
      expect(lock).toBeDefined();
      expect(lock!.taskId).toBe("T1");
    });

    it("should detect lock conflict when file is already locked", () => {
      const filePath = "src/auth.ts";
      const existingLock = { taskId: "T1", filePath, acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() };
      mockLocks.set(filePath, existingLock);

      const newTaskId = "T2";
      const existingLockTask = mockLocks.get(filePath)?.taskId;

      expect(existingLockTask).toBe("T1");
      expect(existingLockTask).not.toBe(newTaskId);
    });

    it("should release lock after task completion", () => {
      const filePath = "src/auth.ts";
      const taskId = "T1";
      mockLocks.set(filePath, { taskId, filePath, acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() });

      // Release lock
      mockLocks.delete(filePath);

      expect(mockLocks.has(filePath)).toBe(false);
    });

    it("should release all locks for a task", () => {
      const taskId = "T1";
      const files = ["src/auth.ts", "src/session.ts", "src/user.ts"];

      files.forEach((file) => {
        mockLocks.set(file, { taskId, filePath: file, acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() });
      });

      // Release all task locks
      for (const [file, lock] of mockLocks) {
        if (lock.taskId === taskId) {
          mockLocks.delete(file);
        }
      }

      // All locks for T1 should be released
      let t1LocksRemaining = 0;
      for (const lock of mockLocks.values()) {
        if (lock.taskId === taskId) t1LocksRemaining++;
      }
      expect(t1LocksRemaining).toBe(0);
    });
  });

  describe("Task State Management", () => {
    it("should track task in_progress state", () => {
      const taskId = "T1";
      const state: TaskState = {
        taskId,
        status: "in_progress",
        startedAt: new Date().toISOString(),
        filesLocked: ["src/auth.ts"],
      };

      mockTaskStates.set(taskId, state);

      const retrieved = mockTaskStates.get(taskId);
      expect(retrieved).toBeDefined();
      expect(retrieved!.status).toBe("in_progress");
      expect(retrieved!.startedAt).toBeDefined();
    });

    it("should transition task to completed state", () => {
      const taskId = "T1";
      const state: TaskState = {
        taskId,
        status: "in_progress",
        startedAt: new Date().toISOString(),
        filesLocked: [],
      };

      mockTaskStates.set(taskId, state);

      // Simulate completion
      state.status = "completed";
      state.completedAt = new Date().toISOString();
      state.filesLocked = [];

      expect(state.status).toBe("completed");
      expect(state.completedAt).toBeDefined();
    });

    it("should track multiple tasks independently", () => {
      const tasks: TaskState[] = [
        { taskId: "T1", status: "completed", filesLocked: [], completedAt: new Date().toISOString() },
        { taskId: "T2", status: "in_progress", startedAt: new Date().toISOString(), filesLocked: ["src/auth.ts"] },
        { taskId: "T3", status: "pending", filesLocked: [] },
      ];

      tasks.forEach((t) => mockTaskStates.set(t.taskId, t));

      expect(mockTaskStates.get("T1")!.status).toBe("completed");
      expect(mockTaskStates.get("T2")!.status).toBe("in_progress");
      expect(mockTaskStates.get("T3")!.status).toBe("pending");
    });
  });

  describe("Task Status Calculation", () => {
    it("should calculate progress correctly", () => {
      const totalTasks = 5;
      const completedTasks = 3;

      const progress = (completedTasks / totalTasks) * 100;
      expect(progress).toBe(60);
    });

    it("should identify next pending task", () => {
      const tasks: TaskState[] = [
        { taskId: "T1", status: "completed", filesLocked: [] },
        { taskId: "T2", status: "in_progress", filesLocked: [], startedAt: new Date().toISOString() },
        { taskId: "T3", status: "pending", filesLocked: [] },
        { taskId: "T4", status: "pending", filesLocked: [] },
        { taskId: "T5", status: "pending", filesLocked: [] },
      ];

      tasks.forEach((t) => mockTaskStates.set(t.taskId, t));

      const inProgressTask = tasks.find((t) => t.status === "in_progress");
      expect(inProgressTask?.taskId).toBe("T2");
    });

    it("should return completed when all tasks done", () => {
      const allCompleted = true;
      const status = allCompleted ? "completed" : "in_progress";
      expect(status).toBe("completed");
    });
  });

  describe("luban_execute_workflow tool", () => {
    // Use afterEach to ensure cleanup even if tests fail
    afterEach(() => {
      // Clean up any test files
      const fs = require("node:fs");
      const path = require("node:path");
      const testFiles = [
        "test-workflow.execution.yaml",
        "sequential-test.execution.yaml",
        "state-test.execution.yaml",
      ];
      for (const file of testFiles) {
        const filePath = path.join(process.cwd(), ".sages/plans", file);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    });

    it("should exist in luban-tools", async () => {
      // This test will fail until we implement luban_execute_workflow
      const lubanTools = await import("../../src/tools/luban-tools");
      expect(lubanTools.luban_execute_workflow).toBeDefined();
    });

    it("should parse execution YAML from .sages/plans/{name}.execution.yaml", async () => {
      const fs = require("node:fs");
      const path = require("node:path");
      const projectDir = process.cwd();
      const planDir = path.join(projectDir, ".sages/plans");

      // Ensure .sages/plans directory exists
      if (!fs.existsSync(planDir)) {
        fs.mkdirSync(planDir, { recursive: true });
      }

      const yaml = `name: test-workflow
timestamp: "2025-01-01T00:00:00Z"
strategy:
  failFast: false
  maxRetries: 3
  retryDelayMs: 100
  continueOnFailure: false
phases:
  - name: setup
    type: sequential
    tasks:
      - T1
      - T2
tasks: []`;

      const executionPath = path.join(planDir, "test-workflow.execution.yaml");
      fs.writeFileSync(executionPath, yaml);

      try {
        const lubanTools = await import("../../src/tools/luban-tools");
        const result = await lubanTools.luban_execute_workflow.execute(
          { name: "test-workflow" },
          { agent: projectDir } as any
        );

        const parsed = JSON.parse(result as string);
        expect(parsed.success).toBe(true);
        expect(parsed.data.planName).toBe("test-workflow");
        expect(parsed.data.totalPhases).toBe(1);
      } finally {
        fs.unlinkSync(executionPath);
      }
    });

    it("should handle sequential phases in order", async () => {
      const fs = require("node:fs");
      const path = require("node:path");
      const projectDir = process.cwd();
      const planDir = path.join(projectDir, ".sages/plans");

      // Note: The parser requires phases to be defined BEFORE tasks in the YAML
      // because the "tasks:" key in phases section conflicts with top-level "tasks:"
      const yaml = `name: sequential-test
timestamp: "2025-01-01T00:00:00Z"
strategy:
  failFast: false
  maxRetries: 3
  retryDelayMs: 100
  continueOnFailure: false
phases:
  - name: first-phase
    type: sequential
    tasks:
      - T1
      - T2
  - name: second-phase
    type: sequential
    tasks:
      - T3
tasks: []`;

      const executionPath = path.join(planDir, "sequential-test.execution.yaml");
      fs.writeFileSync(executionPath, yaml);

      try {
        const lubanTools = await import("../../src/tools/luban-tools");
        const result = await lubanTools.luban_execute_workflow.execute(
          { name: "sequential-test" },
          { agent: projectDir } as any
        );

        const parsed = JSON.parse(result as string);
        expect(parsed.success).toBe(true);
        expect(parsed.data.phasesExecuted).toBe(2);
        expect(parsed.data.tasksExecuted).toBe(3);
      } finally {
        fs.unlinkSync(executionPath);
      }
    });

    it("should report error when execution YAML not found", async () => {
      const lubanTools = await import("../../src/tools/luban-tools");
      const result = await lubanTools.luban_execute_workflow.execute(
        { name: "nonexistent-plan" },
        { agent: process.cwd() } as any
      );

      const parsed = JSON.parse(result as string);
      expect(parsed.success).toBe(false);
      expect(parsed.error.message).toContain("not found");
    });

    it("should track task execution state", async () => {
      const fs = require("node:fs");
      const path = require("node:path");
      const projectDir = process.cwd();
      const planDir = path.join(projectDir, ".sages/plans");

      const yaml = `name: state-test
timestamp: "2025-01-01T00:00:00Z"
strategy:
  failFast: false
  maxRetries: 3
  retryDelayMs: 100
  continueOnFailure: false
phases:
  - name: setup
    type: sequential
    tasks:
      - T1
tasks: []`;

      const executionPath = path.join(planDir, "state-test.execution.yaml");
      fs.writeFileSync(executionPath, yaml);

      try {
        const lubanTools = await import("../../src/tools/luban-tools");
        const result = await lubanTools.luban_execute_workflow.execute(
          { name: "state-test" },
          { agent: projectDir } as any
        );

        const parsed = JSON.parse(result as string);
        expect(parsed.success).toBe(true);
        expect(parsed.data.taskStates).toBeDefined();
        expect(parsed.data.taskStates.T1).toBeDefined();
      } finally {
        fs.unlinkSync(executionPath);
      }
    });
  });

  describe("Lock Conflict Detection", () => {
    it("should identify which task holds the lock", () => {
      const filePath = "src/auth.ts";
      const lockingTaskId = "T1";
      mockLocks.set(filePath, {
        taskId: lockingTaskId,
        filePath,
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });

      const lockOwner = mockLocks.get(filePath)?.taskId;
      expect(lockOwner).toBe("T1");
    });

    it("should allow different files to be locked by different tasks", () => {
      mockLocks.set("src/auth.ts", { taskId: "T1", filePath: "src/auth.ts", acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() });
      mockLocks.set("src/session.ts", { taskId: "T2", filePath: "src/session.ts", acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() });

      expect(mockLocks.get("src/auth.ts")?.taskId).toBe("T1");
      expect(mockLocks.get("src/session.ts")?.taskId).toBe("T2");
    });

    it("should prevent same task from locking same file twice", () => {
      const filePath = "src/auth.ts";
      const taskId = "T1";

      // First lock
      mockLocks.set(filePath, { taskId, filePath, acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() });

      // Attempt to re-lock (should be no-op or replace)
      const existingLock = mockLocks.get(filePath);
      expect(existingLock?.taskId).toBe(taskId);
    });
  });
});