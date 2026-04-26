/**
 * Workflow Engine Type Definitions
 *
 * Comprehensive TypeScript types for the Four Sages Agents workflow orchestration engine.
 * These types support:
 * - Workflow definition parsing from YAML
 * - Runtime state management across phases
 * - Task dispatching to LuBan agents with file locking
 * - Circuit breaker failure management
 * - Crash recovery via session checkpoints
 *
 * NOTE: These types are scoped to the workflow engine and intentionally differ from
 * the plugin-level types in src/types.ts to support different execution models.
 */

/**
 * Task execution status for workflow engine
 */
export type WorkflowTaskStatus = 'pending' | 'dispatched' | 'running' | 'completed' | 'failed' | 'skipped';

/**
 * Phase execution status for workflow engine
 */
export type WorkflowPhaseStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed';

/**
 * Workflow execution status for workflow engine
 */
export type WorkflowExecutionStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

/**
 * Per-task runtime state during workflow execution.
 * Tracks the lifecycle of each task from pending through completion/failure.
 */
export interface WorkflowTaskState {
  /** Unique task identifier matching TaskDefinition.id */
  id: string;
  /** Current execution status */
  status: WorkflowTaskStatus;
  /** Number of execution attempts (max 3 retries) */
  attempts: number;
  /** Assigned LuBan agent identifier */
  agentId?: string;
  /** ISO timestamp when task started execution */
  startedAt?: string;
  /** ISO timestamp when task completed */
  completedAt?: string;
  /** Last error message if task failed */
  error?: string;
  /** Execution result summary */
  result?: string;
}

/**
 * Per-phase runtime state during workflow execution.
 * Contains task states for all tasks within the phase.
 */
export interface WorkflowPhaseState {
  /** Phase name (e.g., "design", "implementation") */
  name: string;
  /** Current execution status */
  status: WorkflowPhaseStatus;
  /** State for each task in the phase */
  tasks: WorkflowTaskState[];
  /** ISO timestamp when phase started */
  startedAt?: string;
  /** ISO timestamp when phase completed */
  completedAt?: string;
  /** Last error message if phase failed */
  error?: string;
}

/**
 * Complete runtime state for a workflow execution.
 * Persisted to enable crash recovery and session checkpoints.
 */
export interface WorkflowExecutionState {
  /** Unique execution identifier */
  workflowId: string;
  /** Current execution status */
  status: WorkflowExecutionStatus;
  /** 1-indexed current phase index */
  currentPhase: number;
  /** Current task index within the phase */
  currentTaskIndex: number;
  /** State for each phase in the workflow */
  phases: WorkflowPhaseState[];
  /** ISO timestamp when workflow started */
  startedAt: string;
  /** ISO timestamp when workflow was last updated */
  updatedAt: string;
  /** ISO timestamp when workflow completed (success or failure) */
  completedAt?: string;
  /** Last error message if workflow failed */
  error?: string;
  /** Path to the original workflow YAML file (for crash recovery) */
  workflowFile?: string;
}

/**
 * Task specification from workflow YAML definition.
 * Defines what a task should do and its dependencies.
 */
export interface WorkflowTaskDefinition {
  /** Unique task identifier */
  id: string;
  /** Human-readable task description */
  description: string;
  /** Agent type to dispatch (e.g., "luban", "qiaochui") */
  agent: string;
  /** Files for the task to work on */
  files?: string[];
  /** Task IDs that must complete before this task */
  dependsOn?: string[];
  /** Execution priority 1-5 (default 3, higher = more urgent) */
  priority?: number;
}

/**
 * Phase specification from workflow YAML definition.
 * Groups related tasks that execute in sequence or parallel.
 */
export interface WorkflowPhaseDefinition {
  /** Phase name (e.g., "design", "implementation") */
  name: string;
  /** Task definitions within this phase */
  tasks: WorkflowTaskDefinition[];
  /** Execute tasks in parallel within this phase (default false) */
  parallel?: boolean;
  /** Maximum concurrent tasks when parallel is true (default 1) */
  maxParallel?: number;
}

/**
 * Workflow configuration settings.
 */
export interface WorkflowSettings {
  /** Maximum concurrent agents across all phases */
  maxParallel: number;
  /** Circuit breaker threshold - open after this many failures (default 12) */
  maxFailure: number;
  /** Retry attempts per task (default 3) */
  retryAttempts: number;
  /** Seconds between checkpoint saves (default 300) */
  checkpointInterval: number;
  /** File lock TTL in seconds (default 1800) */
  lockTimeout: number;
}

/**
 * Complete workflow definition from YAML.
 * Contains all phases, tasks, and settings for a workflow.
 */
export interface WorkflowDefinition {
  /** Workflow name */
  name: string;
  /** Optional workflow description */
  description?: string;
  /** Phase definitions in execution order */
  phases: WorkflowPhaseDefinition[];
  /** Workflow configuration settings */
  settings: WorkflowSettings;
}

/**
 * Result from dispatching a task to a LuBan agent.
 * Indicates success/failure and execution metrics.
 */
export interface WorkflowDispatchResult {
  /** Whether dispatch was successful */
  success: boolean;
  /** Task identifier */
  taskId: string;
  /** Assigned agent identifier */
  agentId?: string;
  /** Execution output or result */
  output?: string;
  /** Error message if dispatch failed */
  error?: string;
  /** Execution duration in milliseconds */
  duration?: number;
}

/**
 * Circuit breaker state for failure management.
 * Opens after maxFailure consecutive failures to prevent cascade.
 */
export interface WorkflowCircuitBreakerState {
  /** Current consecutive failure count */
  failureCount: number;
  /** ISO timestamp of last failure */
  lastFailure?: string;
  /** Whether circuit is open (rejecting new dispatches) */
  isOpen: boolean;
  /** ISO timestamp when circuit was opened */
  openedAt?: string;
}

/**
 * File lock record for coordinating access to shared files during workflow execution.
 * Prevents concurrent edits by multiple agents.
 */
export interface WorkflowFileLock {
  /** Locked file path */
  path: string;
  /** Task ID that owns the lock */
  taskId: string;
  /** Agent ID that holds the lock */
  agentId: string;
  /** ISO timestamp when lock was acquired */
  acquiredAt: string;
  /** ISO timestamp when lock expires (acquiredAt + lockTimeout) */
  expiresAt: string;
}