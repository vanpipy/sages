/**
 * TaskDispatcher - Task Dispatching to LuBan Agents with Swarm Dispatching
 *
 * Manages the dispatching of tasks to LuBan agents using a semaphore-based
 * concurrency control pattern. Handles file locking coordination, tracks
 * in-flight tasks for cancellation, and provides batch dispatch capabilities.
 *
 * Architecture:
 * - Semaphore pattern limits concurrent agents to maxParallel
 * - File locks acquired before dispatch, released on completion/error
 * - In-flight task tracking enables cancellation
 * - Circuit breaker integration prevents dispatch when system is overloaded
 */

import { EventEmitter } from "events";
import type { WorkflowTaskDefinition, WorkflowDispatchResult } from "./types.js";
import type { FileLockManager } from "./file-lock.js";

/** Default dispatch timeout in milliseconds (5 minutes) */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Semaphore for managing concurrent agent dispatches */
interface Semaphore {
  acquire(): Promise<() => void>;
  getRunningCount(): number;
}

/**
 * In-flight task record for tracking dispatched tasks.
 */
interface InFlightTask {
  taskId: string;
  workflowId: string;
  agentId: string;
  startTime: Date;
  timeout: number;
  releaseSemaphore: () => void;
  cancelled: boolean;
}

/**
 * Options for TaskDispatcher configuration.
 */
export interface TaskDispatcherOptions {
  /** Dispatch timeout in milliseconds (default: 5 minutes) */
  timeout?: number;
}

/**
 * TaskDispatcher manages task dispatching to LuBan agents with concurrency control
 * and file locking coordination.
 */
export class TaskDispatcher extends EventEmitter {
  private readonly maxParallel: number;
  private readonly fileLockManager: FileLockManager;
  private readonly timeout: number;
  private readonly semaphore: Semaphore;
  private readonly inFlightTasks: Map<string, InFlightTask>;
  private readonly workflowTasks: Map<string, Set<string>>;

  /**
   * Creates a new TaskDispatcher instance.
   * @param maxParallel - Maximum number of concurrent agents
   * @param fileLockManager - File lock manager for coordinating file access
   * @param options - Optional configuration
   */
  constructor(
    maxParallel: number,
    fileLockManager: FileLockManager,
    options?: TaskDispatcherOptions
  ) {
    super();
    this.maxParallel = maxParallel;
    this.fileLockManager = fileLockManager;
    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
    this.semaphore = this.createSemaphore(maxParallel);
    this.inFlightTasks = new Map();
    this.workflowTasks = new Map();
  }

  /**
   * Creates a semaphore for managing concurrency.
   * @param maxConcurrent - Maximum concurrent acquisitions
   * @returns A semaphore instance
   */
  private createSemaphore(maxConcurrent: number): Semaphore {
    let running = 0;
    let queue: ((release: () => void) => void)[] = [];

    return {
      async acquire(): Promise<() => void> {
        return new Promise((resolve) => {
          const release = () => {
            running--;
            const next = queue.shift();
            if (next) {
              running++;
              next(() => {
                resolve(release);
              });
            }
          };

          if (running < maxConcurrent) {
            running++;
            resolve(release);
          } else {
            queue.push(release);
          }
        });
      },
      getRunningCount(): number {
        return running;
      },
    };
  }

  /**
   * Generates a unique agent ID for dispatch tracking.
   * @param taskId - The task ID
   * @returns A unique agent identifier
   */
  private generateAgentId(taskId: string): string {
    return `luban-${taskId}-${Date.now()}`;
  }

  /**
   * Checks if circuit breaker is open (stub for integration).
   * In production, this would check the actual circuit breaker state.
   * @returns false if circuit allows dispatch
   */
  private isCircuitOpen(): boolean {
    // Circuit breaker integration point
    // This would be connected to the actual circuit breaker in production
    return false;
  }

