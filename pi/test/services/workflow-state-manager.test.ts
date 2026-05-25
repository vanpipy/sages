/**
 * WorkflowStateManager Tests
 * 
 * TDD RED Phase: Write tests first
 * These tests define expected behavior for WorkflowStateManager
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

describe("WorkflowStateManager", () => {
  const testDir = join(process.cwd(), ".test-temp-wfm");

  // Helper to clean up test directory
  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    // Create .sages directories
    mkdirSync(join(testDir, ".sages", "sessions"), { recursive: true });
    mkdirSync(join(testDir, ".sages", "archive"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("create", () => {
    it("should create a new workflow state", async () => {
      const { WorkflowStateManager } = await import("../../src/services/workflow-state-manager.js");
      const manager = new WorkflowStateManager(testDir);
      
      const state = manager.create("test-plan", "Test request");
      
      expect(state).toBeDefined();
      expect(state.planName).toBe("test-plan");
      expect(state.request).toBe("Test request");
      expect(state.phase).toBe("design");
      expect(state.id).toBeDefined();
    });
  });

  describe("save/load", () => {
    it("should save and load workflow state", async () => {
      const { WorkflowStateManager } = await import("../../src/services/workflow-state-manager.js");
      const manager = new WorkflowStateManager(testDir);
      
      const created = manager.create("test-plan", "Test request");
      created.phase = "plan";
      manager.save(created);
      
      const loaded = manager.loadLatest();
      
      expect(loaded).toBeDefined();
      expect(loaded?.planName).toBe("test-plan");
      expect(loaded?.phase).toBe("plan");
    });
  });

  describe("phase management", () => {
    it("should update and retrieve phase", async () => {
      const { WorkflowStateManager } = await import("../../src/services/workflow-state-manager.js");
      const manager = new WorkflowStateManager(testDir);
      
      manager.create("test-plan", "Test request");
      
      manager.setPhase("plan");
      expect(manager.getPhase()).toBe("plan");
      
      manager.setPhase("implement");
      expect(manager.getPhase()).toBe("implement");
    });
  });

  describe("workspace files", () => {
    it("should write and read draft", async () => {
      const { WorkflowStateManager } = await import("../../src/services/workflow-state-manager.js");
      const manager = new WorkflowStateManager(testDir);
      
      manager.create("test-plan", "Test request");
      
      const draftContent = "# Draft Content";
      manager.writeDraft(draftContent);
      
      const read = manager.readDraft();
      expect(read).toBe(draftContent);
    });

    it("should write and read plan", async () => {
      const { WorkflowStateManager } = await import("../../src/services/workflow-state-manager.js");
      const manager = new WorkflowStateManager(testDir);
      
      manager.create("test-plan", "Test request");
      
      const planContent = "# Plan Content";
      manager.writePlan(planContent);
      
      const read = manager.readPlan();
      expect(read).toBe(planContent);
    });

    it("should write and read execution", async () => {
      const { WorkflowStateManager } = await import("../../src/services/workflow-state-manager.js");
      const manager = new WorkflowStateManager(testDir);
      
      manager.create("test-plan", "Test request");
      
      const execContent = "tasks:\n  - id: T1";
      manager.writeExecution(execContent);
      
      const read = manager.readExecution();
      expect(read).toBe(execContent);
    });
  });

  describe("archive", () => {
    it("should archive workflow to archive directory", async () => {
      const { WorkflowStateManager } = await import("../../src/services/workflow-state-manager.js");
      const manager = new WorkflowStateManager(testDir);
      
      manager.create("test-plan", "Test request");
      manager.writeDraft("# Draft");
      manager.writePlan("# Plan");
      manager.complete();
      
      const archivePath = manager.archive();
      
      expect(archivePath).toBeDefined();
      expect(archivePath).toContain("test-plan");
      expect(archivePath).toContain(".sages/archive");
    });

    it("should list archived workflows", async () => {
      const { WorkflowStateManager } = await import("../../src/services/workflow-state-manager.js");
      const manager = new WorkflowStateManager(testDir);
      
      manager.create("test-plan", "Test request");
      manager.complete();
      manager.archive();
      
      const archives = manager.listArchives("test-plan");
      
      expect(archives.length).toBeGreaterThan(0);
      expect(archives[0].timestamp).toBeDefined();
      expect(archives[0].path).toBeDefined();
    });
  });

  describe("restore", () => {
    it("should restore archived workflow to workspace", async () => {
      const { WorkflowStateManager } = await import("../../src/services/workflow-state-manager.js");
      const manager = new WorkflowStateManager(testDir);
      
      // Step 1: Create, write draft, complete, and archive
      manager.create("test-plan", "Test request");
      manager.writeDraft("# Draft Content");
      manager.complete();
      const archivePath = manager.archive();  // Explicitly archive
      expect(archivePath).toBeDefined();
      
      // Get archive info
      const archivesBefore = manager.listArchives("test-plan");
      expect(archivesBefore.length).toBeGreaterThan(0);
      const timestamp = archivesBefore[0].timestamp;
      
      // Step 2: Create a new workflow to clear the workspace
      manager.create("another-plan", "Another request");
      manager.writePlan("# New Plan");  // Different content
      
      // Step 3: Restore the archived workflow
      const restored = manager.restore("test-plan", timestamp);
      
      expect(restored).toBe(true);
      expect(manager.readDraft()).toBe("# Draft Content");
    });
  });

  describe("isWorkspaceEmpty", () => {
    it("should return true for empty workspace", async () => {
      const { WorkflowStateManager } = await import("../../src/services/workflow-state-manager.js");
      const manager = new WorkflowStateManager(testDir);
      
      expect(manager.isWorkspaceEmpty()).toBe(true);
    });

    it("should return false after writing files", async () => {
      const { WorkflowStateManager } = await import("../../src/services/workflow-state-manager.js");
      const manager = new WorkflowStateManager(testDir);
      
      manager.create("test-plan", "Test request");
      manager.writeDraft("# Draft");
      
      expect(manager.isWorkspaceEmpty()).toBe(false);
    });
  });
});
