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
	/**
	 * GC-2026-091: link from the goal contract back to the DAG it was
	 * synthesized into. Populated by `dag_synthesize` after the DAG YAML
	 * is written — i.e. the goal ↔ DAG edge is now programmatically
	 * reliable instead of a hand-typed guess. Optional because:
	 *
	 *   1. Pre-GC-2026-091 goal YAMLs have no `dag_id` field. The
	 *      validator (isGoalContractState) accepts the omission, and
	 *      `loadGoalContract` returns a goal with `dag_id: undefined`.
	 *   2. Newly-created goals (via `goal_contract_create`) do not have
	 *      this field until `dag_synthesize` is called.
	 *
	 * The orchestrator's auto-sync (D2 step in `executeDAGSynthesize`)
	 * atomically writes the goal yaml back with the new `dag_id` and
	 * recomputes `_lock_hash` to keep the lock consistent.
	 */
	dag_id?: string;
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
	/** Subagent role to dispatch to (e.g. "developer", "auditor") */
	subagent_type: string;
	/**
	 * GC-2026-066: optional list of tool names the task is expected to
	 * invoke. Consumed by pi-evaluator's ToolCorrectness metric (GC-2026-066
	 * T2) to compute precision / recall / F1 of actual tool invocations
	 * versus the declared intent. Additive — omitted = unchanged behavior.
	 *
	 * Tool names match CustomToolCallEvent.toolName values used in the
	 * LLM tool registry: 8 file/network tools (bash, read, edit, write,
	 * grep, find, ls, webfetch) plus the 4 Sages orchestrator tools
	 * (goal_contract_create, dag_synthesize, task_dispatch,
	 * orchestrator_audit). Unknown names emit a non-fatal warning at
	 * DAG construction time (see validateExpectedTools in
	 * dag-synthesizer.ts).
	 */
	expected_tools?: string[];
	/** Concurrency grouping — same batch runs in parallel */
	batch: number;
	/**
	 * Per-task isolation policy. GC-2026-017: main-agent dispatches
	 * `developer` in three explicit modes:
	 *
	 *   - Worktree (default): `{ dag_id, task_id, mode: "create" }` —
	 *     Agent tool provisions a managed worktree at
	 *     `.pi/worktree/<dag>/<task>` on branch `sages/<dag>/<task>`.
	 *   - Worktree reuse: `{ dag_id, task_id, mode: "reuse" }` — re-enter
	 *     an existing managed worktree (serial follow-ups in the same
	 *     workspace).
	 *   - Current workspace (GC-2026-017 NEW): `"current-workspace"` —
	 *     Agent tool runs the subagent in the parent's cwd with no
	 *     worktree. Use only for meta-files, single-line edits, and
	 *     design-doc writes where the safety invariant of the
	 *     worktree is unnecessary.
	 *   - Missing → dispatcher defaults to the worktree create object.
	 *
	 * `task_id` MUST match `TaskNode.id` — the dispatcher validates this
	 * at plan-load time and rejects mismatches.
	 *
	 * `"none"` is preserved for backward compatibility with persisted
	 * DAGs that use it (it means the same as omitted — dispatcher falls
	 * back to the worktree create default).
	 */
	isolation:
		| { dag_id: string; task_id: string; worktree_id?: string; mode: "create" | "reuse" }
		| "current-workspace"
		| "none";
	/**
	 * GC-2026-074: stable id assigned by `todowrite_compile` that links this
	 * TaskNode to its generated todowrite item. Optional — plans that were
	 * never compiled (older plans, plans the LLM never ran compile on) do
	 * not have this field, and the auto-sync is a silent no-op for them.
	 * Once set, it persists across rounds: `transitionTask` uses it as the
	 * `task_id` lookup key in the todo file.
	 */
	todo_id?: string;
	/** Whether this task requires strict TDD (delegated to the developer subagent's RED → GREEN → REFACTOR) */
	tdd: "strict" | "none";
	/**
	 * Optional per-task override for the dispatcher's `run_in_background`
	 * policy. When omitted, the dispatcher derives a default from
 * `subagent_type` (Explore/Plan = foreground; Plan compiles a main-agent
	 * Planning Brief; developer/auditor = background).
	 */
	run_in_background?: boolean;
	/**
	 * GC-2026-039: which HANDOFF.md template the developer must use when
	 * writing `.pi/orchestrator/handoff/<workspace_id>/<task_id>-handoff.md`
	 * on exit. Three literal values:
	 *
	 *   - "standard"   — Template A (default for most tasks). Five-section
	 *                    flat structure: Summary / Files / TODOs / Tests / Questions.
	 *   - "phase-gate" — Template B. Used when this task's workspace will be
	 *                    merged with another via the merger sub-agent. Adds
	 *                    Gate Criteria / Documents Carried Forward / Risks.
	 *   - "escalation" — Template C. Used after 2+ failures; the next
	 *                    dispatch is a fresh agent reading the escalation.
	 *                    Adds Failure History / Root Cause / Resolution.
	 *
	 * Only meaningful for `subagent_type === "developer"`. The dispatcher
	 * defaults missing values to "standard" for back-compat with DAGs
	 * authored before GC-2026-039 and renders the choice into the
	 * developer's prompt so it knows which template to follow.
	 */
	handoff_template?: "standard" | "phase-gate" | "escalation";
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
		/**
		 * SC ids this task covers. Required for tasks that satisfy goal
		 * contract SCs (developer, auditor); Explore/Plan/research tasks
		 * can omit this — they contribute to the workflow but don't
		 * directly satisfy any SC. validateDAG still requires every SC
		 * to be covered by at least one task that DOES declare covers.
		 */
		covers?: string[];
		/** Optional automated verification command (run by subagent itself) */
		self_check_cmd?: string;
		/** Optional automated verification command (run by auditor) */
		auditor_check_cmd?: string;
	};
	/**
	 * GC-2026-066: per-task non-fatal validation warnings. Currently
	 * populated by validateExpectedTools when a task references tool
	 * names not in the known registry (see KNOWN_TOOL_NAMES in
	 * dag-synthesizer.ts). Older plans written before GC-2026-066 omit
	 * the field; new plans attach one entry per task that has at least
	 * one unknown tool name. Downstream consumers (subagents reading
	 * the plan, evaluators scoring it) can use this list to surface
	 * informational notes without grep'ing the global
	 * DAGValidation.warnings array.
	 */
	acceptance_warnings?: string[];
	/** Runtime state (filled during execution) */
	status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
	retry_count: number;
	max_retries: number;
	/** Agent runtime identity recorded by task_dispatch lifecycle updates. */
	agent_id?: string;
	/** ISO timestamps */
	started_at?: string;
	completed_at?: string;
	failed_at?: string;
	/** Outputs */
	result?: string;
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
	/**
	 * Reserved for historical todo-compile marker (GC-2026-061). The
	 * auto-todowrite module that produced this flag was removed in the
	 * GC-2026-068 reversal; the field is kept so older dag yaml files
	 * still round-trip through `loadPlan` without losing their original
	 * provenance. New plans should never set it. Extra top-level fields
	 * are transparent to the persistence validators (structural checks only).
	 */
	compiled_from_todos?: boolean;
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
	/** Template name (without extension). E.g. "subagent-developer" */
	name: string;
	/** Parameters passed to the template renderer */
	params: Record<string, unknown>;
}

