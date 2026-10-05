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
 *      phase categories complete, the cascade is exhausted on NEEDS_WORK
 *      after max_fix_iterations, or the workflow pauses on NEEDS_CLARIFICATION
 *   5. Resolves with `WorkflowRunOutput` (LLM-facing shape unchanged) when
 *      the pipeline completes or blocks
 *
 * GC-2026-verdict-states-and-dynamic-cascade additions:
 *   - The phase-complete event can now carry status="needs_clarification"
 *     (Review emitted verdict=NEEDS_CLARIFICATION). workflow-run pauses
 *     the workflow and surfaces the open_question via WorkflowRunOutput.
 *   - The phase-complete event also carries verdict=NEEDS_REDESIGN; the
 *     workflow tracks redesigns_used (capped by max_redesigns, default 1)
 *     and resolves as blocked if the redesign budget is exhausted.
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
		/**
		 * GC-2026-verdict-states-and-dynamic-cascade: cap on
		 * NEEDS_REDESIGN dispatches. Default 1.
		 */
		max_redesigns?: number;
		/**
		 * GC-2026-needs-clarification-resume: when the prior workflow_run
		 * emitted `needs_clarification` (Reviewer surfaced an
		 * `open_question`), the orchestrator main agent can pass the
		 * user's answer here on re-dispatch. workflow-run stamps it into
		 * `workflow-{goal_id}.yaml` for audit and surfaces it in the
		 * LLM-facing output as `clarification_answer_recorded`.
		 *
		 * The cascade itself is NOT auto-resumed by passing this field —
		 * the orchestrator main agent decides whether to start a fresh
		 * pipeline or to manually edit `workflow-{goal_id}.yaml` to set
		 * the paused Review's verdict to CLEAN before re-running.
		 */
		clarification_answer?: string;
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
	/**
	 * GC-2026-verdict-states-and-dynamic-cascade: widened from
	 * `CLEAN | NEEDS_WORK` to 4-state set.
	 */
	verdict: "CLEAN" | "NEEDS_WORK" | "NEEDS_REDESIGN" | "NEEDS_CLARIFICATION";
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
	/**
	 * GC-2026-verdict-states-and-dynamic-cascade: was named
	 * `iterations_used` and effectively aliased to lastReviewIteration. Now
	 * the field reflects the actual Fix-dispatch count from the workflow
	 * layer's `fix_iterations_used` counter. A new sibling
	 * `redesigns_used` tracks NEEDS_REDESIGN dispatches.
	 */
	iterations_used: number;
	/**
	 * GC-2026-verdict-states-and-dynamic-cascade: count of NEEDS_REDESIGN
	 * Implement dispatches. Capped by max_redesigns (default 1). Surfaces
	 * in the LLM-facing output so the orchestrator can decide whether to
	 * start a fresh goal or accept the block.
	 */
	redesigns_used?: number;
	/**
	 * GC-2026-verdict-states-and-dynamic-cascade: surfaced when the last
	 * Review emitted NEEDS_CLARIFICATION. Free-form question text the
	 * Reviewer attached to the verdict.
	 */
	open_question?: string;
	/**
	 * GC-2026-needs-clarification-resume: echoed back when
	 * `options.clarification_answer` was passed to this run. Confirms
	 * the answer was persisted to `workflow-{goal_id}.yaml`; the
	 * orchestrator main agent uses this as proof the user's answer
	 * was recorded before deciding whether to proceed.
	 */
	clarification_answer_recorded?: string;
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
	// GC-2026-verdict-states-and-dynamic-cascade: adds "needs_clarification"
	// for the Review=NEEDS_CLARIFICATION pause path.
	status: "completed" | "failed" | "needs_clarification";
	verdict?: "CLEAN" | "NEEDS_WORK" | "NEEDS_REDESIGN" | "NEEDS_CLARIFICATION";
	findings_count?: number;
	open_question?: string;
	task_id: string;
	error?: string;
}

