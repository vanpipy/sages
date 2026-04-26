/**
 * WorkflowEngine - Main Orchestration Engine for Workflow Execution
 *
 * Manages workflow lifecycle (pending → running → completed/failed),
 * coordinates StateManager, FileLockManager, CircuitBreaker, and TaskDispatcher,
 * handles phase sequencing, task retry logic, pause/cancel functionality,
 * and supports crash recovery via resume().
 *
 * Execution Flow:
 * 1. Initialize state from workflow definition
 * 2. For each phase (in order):
 *    a. Update phase status to 'running'
 *    b. Check circuit breaker (if open, fail workflow)
 *    c. For each task in phase:
 *       i.   Check circuit breaker
 *       ii.  Check task dependencies
 *       iii. Dispatch task to TaskDispatcher
 *       iv.  Wait for completion
 *       v.   On success: record success, continue
 *       vi.  On failure: record failure, retry up to maxRetries
 *       vii. If retries exhausted: skip task, continue
 *    d. If all tasks skipped or completed → phase complete
 *    e. If any task failed fatally → phase failed
 * 3. Workflow complete or failed
 * 4. Save final state
 */

import type {
  WorkflowDefinition,
  WorkflowExecutionState,
  WorkflowPhaseState,
  WorkflowTaskState,
  WorkflowTaskDefinition,
} from "./types.js";
import { StateManager } from "./state-manager.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { TaskDispatcher } from "./task-dispatcher.js";
import { FileLockManager } from "./file-lock.js";
import { randomUUID } from "crypto";

/**
 * WorkflowEngine configuration options
 */
export interface WorkflowEngineOptions {
  /** State manager for persistence (optional, uses in-memory if not provided) */
  stateManager?: StateManager;
  /** Circuit breaker for failure management (optional, created if not provided) */
  circuitBreaker?: CircuitBreaker;
  /** Task dispatcher for agent dispatching (optional, created if not provided) */
  taskDispatcher?: TaskDispatcher;
  /** Base directory for file locks (default: /tmp) */
  lockBaseDir?: string;
}

/**
 * WorkflowEngine is the main orchestration engine that runs workflows through phases.
 * It manages the complete lifecycle of a workflow execution including:
 * - Phase sequencing and execution
 * - Task dispatching with dependency management
 * - Circuit breaker integration for failure handling
 * - Checkpoint-based crash recovery
 * - Pause/cancel functionality
 */
export class WorkflowEngine {
  private readonly workflowDefinition: WorkflowDefinition;
  private readonly stateManager: StateManager;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly taskDispatcher: TaskDispatcher;
  private state: WorkflowExecutionState | null = null;
  private isPaused = false;
  private isCancelled = false;
  private lastCheckpointTime = 0;
  private onProgressCallback: ((state: WorkflowExecutionState) => void) | null = null;

  /**
   * Creates a new WorkflowEngine instance.
   * @param workflowDefinition - The workflow definition to execute
   * @param options - Optional configuration for dependencies
   */
  constructor(workflowDefinition: WorkflowDefinition, options?: WorkflowEngineOptions) {
    if (!workflowDefinition) {
      throw new Error("WorkflowEngine: workflowDefinition is required");
    }

    this.workflowDefinition = workflowDefinition;
    this.stateManager = options?.stateManager ?? new StateManager();
    this.circuitBreaker = options?.circuitBreaker ?? new CircuitBreaker(
      workflowDefinition.settings.maxFailure
    );
    this.taskDispatcher = options?.taskDispatcher ?? this.createDefaultTaskDispatcher();
    this.isPaused = false;
    this.isCancelled = false;
    this.lastCheckpointTime = Date.now();
  }

  /**
   * Creates a default TaskDispatcher with FileLockManager.
   * @returns A new TaskDispatcher instance
   */
  private createDefaultTaskDispatcher(): TaskDispatcher {
    const fileLockManager = new FileLockManager("/tmp");
    return new TaskDispatcher(
      this.workflowDefinition.settings.maxParallel,
      fileLockManager
    );
  }