/**
 * GC-2026-073: LLM-facing summary of a subagent's current state. Returned
 * by the `subagent_status` tool. Plain object — never the live AgentRecord
 * reference — so the LLM cannot mutate internal manager state.
 */
export interface SubagentStatusSummary {
	id: string;
	type: string;
	description: string;
	status:
		| "queued"
		| "running"
		| "completed"
		| "steered"
		| "aborted"
		| "stopped"
		| "error";
	startedAt: number;
	completedAt?: number;
	isBackground?: boolean;
	lifetimeUsage?: { input: number; output: number; cacheWrite: number };
	toolUses?: number;
	compactionCount?: number;
}

/** Path conventions — single source of truth for the orchestrator directory layout. */
export const ORCHESTRATOR_DIR = ".pi/orchestrator";
export const GOAL_CONTRACT_PREFIX = "goal-";
export const DAG_PREFIX = "dag-";
export const TASK_REPORT_PREFIX = "task-";
export const TASK_AUDIT_PREFIX = "audit-";
export const WORKFLOW_AUDIT = "audit-workflow.md";
export const TODO_PREFIX = "todo-";

/**
 * GC-2026-074: link key between a todowrite item and the TaskNode it
 * shadows. Set by `todowrite_compile` at compile time; the DAG is the
 * source of truth, the todo is the LLM-facing view.
 */
export type TodoStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export interface TodoItem {
	todo_id: string;
	task_id: string;
	content: string;
	status: TodoStatus;
	last_synced_at: string | null;
}

export interface TodoFile {
	schemaVersion: "v1";
	dag_id: string;
	/**
	 * GC-2026-091: link from the todowrite view back to the goal contract
	 * it shadows. Populated by `todowrite_compile` from the
	 * OrchestrationPlan.goal_id at compile time so the todo view
	 * carries the full plan → DAG → todo → goal chain end-to-end.
	 *
	 * Optional because pre-GC-2026-091 todo YAMLs have no `goal_id`
	 * field — they continue to load through the `saveTodoFile`
	 * validator and `loadTodoFile` reader.
	 */
	goal_id?: string;
	compiled_at: string;
	compiled_from_todos: boolean;
	items: TodoItem[];
}

/**
 * Drift kind: how the LLM's todo view diverges from the DAG's task list.
 * "todo_ahead" / "dag_ahead" mean the two views disagree on completion
 * order; "todo_orphaned" / "task_orphaned" mean a record exists in one
 * view but not the other.
 */
export type TodoDriftKind = "todo_ahead" | "dag_ahead" | "todo_orphaned" | "task_orphaned";

export interface TodoDrift {
	todo_id?: string;
	task_id?: string;
	todo_status?: TodoStatus;
	dag_status?: TaskNode["status"];
	drift_kind: TodoDriftKind;
}

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

/** Returns the path for a todowrite YAML (GC-2026-074). */
export function todoPath(cwd: string, dagId: string): string {
	return `${cwd}/${ORCHESTRATOR_DIR}/${TODO_PREFIX}${dagId}.yaml`;
}