  /**
   * Acquires file locks for all files in a task.
   * @param task - The task definition
   * @param taskId - The task ID
   * @param agentId - The agent ID
   * @returns Array of acquired locks or null if any lock failed
   */
  private async acquireFileLocks(
    task: WorkflowTaskDefinition,
    taskId: string,
    agentId: string
  ): Promise<{ path: string; taskId: string; agentId: string }[] | null> {
    const files = task.files ?? [];
    const acquiredLocks: { path: string; taskId: string; agentId: string }[] = [];

    for (const file of files) {
      const lock = await this.fileLockManager.acquireLock(file, taskId, agentId);
      if (!lock) {
        // Lock acquisition failed - release all acquired locks
        for (const acquired of acquiredLocks) {
          await this.fileLockManager.releaseLock(acquired.path, taskId);
        }
        return null;
      }
      acquiredLocks.push(lock);
    }

    return acquiredLocks;
  }

  /**
   * Releases file locks for all files in a task.
   * @param task - The task definition
   * @param taskId - The task ID
   */
  private async releaseFileLocks(
    task: WorkflowTaskDefinition,
    taskId: string
  ): Promise<void> {
    const files = task.files ?? [];
    for (const file of files) {
      await this.fileLockManager.releaseLock(file, taskId);
    }
  }

