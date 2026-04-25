/**
 * Unit Tests for Fuxi Error Recovery State Machine
 * Tests workflow state transitions and error recovery logic
 */
import { describe, it, expect, beforeEach } from "bun:test";

describe("Fuxi Error Recovery State Machine", () => {
  describe("Workflow Phases", () => {
    type WorkflowPhase =
      | "INITIALIZING"
      | "DRAFTING"
      | "DRAFT_COMPLETE"
      | "QIAOCHUI_REVIEWING"
      | "QIAOCHUI_APPROVED"
      | "QIAOCHUI_REVISING"
      | "QIAOCHUI_REJECTED"
      | "USER_APPROVING"
      | "EXECUTING"
      | "COMPLETED"
      | "FAILED";

    const validPhases: WorkflowPhase[] = [
      "INITIALIZING",
      "DRAFTING",
      "DRAFT_COMPLETE",
      "QIAOCHUI_REVIEWING",
      "QIAOCHUI_APPROVED",
      "QIAOCHUI_REVISING",
      "QIAOCHUI_REJECTED",
      "USER_APPROVING",
      "EXECUTING",
      "COMPLETED",
      "FAILED",
    ];

    it("should have all expected phases defined", () => {
      expect(validPhases.length).toBe(11);
    });

    it("should have terminal states defined", () => {
      const terminalPhases = ["COMPLETED", "FAILED"];
      terminalPhases.forEach(phase => {
        expect(validPhases).toContain(phase);
      });
    });
  });

  describe("State Transitions", () => {
    type WorkflowPhase =
      | "INITIALIZING"
      | "DRAFTING"
      | "DRAFT_COMPLETE"
      | "QIAOCHUI_REVIEWING"
      | "QIAOCHUI_APPROVED"
      | "QIAOCHUI_REVISING"
      | "QIAOCHUI_REJECTED"
      | "USER_APPROVING"
      | "EXECUTING"
      | "COMPLETED"
      | "FAILED";

    interface WorkflowRecoveryState {
      currentPhase: WorkflowPhase;
      errors: Array<{ phase: WorkflowPhase; error: string; retries: number }>;
      planName: string;
    }

    function canTransition(from: WorkflowPhase, to: WorkflowPhase): boolean {
      const allowedTransitions: Record<WorkflowPhase, WorkflowPhase[]> = {
        INITIALIZING: ["DRAFTING", "FAILED"],
        DRAFTING: ["DRAFT_COMPLETE", "FAILED"],
        DRAFT_COMPLETE: ["QIAOCHUI_REVIEWING", "FAILED"],
        QIAOCHUI_REVIEWING: ["QIAOCHUI_APPROVED", "QIAOCHUI_REVISING", "QIAOCHUI_REJECTED", "FAILED"],
        QIAOCHUI_APPROVED: ["USER_APPROVING", "EXECUTING", "FAILED"],
        QIAOCHUI_REVISING: ["DRAFTING", "FAILED"],
        QIAOCHUI_REJECTED: ["FAILED"],
        USER_APPROVING: ["EXECUTING", "FAILED"],
        EXECUTING: ["COMPLETED", "FAILED"],
        COMPLETED: [],
        FAILED: [],
      };
      return allowedTransitions[from]?.includes(to) || false;
    }

    it("should allow INITIALIZING -> DRAFTING", () => {
      expect(canTransition("INITIALIZING", "DRAFTING")).toBe(true);
    });

    it("should allow DRAFTING -> DRAFT_COMPLETE", () => {
      expect(canTransition("DRAFTING", "DRAFT_COMPLETE")).toBe(true);
    });

    it("should allow DRAFT_COMPLETE -> QIAOCHUI_REVIEWING", () => {
      expect(canTransition("DRAFT_COMPLETE", "QIAOCHUI_REVIEWING")).toBe(true);
    });

    it("should allow QIAOCHUI_REVIEWING -> QIAOCHUI_APPROVED", () => {
      expect(canTransition("QIAOCHUI_REVIEWING", "QIAOCHUI_APPROVED")).toBe(true);
    });

    it("should allow QIAOCHUI_REVIEWING -> QIAOCHUI_REVISING", () => {
      expect(canTransition("QIAOCHUI_REVIEWING", "QIAOCHUI_REVISING")).toBe(true);
    });

    it("should allow QIAOCHUI_REVIEWING -> QIAOCHUI_REJECTED", () => {
      expect(canTransition("QIAOCHUI_REVIEWING", "QIAOCHUI_REJECTED")).toBe(true);
    });

    it("should allow QIAOCHUI_APPROVED -> EXECUTING", () => {
      expect(canTransition("QIAOCHUI_APPROVED", "EXECUTING")).toBe(true);
    });

    it("should allow EXECUTING -> COMPLETED", () => {
      expect(canTransition("EXECUTING", "COMPLETED")).toBe(true);
    });

    it("should allow any phase -> FAILED", () => {
      const nonTerminalPhases: WorkflowPhase[] = [
        "INITIALIZING", "DRAFTING", "DRAFT_COMPLETE", "QIAOCHUI_REVIEWING",
        "QIAOCHUI_APPROVED", "QIAOCHUI_REVISING", "USER_APPROVING", "EXECUTING"
      ];
      nonTerminalPhases.forEach(phase => {
        expect(canTransition(phase, "FAILED")).toBe(true);
      });
    });

    it("should NOT allow COMPLETED -> any other phase", () => {
      const allPhases: WorkflowPhase[] = [
        "INITIALIZING", "DRAFTING", "DRAFT_COMPLETE", "QIAOCHUI_REVIEWING",
        "QIAOCHUI_APPROVED", "QIAOCHUI_REVISING", "QIAOCHUI_REJECTED",
        "USER_APPROVING", "EXECUTING", "COMPLETED", "FAILED"
      ];
      allPhases.forEach(to => {
        expect(canTransition("COMPLETED", to)).toBe(false);
      });
    });

    it("should NOT allow backwards transitions", () => {
      expect(canTransition("DRAFT_COMPLETE", "DRAFTING")).toBe(false);
      expect(canTransition("QIAOCHUI_REVIEWING", "DRAFT_COMPLETE")).toBe(false);
      expect(canTransition("EXECUTING", "QIAOCHUI_APPROVED")).toBe(false);
    });
  });

  describe("Retry Logic", () => {
    const MAX_RETRIES = 3;
    const RETRY_DELAYS = [1000, 3000, 10000];

    interface WorkflowError {
      phase: string;
      error: string;
      retries: number;
      timestamp: string;
    }

    function canRetry(errors: WorkflowError[]): boolean {
      const lastError = errors.length > 0 ? errors[errors.length - 1] : null;
      if (!lastError) return true;
      return lastError.retries < MAX_RETRIES;
    }

    function incrementRetry(errors: WorkflowError[]): WorkflowError[] {
      if (errors.length === 0) return errors;
      const updated = [...errors];
      const lastError = updated[updated.length - 1];
      updated[updated.length - 1] = { ...lastError, retries: lastError.retries + 1 };
      return updated;
    }

    function getRetryDelay(errors: WorkflowError[]): number {
      const lastError = errors.length > 0 ? errors[errors.length - 1] : null;
      if (!lastError) return RETRY_DELAYS[0];
      const index = Math.min(lastError.retries, RETRY_DELAYS.length - 1);
      return RETRY_DELAYS[index];
    }

    it("should allow retry when no errors exist", () => {
      expect(canRetry([])).toBe(true);
    });

    it("should allow retry when retries < MAX_RETRIES", () => {
      const errors: WorkflowError[] = [{ phase: "DRAFTING", error: "timeout", retries: 2, timestamp: "" }];
      expect(canRetry(errors)).toBe(true);
    });

    it("should NOT allow retry when retries >= MAX_RETRIES", () => {
      const errors: WorkflowError[] = [{ phase: "DRAFTING", error: "timeout", retries: 3, timestamp: "" }];
      expect(canRetry(errors)).toBe(false);
    });

    it("should increment retry count", () => {
      const errors: WorkflowError[] = [{ phase: "DRAFTING", error: "timeout", retries: 0, timestamp: "" }];
      const updated = incrementRetry(errors);
      expect(updated[updated.length - 1].retries).toBe(1);
    });

    it("should return correct delay based on retry count", () => {
      expect(getRetryDelay([])).toBe(1000);
      expect(getRetryDelay([{ phase: "D", error: "", retries: 0, timestamp: "" }])).toBe(1000);
      expect(getRetryDelay([{ phase: "D", error: "", retries: 1, timestamp: "" }])).toBe(3000);
      expect(getRetryDelay([{ phase: "D", error: "", retries: 2, timestamp: "" }])).toBe(10000);
      expect(getRetryDelay([{ phase: "D", error: "", retries: 3, timestamp: "" }])).toBe(10000); // cap at max
    });
  });

  describe("State Persistence", () => {
    interface WorkflowRecoveryState {
      sessionId: string;
      currentPhase: string;
      planName: string;
      request: string;
      draftPath?: string;
      planPath?: string;
      executionPath?: string;
      errors: Array<{ phase: string; error: string; retries: number; timestamp: string }>;
      createdAt: string;
      updatedAt: string;
    }

    function createRecoveryState(sessionId: string, planName: string, request: string): WorkflowRecoveryState {
      return {
        sessionId,
        currentPhase: "INITIALIZING",
        planName,
        request,
        errors: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    function serializeState(state: WorkflowRecoveryState): string {
      return JSON.stringify(state, null, 2);
    }

    function deserializeState(json: string): WorkflowRecoveryState {
      return JSON.parse(json);
    }

    it("should create state with INITIALIZING phase", () => {
      const state = createRecoveryState("sess-123", "test-plan", "build something");
      expect(state.currentPhase).toBe("INITIALIZING");
      expect(state.sessionId).toBe("sess-123");
      expect(state.planName).toBe("test-plan");
    });

    it("should serialize and deserialize state correctly", () => {
      const state = createRecoveryState("sess-123", "test-plan", "build something");
      state.currentPhase = "DRAFTING";
      state.draftPath = ".plan/test-plan.draft.md";

      const serialized = serializeState(state);
      const restored = deserializeState(serialized);

      expect(restored.sessionId).toBe(state.sessionId);
      expect(restored.currentPhase).toBe(state.currentPhase);
      expect(restored.draftPath).toBe(state.draftPath);
      expect(restored.errors).toEqual(state.errors);
    });

    it("should preserve errors array through serialization", () => {
      const state = createRecoveryState("sess-123", "test-plan", "build something");
      state.errors.push({ phase: "DRAFTING", error: "timeout", retries: 1, timestamp: new Date().toISOString() });

      const serialized = serializeState(state);
      const restored = deserializeState(serialized);

      expect(restored.errors.length).toBe(1);
      expect(restored.errors[0].error).toBe("timeout");
    });
  });

  describe("Concurrent Execution Detection", () => {
    interface FileLock {
      taskId: string;
      filePath: string;
      lockedBy: string;
      lockedAt: string;
      expiresAt?: string;
    }

    function detectConflict(locks: FileLock[], taskId: string, filePath: string): boolean {
      const existing = locks.find(l => l.filePath === filePath && l.taskId !== taskId);
      if (!existing) return false;
      if (existing.expiresAt && new Date(existing.expiresAt) < new Date()) return false;
      return true;
    }

    it("should detect conflict when same file is locked by different task", () => {
      const locks: FileLock[] = [
        { taskId: "T1", filePath: "src/index.ts", lockedBy: "T1", lockedAt: new Date().toISOString() }
      ];
      expect(detectConflict(locks, "T2", "src/index.ts")).toBe(true);
    });

    it("should NOT detect conflict for same task", () => {
      const locks: FileLock[] = [
        { taskId: "T1", filePath: "src/index.ts", lockedBy: "T1", lockedAt: new Date().toISOString() }
      ];
      expect(detectConflict(locks, "T1", "src/index.ts")).toBe(false);
    });

    it("should NOT detect conflict when lock is expired", () => {
      const locks: FileLock[] = [
        {
          taskId: "T1",
          filePath: "src/index.ts",
          lockedBy: "T1",
          lockedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() - 1000).toISOString() // expired
        }
      ];
      expect(detectConflict(locks, "T2", "src/index.ts")).toBe(false);
    });

    it("should NOT detect conflict for different files", () => {
      const locks: FileLock[] = [
        { taskId: "T1", filePath: "src/index.ts", lockedBy: "T1", lockedAt: new Date().toISOString() }
      ];
      expect(detectConflict(locks, "T2", "src/utils.ts")).toBe(false);
    });
  });
});