  /**
   * Executes the workflow from scratch.
   * @param onProgress - Optional callback for progress updates
   * @param workflowFile - Optional path to workflow file (saved in state for crash recovery)
   * @returns The final workflow execution state
   */
  async execute(
    onProgress?: (state: WorkflowExecutionState) => void,
    workflowFile?: string
  ): Promise<WorkflowExecutionState> {
    this.onProgressCallback = onProgress ?? null;

    // Initialize state from workflow definition
    this.state = this.initializeState();
    this.isPaused = false;
    this.isCancelled = false;

    // Store workflow file path in state for crash recovery
    if (workflowFile) {
      this.state.workflowFile = workflowFile;
    }

    // Update status to running
    this.state.status = "running";
    this.state.startedAt = new Date().toISOString();
    this.state.updatedAt = new Date().toISOString();

    try {
      // Execute each phase in order
      for (
        let phaseIndex = this.state.currentPhase;
        phaseIndex < this.workflowDefinition.phases.length;
        phaseIndex++
      ) {
        // Check for cancellation
        if (this.isCancelled) {
          this.state.status = "cancelled";
          this.state.completedAt = new Date().toISOString();
          this.state.error = "Workflow cancelled";
          break;
        }

        // Check circuit breaker before phase
        if (this.circuitBreaker.isOpen()) {
          this.state.status = "failed";
          this.state.error = "Circuit breaker opened";
          this.state.completedAt = new Date().toISOString();
          break;
        }

        // Set current phase
        this.state.currentPhase = phaseIndex;

        // Execute phase
        const phaseResult = await this.executePhase(phaseIndex);

        if (!phaseResult) {
          // Phase failed fatally
          this.state.status = "failed";
          this.state.completedAt = new Date().toISOString();
          break;
        }

        // Update phase state
        const phaseState = this.state.phases[phaseIndex];
        if (phaseState.status === "completed") {
          phaseState.completedAt = new Date().toISOString();
        } else if (phaseState.status === "failed") {
          // Check if all tasks failed - this is fatal for the phase
          const allFailed = phaseState.tasks.every(
            (t) => t.status === "failed" || t.status === "skipped"
          );
          if (allFailed && phaseState.tasks.length > 0) {
            this.state.status = "failed";
            this.state.error = `Phase ${phaseState.name} failed: all tasks failed`;
            this.state.completedAt = new Date().toISOString();
            break;
          }
        }

        // Save checkpoint
        await this.maybeCheckpoint();
      }

      // Final status check
      if (this.state.status === "running") {
        this.state.status = "completed";
        this.state.completedAt = new Date().toISOString();
      }

      this.state.updatedAt = new Date().toISOString();

      // Final state persistence
      await this.stateManager.saveState(this.state);

      // Notify final progress
      if (this.onProgressCallback) {
        this.onProgressCallback(this.state);
      }

      return this.state;
    } catch (error) {
      if (this.state) {
        this.state.status = "failed";
        this.state.error = error instanceof Error ? error.message : String(error);
        this.state.completedAt = new Date().toISOString();
        this.state.updatedAt = new Date().toISOString();
        await this.stateManager.saveState(this.state);
      }
      throw error;
    }
  }

  /**
   * Resumes workflow execution from a checkpoint.
   * @param state - The saved workflow execution state
   * @param onProgress - Optional callback for progress updates
   * @returns The final workflow execution state
   */
  async resume(
    state: WorkflowExecutionState,
    onProgress?: (state: WorkflowExecutionState) => void
  ): Promise<WorkflowExecutionState> {
    this.state = state;
    this.onProgressCallback = onProgress ?? null;
    this.isPaused = false;
    this.isCancelled = false;
    // Note: Circuit breaker state is not persisted - it starts fresh on resume

    // Continue execution from checkpoint - don't reinitialize state
    return this.continueExecution();
  }