  /**
   * Dispatches a task to a LuBan agent.
   * @param task - The task definition
   * @param workflowId - The workflow ID this task belongs to
   * @returns The dispatch result
   */
  async dispatch(
    task: WorkflowTaskDefinition,
    workflowId: string
  ): Promise<WorkflowDispatchResult> {
    const startTime = Date.now();
    const taskId = task.id;
    const agentId = this.generateAgentId(taskId);

    // Pre-dispatch validation: check circuit breaker
    if (this.isCircuitOpen()) {
      return {
        success: false,
        taskId,
        agentId,
        error: "Circuit breaker is open",
        duration: Date.now() - startTime,
      };
    }

    // Pre-dispatch validation: check file locks
    const locksAcquired = await this.acquireFileLocks(task, taskId, agentId);
    if (!locksAcquired) {
      return {
        success: false,
        taskId,
        agentId,
        error: "Failed to acquire file locks",
        duration: Date.now() - startTime,
      };
    }

    // Acquire semaphore slot
    let releaseSemaphore: (() => void) | null = null;
    try {
      releaseSemaphore = await this.semaphore.acquire();
    } catch (err) {
      // Semaphore acquisition failed - release locks
      await this.releaseFileLocks(task, taskId);
      return {
        success: false,
        taskId,
        agentId,
        error: "Failed to acquire semaphore slot",
        duration: Date.now() - startTime,
      };
    }

    // Track in-flight task
    const inFlightTask: InFlightTask = {
      taskId,
      workflowId,
      agentId,
      startTime: new Date(),
      timeout: this.timeout,
      releaseSemaphore,
      cancelled: false,
    };
    this.inFlightTasks.set(taskId, inFlightTask);

    // Track task in workflow
    if (!this.workflowTasks.has(workflowId)) {
      this.workflowTasks.set(workflowId, new Set());
    }
    this.workflowTasks.get(workflowId)!.add(taskId);

    // Dispatch to LuBan agent
    try {
      const result = await this.dispatchToAgent(task, workflowId, agentId);

      // Release semaphore, file locks, and clean up
      releaseSemaphore();
      await this.releaseFileLocks(task, taskId);
      this.inFlightTasks.delete(taskId);
      this.workflowTasks.get(workflowId)?.delete(taskId);

      return {
        success: result.success,
        taskId,
        agentId,
        output: result.output,
        error: result.error,
        duration: Date.now() - startTime,
      };
    } catch (err) {
      // Agent dispatch failed - release semaphore and locks
      releaseSemaphore();
      await this.releaseFileLocks(task, taskId);
      this.inFlightTasks.delete(taskId);
      this.workflowTasks.get(workflowId)?.delete(taskId);

      return {
        success: false,
        taskId,
        agentId,
        error: err instanceof Error ? err.message : String(err),
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Dispatches a task to a LuBan agent via the task tool.
   * @param task - The task definition
   * @param workflowId - The workflow ID
   * @param agentId - The agent ID
   * @returns The agent execution result
   */
  private async dispatchToAgent(
    task: WorkflowTaskDefinition,
    workflowId: string,
    agentId: string
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    // This is the integration point with the OpenCode task tool
    // In production, this would use the actual task() tool mechanism
    const taskSpec = {
      id: task.id,
      description: task.description,
      files: task.files ?? [],
      dependsOn: task.dependsOn ?? [],
    };

    try {
      // Dispatch via task tool - this is an async operation that runs in background
      // We simulate the dispatch and wait for completion
      const dispatchResult = await this.runAgentTask(taskSpec, agentId);
      return dispatchResult;
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Runs an agent task and waits for completion.
   * This is a placeholder that would be connected to the actual OpenCode task mechanism.
   * @param taskSpec - The task specification
   * @param agentId - The agent ID
   * @returns The execution result
   */
  private async runAgentTask(
    taskSpec: { id: string; description: string; files: string[]; dependsOn: string[] },
    agentId: string
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    // Integration point: connect to OpenCode's task() tool mechanism
    // For now, this is a stub that would be replaced with actual task tool dispatch
    return new Promise((resolve) => {
      // Simulate async dispatch - in production this would be the actual task tool call
      setTimeout(() => {
        resolve({
          success: true,
          output: `Task ${taskSpec.id} completed by ${agentId}`,
        });
      }, 100);
    });
  }

  /**
   * Dispatches multiple tasks in batch, respecting maxParallel limits.
   * Uses chunking to dispatch up to maxParallel tasks concurrently.
   * @param tasks - Array of task definitions
   * @param workflowId - The workflow ID these tasks belong to
   * @returns Array of dispatch results in same order as input
   */
  async dispatchBatch(
    tasks: WorkflowTaskDefinition[],
    workflowId: string
  ): Promise<WorkflowDispatchResult[]> {
    const results: WorkflowDispatchResult[] = [];

    // Process tasks in chunks of maxParallel for concurrent dispatch
    for (let i = 0; i < tasks.length; i += this.maxParallel) {
      const chunk = tasks.slice(i, i + this.maxParallel);
      const chunkResults = await Promise.all(
        chunk.map((task) => this.dispatch(task, workflowId))
      );
      results.push(...chunkResults);
    }

    return results;
  }

  /**
   * Gets the current queue depth (tasks waiting to dispatch).
   * Note: This is an approximation since the semaphore doesn't expose queue length.
   * @returns The approximate number of queued tasks
   */
  getQueueDepth(): number {
    // Semaphore doesn't expose queue length, return 0 as approximation
    // In production, could track this separately
    return 0;
  }

  /**
   * Gets the number of currently active (running) tasks.
   * @returns The number of active tasks
   */
  getActiveCount(): number {
    return this.inFlightTasks.size;
  }

  /**
   * Cancels a specific task by ID.
   * Note: This is a stub - actual task cancellation requires integration with
   * the OpenCode task tool's abort mechanism via cancellation tokens.
   * @param taskId - The task ID to cancel
   */
  cancelTask(taskId: string): void {
    const task = this.inFlightTasks.get(taskId);
    if (!task) {
      return;
    }

    task.cancelled = true;

    // Emit cancellation event for integration points
    this.emit("taskCancelled", { taskId, workflowId: task.workflowId });
  }

  /**
   * Cancels all tasks for a specific workflow.
   * Note: This is a stub - actual task cancellation requires integration with
   * the OpenCode task tool's abort mechanism.
   * @param workflowId - The workflow ID whose tasks to cancel
   */
  cancelWorkflow(workflowId: string): void {
    const taskIds = this.workflowTasks.get(workflowId);
    if (!taskIds) {
      return;
    }

    for (const taskId of taskIds) {
      this.cancelTask(taskId);
    }
  }

  /**
   * Cancels all in-flight tasks and releases resources.
   * Note: This is a stub - actual task cancellation requires integration with
   * the OpenCode task tool's abort mechanism.
   */
  cancelAll(): void {
    for (const [taskId, task] of this.inFlightTasks) {
      task.cancelled = true;
      this.emit("taskCancelled", { taskId, workflowId: task.workflowId });
    }
    this.inFlightTasks.clear();
    this.workflowTasks.clear();
  }
}
