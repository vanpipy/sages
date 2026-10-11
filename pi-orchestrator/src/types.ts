/**
 * Orchestrator Types
 *
 * After GC-2026-orchestrator-simplify + GC-2026-task-feeding-and-decomposition +
 * GC-2026-remove-workflow-run-prod + GC-2026-decompose-task-removed the
 * orchestrator owns ONE tool (`goal_contract_create`) — DAG, dispatch,
 * audit, reminder, workflow_run, and decompose_task tools were removed.
 * The intent contract below is what gets written to disk; the canonical
 * 4-phase pipeline (Implement → Review ⇆ Fix → Merge) is materialized
 * by the LLM as raw `TaskCreate` × N + `TaskExecute` directly, with
 * `agentType` set to `"Developer"` / `"Reviewer"` / `"Fix"` /
 * `"MergerAdvisor"` per phase.
 *
 * Storage location: `${TMPDIR}/${ORCHESTRATOR_WORKDIR}` (see
 * `./workdir.ts`). The legacy per-project `.pi/orchestrator/` layout was
 * retired — see git log: chore/orchestrator-workdir-tmpdir.
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

/** Path conventions — prefix for goal-contract filenames. */
export const GOAL_CONTRACT_PREFIX = "goal-";
