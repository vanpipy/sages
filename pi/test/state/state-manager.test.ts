/**
 * Unit Tests for StateManager with Phase-Based Mode
 * Tests workflow state with mode restrictions as per desc.md
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StateManager, type WorkflowState, type Task } from "../../src/state/state-manager";

describe("StateManager", () => {
  let manager: StateManager;
  let testDir: string;

  beforeEach(() => {
    testDir = join("/tmp", `sages-state-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    manager = new StateManager(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("workflow phases (desc.md)", () => {
    const validPhases = [
      "idle",
      "design",     // read-only, only draft.md
      "plan",       // read-only, plan.md + execution.yaml
      "implement",  // writeable, all files
      "review",     // read-only, report-{time}.md
      "complete",
    ];

    it("should support all phases from desc.md", () => {
      validPhases.forEach(phase => {
        const state: WorkflowState = {
          id: "test",
          phase: phase as WorkflowState["phase"],
          planName: "test",
          request: "test request",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        expect(state.phase).toBe(phase);
      });
    });
  });

  describe("create workflow (design phase)", () => {
    it("should create new workflow in design phase", () => {
      const state = manager.create("test-plan", "Build user auth");
      
      expect(state.id).toBeTruthy();
      expect(state.planName).toBe("test-plan");
      expect(state.request).toBe("Build user auth");
      expect(state.phase).toBe("design");
      expect(state.createdAt).toBeTruthy();
    });

    it("should generate ID with sages prefix", () => {
      const state = manager.create("plan1", "Request 1");
      expect(state.id.startsWith("sages-")).toBe(true);
    });
  });

  describe("phase transitions (desc.md flow)", () => {
    it("should transition from design to plan", () => {
      manager.create("test", "Test");
      manager.updatePhase("plan");
      
      const state = manager.getState();
      expect(state?.phase).toBe("plan");
    });

    it("should transition from plan to implement", () => {
      manager.create("test", "Test");
      manager.updatePhase("implement");
      
      const state = manager.getState();
      expect(state?.phase).toBe("implement");
    });

    it("should transition from implement to review", () => {
      manager.create("test", "Test");
      manager.updatePhase("implement");
      manager.updatePhase("review");
      
      const state = manager.getState();
      expect(state?.phase).toBe("review");
    });

    it("should complete workflow", () => {
      manager.create("test", "Test");
      manager.complete();
      
      const state = manager.getState();
      expect(state?.phase).toBe("complete");
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
  });

  describe("workspace files", () => {
    it("should return existing workspace files", () => {
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

describe("WorkflowState types", () => {
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

  it("should support implement phase (desc.md)", () => {
    const state: WorkflowState = {
      id: "test",
      phase: "implement",
      planName: "test",
      request: "test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    expect(state.phase).toBe("implement");
  });

  it("should support review phase (desc.md)", () => {
    const state: WorkflowState = {
      id: "test",
      phase: "review",
      planName: "test",
      request: "test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    expect(state.phase).toBe("review");
  });
});

describe("Task types", () => {
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