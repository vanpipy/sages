/**
 * Luban Types - TDD Task Execution interfaces
 * 
 * Part of: src/tools/luban/
 * Purpose: Shared type definitions for task execution
 */

import type { MDDPlane } from "../qiaochui/types.js";

/**
 * TDD Phases
 */
export type TDDPhase = "RED" | "GREEN" | "REFACTOR";

/**
 * Phase status
 */
export type PhaseStatus = "pending" | "in_progress" | "completed" | "failed";

/**
 * Individual TDD phase result
 */
export interface TDDPhaseResult {
  name: TDDPhase;
  status: PhaseStatus;
  output?: string;
  error?: string;
}

/**
 * Task status
 */
export type TaskStatus = "pending" | "running" | "completed" | "failed";

/**
 * Task generated from MDD decomposition
 */
export interface LubanTask {
  id: string;
  description: string;
  plane: MDDPlane;
  priority: "high" | "medium" | "low";
  dependsOn: string[];
  files: string[];
  /**
   * Test files associated with this task. When provided, conflict detection
   * considers these files as part of the conflict surface (S5 scenario).
   * Optional — falls back to deriving from sourceFiles if absent.
   */
  testFiles?: string[];
  status: TaskStatus;
}

/**
 * TDD Runner configuration
 */
export interface TDDConfig {
  taskId: string;
  taskDescription: string;
  sourceFiles: string[];
  testFiles: string[];
  testCommand: string;
  cwd: string;
  subagent?: boolean;
  /**
   * V-cases (Given/When/Then) parsed from draft.md ## Scenarios.
   * When provided, the RED phase generates a test file with one
   * it() block per scenario, with Given/When/Then as comments.
   */
  scenarios?: Array<{
    name: string;
    given: string;
    when: string;
    then: string;
    but?: string;
  }>;
  /**
   * Files that LuBan must NOT touch (scope guard).
   * Sourced from draft.md ## Out of Scope (after FILL IN items are filled in).
   * LuBan aborts with a clear error if any sourceFile/testFile is in this list.
   */
  denyFiles?: string[];
}

/**
 * Task execution result
 */
export interface TaskResult {
  taskId: string;
  success: boolean;
  duration: number;
  phases: TDDPhaseResult[];
  filesCreated?: string[];
  filesModified?: string[];
  committed?: boolean;
  commitHash?: string;
}

/**
 * Execution settings
 */
export interface ExecutionSettings {
  name: string;
  maxParallel: number;
  useSubagent: boolean;
  maxRetry: number;
  autoCommit: boolean;
  subagentConfig?: {
    skills: string[];
    maxContext: number;
    timeout: number;
  };
}

/**
 * Parsed execution plan
 */
export interface ExecutionPlan {
  name: string;
  settings: ExecutionSettings;
  tasks: LubanTask[];
}

// ============================================================================
// Batch API (luban_execute_batch)
// ============================================================================

/**
 * A batch is an atomic unit of execution. The caller (qiaochui or agent)
 * composes a batch from the decomposed plan; LuBan executes it as a unit.
 *
 * Contract:
 * - maxParallel must be >= 1; values < 1 are rejected at runBatch entry (fail-fast).
 *   Use maxParallel=1 for explicit serial execution (skips conflict detection).
 * - maxParallel is the optimistic concurrency cap. If intra-batch file
 *   conflicts are detected, the batch auto-degrades to serial regardless
 *   of maxParallel (S2 scenario).
 * - testCommand applies to every task in the batch; per-task overrides
 *   are not supported in this round.
 *
 * Limitation (KD-4 deferred):
 * - `cwd` is honored for record-keeping and is passed to TDDConfig, but the
 *   current task-runner uses a module-level FileService singleton bound to
 *   process.cwd(). To make cwd truly take effect requires threading
 *   FileService through runTask (planned for the TDD optimization milestone).
 */
export interface Batch {
  tasks: LubanTask[];
  maxParallel: number;
  testCommand: string;
  cwd: string;
}

/**
 * Conflict report from detectFileConflicts. Pure data — no I/O.
 *
 * `conflicts` lists file paths that appear in more than one task's
 * file surface (sourceFiles ∪ testFiles).
 *
 * `owners` maps each conflicting file to the list of task IDs that
 * reference it. Useful for debug logging; not exposed to agent by default.
 */
export interface ConflictReport {
  conflicts: string[];
  owners: Map<string, string[]>;
}

/**
 * Result returned by runBatch. The agent sees mode/degraded/conflicts/
 * completed/totalDuration in content.text; full per-task details are in
 * the pi extension `details` field (KD-3: black-box contract).
 */
export interface BatchResult {
  /** True if all tasks completed successfully (results.every(r => r.success)) */
  success: boolean;
  /** Actual execution mode chosen by the scheduler */
  mode: "parallel" | "serial";
  /** True when conflicts forced downgrade to serial */
  degraded: boolean;
  /** Populated only when degraded === true */
  conflicts?: string[];
  /** Per-task outcomes, ordered by tasks input order */
  results: TaskResult[];
  /** IDs of tasks that completed successfully */
  completed: string[];
  /**
   * Wall-clock duration in milliseconds for the entire batch.
   * Uses monotonic clock (performance.now()), robust to NTP corrections.
   */
  totalDuration: number;
  /**
   * Top-3 failure messages (KD-3 diagnosis aid). Populated only when at
   * least one task failed. Format: "<taskId>: <phase error>".
   * Gives the agent a way to diagnose batch failures without bypassing
   * the black-box contract by reading .sages/workspace/ directly.
   */
  topErrors?: string[];
}
