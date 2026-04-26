/**
 * Unit Tests for StateManager
 * Tests workflow state persistence, crash recovery, and session management
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { StateManager } from "../../src/engine/state-manager";
import type { WorkflowExecutionState, WorkflowPhaseState, WorkflowTaskState } from "../../src/engine/types";
import { promises as fs, constants } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_DIR = join(tmpdir(), "sages-state-manager-test-" + Date.now());

function createMockState(workflowId: string, status: WorkflowExecutionState["status"] = "running"): WorkflowExecutionState {
  const task: WorkflowTaskState = {
    id: "task-1",
    status: "pending",
    attempts: 0,
  };
  const phase: WorkflowPhaseState = {
    name: "design",
    status: "pending",
    tasks: [task],
  };
  const now = new Date().toISOString();
  return {
    workflowId,
    status,
    currentPhase: 1,
    currentTaskIndex: 0,
    phases: [phase],
    startedAt: now,
    updatedAt: now,
  };
}

describe("StateManager", () => {
  let manager: StateManager;

  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("constructor", () => {
    it("should create StateManager with default session path", () => {
      const manager = new StateManager();
      expect(manager).toBeDefined();
    });

    it("should create StateManager with custom session path", () => {
      const manager = new StateManager(join(TEST_DIR, "custom.json"));
      expect(manager).toBeDefined();
    });
  });

  describe("loadState", () => {
    it("should return null when state file does not exist", async () => {
      const manager = new StateManager(join(TEST_DIR, "nonexistent.json"));
      const state = await manager.loadState();
      expect(state).toBeNull();
    });

    it("should load existing state from file", async () => {
      const filePath = join(TEST_DIR, "existing.json");
      const state = createMockState("workflow-1", "running");
      await fs.writeFile(filePath, JSON.stringify(state));

      const manager = new StateManager(filePath);
      const loaded = await manager.loadState();

      expect(loaded).not.toBeNull();
      expect(loaded!.workflowId).toBe("workflow-1");
      expect(loaded!.status).toBe("running");
    });

    it("should return null for corrupted JSON and backup file", async () => {
      const filePath = join(TEST_DIR, "corrupted.json");
      await fs.writeFile(filePath, '{"invalid json}');

      const manager = new StateManager(filePath);
      const state = await manager.loadState();

      expect(state).toBeNull();
      // Should have created backup
      const backupPath = filePath + ".backup";
      const backupExists = await fs.access(backupPath).then(() => true).catch(() => false);
      expect(backupExists).toBe(true);
    });
  });

  describe("saveState", () => {
    it("should save state to file", async () => {
      const filePath = join(TEST_DIR, "save.json");
      const state = createMockState("workflow-save", "running");

      const manager = new StateManager(filePath);
      await manager.saveState(state);

      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.workflowId).toBe("workflow-save");
      expect(parsed.status).toBe("running");
    });

    it("should overwrite existing state", async () => {
      const filePath = join(TEST_DIR, "overwrite.json");
      const state1 = createMockState("workflow-1", "running");
      const state2 = createMockState("workflow-2", "completed");

      await fs.writeFile(filePath, JSON.stringify(state1));

      const manager = new StateManager(filePath);
      await manager.saveState(state2);

      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.workflowId).toBe("workflow-2");
      expect(parsed.status).toBe("completed");
    });

    it("should create directory if it does not exist", async () => {
      const nestedPath = join(TEST_DIR, "nested", "deep", "state.json");
      const state = createMockState("workflow-nested", "pending");

      const manager = new StateManager(nestedPath);
      await manager.saveState(state);

      const content = await fs.readFile(nestedPath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.workflowId).toBe("workflow-nested");
    });
  });

  describe("clearState", () => {
    it("should delete state file", async () => {
      const filePath = join(TEST_DIR, "clear.json");
      const state = createMockState("workflow-clear", "running");
      await fs.writeFile(filePath, JSON.stringify(state));

      const manager = new StateManager(filePath);
      await manager.clearState();

      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it("should not throw when file does not exist", async () => {
      const manager = new StateManager(join(TEST_DIR, "nonexistent.json"));
      await expect(manager.clearState()).resolves.toBeUndefined();
    });
  });

  describe("getExecutionState", () => {
    it("should return null when no state loaded", () => {
      const manager = new StateManager(join(TEST_DIR, "get.json"));
      expect(manager.getExecutionState()).toBeNull();
    });

    it("should return cached state after loadState", async () => {
      const filePath = join(TEST_DIR, "cached.json");
      const state = createMockState("workflow-cache", "running");
      await fs.writeFile(filePath, JSON.stringify(state));

      const manager = new StateManager(filePath);
      await manager.loadState();
      const cached = manager.getExecutionState();

      expect(cached).not.toBeNull();
      expect(cached!.workflowId).toBe("workflow-cache");
    });

    it("should return cached state without additional file read", async () => {
      const filePath = join(TEST_DIR, "noclass.json");
      const state = createMockState("workflow-noclass", "paused");
      await fs.writeFile(filePath, JSON.stringify(state));

      const manager = new StateManager(filePath);
      await manager.loadState();

      // Access twice - second should be from cache
      const cached1 = manager.getExecutionState();
      const cached2 = manager.getExecutionState();

      expect(cached1).toEqual(cached2);
    });
  });

  describe("isWorkflowRunning", () => {
    it("should return false when state file does not exist", async () => {
      const manager = new StateManager(join(TEST_DIR, "notrunning.json"));
      const isRunning = await manager.isWorkflowRunning("workflow-xyz");
      expect(isRunning).toBe(false);
    });

    it("should return true for running workflow", async () => {
      const filePath = join(TEST_DIR, "running.json");
      const state = createMockState("workflow-running", "running");
      await fs.writeFile(filePath, JSON.stringify(state));

      const manager = new StateManager(filePath);
      const isRunning = await manager.isWorkflowRunning("workflow-running");

      expect(isRunning).toBe(true);
    });

    it("should return true for pending workflow", async () => {
      const filePath = join(TEST_DIR, "pending.json");
      const state = createMockState("workflow-pending", "pending");
      await fs.writeFile(filePath, JSON.stringify(state));

      const manager = new StateManager(filePath);
      const isRunning = await manager.isWorkflowRunning("workflow-pending");

      expect(isRunning).toBe(true);
    });

    it("should return false for completed workflow", async () => {
      const filePath = join(TEST_DIR, "completed.json");
      const state = createMockState("workflow-completed", "completed");
      await fs.writeFile(filePath, JSON.stringify(state));

      const manager = new StateManager(filePath);
      const isRunning = await manager.isWorkflowRunning("workflow-completed");

      expect(isRunning).toBe(false);
    });

    it("should return false for failed workflow", async () => {
      const filePath = join(TEST_DIR, "failed.json");
      const state = createMockState("workflow-failed", "failed");
      await fs.writeFile(filePath, JSON.stringify(state));

      const manager = new StateManager(filePath);
      const isRunning = await manager.isWorkflowRunning("workflow-failed");

      expect(isRunning).toBe(false);
    });

    it("should return false for different workflowId", async () => {
      const filePath = join(TEST_DIR, "different.json");
      const state = createMockState("workflow-a", "running");
      await fs.writeFile(filePath, JSON.stringify(state));

      const manager = new StateManager(filePath);
      const isRunning = await manager.isWorkflowRunning("workflow-b");

      expect(isRunning).toBe(false);
    });
  });

  describe("checkpoint", () => {
    it("should save state with timestamp and checkpointedAt field", async () => {
      // Session data dir is derived from session manifest path (.json -> .d)
      const sessionManifestPath = join(TEST_DIR, "checkpoint.json");
      const sessionDataDir = join(TEST_DIR, "checkpoint.d");
      const state = createMockState("workflow-checkpoint", "running");

      const manager = new StateManager(sessionManifestPath);
      await manager.checkpoint(state);

      // Check session directory was created
      const workflowDir = join(sessionDataDir, "workflow-checkpoint");
      const entries = await fs.readdir(workflowDir);
      // Find the checkpoint file (state.{timestamp}.json)
      const checkpointFile = entries.find(e => e.startsWith("state.") && e.endsWith(".json"));
      expect(checkpointFile).toBeDefined();

      const stateFile = join(workflowDir, checkpointFile!);
      const content = await fs.readFile(stateFile, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.workflowId).toBe("workflow-checkpoint");
      expect(parsed.checkpointedAt).toBeDefined();
      expect(new Date(parsed.checkpointedAt)).toBeInstanceOf(Date);
    });

    it("should keep last 3 checkpoints", async () => {
      // Session data dir is derived from session manifest path (.json -> .d)
      const sessionManifestPath = join(TEST_DIR, "checkpoint-keep.json");
      const sessionDataDir = join(TEST_DIR, "checkpoint-keep.d");
      const state = createMockState("workflow-keep", "running");

      const manager = new StateManager(sessionManifestPath);

      // Create 5 checkpoints
      for (let i = 0; i < 5; i++) {
        state.currentPhase = i + 1;
        await manager.checkpoint(state);
      }

      // Should only have 3 checkpoint files (state.{timestamp}.json)
      const workflowDir = join(sessionDataDir, "workflow-keep");
      const entries = await fs.readdir(workflowDir);
      const checkpointFiles = entries.filter(e => e.startsWith("state.") && e.endsWith(".json"));
      expect(checkpointFiles.length).toBe(3);
    });
  });

  describe("listSessions", () => {
    it("should return empty array when no sessions exist", async () => {
      const manager = new StateManager(join(TEST_DIR, "nosessions.json"));
      const sessions = await manager.listSessions();
      expect(sessions).toEqual([]);
    });

    it("should list all workflow IDs in session directory", async () => {
      const sessionDir = join(TEST_DIR, "list-sessions.d");
      await fs.mkdir(join(sessionDir, "workflow-1"), { recursive: true });
      await fs.mkdir(join(sessionDir, "workflow-2"), { recursive: true });
      await fs.mkdir(join(sessionDir, "workflow-3"), { recursive: true });

      const manager = new StateManager(join(TEST_DIR, "list-sessions.json"));
      const sessions = await manager.listSessions();

      expect(sessions).toContain("workflow-1");
      expect(sessions).toContain("workflow-2");
      expect(sessions).toContain("workflow-3");
      expect(sessions.length).toBe(3);
    });
  });

  describe("deleteSession", () => {
    it("should delete session directory", async () => {
      const sessionDir = join(TEST_DIR, "delete-session.d");
      const workflowDir = join(sessionDir, "workflow-delete");
      await fs.mkdir(workflowDir, { recursive: true });
      await fs.writeFile(join(workflowDir, "state.json"), "{}");

      const manager = new StateManager(join(TEST_DIR, "delete-session.json"));
      await manager.deleteSession("workflow-delete");

      const exists = await fs.access(workflowDir).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it("should not throw when session does not exist", async () => {
      const manager = new StateManager(join(TEST_DIR, "delete-nonexistent.json"));
      await expect(manager.deleteSession("nonexistent")).resolves.toBeUndefined();
    });
  });
});
