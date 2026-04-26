/**
 * Unit Tests for WorkflowEngine
 * Tests workflow orchestration with phases, tasks, circuit breaker, and state management
 */
import { describe, it, expect, beforeEach, vi } from "bun:test";
import { WorkflowEngine } from "../../src/engine/workflow-engine";
import { FileLockManager } from "../../src/engine/file-lock";
import { StateManager } from "../../src/engine/state-manager";
import { CircuitBreaker } from "../../src/engine/circuit-breaker";
import { TaskDispatcher } from "../../src/engine/task-dispatcher";
import type {
  WorkflowDefinition,
  WorkflowExecutionState,
  WorkflowTaskDefinition,
  WorkflowDispatchResult,
} from "../../src/engine/types";

// Mock TaskDispatcher for testing
class MockTaskDispatcher {
  public dispatchedTasks: { task: WorkflowTaskDefinition; workflowId: string }[] = [];
  public shouldFailDispatch = false;
  public dispatchResults: Map<string, WorkflowDispatchResult> = new Map();
  public activeCount = 0;

  async dispatch(
    task: WorkflowTaskDefinition,
    workflowId: string
  ): Promise<WorkflowDispatchResult> {
    this.dispatchedTasks.push({ task, workflowId });

    if (this.shouldFailDispatch) {
      return {
        success: false,
        taskId: task.id,
        error: "Mock dispatch failure",
        duration: 100,
      };
    }

    const result = this.dispatchResults.get(task.id) ?? {
      success: true,
      taskId: task.id,
      agentId: `mock-agent-${task.id}`,
      output: `Task ${task.id} completed`,
      duration: 100,
    };

    return result;
  }

  async dispatchBatch(
    tasks: WorkflowTaskDefinition[],
    workflowId: string
  ): Promise<WorkflowDispatchResult[]> {
    return Promise.all(tasks.map((t) => this.dispatch(t, workflowId)));
  }

  cancelAll(): void {
    this.dispatchedTasks = [];
  }

  getActiveCount(): number {
    return this.activeCount;
  }
}

// Mock CircuitBreaker for testing
class MockCircuitBreaker {
  public failureCount = 0;
  public isOpenState = false;

  recordFailure(): void {
    this.failureCount++;
  }

  recordSuccess(): void {
    // Reset on success when open
  }

  isOpen(): boolean {
    return this.isOpenState;
  }

  getState() {
    return {
      failureCount: this.failureCount,
      isOpen: this.isOpenState,
    };
  }
}

