/**
 * Orchestrator Types
 *
 * Goal-driven task DAG for the orchestrator workflow. The MDD Seven Planes
 * classification (`plane` + `priority`) is preserved via `MDDPlane` and
 * `MDDPriority` from `./planes.js` so DAG templates remain readable and
 * the orchestrator can audit plane-coverage — but no MDD draft.md is
 * produced (the four-sage workflow that authored those is gone).
 *
 * Storage location: .pi/orchestrator/  (NOT .sages/workspace/ — that
 * directory is reserved for ephemeral session state).
 */

import type { MDDPlane, MDDPriority } from "./planes.js";

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
 * Combines MDD classification (plane / priority) with orchestrator-specific
 * execution fields (subagent_type, batch, acceptance, etc.).
 */
export interface TaskNode {
	/** Semantic id like "P1", "P2.a" */
	id: string;
	/** What this task accomplishes */
	description: string;
	/** MDD Seven Planes classification */
	plane: MDDPlane;
	/** Priority */
	priority: MDDPriority;
	/** Task ids this depends on */
	depends_on: string[];
	/** Files this task touches */
	files: string[];
	/** Subagent role to dispatch to (e.g. "software-developer", "software-auditor") */
	subagent_type: string;
	/** Concurrency grouping — same batch runs in parallel */
	batch: number;
	/** Filesystem isolation: "worktree" = own git branch, "none" = shared */
	isolation: "worktree" | "none";
	/** Whether this task requires strict TDD (delegated to software-developer subagent's RED → GREEN → REFACTOR) */
	tdd: "strict" | "none";
	/**
	 * Optional per-task override for the dispatcher's `run_in_background`
	 * policy. When omitted, the dispatcher derives a default from
	 * `subagent_type` (Explore/Plan/general-purpose = foreground,
	 * software-developer/software-auditor = background).
	 */
	run_in_background?: boolean;
	/** Detailed prompt given to the subagent (assembled by orchestrator from MDD outputs, or rendered from task_template) */
	prompt: string;
	/** Optional template reference — if set, dag_synthesizer renders prompt from template + task_params */
	task_template?: string;
	/** Parameters passed to the task_template renderer (replaces or augments manual prompt) */
	task_params?: Record<string, unknown>;
	/**
	 * Inputs from upstream tasks. At dispatch time, the dispatcher reads each
	 * upstream task's output_path and appends the content to the subagent's prompt
	 * under a "Context from upstream tasks" section.
	 */
	inputs?: Array<{
		/** The task id whose output to read */
		from_task: string;
		/** Logical field name (e.g. "findings", "design", "report") — used as section heading */
		field: string;
		/** How to embed the upstream output: "inline" (default) or "summary" (first 500 chars) */
		embed?: "inline" | "summary";
	}>;
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

/** One audit finding. Categories mirror the GaoYao 5-phase vocabulary. */
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

/**
 * Template reference — points to a template file under
 * skills/orchestrator/templates/{prompts,goals,dag,responses}/
 *
 * When task_template is set, dag_synthesizer renders the prompt
 * automatically from task_params. When omitted, the LLM-written
 * prompt field is used as-is.
 */
export interface TaskTemplate {
	/** Template name (without extension). E.g. "subagent-software-developer" */
	name: string;
	/** Parameters passed to the template renderer */
	params: Record<string, unknown>;
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