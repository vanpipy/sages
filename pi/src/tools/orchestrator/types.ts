/**
 * Orchestrator Types
 *
 * Goal-driven task DAG for orchestrator workflow. Complements (does not replace)
 * the MDD-driven decomposition in qiaochui/types.ts:
 *   - MDDTask = "what to build" (planes, files)
 *   - TaskNode = "how to execute" (subagent_type, batch, acceptance)
 *
 * Storage location: .pi/orchestrator/  (NOT .sages/workspace/ — that's sages' territory
 * and would cause shared-workspace conflicts when subagents run in parallel).
 */

import type { MDDTask } from "../qiaochui/types.js";

/** A single success criterion with verification (must be runnable). */
export interface SuccessCriterion {
  /** Stable id, e.g. "SC1" */
  id: string;
  /** Human-readable description */
  criterion: string;
  /** Command that proves pass/fail. Must be non-empty. */
  verification_cmd: string;
  /** Expected output snippet (optional, for fuzzy checks) */
  expected_output?: string;
  /** Priority for failure reporting */
  severity?: "blocker" | "major" | "minor";
}

/** The contract that the orchestrator commits to satisfying. */
export interface GoalContract {
  /** Stable id, e.g. "GC-2025-001" */
  id: string;
  title: string;
  /** Why this goal exists */
  rationale?: string;
  /** Binary success criteria — every one must be verifiable */
  success_criteria: SuccessCriterion[];
  /** Things explicitly NOT to do */
  anti_goals: string[];
  /** Files / modules in scope */
  scope: {
    include: string[];
    exclude: string[];
  };
  /** Hard constraints */
  constraints: {
    must_use_existing_patterns?: boolean;
    max_dependency_additions?: number;
    test_coverage_min?: number;
    typecheck_required?: boolean;
    lint_required?: boolean;
    /** Free-form additional constraints */
    [key: string]: unknown;
  };
  /** Free-form completion definition */
  done_definition: string;
  /** ISO timestamp */
  created_at: string;
}

/**
 * One executable task in the orchestrator DAG.
 *
 * Extends MDDTask with orchestrator-specific execution fields:
 *   - subagent_type: which role to dispatch to
 *   - batch: concurrency grouping (same batch run in parallel)
 *   - acceptance: verifiable completion check
 *   - output_schema: structured output contract
 *   - isolation: worktree vs none
 *
 * Subagents use `dependencies` (which depends on what) — internally we use
 * `depends_on` for consistency with MDD.
 */
export interface TaskNode extends Omit<MDDTask, "id" | "dependsOn"> {
  /** Semantic id like "P1", "P2.a" (preserved from MDDTask) */
  id: string;
  /** Same shape as MDDTask.dependsOn */
  depends_on: string[];
  /** Subagent role to dispatch to (e.g. "software-developer", "software-auditor") */
  subagent_type: string;
  /** Concurrency grouping — same batch runs in parallel */
  batch: number;
  /** Filesystem isolation: "worktree" = own git branch, "none" = shared */
  isolation: "worktree" | "none";
  /** Whether this task requires strict TDD (LuBan-sage-enforced RED → GREEN → REFACTOR) */
  tdd: "strict" | "none";
  /** Detailed prompt given to the subagent (assembled by orchestrator from MDD outputs) */
  prompt: string;
  /** Structured output contract */
  output_schema: {
    kind: "file_list" | "design_doc" | "code_changes" | "test_results" | "verdict";
    /** Where the output is written (relative to cwd) */
    path?: string;
    /** Required fields for verification */
    fields?: string[];
  };
  /** How to verify completion — maps to GoalContract.success_criteria */
  acceptance: {
    /** SC ids this task covers */
    covers: string[];
    /** Optional automated verification command (run by subagent itself) */
    self_check_cmd?: string;
    /** Optional automated verification command (run by auditor) */
    auditor_check_cmd?: string;
  };
  /** Runtime state (filled during execution) */
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  retry_count: number;
  max_retries: number;
  /** ISO timestamps */
  started_at?: string;
  completed_at?: string;
  /** Outputs */
  output?: string;
  output_path?: string;
  error?: string;
}

/** Top-level DAG orchestration plan. */
export interface OrchestrationPlan {
  /** Stable id */
  id: string;
  /** Reference to the goal contract */
  goal_id: string;
  /** Title (echoed from goal contract) */
  title: string;
  /** Tasks in execution order (topological) */
  tasks: TaskNode[];
  /** ISO timestamps */
  created_at: string;
  updated_at: string;
  /** Workflow state */
  state: "draft" | "approved" | "executing" | "completed" | "failed";
  /** Map from task_id to subagent prompt (assembled by dag_synthesize) */
  prompts: Record<string, string>;
}

/** Audit verdict (one task or whole workflow). */
export type AuditVerdict = "PASS" | "REVISE" | "REJECT";

/** One audit finding (mirrors GaoYao's finding shape, scoped to orchestrator task). */
export interface OrchestratorFinding {
  task_id?: string;
  category: "ink" | "nose" | "foot" | "castration" | "death";
  severity: "critical" | "major" | "minor";
  issue: string;
  evidence?: string;
  recommendation?: string;
}

/** Result of orchestrator_audit on a single task or whole DAG. */
export interface OrchestratorAuditResult {
  verdict: AuditVerdict;
  /** 0-100 */
  score: number;
  findings: OrchestratorFinding[];
  /** Path to the audit report markdown */
  report_path: string;
  /** Summary text */
  summary: string;
}

/** Path conventions — single source of truth for the orchestrator directory layout. */
export const ORCHESTRATOR_DIR = ".pi/orchestrator";
export const GOAL_CONTRACT_PREFIX = "goal-";
export const DAG_PREFIX = "dag-";
export const TASK_REPORT_PREFIX = "task-";
export const TASK_AUDIT_PREFIX = "audit-";
export const WORKFLOW_AUDIT = "audit-workflow.md";

/** Returns the path for a goal contract YAML. */
export function goalContractPath(cwd: string, id: string): string {
  return `${cwd}/${ORCHESTRATOR_DIR}/${GOAL_CONTRACT_PREFIX}${id}.yaml`;
}

/** Returns the path for a DAG YAML. */
export function dagPath(cwd: string, id: string): string {
  return `${cwd}/${ORCHESTRATOR_DIR}/${DAG_PREFIX}${id}.yaml`;
}

/** Returns the path for a task report. */
export function taskReportPath(cwd: string, taskId: string): string {
  return `${cwd}/${ORCHESTRATOR_DIR}/${TASK_REPORT_PREFIX}${taskId}-report.md`;
}

/** Returns the path for a task audit report. */
export function taskAuditPath(cwd: string, taskId: string): string {
  return `${cwd}/${ORCHESTRATOR_DIR}/${TASK_AUDIT_PREFIX}${taskId}.md`;
}