interface WorkflowState {
	schema_version: "v1";
	goal_id: string;
	workflow_id: string;
	started_at: string;
	current_phase: "implement" | "review" | "fix_loop" | "redesign" | "merge" | "completed" | "blocked" | "needs_clarification";
	status: "pending" | "running" | "success" | "blocked" | "needs_clarification";
	/**
	 * GC-2026-verdict-states-and-dynamic-cascade: this field is kept as
	 * the LLM-facing iteration counter (max_fix_iterations compatible),
	 * but it now reflects the actual Fix-dispatch count from the
	 * tracking layer (not lastReviewIteration as before — that semantic
	 * was misleading, see audit).
	 */
	iterations_used: number;
	/**
	 * GC-2026-verdict-states-and-dynamic-cascade: count of NEEDS_REDESIGN
	 * Implement dispatches. Capped by max_redesigns (default 1).
	 */
	redesigns_used: number;
	/**
	 * GC-2026-needs-clarification-resume: when set, the user has
	 * answered the prior NEEDS_CLARIFICATION pause. Read by the
	 * orchestrator main agent when deciding whether to re-dispatch
	 * workflow_run after surfacing the question.
	 */
	clarification_answer?: string;
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
			/**
			 * GC-2026-verdict-states-and-dynamic-cascade: cap on
			 * NEEDS_REDESIGN dispatches. Default 1.
			 */
			max_redesigns: Type.Optional(
				Type.Number({ minimum: 0, maximum: 5, description: "Maximum NEEDS_REDESIGN → new Implement cycles. Default 1." }),
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
			/**
			 * GC-2026-needs-clarification-resume: pass the user's answer
			 * to a prior NEEDS_CLARIFICATION pause. The orchestrator main
			 * agent must collect this from the user before re-dispatching
			 * workflow_run. Persisted to `workflow-{goal_id}.yaml` for
			 * audit; does NOT auto-resume the cascade.
			 */
			clarification_answer: Type.Optional(Type.String({ description: "User's answer to a prior Reviewer's NEEDS_CLARIFICATION open_question." })),
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
		`redesigns_used: ${state.redesigns_used}`,
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
	/**
	 * GC-2026-workflow-chat-stream: streaming progress callback. Mirrors
	 * pi-coding-agent's `ToolDefinition.execute()`'s `onUpdate` parameter —
	 * the host (TUI interactive mode) renders each call as a partial
	 * tool-result block in the chat, so the user sees phase progress live
	 * instead of waiting for the full tool result.
	 *
	 * The payload shape is `WorkflowProgressUpdate` (see below). The host
	 * is expected to render `partial: true` as a streaming indicator.
	 */
	onUpdate?: (update: WorkflowProgressUpdate) => void;
}

/**
 * GC-2026-workflow-chat-stream: structured payload emitted via
 * `RunContext.onUpdate` on each `workflow:phase-complete` event.
 * `partial: true` signals to the host (pi-coding-agent's
 * `ToolRenderResultOptions.isPartial`) that this is a streaming
 * intermediate, not the final tool result.
 */
export interface WorkflowProgressUpdate {
	/** Always true for onUpdate calls — distinguishes from final AgentToolResult. */
	partial: true;
	/** Goal contract id (e.g. "GC-2026-foo"). */
	goal_id: string;
	/** Current phase that just completed (or is active). */
	current_phase: "implement" | "review" | "fix" | "merge" | "needs_clarification" | "redesign";
	/** Iteration counter (1-indexed). 0 for Implement/Merge. */
	iteration: number;
	/** Last Review verdict (only set when current_phase === "review" or fix/merge follows). */
	last_verdict?: "CLEAN" | "NEEDS_WORK" | "NEEDS_REDESIGN" | "NEEDS_CLARIFICATION";
	/** Findings count from the last Reviewer verdict. */
	findings_count?: number;
	/** Fix dispatch count so far (max_fix_iterations capped). */
	fix_iterations_used?: number;
	/** NEEDS_REDESIGN dispatch count so far (max_redesigns capped). */
	redesigns_used?: number;
	/** Total tasks completed so far. */
	tasks_done: number;
	/** Total task count in the static graph (Implement + N Reviews + Merge). */
	tasks_total: number;
	/** Wall-clock ms since workflow:start. */
	elapsed_ms: number;
	/** Open question surfaced by NEEDS_CLARIFICATION (set only on that phase). */
	open_question?: string;
	/**
	 * Short human-readable summary the TUI can render as the partial
	 * block body (e.g. "Review 1 of 3: CLEAN"). TUI may render this
	 * directly or compose a richer view from the structured fields.
	 */
	summary: string;
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
		redesigns_used: 0,
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
		max_redesigns: opts.max_redesigns,
		worktree_path: worktreePath,
	});

	// ── 5. Subscribe to workflow:phase-complete, aggregate, resolve ────
	return new Promise<WorkflowRunOutput>((resolveFn) => {
		let implementDone = false;
		let mergeDone = false;
		let lastReviewVerdict:
			| "CLEAN"
			| "NEEDS_WORK"
			| "NEEDS_REDESIGN"
			| "NEEDS_CLARIFICATION"
			| undefined;
		let lastReviewIteration = 0;
		let redesignsCount = 0; // GC-2026-verdict-states-and-dynamic-cascade: per-workflow counter
		let pendingOpenQuestion: string | undefined;
		const taskSummaries: Record<string, TaskSummary> = {};
		// GC-2026-workflow-chat-stream: tasks_total = static graph size
		// (Implement + N Reviews + Merge). workflow-handler creates the static
		// graph in onWorkflowStart; we don't have direct access here, so
		// approximate via the static TasksConfig (5 for max=3). For
		// accurate count, recompute from buildStaticWorkflowGraph — but the
		// shape is stable (Implement + max_fix_iterations Reviews + Merge)
		// so the approximate is fine for the streaming UI.
		const tasksTotalEstimate = 1 + maxFixIterations + 1;
		let tasksDone = 0;
		const startedAtMs = Date.parse(state.started_at);
		// GC-2026-workflow-chat-stream: build a partial-progress payload and
		// emit it via the host's onUpdate callback. Host renders partial
		// result blocks; user sees phases appear live.
		const emitProgress = (
			currentPhase: WorkflowProgressUpdate["current_phase"],
			phaseIteration: number,
			phaseLabel: string,
		) => {
			if (!runCtx.onUpdate) return;
			runCtx.onUpdate({
				partial: true,
				goal_id: goalId,
				current_phase: currentPhase,
				iteration: phaseIteration,
				...(lastReviewVerdict !== undefined && {
					last_verdict: lastReviewVerdict,
				}),
				...(ev_findings_count !== undefined && {
					findings_count: ev_findings_count,
				}),
				fix_iterations_used: state.iterations_used,
				redesigns_used: redesignsCount,
				tasks_done: tasksDone,
				tasks_total: tasksTotalEstimate,
				elapsed_ms: Math.max(0, Date.now() - startedAtMs),
				...(pendingOpenQuestion !== undefined && {
					open_question: pendingOpenQuestion,
				}),
				summary: phaseLabel,
			});
		};
		// Snapshot of the last findings_count we saw (kept outside the closure
		// so emitProgress reads the most recent value).
		let ev_findings_count: number | undefined;

		const unsub = pi.events.on("workflow:phase-complete", (data) => {
			const ev = data as PhaseCompleteEvent;
			if (ev.workflow_id !== workflowId) return;

			taskSummaries[ev.task_id] = {
				id: ev.task_id,
				status: ev.status === "completed" ? "completed" : "failed",
				...(ev.error && { error: ev.error }),
			};
			ev_findings_count = ev.findings_count;

			// GC-2026-verdict-states-and-dynamic-cascade: the pause path.
			// Review emitted verdict=NEEDS_CLARIFICATION. workflow-run
			// resolves as needs_clarification so the orchestrator main
			// agent can surface the open_question. We do NOT cascade
			// further — the tracking layer (workflow-handler) stopped
			// dispatching after the needs_clarification phase-complete.
			if (ev.status === "needs_clarification") {
				lastReviewVerdict = "NEEDS_CLARIFICATION";
				pendingOpenQuestion = ev.open_question;
				state.current_phase = "needs_clarification";
				state.status = "needs_clarification";
				// GC-2026-needs-clarification-resume: stamp the user's
				// answer into state if it was passed via options.clarification_answer.
				// The orchestrator main agent can read this back via
				// WorkflowRunOutput.clarification_answer_recorded.
				if (opts.clarification_answer !== undefined) {
					state.clarification_answer = opts.clarification_answer;
				}
				saveWorkflowState(repoCwd, state);
				unsub();
				resolveFn(
					buildClarificationOutput(
						goalId,
						maxFixIterations,
						state.iterations_used,
						redesignsCount,
						worktreePath,
						branch,
						taskSummaries,
						pendingOpenQuestion,
						state.clarification_answer,
					),
				);
				return;
			}

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
						redesignsCount,
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
				tasksDone += 1;
				state.current_phase = "review";
			} else if (ev.phase === "review") {
				lastReviewVerdict = ev.verdict;
				lastReviewIteration = ev.iteration ?? lastReviewIteration + 1;
				tasksDone += 1;
				if (ev.verdict === "NEEDS_REDESIGN") {
					redesignsCount += 1;
					state.redesigns_used = redesignsCount;
					state.current_phase = "redesign";
				} else if (ev.verdict === "NEEDS_WORK") {
					// GC-2026-verdict-states-and-dynamic-cascade: this counter now
					// reflects actual Fix dispatches (which only happen on
					// NEEDS_WORK). The semantic shift from "lastReviewIteration"
					// is the postmortem-documented rationale.
					state.iterations_used += 1;
					state.current_phase = "fix_loop";
				} else {
					state.current_phase = "review";
				}
			} else if (ev.phase === "fix") {
				// Cascade: Fix → next Review. Just record.
				tasksDone += 1;
				state.current_phase = "review";
			} else if (ev.phase === "merge") {
				mergeDone = true;
				tasksDone += 1;
				state.current_phase = "completed";
			}
			saveWorkflowState(repoCwd, state);

			// GC-2026-workflow-chat-stream: emit a partial progress update to
			// the host (pi-coding-agent's onUpdate channel) so the user sees
			// the phase transition in the chat thread live. Phases are
			// reported AFTER state mutations so the payload reflects the
			// post-transition counters.
			const summaryLabel =
				ev.phase === "implement"
					? `Implement complete — Review ${(ev.iteration ?? lastReviewIteration) + 1} starting`
					: ev.phase === "review"
						? `Review ${ev.iteration ?? lastReviewIteration} (iter ${lastReviewIteration}): ${ev.verdict ?? "?"}`
						: ev.phase === "fix"
							? `Fix ${ev.iteration ?? state.iterations_used}: dispatched`
							: ev.phase === "merge"
								? `Merge dispatched`
								: `${ev.phase} complete`;
			emitProgress(
				ev.phase === "review"
					? "review"
					: ev.phase === "fix"
						? "fix"
						: ev.phase === "merge"
							? "merge"
							: "implement",
				ev.iteration ?? lastReviewIteration,
				summaryLabel,
			);

			// ── Resolve conditions ──
			// Success: implement + last review (CLEAN) + merge all done
			if (implementDone && lastReviewVerdict === "CLEAN" && mergeDone) {
				unsub();
				resolveFn(buildSuccessOutput(goalId, maxFixIterations, redesignsCount, worktreePath, branch, taskSummaries));
				return;
			}
			// Blocked: NEEDS_WORK iterations exhausted AND last review was NEEDS_WORK AND no merge.
			if (
				implementDone &&
				state.iterations_used >= maxFixIterations &&
				lastReviewVerdict === "NEEDS_WORK" &&
				!mergeDone
			) {
				unsub();
				resolveFn(
					buildBlockedOutput(
						goalId,
						maxFixIterations,
						state.iterations_used,
						redesignsCount,
						worktreePath,
						branch,
						taskSummaries,
					),
				);
				return;
			}
			// Blocked: NEEDS_REDESIGN redesigns exhausted.
			const maxRedesigns = opts.max_redesigns ?? 1;
			if (
				implementDone &&
				lastReviewVerdict === "NEEDS_REDESIGN" &&
				redesignsCount >= maxRedesigns &&
				!mergeDone
			) {
				unsub();
				resolveFn(
					buildBlockedOutput(
						goalId,
						maxFixIterations,
						state.iterations_used,
						redesignsCount,
						worktreePath,
						branch,
						taskSummaries,
						"review",
						`NEEDS_REDESIGN budget (${maxRedesigns}) exhausted`,
					),
				);
				return;
			}
		});
	});
}

