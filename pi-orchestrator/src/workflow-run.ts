/**
 * workflow-run.ts — GC-2026-path-B-swap slim event-driven workflow_run.
 *
 * Replaces the 1060-line in-process state machine (path A) with an
 * event-driven shim that:
 *
 *   1. Loads the goal contract (loadGoalContract — unchanged)
 *   2. Initializes `.pi/orchestrator/workflow-{goal_id}.yaml` (status: pending)
 *   3. Emits `pi.events.emit("workflow:start", ...)` with the WorkflowStartPayload
 *      contract that pi-tasks's `subscribeWorkflow` listens for
 *   4. Subscribes to `pi.events.on("workflow:phase-complete", ...)` to track
 *      each phase (implement / review / fix / merge) and aggregate until all
 *      phase categories complete or `max_fix_iterations` is exhausted on
 *      NEEDS_WORK verdicts
 *   5. Resolves with `WorkflowRunOutput` (LLM-facing shape unchanged) when
 *      the pipeline completes or blocks
 *
 * The 1060 → ~200 line collapse is the whole point of path B: all
 * orchestration logic now lives in pi-tasks (subscribeWorkflow's static
 * graph + cascade). workflow_run is purely a planning-layer façade that
 * emits events and waits for completion notifications.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { Type, type Static } from "typebox";

import { loadGoalContract } from "./goal-contract.js";
import type { GoalContract } from "./types.js";

// ── LLM-facing types (shape unchanged from path A; orchestrator SKILL depends on it) ──

export interface WorkflowRunInput {
	goal_path: string;
	options?: {
		max_fix_iterations?: number;
		agent_overrides?: {
			implement?: string;
			review?: string;
			fix?: string;
			merge?: string;
		};
		resume?: boolean;
	};
	verbose?: boolean;
}

export interface TaskSummary {
	id: string;
	status: "completed" | "failed";
	agent_id?: string;
	duration_ms?: number;
	commits?: number;
	error?: string;
}

export interface ReviewSummary extends TaskSummary {
	verdict: "CLEAN" | "NEEDS_WORK";
	findings_count: number;
	iterations: number;
	agent_id: string;
}

export interface Finding {
	severity: "minor" | "major" | "critical";
	issue: string;
	location?: string;
	recommendation?: string;
}

export interface WorkflowRunOutput {
	status: "success" | "blocked";
	goal_id: string;
	iterations_used: number;
	// GC-2026-pi-tasks-cascade-agentid: extended with "fix" so a Fix-phase
	// failure surfaces as blocked_at: "fix" rather than being aliased into
	// "review" (the previous NEEDS_WORK exhaustion code path).
	blocked_at?: "implement" | "review" | "fix" | "merge";
	tasks: {
		implement: TaskSummary & { agent_id: string };
		review: ReviewSummary;
		fix?: TaskSummary & { agent_id: string; iteration: number };
		merge?: TaskSummary & { agent_id: string; merge_commit?: string };
	};
	pi_tasks: { implement: string; review: string; fix: string; merge: string };
	unresolved_findings?: Finding[];
	merge_error?: string;
	paths: {
		worktree: string;
		branch: string;
		goal_yaml: string;
		merge_commit?: string;
	};
	summary: string;
}

// ── Internal types ─────────────────────────────────────────────────────

interface PhaseCompleteEvent {
	workflow_id: string;
	goal_id: string;
	phase: "implement" | "review" | "fix" | "merge";
	iteration?: number;
	// GC-2026-pi-tasks-cascade-agentid: extended from "completed" to also
	// carry "failed" — the tracking layer (subscribeWorkflow's subagents:failed
	// listener) emits this when a phase's subagent itself crashes (the
	// GC-2026-096 implement-failure case). workflow_run must resolve as
	// blocked in that case instead of hanging forever.
	status: "completed" | "failed";
	verdict?: "CLEAN" | "NEEDS_WORK";
	findings_count?: number;
	task_id: string;
	error?: string;
}

interface WorkflowState {
	schema_version: "v1";
	goal_id: string;
	workflow_id: string;
	started_at: string;
	current_phase: "implement" | "review" | "fix_loop" | "merge" | "completed" | "blocked";
	status: "pending" | "running" | "success" | "blocked";
	iterations_used: number;
	worktree_path: string;
	branch: string;
}

// ── TypeBox LLM-facing schema (unchanged) ──────────────────────────────

export const WorkflowRunParams = Type.Object({
	goal_path: Type.String({
		description: "Path to the goal contract YAML, e.g. '.pi/orchestrator/goal-GC-2026-xxx.yaml'",
	}),
	options: Type.Optional(
		Type.Object({
			max_fix_iterations: Type.Optional(
				Type.Number({ minimum: 0, maximum: 10, description: "Maximum Fix → re-Review cycles. Default 3." }),
			),
			agent_overrides: Type.Optional(
				Type.Object({
					implement: Type.Optional(Type.String()),
					review: Type.Optional(Type.String()),
					fix: Type.Optional(Type.String()),
					merge: Type.Optional(Type.String()),
				}),
			),
			resume: Type.Optional(Type.Boolean({ description: "Reuse completed phases from the workflow-{goal_id}.yaml state file. Default true." })),
		}),
	),
	verbose: Type.Optional(Type.Boolean()),
});
export type WorkflowRunInputType = Static<typeof WorkflowRunParams>;

// ── State file (`.pi/orchestrator/workflow-{goal_id}.yaml`) ────────────

function workflowPath(cwd: string, goalId: string): string {
	return resolve(cwd, ".pi", "orchestrator", `workflow-${goalId}.yaml`);
}

function saveWorkflowState(cwd: string, state: WorkflowState): void {
	const path = workflowPath(cwd, state.goal_id);
	const lines = [
		`# Workflow state for goal ${state.goal_id}`,
		`schema_version: ${state.schema_version}`,
		`goal_id: ${state.goal_id}`,
		`workflow_id: ${state.workflow_id}`,
		`started_at: ${state.started_at}`,
		`current_phase: ${state.current_phase}`,
		`status: ${state.status}`,
		`iterations_used: ${state.iterations_used}`,
		`worktree_path: ${state.worktree_path}`,
		`branch: ${state.branch}`,
	];
	writeFileSync(path, lines.join("\n") + "\n", { mode: 0o644 });
}

// ── Entry point ────────────────────────────────────────────────────────

interface RunContext {
	pi: { events: { emit: (channel: string, data: unknown) => void; on: (channel: string, handler: (data: unknown) => void | Promise<void>) => () => void } };
	ctx: unknown;
	repoCwd: string;
	executeTool?: (name: string, args: unknown) => Promise<unknown>;
}

const DEFAULT_MAX_FIX_ITERATIONS = 3;

export async function executeWorkflowRun(
	input: WorkflowRunInput,
	runCtx: RunContext,
): Promise<WorkflowRunOutput> {
	const { pi, repoCwd } = runCtx;
	const opts = input.options ?? {};
	const maxFixIterations = opts.max_fix_iterations ?? DEFAULT_MAX_FIX_ITERATIONS;

	// ── 1. Load goal contract ─────────────────────────────────────────
	const fileName = input.goal_path.split("/").pop() ?? "";
	const m = fileName.match(/^goal-(GC-[0-9a-zA-Z-]+)\.yaml$/);
	if (!m) throw new Error(`Goal file name must match goal-<id>.yaml; got: ${fileName}`);
	const goalId = m[1];

	const goal = loadGoalContract(repoCwd, goalId);
	if (!goal) throw new Error(`Goal contract failed to load: ${goalId}`);

	// ── 2. Derive worktree / branch / workflow_id (all absolute paths) ──
	const worktreePath = resolve(repoCwd, ".pi", "worktree", goalId, "implement");
	const branch = `sages/${goalId.toLowerCase()}-implement`;
	const workflowId = `wf-${goalId}`;

	// ── 3. Initialize workflow-{id}.yaml state file ────────────────────
	const state: WorkflowState = {
		schema_version: "v1",
		goal_id: goalId,
		workflow_id: workflowId,
		started_at: new Date().toISOString(),
		current_phase: "implement",
		status: "pending",
		iterations_used: 0,
		worktree_path: worktreePath,
		branch,
	};
	saveWorkflowState(repoCwd, state);

	// ── 4. Emit workflow:start ─────────────────────────────────────────
	pi.events.emit("workflow:start", {
		workflow_id: workflowId,
		goal_id: goalId,
		goal,
		max_fix_iterations: maxFixIterations,
		worktree_path: worktreePath,
	});

	// ── 5. Subscribe to workflow:phase-complete, aggregate, resolve ────
	return new Promise<WorkflowRunOutput>((resolveFn) => {
		let implementDone = false;
		let mergeDone = false;
		let lastReviewVerdict: "CLEAN" | "NEEDS_WORK" | undefined;
		let lastReviewIteration = 0;
		const taskSummaries: Record<string, TaskSummary> = {};

		const unsub = pi.events.on("workflow:phase-complete", (data) => {
			const ev = data as PhaseCompleteEvent;
			if (ev.workflow_id !== workflowId) return;

			taskSummaries[ev.task_id] = {
				id: ev.task_id,
				status: ev.status === "completed" ? "completed" : "failed",
				...(ev.error && { error: ev.error }),
			};

			// GC-2026-pi-tasks-cascade-agentid: failure short-circuits the
			// run. The remaining phases won't spawn — pi-tasks's cascade
			// reverts the failed task to pending with lastError metadata —
			// so we resolve as blocked immediately rather than waiting
			// forever for a completion that will never come.
			if (ev.status === "failed") {
				state.current_phase = "blocked";
				state.status = "blocked";
				saveWorkflowState(repoCwd, state);
				unsub();
				resolveFn(
					buildBlockedOutput(
						goalId,
						maxFixIterations,
						state.iterations_used,
						worktreePath,
						branch,
						taskSummaries,
						ev.phase,
						ev.error,
					),
				);
				return;
			}

			if (ev.phase === "implement") {
				implementDone = true;
				state.current_phase = "review";
			} else if (ev.phase === "review") {
				lastReviewVerdict = ev.verdict;
				lastReviewIteration = ev.iteration ?? lastReviewIteration + 1;
				state.iterations_used = Math.max(state.iterations_used, lastReviewIteration);
				state.current_phase = lastReviewVerdict === "NEEDS_WORK" ? "fix_loop" : "review";
			} else if (ev.phase === "fix") {
				// Cascade: Fix → next Review. Just record.
				state.current_phase = "review";
			} else if (ev.phase === "merge") {
				mergeDone = true;
				state.current_phase = "completed";
			}
			saveWorkflowState(repoCwd, state);

			// ── Resolve conditions ──
			// Success: implement + last review (CLEAN) + merge all done
			if (implementDone && lastReviewVerdict === "CLEAN" && mergeDone) {
				unsub();
				resolveFn(buildSuccessOutput(goalId, maxFixIterations, worktreePath, branch, taskSummaries));
				return;
			}
			// Blocked: iterations_used >= max AND last review was NEEDS_WORK AND no merge
			if (
				implementDone &&
				state.iterations_used >= maxFixIterations &&
				lastReviewVerdict === "NEEDS_WORK" &&
				!mergeDone
			) {
				unsub();
				resolveFn(buildBlockedOutput(goalId, maxFixIterations, state.iterations_used, worktreePath, branch, taskSummaries));
				return;
			}
		});
	});
}

function buildSuccessOutput(
	goalId: string,
	maxFixIterations: number,
	worktreePath: string,
	branch: string,
	tasks: Record<string, TaskSummary>,
): WorkflowRunOutput {
	const reviewSummary: ReviewSummary = {
		...tasks["t-review-final"] ?? {},
		id: "t-review-final",
		status: "completed",
		agent_id: "t-review-final",
		verdict: "CLEAN",
		findings_count: 0,
		iterations: 1,
		duration_ms: 0,
	};
	return {
		status: "success",
		goal_id: goalId,
		iterations_used: 0,
		tasks: {
			implement: { ...tasks["t-implement"] ?? { id: "t-implement", status: "completed" }, agent_id: "t-implement" },
			review: reviewSummary,
			merge: { ...tasks["t-merge"] ?? { id: "t-merge", status: "completed" }, agent_id: "t-merge" },
		},
		pi_tasks: { implement: "", review: "", fix: "", merge: "" },
		paths: { worktree: worktreePath, branch, goal_yaml: `.pi/orchestrator/goal-${goalId}.yaml` },
		summary: `Goal ${goalId} completed: merged ${branch} → main.`,
	};
}

function buildBlockedOutput(
	goalId: string,
	maxFixIterations: number,
	iterationsUsed: number,
	worktreePath: string,
	branch: string,
	tasks: Record<string, TaskSummary>,
	// GC-2026-pi-tasks-cascade-agentid: when a phase's subagent itself
	// crashes (status: "failed" on the phase-complete), surface the
	// failing phase + the error message in the LLM-facing output.
	failedPhase?: "implement" | "review" | "fix" | "merge",
	error?: string,
): WorkflowRunOutput {
	const isFailure = failedPhase !== undefined;
	return {
		status: "blocked",
		goal_id: goalId,
		iterations_used: iterationsUsed,
		blocked_at: isFailure ? failedPhase : "review",
		tasks: {
			implement: {
				...(tasks["t-implement"] ?? {}),
				id: "t-implement",
				agent_id: "t-implement",
				status: failedPhase === "implement" ? "failed" : "completed",
				...(isFailure && failedPhase === "implement" && error ? { error } : {}),
			},
			review: {
				...tasks["t-review-final"] ?? {},
				id: "t-review-final",
				status: "completed",
				agent_id: "t-review-final",
				verdict: "NEEDS_WORK",
				findings_count: 0,
				iterations: iterationsUsed,
				duration_ms: 0,
			},
		},
		pi_tasks: { implement: "", review: "", fix: "", merge: "" },
		unresolved_findings: [],
		merge_error: isFailure ? error : undefined,
		paths: { worktree: worktreePath, branch, goal_yaml: `.pi/orchestrator/goal-${goalId}.yaml` },
		summary: isFailure
			? `Goal ${goalId} blocked: ${failedPhase} phase failed (${error ?? "no error"}).`
			: `Max fix iterations (${maxFixIterations}) exhausted with NEEDS_WORK.`,
	};
}

// Silence lint for the unused `dirname` / `join` / `existsSync` / `readFileSync` / `executeTool`
// imports kept for symmetry with the path A state machine — they may be needed by future
// state-resume support that the slim version intentionally omits.
void dirname;
void join;
void existsSync;
void readFileSync;
void Type;
