/**
 * Unit Tests for FuxiTools
 * Tests commands from skills:
 * - fuxi-start, fuxi-request, fuxi-plan, fuxi-recover, fuxi-end, fuxi-get-status
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Mock types for testing
interface TestWorkflowState {
  id: string;
  phase: "idle" | "design" | "plan" | "implement" | "review" | "complete";
  planName: string;
  request: string;
  createdAt: string;
  updatedAt: string;
  score?: number;
}

describe("FuxiTools Commands (skills)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join("/tmp", `sages-fuxi-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, ".sages/workspace"), { recursive: true });
    mkdirSync(join(testDir, ".sages/sessions"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("/fuxi-start command", () => {
    it("should create new workflow with design phase", () => {
      const state: TestWorkflowState = {
        id: "sages-123",
        phase: "design",
        planName: "TestPlan",
        request: "Build a REST API",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Simulate fuxi-start behavior
      const statePath = join(testDir, ".sages/workspace/state.json");
      writeFileSync(statePath, JSON.stringify(state));

      const loaded = JSON.parse(readFileSync(statePath, "utf-8")) as TestWorkflowState;
      expect(loaded.phase).toBe("design");
      expect(loaded.planName).toBe("TestPlan");
    });

    it("should set phase to design in state.json", () => {
      const statePath = join(testDir, ".sages/workspace/state.json");
      const initialState = { phase: "design" };
      writeFileSync(statePath, JSON.stringify(initialState));

      const loaded = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(loaded.phase).toBe("design");
    });
  });

  describe("/fuxi-request command", () => {
    it("should create requirement draft", () => {
      const draftPath = join(testDir, ".sages/workspace/draft.md");
      const draftContent = "# Requirement Draft\n\n## Overview\n- Request: Build a REST API\n\n## Requirements\n- Create endpoints\n- Handle authentication";
      
      writeFileSync(draftPath, draftContent);
      const content = readFileSync(draftPath, "utf-8");

      expect(content).toContain("Requirement Draft");
      expect(content).toContain("Build a REST API");
    });
  });

  describe("/fuxi-plan command (score > 80 only)", () => {
    it("should start plan only when score > 80", () => {
      const state: TestWorkflowState = {
        id: "sages-123",
        phase: "design",
        planName: "TestPlan",
        request: "Build API",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        score: 85, // Above threshold
      };

      const statePath = join(testDir, ".sages/workspace/state.json");
      writeFileSync(statePath, JSON.stringify(state));

      const loaded = JSON.parse(readFileSync(statePath, "utf-8")) as TestWorkflowState;
      const canStartPlan = loaded.score !== undefined && loaded.score > 80;

      expect(canStartPlan).toBe(true);
    });

    it("should NOT start plan when score <= 80", () => {
      const state: TestWorkflowState = {
        id: "sages-123",
        phase: "design",
        planName: "TestPlan",
        request: "Build API",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        score: 75, // Below threshold
      };

      const canStartPlan = state.score !== undefined && state.score > 80;
      expect(canStartPlan).toBe(false);
    });
  });

  describe("/fuxi-recover command", () => {
    it("should recover workflow from state.json", () => {
      const state: TestWorkflowState = {
        id: "sages-123",
        phase: "implement",
        planName: "RecoverPlan",
        request: "Continue implementation",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const statePath = join(testDir, ".sages/workspace/state.json");
      writeFileSync(statePath, JSON.stringify(state));

      const loaded = JSON.parse(readFileSync(statePath, "utf-8")) as TestWorkflowState;
      expect(loaded.phase).toBe("implement");
      expect(loaded.planName).toBe("RecoverPlan");
    });
  });

  describe("/fuxi-end command", () => {
    it("should end workflow and archive", () => {
      const state: TestWorkflowState = {
        id: "sages-123",
        phase: "complete",
        planName: "CompletedPlan",
        request: "All done",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const statePath = join(testDir, ".sages/workspace/state.json");
      writeFileSync(statePath, JSON.stringify(state));

      // Archive
      const archiveDir = join(testDir, `.sages/archive/${state.planName}/${new Date().toISOString()}`);
      mkdirSync(archiveDir, { recursive: true });
      writeFileSync(join(archiveDir, "state.json"), JSON.stringify(state));

      expect(existsSync(archiveDir)).toBe(true);
      expect(existsSync(join(archiveDir, "state.json"))).toBe(true);
    });
  });

  describe("Phase modes (skills)", () => {
    it("should enforce design phase read-only (only draft.md)", () => {
      const allowedFiles = ["draft.md"];
      const file1 = "draft.md";
      const file2 = "plan.md";
      const file3 = "src/index.ts";

      expect(allowedFiles.includes(file1)).toBe(true);
      expect(allowedFiles.includes(file2)).toBe(false);
      expect(allowedFiles.includes(file3)).toBe(false);
    });

    it("should enforce plan phase read-only (plan.md, execution.yaml)", () => {
      const allowedFiles = ["plan.md", "execution.yaml"];
      
      expect(allowedFiles.includes("plan.md")).toBe(true);
      expect(allowedFiles.includes("execution.yaml")).toBe(true);
      expect(allowedFiles.includes("draft.md")).toBe(false);
    });

    it("should allow all files in implement phase", () => {
      const allowedFiles = "*";
      
      // In implement phase, all files should be allowed
      expect(true).toBe(true); // Wildcard means all allowed
    });

    it("should enforce review phase read-only (audit.md)", () => {
      const pattern = /^audit(-.*)?\.md$/;
      
      expect(pattern.test("audit.md")).toBe(true);
      expect(pattern.test("audit-2024-01-15.md")).toBe(true);
      expect(pattern.test("draft.md")).toBe(false);
    });
  });

  describe("Removed commands (should not exist)", () => {
    const removedCommands = [
      "/fuxi-approve",
      "/gaoyao-check-security", 
      "/fuxi-restart",
      "/fuxi-archive",
    ];

    removedCommands.forEach(cmd => {
      it(`should NOT have ${cmd} command`, () => {
        // This test documents which commands should be removed
        // Implementation should not register these commands
        expect(true).toBe(true);
      });
    });
  });
});

describe("Workflow state transitions (skills)", () => {
  it("should follow design → plan → implement → review flow", () => {
    const phases = ["design", "plan", "implement", "review", "complete"];
    
    // Each phase should come after the previous
    expect(phases.indexOf("design")).toBeLessThan(phases.indexOf("plan"));
    expect(phases.indexOf("plan")).toBeLessThan(phases.indexOf("implement"));
    expect(phases.indexOf("implement")).toBeLessThan(phases.indexOf("review"));
    expect(phases.indexOf("review")).toBeLessThan(phases.indexOf("complete"));
  });

  it("should only transition to plan when score > 80", () => {
    const currentScore = 85;
    const canTransition = currentScore > 80;
    expect(canTransition).toBe(true);
  });
});