  /**
   * Internal execution that continues from current state (used by resume).
   * Does NOT reinitialize state - assumes state is already set.
   * @returns The final workflow execution state
   */
  private async continueExecution(): Promise<WorkflowExecutionState> {
    // Update status to running (in case it was paused)
    this.state!.status = "running";
    this.state!.updatedAt = new Date().toISOString();

    try {
      // Execute each phase starting from currentPhase
      for (
        let phaseIndex = this.state!.currentPhase;
        phaseIndex < this.workflowDefinition.phases.length;
        phaseIndex++
      ) {
        // Check for cancellation
        if (this.isCancelled) {
          this.state!.status = "cancelled";
          this.state!.completedAt = new Date().toISOString();
          break;
        }

        // Check circuit breaker before phase
        if (this.circuitBreaker.isOpen()) {
          this.state!.status = "failed";
          this.state!.error = "Circuit breaker opened";
          this.state!.completedAt = new Date().toISOString();
          break;
        }

        // Set current phase
        this.state!.currentPhase = phaseIndex;

        // Execute phase
        const phaseResult = await this.executePhase(phaseIndex);

        if (!phaseResult) {
          // Phase failed fatally
          this.state!.status = "failed";
          this.state!.completedAt = new Date().toISOString();
          break;
        }

        // Update phase state
        const phaseState = this.state!.phases[phaseIndex];
        if (phaseState.status === "completed") {
          phaseState.completedAt = new Date().toISOString();
        } else if (phaseState.status === "failed") {
          const allFailed = phaseState.tasks.every(
            (t) => t.status === "failed" || t.status === "skipped"
          );
          if (allFailed && phaseState.tasks.length > 0) {
            this.state!.status = "failed";
            this.state!.error = `Phase ${phaseState.name} failed: all tasks failed`;
            this.state!.completedAt = new Date().toISOString();
            break;
          }
        }

        // Save checkpoint
        await this.maybeCheckpoint();
      }

      // Final status check
      if (this.state!.status === "running") {
        this.state!.status = "completed";
        this.state!.completedAt = new Date().toISOString();
      }

      this.state!.updatedAt = new Date().toISOString();
      await this.stateManager.saveState(this.state!);

      if (this.onProgressCallback) {
        this.onProgressCallback(this.state!);
      }

      return this.state!;
    } catch (error) {
      if (this.state) {
        this.state.status = "failed";
        this.state.error = error instanceof Error ? error.message : String(error);
        this.state.completedAt = new Date().toISOString();
        this.state.updatedAt = new Date().toISOString();
        await this.stateManager.saveState(this.state);
      }
      throw error;
    }
  }

  /**
   * Pauses workflow execution.
   * Sets internal pause flag - current task completes, next task waits.
   */
  pause(): void {
    this.isPaused = true;
    if (this.state) {
      this.state.status = "paused";
      this.state.updatedAt = new Date().toISOString();
    }
  }

  /**
   * Cancels workflow execution.
   * Sets cancel flag and calls TaskDispatcher.cancelAll().
   */
  cancel(): void {
    this.isCancelled = true;
    this.taskDispatcher.cancelAll();
    if (this.state) {
      this.state.status = "cancelled";
      this.state.updatedAt = new Date().toISOString();
    }
  }

  /**
   * Gets the current workflow execution state.
   * @returns The current state or null if not initialized
   */
  getState(): WorkflowExecutionState | null {
    return this.state;
  }

  /**
   * Initializes workflow execution state from the workflow definition.
   * @returns A new WorkflowExecutionState
   */
  private initializeState(): WorkflowExecutionState {
    const workflowId = randomUUID();
    const now = new Date().toISOString();

    return {
      workflowId,
      status: "pending",
      currentPhase: 0,
      currentTaskIndex: 0,
      phases: this.workflowDefinition.phases.map((phase) => ({
        name: phase.name,
        status: "pending" as const,
        tasks: phase.tasks.map((task) => ({
          id: task.id,
          status: "pending" as const,
          attempts: 0,
        })),
      })),
      startedAt: now,
      updatedAt: now,
    };
  }

  /**
   * Executes a single phase.
   * @param phaseIndex - The index of the phase to execute
   * @returns true if phase completed, false if phase failed fatally
   */
  private async executePhase(phaseIndex: number): Promise<boolean> {
    const phaseDef = this.workflowDefinition.phases[phaseIndex];
    const phaseState = this.state!.phases[phaseIndex];

    // Update phase status to running
    phaseState.status = "running";
    phaseState.startedAt = new Date().toISOString();
    this.notifyProgress();

    // Check circuit breaker before phase
    if (this.circuitBreaker.isOpen()) {
      phaseState.status = "failed";
      phaseState.error = "Circuit breaker opened before phase";
      return false;
    }

    // Execute tasks sequentially within the phase
    for (
      let taskIndex = this.state!.currentTaskIndex;
      taskIndex < phaseDef.tasks.length;
      taskIndex++
    ) {
      // Check for pause
      while (this.isPaused && !this.isCancelled) {
        await this.sleep(100);
      }

      // Check for cancellation
      if (this.isCancelled) {
        return false;
      }

      // Check circuit breaker before task
      if (this.circuitBreaker.isOpen()) {
        phaseState.status = "failed";
        phaseState.error = "Circuit breaker opened before task";
        return false;
      }

      // Set current task
      this.state!.currentTaskIndex = taskIndex;

      // Check task dependencies
      const taskDef = phaseDef.tasks[taskIndex];
      if (!this.checkTaskDependencies(taskDef, phaseState)) {
        // Dependencies not met - skip task
        const taskState = phaseState.tasks[taskIndex];
        taskState.status = "skipped";
        taskState.error = "Dependencies not met";
        continue;
      }

      // Dispatch task
      const success = await this.executeTask(taskDef, phaseState, taskIndex);

      if (!success) {
        // Task failed - record in circuit breaker
        this.circuitBreaker.recordFailure();

        // Check if circuit is now open
        if (this.circuitBreaker.isOpen()) {
          phaseState.status = "failed";
          phaseState.error = "Circuit breaker opened during task execution";
          return false;
        }
      }
    }

    // Determine phase completion status
    const allTasksDone = phaseState.tasks.every(
      (t) =>
        t.status === "completed" ||
        t.status === "skipped" ||
        t.status === "failed"
    );

    if (allTasksDone) {
      // Check if any task failed (not just skipped)
      const anyFailed = phaseState.tasks.some((t) => t.status === "failed");
      phaseState.status = anyFailed ? "failed" : "completed";
    } else {
      phaseState.status = "running";
    }

    this.notifyProgress();
    return true;
  }

