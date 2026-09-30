/**
 * Orchestrator Types
 *
 * After GC-2026-orchestrator-simplify the orchestrator owns ONE tool
 * (`goal_contract_create`) — DAG, dispatch, audit, and reminder tools were
 * removed. The intent contract below is what gets written to disk; the LLM
 * is responsible for orchestrating the Implement → Review → optional Fix →
 * Merge pipeline via pi-tasks (TaskCreate × 4 + TaskExecute). GC-2 adds
 * `workflow_run` as a one-shot pipeline runner.
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
