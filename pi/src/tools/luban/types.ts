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