  /**
   * Executes a single task with retry logic.
   * @param taskDef - The task definition
   * @param phaseState - The phase state
   * @param taskIndex - The task index within the phase
   * @returns true if task succeeded, false if failed
   */
  private async executeTask(
    taskDef: WorkflowTaskDefinition,
    phaseState: WorkflowPhaseState,
    taskIndex: number
  ): Promise<boolean> {
    const taskState = phaseState.tasks[taskIndex];
    const maxRetries = this.workflowDefinition.settings.retryAttempts;

    // Update task to dispatched
    taskState.status = "dispatched";
    this.notifyProgress();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Check for cancellation
      if (this.isCancelled) {
        taskState.status = "skipped";
        taskState.error = "Task cancelled";
        return false;
      }

      // Update attempt count
      taskState.attempts = attempt + 1;
      taskState.status = "running";
      taskState.startedAt = new Date().toISOString();
      this.notifyProgress();

      try {
        // Dispatch to task dispatcher
        const result = await this.taskDispatcher.dispatch(
          taskDef,
          this.state!.workflowId
        );

        if (result.success) {
          // Task succeeded
          taskState.status = "completed";
          taskState.completedAt = new Date().toISOString();
          taskState.result = result.output;
          taskState.agentId = result.agentId;
          this.circuitBreaker.recordSuccess();
          this.notifyProgress();
          return true;
        } else {
          // Task failed
          taskState.error = result.error;
          taskState.status = "failed";
          taskState.completedAt = new Date().toISOString();
          this.notifyProgress();

          // If retries exhausted, skip
          if (attempt >= maxRetries) {
            taskState.status = "skipped";
            return false;
          }
        }
      } catch (error) {
        // Exception during dispatch
        taskState.error = error instanceof Error ? error.message : String(error);
        taskState.status = "failed";
        taskState.completedAt = new Date().toISOString();
        this.notifyProgress();

        if (attempt >= maxRetries) {
          taskState.status = "skipped";
          return false;
        }
      }

      // Sleep before retry
      await this.sleep(100 * (attempt + 1));
    }

    return false;
  }

  /**
   * Checks if task dependencies are met.
   * @param taskDef - The task definition
   * @param phaseState - The phase state
   * @returns true if dependencies are met or no dependencies
   */
  private checkTaskDependencies(
    taskDef: WorkflowTaskDefinition,
    phaseState: WorkflowPhaseState
  ): boolean {
    const dependsOn = taskDef.dependsOn ?? [];
    if (dependsOn.length === 0) {
      return true;
    }

    for (const depId of dependsOn) {
      const depTask = phaseState.tasks.find((t) => t.id === depId);
      if (!depTask) {
        // Dependency task not found - check other phases
        // For now, we only check within the same phase
        continue;
      }

      if (depTask.status !== "completed") {
        return false;
      }
    }

    return true;
  }

  /**
   * Notifies progress callback if registered.
   */
  private notifyProgress(): void {
    if (this.onProgressCallback && this.state) {
      this.onProgressCallback({ ...this.state });
    }
  }

  /**
   * Maybe saves a checkpoint based on interval.
   */
  private async maybeCheckpoint(): Promise<void> {
    const now = Date.now();
    const interval = this.workflowDefinition.settings.checkpointInterval * 1000;

    if (now - this.lastCheckpointTime >= interval && this.state) {
      await this.stateManager.checkpoint(this.state);
      this.lastCheckpointTime = now;
    }
  }

  /**
   * Sleep utility for async operations.
   * @param ms - Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