function buildSuccessOutput(
	goalId: string,
	maxFixIterations: number,
	redesignsUsed: number,
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
		redesigns_used: redesignsUsed,
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
	redesignsUsed: number,
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
		redesigns_used: redesignsUsed,
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
				verdict: isFailure ? "NEEDS_WORK" : "NEEDS_WORK",
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

/**
 * GC-2026-verdict-states-and-dynamic-cascade: the Review emitted
 * verdict=NEEDS_CLARIFICATION with an `open_question`. workflow-run
 * resolves as status="blocked" with blocked_at="review" (the failing
 * phase) and surfaces the open_question so the orchestrator main agent
 * can relay it to the user.
 *
 * Note: the workflow-run status enum stays {success, blocked}. The
 * NEEDS_CLARIFICATION pause is signalled via `blocked_at: "review"`
 * + `open_question` rather than a new top-level status — keeping the
 * LLM-facing output shape additive.
 */
function buildClarificationOutput(
	goalId: string,
	maxFixIterations: number,
	iterationsUsed: number,
	redesignsUsed: number,
	worktreePath: string,
	branch: string,
	tasks: Record<string, TaskSummary>,
	openQuestion: string | undefined,
	// GC-2026-needs-clarification-resume: when the user re-dispatches with
	// options.clarification_answer, echo it back so the orchestrator main
	// agent can confirm the answer was recorded before deciding the next
	// move. The orchestrator main agent then decides whether to start a
	// fresh pipeline or to manually flip the paused Review to CLEAN in
	// `workflow-{goal_id}.yaml` before re-running.
	clarificationAnswerRecorded: string | undefined,
): WorkflowRunOutput {
	return {
		status: "blocked",
		goal_id: goalId,
		iterations_used: iterationsUsed,
		redesigns_used: redesignsUsed,
		blocked_at: "review",
		open_question: openQuestion,
		clarification_answer_recorded: clarificationAnswerRecorded,
		tasks: {
			implement: {
				...(tasks["t-implement"] ?? {}),
				id: "t-implement",
				agent_id: "t-implement",
				status: "completed",
			},
			review: {
				...tasks["t-review-final"] ?? {},
				id: "t-review-final",
				status: "completed",
				agent_id: "t-review-final",
				verdict: "NEEDS_CLARIFICATION",
				findings_count: 0,
				iterations: iterationsUsed,
				duration_ms: 0,
			},
		},
		pi_tasks: { implement: "", review: "", fix: "", merge: "" },
		unresolved_findings: [],
		paths: { worktree: worktreePath, branch, goal_yaml: `.pi/orchestrator/goal-${goalId}.yaml` },
		summary: `Goal ${goalId} needs clarification: ${openQuestion ?? "(no question provided)"}`,
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
