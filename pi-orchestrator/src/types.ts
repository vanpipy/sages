/**
 * Orchestrator Types
 *
 * After GC-2026-orchestrator-simplify + GC-2026-workflow-run +
 * GC-2026-path-B-swap the orchestrator owns TWO tools
 * (`goal_contract_create`, `workflow_run`) — DAG, dispatch, audit,
 * and reminder tools were removed. The intent contract below is what
 * gets written to disk; workflow_run is a thin event-driven shim that
 * emits `workflow:start` to pi-tasks and waits for `workflow:phase-complete`.
 * For escape-hatch shapes the LLM can drive pi-tasks's
 * TaskCreate × N + TaskExecute directly.
 *
 * Storage location: .pi/orchestrator/  (NOT .sages/workspace/ — that
 * directory is reserved for ephemeral session state).
 */

/** The contract that the orchestrator commits to satisfying. */
export interface GoalContract {
	/** Stable id, e.g. "GC-2025-001" */
	id: string;
	title: string;
	/** Why this goal exists */
	rationale?: string;
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

/** Path conventions — single source of truth for the orchestrator directory layout. */
export const ORCHESTRATOR_DIR = ".pi/orchestrator";
export const GOAL_CONTRACT_PREFIX = "goal-";

/** Returns the path for a goal contract YAML. */
export function goalContractPath(cwd: string, id: string): string {
	return `${cwd}/${ORCHESTRATOR_DIR}/${GOAL_CONTRACT_PREFIX}${id}.yaml`;
}