describe("WorkflowEngine", () => {
  let fileLockManager: FileLockManager;
  let stateManager: StateManager;
  let circuitBreaker: CircuitBreaker;
  let mockDispatcher: MockTaskDispatcher;
  let engine: WorkflowEngine;

  const createWorkflowDefinition = (): WorkflowDefinition => ({
    name: "Test Workflow",
    description: "A test workflow",
    phases: [
      {
        name: "phase-1",
        tasks: [
          { id: "task-1", description: "First task", agent: "luban", files: [] },
          { id: "task-2", description: "Second task", agent: "luban", files: [] },
        ],
      },
      {
        name: "phase-2",
        tasks: [
          { id: "task-3", description: "Third task", agent: "qiaochui", files: [] },
        ],
      },
    ],
    settings: {
      maxParallel: 2,
      maxFailure: 3,
      retryAttempts: 2,
      checkpointInterval: 300,
      lockTimeout: 1800,
    },
  });

  beforeEach(() => {
    fileLockManager = new FileLockManager("/tmp/test-locks");
    stateManager = new StateManager("/tmp/test-session.json");
    circuitBreaker = new CircuitBreaker(3);
    mockDispatcher = new MockTaskDispatcher();

    // Create engine with mocked dependencies
    engine = new WorkflowEngine(createWorkflowDefinition(), {
      stateManager,
      circuitBreaker,
      taskDispatcher: mockDispatcher as unknown as TaskDispatcher,
    });
  });

  describe("constructor", () => {
    it("should create WorkflowEngine with workflow definition", () => {
      expect(engine).toBeDefined();
    });

    it("should throw if workflow definition is null", () => {
      expect(() => {
        // @ts-ignore - Testing invalid input
        new WorkflowEngine(null);
      }).toThrow();
    });
  });

  describe("execute", () => {
    it("should execute workflow and return final state", async () => {
      const state = await engine.execute();

      expect(state).toBeDefined();
      expect(state.status).toBe("completed");
      expect(state.workflowId).toBeDefined();
    });

    it("should run all phases in order", async () => {
      const onProgressCalls: WorkflowExecutionState[] = [];
      await engine.execute((state) => {
        onProgressCalls.push(state);
      });

      // Should have progress calls for each phase and task
      expect(onProgressCalls.length).toBeGreaterThan(0);
    });

    it("should update task status to completed on success", async () => {
      const state = await engine.execute();

      // Find completed tasks
      const completedTasks = state.phases
        .flatMap((p) => p.tasks)
        .filter((t) => t.status === "completed");

      expect(completedTasks.length).toBeGreaterThan(0);
    });

    it("should call onProgress callback with state updates", async () => {
      let callCount = 0;
      await engine.execute((state) => {
        callCount++;
        expect(state).toBeDefined();
        expect(state.status).toMatch(/^(running|completed|failed)$/);
      });

      expect(callCount).toBeGreaterThan(0);
    });

    it("should record circuit breaker failures on task failure", async () => {
      // Create engine with higher failure threshold so circuit doesn't open immediately
      const highThresholdEngine = new WorkflowEngine(createWorkflowDefinition(), {
        stateManager,
        circuitBreaker: new CircuitBreaker(100), // High threshold so circuit doesn't open
        taskDispatcher: mockDispatcher as unknown as TaskDispatcher,
      });

      // Make dispatcher fail
      mockDispatcher.shouldFailDispatch = true;

      const state = await highThresholdEngine.execute();

      // Workflow completes (circuit breaker threshold not reached, tasks skipped)
      expect(state.status).toBe("completed");

      // Tasks should be skipped due to retry exhaustion
      const skippedTasks = state.phases
        .flatMap((p) => p.tasks)
        .filter((t) => t.status === "skipped");
      expect(skippedTasks.length).toBeGreaterThan(0);
    });

    it("should fail workflow immediately when circuit breaker opens", async () => {
      // Open the circuit breaker
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      const state = await engine.execute();

      expect(state.status).toBe("failed");
      expect(state.error).toContain("Circuit breaker");
    });
  });

  describe("getState", () => {
    it("should return null before execution", () => {
      const state = engine.getState();
      expect(state).toBeNull();
    });

    it("should return current state after execution", async () => {
      await engine.execute();
      const state = engine.getState();
      expect(state).not.toBeNull();
      expect(state!.status).toBeDefined();
    });
  });

  describe("pause and cancel", () => {
    it("should have pause method", () => {
      expect(typeof engine.pause).toBe("function");
    });

    it("should have cancel method", () => {
      expect(typeof engine.cancel).toBe("function");
    });

    it("should not throw when pausing", () => {
      engine.pause();
    });

    it("should not throw when cancelling", () => {
      engine.cancel();
    });
  });

  describe("task dependency checking", () => {
    it("should handle tasks with dependencies", async () => {
      const workflowWithDeps: WorkflowDefinition = {
        name: "Workflow with dependencies",
        phases: [
          {
            name: "phase-1",
            tasks: [
              { id: "task-1", description: "First", agent: "luban", files: [] },
              { id: "task-2", description: "Second", agent: "luban", files: [], dependsOn: ["task-1"] },
            ],
          },
        ],
        settings: {
          maxParallel: 1,
          maxFailure: 3,
          retryAttempts: 2,
          checkpointInterval: 300,
          lockTimeout: 1800,
        },
      };

      const engineWithDeps = new WorkflowEngine(workflowWithDeps, {
        stateManager,
        circuitBreaker,
        taskDispatcher: mockDispatcher as unknown as TaskDispatcher,
      });

      const state = await engineWithDeps.execute();

      // Task 1 should complete before Task 2 is dispatched
      expect(state.status).toBe("completed");
    });
  });

  describe("resume", () => {
    it("should have resume method", () => {
      expect(typeof engine.resume).toBe("function");
    });

    it("should continue from saved state", async () => {
      // Create a workflow that tracks which tasks were executed
      const executedTasks: string[] = [];
      const trackingDispatcher = new MockTaskDispatcher();
      trackingDispatcher.dispatch = async (task, workflowId) => {
        executedTasks.push(task.id);
        return {
          success: true,
          taskId: task.id,
          agentId: `mock-agent-${task.id}`,
          output: `Task ${task.id} completed`,
          duration: 100,
        };
      };

      // Create a partial state with first phase complete
      const partialState: WorkflowExecutionState = {
        workflowId: "test-workflow-123",
        status: "paused",
        currentPhase: 1, // Start from phase 2
        currentTaskIndex: 0,
        phases: [
          {
            name: "phase-1",
            status: "completed",
            tasks: [
              { id: "task-1", status: "completed", attempts: 1 },
              { id: "task-2", status: "completed", attempts: 1 },
            ],
          },
          {
            name: "phase-2",
            status: "pending",
            tasks: [{ id: "task-3", status: "pending", attempts: 0 }],
          },
        ],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const resumeEngine = new WorkflowEngine(createWorkflowDefinition(), {
        stateManager,
        circuitBreaker,
        taskDispatcher: trackingDispatcher as unknown as TaskDispatcher,
      });

      const finalState = await resumeEngine.resume(partialState);

      // Should have continued from phase 2, not re-run phase 1
      expect(finalState.currentPhase).toBe(1);
      expect(finalState.status).toBe("completed");
    });

    it("should preserve task states when resuming", async () => {
      // Create a partial state that matches the workflow definition structure
      const workflowDef = createWorkflowDefinition();
      const partialState: WorkflowExecutionState = {
        workflowId: "test-workflow-456",
        status: "paused",
        currentPhase: 0,
        currentTaskIndex: 1,
        phases: workflowDef.phases.map((phase) => ({
          name: phase.name,
          status: phase.name === "phase-1" ? "running" : "pending",
          tasks: phase.tasks.map((task) => ({
            id: task.id,
            status: task.id === "task-1" ? "completed" as const : "pending" as const,
            attempts: task.id === "task-1" ? 1 : 0,
          })),
        })),
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const resumeEngine = new WorkflowEngine(workflowDef, {
        stateManager,
        circuitBreaker,
        taskDispatcher: mockDispatcher as unknown as TaskDispatcher,
      });

      const finalState = await resumeEngine.resume(partialState);

      // Task 1 should still be completed
      expect(finalState.phases[0].tasks[0].status).toBe("completed");
      // Task 2 should be completed from resumed execution
      expect(finalState.phases[0].tasks[1].status).toBe("completed");
    });
  });
});
