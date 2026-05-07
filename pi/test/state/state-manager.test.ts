/**
 * Unit Tests for StateManager
 * Tests workflow state persistence, recovery, and workspace management
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StateManager, type WorkflowState, type Task, type AuditResult } from "../../src/state/state-manager";

describe("StateManager", () => {
  let manager: StateManager;
  let testDir: string;

  beforeEach(() => {
    testDir = join("/tmp", `sages-state-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    manager = new StateManager(testDir);
  });

  afterEach(() => {
    // Cleanup
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("constructor", () => {
    it("should create instance with cwd", () => {
      expect(manager).toBeDefined();
    });

    it("should return workspace path", () => {
      const path = manager.getWorkspacePath();
      expect(path).toContain(".sages/workspace");
    });
  });

  describe("workflow phases", () => {
    it("should have valid phase values", () => {
      const phases: WorkflowState["phase"][] = [
        "idle",
        "design",
        "review",
        "plan",
        "execute",
        "audit",
        "complete",
      ];

      phases.forEach(phase => {
        const state: WorkflowState = {
          id: "test",
          phase,
          planName: "test",
          request: "test request",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        expect(state.phase).toBe(phase);
      });
    });

    it("should transition through workflow correctly", () => {
      const phaseOrder: WorkflowState["phase"][] = [
        "idle",
        "design",
        "review",
        "plan",
        "execute",
        "audit",
        "complete",
      ];

      // Verify phase order is logical
      expect(phaseOrder.indexOf("design")).toBeLessThan(phaseOrder.indexOf("review"));
      expect(phaseOrder.indexOf("review")).toBeLessThan(phaseOrder.indexOf("plan"));
      expect(phaseOrder.indexOf("plan")).toBeLessThan(phaseOrder.indexOf("execute"));
      expect(phaseOrder.indexOf("execute")).toBeLessThan(phaseOrder.indexOf("audit"));
    });
  });

  describe("create workflow", () => {
    it("should create new workflow state", () => {
      const state = manager.create("test-plan", "Build user auth");
      
      expect(state.id).toBeTruthy();
      expect(state.planName).toBe("test-plan");
      expect(state.request).toBe("Build user auth");
      expect(state.phase).toBe("design");
      expect(state.createdAt).toBeTruthy();
    });

    it("should generate ID with sages prefix", () => {
      const state = manager.create("plan1", "Request 1");
      
      // IDs should start with "sages-"
      expect(state.id.startsWith("sages-")).toBe(true);
    });
  });

  describe("save and load state", () => {
    it("should save and load workflow state", () => {
      const created = manager.create("test-plan", "Test request");
      const loaded = manager.load(created.id);
      
      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe(created.id);
      expect(loaded?.planName).toBe("test-plan");
    });

    it("should return null for non-existent ID", () => {
      const loaded = manager.load("non-existent-id");
      expect(loaded).toBeNull();
    });
  });

  describe("update phase", () => {
    it("should update workflow phase", () => {
      manager.create("test", "Test");
      manager.updatePhase("review");
      
      const state = manager.getState();
      expect(state?.phase).toBe("review");
    });
  });

  describe("task management", () => {
    it("should set tasks", () => {
      manager.create("test", "Test");
      const tasks: Task[] = [
        { id: "T1", description: "Task 1", status: "pending", priority: "high", dependsOn: [], files: [] },
        { id: "T2", description: "Task 2", status: "pending", priority: "medium", dependsOn: ["T1"], files: [] },
      ];
      
      manager.setTasks(tasks);
      const state = manager.getState();
      
      expect(state?.tasks).toHaveLength(2);
      expect(state?.tasks?.[0].id).toBe("T1");
    });

    it("should update task status", () => {
      manager.create("test", "Test");
      const tasks: Task[] = [
        { id: "T1", description: "Task 1", status: "pending", priority: "high", dependsOn: [], files: [] },
      ];
      
      manager.setTasks(tasks);
      manager.updateTaskStatus("T1", "completed");
      
      const state = manager.getState();
      expect(state?.tasks?.[0].status).toBe("completed");
    });

    it("should get current task", () => {
      manager.create("test", "Test");
      const tasks: Task[] = [
        { id: "T1", description: "Task 1", status: "pending", priority: "high", dependsOn: [], files: [] },
        { id: "T2", description: "Task 2", status: "pending", priority: "medium", dependsOn: [], files: [] },
      ];
      
      manager.setTasks(tasks);
      const currentTask = manager.getCurrentTask();
      
      expect(currentTask?.id).toBe("T1");
    });

    it("should advance to next task", () => {
      manager.create("test", "Test");
      const tasks: Task[] = [
        { id: "T1", description: "Task 1", status: "completed", priority: "high", dependsOn: [], files: [] },
        { id: "T2", description: "Task 2", status: "pending", priority: "medium", dependsOn: [], files: [] },
      ];
      
      manager.setTasks(tasks);
      manager.advanceTask();
      
      const currentTask = manager.getCurrentTask();
      expect(currentTask?.id).toBe("T2");
    });
  });

  describe("audit result", () => {
    it("should set audit result", () => {
      manager.create("test", "Test");
      const audit: AuditResult = {
        verdict: "PASS",
        qualityScore: 95,
        checks: { quality: true, security: true },
        timestamp: new Date().toISOString(),
      };
      
      manager.setAuditResult(audit);
      const state = manager.getState();
      
      expect(state?.auditResult?.verdict).toBe("PASS");
      expect(state?.auditResult?.qualityScore).toBe(95);
    });
  });

  describe("complete workflow", () => {
    it("should mark workflow as complete", () => {
      manager.create("test", "Test");
      manager.complete();
      
      const state = manager.getState();
      expect(state?.phase).toBe("complete");
    });
  });

  describe("workspace files", () => {
    it("should return existing workspace files", () => {
      // Create workspace dir with files
      const workspace = join(testDir, ".sages/workspace");
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, "draft.md"), "# Draft");
      writeFileSync(join(workspace, "plan.md"), "# Plan");
      
      const files = manager.getWorkspaceFiles();
      
      expect(files.draft).toBeTruthy();
      expect(files.plan).toBeTruthy();
    });
  });

  describe("archive", () => {
    it("should return null when no current state", () => {
      const result = manager.archive();
      expect(result).toBeNull();
    });

    it("should create archive directory", () => {
      manager.create("test-plan", "Test");
      
      const archivePath = manager.archive();
      
      expect(archivePath).not.toBeNull();
      expect(existsSync(archivePath!)).toBe(true);
    });

    it("should clear workspace after archive", () => {
      manager.create("test", "Test");
      const workspace = join(testDir, ".sages/workspace");
      writeFileSync(join(workspace, "draft.md"), "# Draft");
      writeFileSync(join(workspace, "state.json"), '{"id":"test"}');
      
      manager.archive();
      
      // State file should be deleted after archive
      const stateExists = existsSync(join(workspace, "state.json"));
      expect(stateExists).toBe(false);
    });
  });

  describe("list archives", () => {
    it("should return empty array when no archives", () => {
      const archives = manager.listArchives("non-existent");
      expect(archives).toHaveLength(0);
    });

    it("should list archived plans", () => {
      const plans = manager.listArchivedPlans();
      expect(Array.isArray(plans)).toBe(true);
    });
  });

  describe("restore", () => {
    it("should return false for non-existent archive", () => {
      const result = manager.restore("non-existent", "timestamp");
      expect(result).toBe(false);
    });
  });

  describe("delete state", () => {
    it("should delete workflow state", () => {
      const state = manager.create("test", "Test");
      
      manager.delete(state.id);
      
      const loaded = manager.load(state.id);
      expect(loaded).toBeNull();
    });
  });
});

describe("WorkflowState", () => {
  it("should have required fields", () => {
    const state: WorkflowState = {
      id: "test-id",
      phase: "design",
      planName: "test-plan",
      request: "test request",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    expect(state.id).toBe("test-id");
    expect(state.phase).toBe("design");
    expect(state.planName).toBe("test-plan");
  });

  it("should have optional task fields", () => {
    const state: WorkflowState = {
      id: "test",
      phase: "execute",
      planName: "test",
      request: "test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [
        { id: "T1", description: "Task", status: "completed", priority: "high", dependsOn: [], files: [] },
      ],
      currentTaskIndex: 1,
    };
    
    expect(state.tasks).toHaveLength(1);
    expect(state.currentTaskIndex).toBe(1);
  });
});

describe("Task", () => {
  it("should have required fields", () => {
    const task: Task = {
      id: "T1",
      description: "Implement feature",
      status: "pending",
      priority: "high",
      dependsOn: [],
      files: [],
    };
    
    expect(task.id).toBe("T1");
    expect(task.status).toBe("pending");
  });

  it("should have valid status values", () => {
    const statuses: Task["status"][] = ["pending", "in_progress", "completed", "failed"];
    
    statuses.forEach(status => {
      const task: Task = {
        id: "T1",
        description: "Test",
        status,
        priority: "high",
        dependsOn: [],
        files: [],
      };
      expect(task.status).toBe(status);
    });
  });
});

describe("AuditResult", () => {
  it("should have valid verdict values", () => {
    const verdicts: AuditResult["verdict"][] = ["PASS", "NEEDS_CHANGES", "REJECTED"];
    
    verdicts.forEach(verdict => {
      const audit: AuditResult = {
        verdict,
        qualityScore: 85,
        checks: {},
        timestamp: new Date().toISOString(),
      };
      expect(audit.verdict).toBe(verdict);
    });
  });

  it("should have quality score 0-100", () => {
    const audit: AuditResult = {
      verdict: "PASS",
      qualityScore: 95,
      checks: { quality: true },
      timestamp: new Date().toISOString(),
    };
    
    expect(audit.qualityScore).toBeGreaterThanOrEqual(0);
    expect(audit.qualityScore).toBeLessThanOrEqual(100);
  });
});
