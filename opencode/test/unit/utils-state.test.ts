/**
 * Unit Tests for state utilities
 * Tests workflow state loading, saving, and phase transitions
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadWorkflowState, saveWorkflowState, transitionPhase } from "../../src/utils/state";
import type { WorkflowState, Phase } from "../../src/types";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_DIR = join(tmpdir(), "sages-state-test-" + Date.now());

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe("loadWorkflowState", () => {
  it("should return default state when file does not exist", () => {
    const state = loadWorkflowState(join(TEST_DIR, "nonexistent.json"));

    expect(state.planName).toBe("");
    expect(state.status).toBe("idle");
    expect(state.hasDraft).toBe(false);
    expect(state.hasPlan).toBe(false);
    expect(state.hasExecution).toBe(false);
    expect(state.completedTasks).toBe(0);
    expect(state.totalTasks).toBe(0);
  });

  it("should load state from JSON file", () => {
    const filePath = join(TEST_DIR, "existing.json");
    const existingState: WorkflowState = {
      planName: "test-plan",
      status: "execution",
      hasDraft: true,
      hasPlan: true,
      hasExecution: true,
      currentPhase: "phase-1",
      completedTasks: 5,
      totalTasks: 10,
      nextTask: "T6"
    };
    writeFileSync(filePath, JSON.stringify(existingState));

    const state = loadWorkflowState(filePath);

    expect(state.planName).toBe("test-plan");
    expect(state.status).toBe("execution");
    expect(state.currentPhase).toBe("phase-1");
    expect(state.completedTasks).toBe(5);
    expect(state.totalTasks).toBe(10);
    expect(state.nextTask).toBe("T6");
  });

  it("should parse JSON state correctly", () => {
    const filePath = join(TEST_DIR, "parse-test.json");
    writeFileSync(filePath, '{"planName":"myplan","status":"plan","hasDraft":true,"hasPlan":false,"hasExecution":false,"completedTasks":0,"totalTasks":3}');

    const state = loadWorkflowState(filePath);

    expect(state.planName).toBe("myplan");
    expect(state.status).toBe("plan");
    expect(state.hasDraft).toBe(true);
    expect(state.hasPlan).toBe(false);
  });

  it("should throw error when file contains corrupted JSON", () => {
    const filePath = join(TEST_DIR, "corrupted.json");
    writeFileSync(filePath, '{"planName": "test", invalid}');

    expect(() => loadWorkflowState(filePath)).toThrow();
  });
});

describe("saveWorkflowState", () => {
  it("should save state to JSON file", () => {
    const filePath = join(TEST_DIR, "saved.json");
    const state: WorkflowState = {
      planName: "save-test",
      status: "draft",
      hasDraft: true,
      hasPlan: false,
      hasExecution: false,
      completedTasks: 0,
      totalTasks: 5
    };

    saveWorkflowState(state, filePath);

    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.planName).toBe("save-test");
    expect(parsed.status).toBe("draft");
  });

  it("should create directory if it does not exist", () => {
    const nestedPath = join(TEST_DIR, "nested", "deep", "state.json");
    const state: WorkflowState = {
      planName: "nested-test",
      status: "idle",
      hasDraft: false,
      hasPlan: false,
      hasExecution: false,
      completedTasks: 0,
      totalTasks: 0
    };

    saveWorkflowState(state, nestedPath);

    const content = readFileSync(nestedPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.planName).toBe("nested-test");
  });

  it("should overwrite existing file", () => {
    const filePath = join(TEST_DIR, "overwrite.json");
    writeFileSync(filePath, JSON.stringify({ planName: "old", status: "idle" }));

    const state: WorkflowState = {
      planName: "new",
      status: "execution",
      hasDraft: true,
      hasPlan: true,
      hasExecution: false,
      completedTasks: 2,
      totalTasks: 4
    };

    saveWorkflowState(state, filePath);

    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.planName).toBe("new");
    expect(parsed.status).toBe("execution");
  });
});

describe("transitionPhase", () => {
  it("should update currentPhase to new phase name", () => {
    const state: WorkflowState = {
      planName: "test",
      status: "execution",
      hasDraft: true,
      hasPlan: true,
      hasExecution: true,
      completedTasks: 3,
      totalTasks: 8
    };
    const phase: Phase = {
      name: "phase-1",
      tasks: ["T1", "T2"],
      type: "sequential"
    };

    const newState = transitionPhase(state, phase);

    expect(newState.currentPhase).toBe("phase-1");
  });

  it("should return new state object (immutable)", () => {
    const state: WorkflowState = {
      planName: "test",
      status: "execution",
      hasDraft: true,
      hasPlan: true,
      hasExecution: true,
      completedTasks: 3,
      totalTasks: 8
    };
    const phase: Phase = {
      name: "phase-1",
      tasks: ["T1"],
      type: "sequential"
    };

    const newState = transitionPhase(state, phase);

    expect(newState).not.toBe(state);
    expect(state.currentPhase).toBeUndefined();
  });

  it("should preserve other state properties", () => {
    const state: WorkflowState = {
      planName: "preserve-test",
      status: "execution",
      hasDraft: true,
      hasPlan: true,
      hasExecution: true,
      currentPhase: "old-phase",
      completedTasks: 5,
      totalTasks: 10,
      nextTask: "T6"
    };
    const phase: Phase = {
      name: "new-phase",
      tasks: ["T7", "T8"],
      type: "parallel"
    };

    const newState = transitionPhase(state, phase);

    expect(newState.planName).toBe("preserve-test");
    expect(newState.status).toBe("execution");
    expect(newState.hasDraft).toBe(true);
    expect(newState.hasPlan).toBe(true);
    expect(newState.hasExecution).toBe(true);
    expect(newState.completedTasks).toBe(5);
    expect(newState.totalTasks).toBe(10);
    expect(newState.nextTask).toBe("T6");
    expect(newState.currentPhase).toBe("new-phase");
  });

  it("should handle phase with different names", () => {
    const state: WorkflowState = {
      planName: "test",
      status: "draft",
      hasDraft: false,
      hasPlan: false,
      hasExecution: false,
      completedTasks: 0,
      totalTasks: 0
    };
    const phase: Phase = {
      name: "execution-phase",
      tasks: ["T1", "T2", "T3"],
      type: "parallel"
    };

    const newState = transitionPhase(state, phase);

    expect(newState.currentPhase).toBe("execution-phase");
  });
});