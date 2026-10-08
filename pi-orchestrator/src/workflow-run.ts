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
import { resolve } from "node:path";

import { Type, type Static } from "typebox";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";

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
		/**
		 * GC-2026-097 M1: previously advertised as "Reuse completed
		 * phases from the workflow-{goal_id}.yaml state file. Default true."
		 * but never wired through executeWorkflowRun — the slim path B
		 * implementation always re-creates the static graph from
		 * scratch. Reserved as an opaque pass-through for forward
		 * compatibility; orchestrator-side resume support is deferred
		 * to a future GC.
		 */
		resume?: boolean;
		/**
		 * GC-2026-109 FU1a: watchdog timeout in milliseconds. If no
		 * `workflow:phase-complete` event with the matching `workflow_id`
		 * arrives within this window, workflow_run rejects with a
		 * `WorkflowRunStartTimeoutError` instead of hanging until
		 * harness timeout. Default 10000. Set to 0 to disable the
		 * watchdog (escape hatch for tests that drive the cascade out
		 * of band, and for callers that want the old behavior).
		 */
		timeout_ms?: number;
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

// ── Error classes ─────────────────────────────────────────────────────

/**
 * GC-2026-109 FU1a: thrown when `workflow_run` does not receive any
 * `workflow:phase-complete` event for its `workflow_id` within
 * `options.timeout_ms` (default 10000). The error message names the
 * goal_id, workflow_id, and the actionable fix
 * (run `pi-orchestrator/scripts/install.sh` and restart pi).
 *
 * The class is exported so callers (and the harness) can match on
 * it via `instanceof` or `error.name === "WorkflowRunStartTimeoutError"`.
 */
export class WorkflowRunStartTimeoutError extends Error {
	override readonly name = "WorkflowRunStartTimeoutError";
	readonly code = "WORKFLOW_START_TIMEOUT";
	constructor(
		readonly goalId: string,
		readonly workflowId: string,
		readonly timeoutMs: number,
		message: string,
	) {
		super(message);
	}
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
	// GC-2026-102 V5: "needs_clarification_answered" is the post-resume
	// state. The orchestrator main agent can detect this status and
	// decide whether to re-dispatch a fresh workflow_run with the
	// clarified goal in scope.
	status: "pending" | "running" | "success" | "blocked" | "needs_clarification" | "needs_clarification_answered";
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
			resume: Type.Optional(Type.Boolean({ description: "GC-2026-097 M1: reserved for future state-resume support; currently ignored by executeWorkflowRun." })),
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
	];
	if (state.clarification_answer !== undefined) {
		lines.push(`clarification_answer: ${state.clarification_answer}`);
	}
	lines.push(
		`worktree_path: ${state.worktree_path}`,
		`branch: ${state.branch}`,
	);
	writeFileSync(path, lines.join("\n") + "\n", { mode: 0o644 });
}

/**
 * GC-2026-102 V5 (NEEDS_CLARIFICATION resume): load the workflow state
 * file to detect a paused run. Returns undefined if the file doesn't
 * exist (fresh workflow) or can't be parsed (corrupted / legacy format).
 *
 * The parser is intentionally narrow: it reads only the key/value pairs
 * the resume pathway needs (status, clarification_answer). Anything else
 * falls through to undefined and the caller treats it as "no prior run".
 */
export function loadWorkflowState(cwd: string, goalId: string): WorkflowState | undefined {
	const path = workflowPath(cwd, goalId);
	if (!existsSync(path)) return undefined;
	try {
		const raw = readFileSync(path, "utf-8");
		const out: Partial<WorkflowState> = {};
		for (const line of raw.split("\n")) {
			const m = line.match(/^([a-z_]+):\s*(.*)$/);
			if (!m || !m[1] || m[2] === undefined) continue;
			const key = m[1];
			const value = m[2];
			switch (key) {
				case "schema_version": out.schema_version = value as "v1"; break;
				case "goal_id": out.goal_id = value; break;
				case "workflow_id": out.workflow_id = value; break;
				case "current_phase": out.current_phase = value as WorkflowState["current_phase"]; break;
				case "status": out.status = value as WorkflowState["status"]; break;
				case "iterations_used": out.iterations_used = Number(value); break;
				case "redesigns_used": out.redesigns_used = Number(value); break;
				case "clarification_answer": out.clarification_answer = value; break;
				case "worktree_path": out.worktree_path = value; break;
				case "branch": out.branch = value; break;
				default: break;
			}
		}
		return out as WorkflowState;
	} catch {
		return undefined;
	}
}

// ── Entry point ────────────────────────────────────────────────────────

interface RunContext {
	pi: { events: { emit: (channel: string, data: unknown) => void; on: (channel: string, handler: (data: unknown) => void | Promise<void>) => () => void } };
	ctx: unknown;
	repoCwd: string;
	/**
	 * GC-2026-chat-stream-render: streaming progress callback. Aligned
	 * with pi-coding-agent's `AgentToolUpdateCallback<TDetails>` shape —
	 * the host (TUI interactive mode) renders each call as a partial
	 * tool-result block in the chat, so the user sees phase progress live
	 * instead of waiting for the full tool result.
	 *
	 * The payload is `AgentToolResult<WorkflowProgressDetails>` — the
	 * `details` field carries the progress data; the `content` field is
	 * empty (the TUI renders from `details` + the final tool result).
	 */
	onUpdate?: AgentToolUpdateCallback<WorkflowProgressDetails>;
}

/**
 * GC-2026-chat-stream-render: structured details emitted via
 * `RunContext.onUpdate.details` on each `workflow:phase-complete` event.
 * The TDetails type for the host's `AgentToolResult<WorkflowProgressDetails>`
 * — partial progress data the host renders as a live streaming block.
 *
 * Previously named WorkflowProgressUpdate; renamed to WorkflowProgressDetails in GC-2026-chat-stream-render and had a
 * leading `partial: true` literal boolean field. The first audit
 * (GC-2026-workflow-chat-stream postmortem) assumed the host would
 * render that field as a streaming indicator; the actual host
 * (`AgentToolUpdateCallback<TDetails>`) treats its argument as an
 * `AgentToolResult<TDetails>` envelope, not a freeform partial. The
 * `partial: true` field landed in `details.partial`, which the host
 * did not read, and the rest of the fields landed in `details.*` where
 * they were ignored. Live streaming was effectively broken.
 */
export interface WorkflowProgressDetails {
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

	// ── 2. NEEDS_CLARIFICATION resume (GC-2026-102 V5) ───────────────
	// If the previous run paused on NEEDS_CLARIFICATION AND the caller
	// is providing the user's answer, record the answer and resolve
	// the Promise with status=success so the orchestrator main agent
	// can re-dispatch a fresh workflow_run with the clarified goal in
	// scope. This is the minimal viable resume that doesn't require
	// pi-tasks changes: the cascade in pi-tasks's subscribeWorkflow
	// pauses on NEEDS_CLARIFICATION and has no internal "pick up"
	// pathway, so the resume is a record-and-stall operation. The
	// orchestrator main agent reads the recorded answer and decides
	// whether to re-dispatch.
	//
	// What the resume does NOT do:
	//   - It does NOT re-trigger pi-tasks's cascade (pi-tasks has no
	//     resume pathway; adding one is a separate GC).
	//   - It does NOT continue past the cleared review; it only
	//     records the answer and surfaces status=success so the
	//     orchestrator can act on it.
	//
	// Status when resume is NOT applicable (status !== needs_clarification,
	// or no clarification_answer provided): behavior unchanged.
	const previousState = loadWorkflowState(repoCwd, goalId);
	if (
		previousState?.status === "needs_clarification" &&
		opts.clarification_answer !== undefined
	) {
		// Record the answer in workflow-{id}.yaml. The orchestrator
		// can read this back to learn the user's response. We keep
		// status=needs_clarification_answered to distinguish a
		// answered run from a never-answered one.
		previousState.clarification_answer = opts.clarification_answer;
		previousState.status = "needs_clarification_answered";
		saveWorkflowState(repoCwd, previousState);
		return buildResumeOutput(goalId, previousState, opts.clarification_answer, maxFixIterations);
	}

	// ── 3. Derive worktree / branch / workflow_id (all absolute paths) ──
	// GC-2026-workflow-worktree-namespace: drop the stale `sages/` prefix on
	// `branch`. The agent creates the actual git branch via `git checkout -b`
	// from the dispatch brief, and that brief uses `goal_id_lowercase +
	// "-implement"` (no `sages/` prefix). The prior value pointed at a
	// non-existent ref in workflow-{id}.yaml.
	const worktreePath = resolve(repoCwd, ".pi", "worktree", goalId, "implement");
	const branch = `${goalId.toLowerCase()}-implement`;
	const workflowId = `wf-${goalId}`;

	// ── 3. Initialize workflow-{id}.yaml state file ────────────────────
	const state: WorkflowState = {
		schema_version: "v1",
		goal_id: goalId,
		workflow_id: workflowId,
		started_at: previousState?.started_at ?? new Date().toISOString(),
		current_phase: "implement",
		status: "pending",
		iterations_used: previousState?.iterations_used ?? 0,
		redesigns_used: previousState?.redesigns_used ?? 0,
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
	return new Promise<WorkflowRunOutput>((resolveFn, rejectFn) => {
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
		// GC-2026-097 H1: track real task ids (UUIDs from pi-tasks's
		// TaskStore.create()) as phases complete, instead of relying on
		// hardcoded "t-implement" / "t-review-final" / "t-merge" literals
		// in the output builders.
		let implementTaskId: string | undefined;
		let lastReviewTaskId: string | undefined;
		let mergeTaskId: string | undefined;
		// GC-2026-workflow-chat-stream: tasks_total upper bound. The static
		// graph is Implement + max_fix_iterations Reviews + Merge. Fix
		// dispatches happen on-demand when Review emits NEEDS_WORK, so
		// they are NOT in the static count but ARE bounded by
		// max_fix_iterations. The streaming UI shows an upper bound so the
		// progress bar never hits 100% while Fix tasks are still queued.
		const tasksTotalEstimate = 1 + 2 * maxFixIterations + 1;
		let tasksDone = 0;
		const startedAtMs = Date.parse(state.started_at);
		// GC-2026-workflow-chat-stream: build a partial-progress payload and
		// emit it via the host's onUpdate callback. Host renders partial
		// result blocks; user sees phases appear live.
		const emitProgress = (
			currentPhase: WorkflowProgressDetails["current_phase"],
			phaseIteration: number,
			phaseLabel: string,
		) => {
			if (!runCtx.onUpdate) return;
			// GC-2026-chat-stream-render: wrap in AgentToolResult envelope.
			// The host's AgentToolUpdateCallback<TDetails> expects the full
			// result shape, not a freeform partial. The `content: []` is
			// the standard convention for "TUI renders from details".
			const details: WorkflowProgressDetails = {
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
			};
			runCtx.onUpdate({ content: [], details });
		};
		// Snapshot of the last findings_count we saw (kept outside the closure
		// so emitProgress reads the most recent value).
		let ev_findings_count: number | undefined;

		// GC-2026-109 FU1a: watchdog. If the cascade never fires (e.g.
		// pi-tasks / pi-subagents are not registered in the active session),
		// `workflow:phase-complete` never arrives. Without this guard the
		// Promise stays pending until the harness timeout ("No result
		// provided"). The watchdog rejects with a clear, actionable error
		// within `options.timeout_ms` (default 10000).
		const watchdogMs = opts.timeout_ms ?? 10000;
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		const clearWatchdog = () => {
			if (watchdog !== undefined) {
				clearTimeout(watchdog);
				watchdog = undefined;
			}
		};
		if (watchdogMs > 0) {
			watchdog = setTimeout(() => {
				// Tear down the phase-complete subscription so a late
				// event arriving after the watchdog fires doesn't double-
				// resolve / double-clean.
				clearWatchdog();
				try {
					unsub();
				} catch {
					// unsub is idempotent; ignore any error.
				}
				rejectFn(
					new WorkflowRunStartTimeoutError(
						goalId,
						workflowId,
						watchdogMs,
						`workflow_run for goal ${goalId} (workflow_id: ${workflowId}) ` +
							`did not receive any workflow:phase-complete event within ` +
							`${watchdogMs}ms. This usually means the pi-tasks and/or ` +
							`pi-subagents extensions are not registered in the active ` +
							`session. Fix: run pi-orchestrator/scripts/install.sh and ` +
							`restart pi.`,
					),
				);
			}, watchdogMs);
		}

		const unsub = pi.events.on("workflow:phase-complete", (data) => {
			const ev = data as PhaseCompleteEvent;
			if (ev.workflow_id !== workflowId) return;

			// GC-2026-109 FU1a: any progress cancels the watchdog.
			clearWatchdog();

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
				// GC-2026-workflow-chat-stream: emit the pause-path progress
				// update BEFORE the unsub/resolveFn so the host still sees
				// the partial payload before workflow_run returns.
				emitProgress(
					"needs_clarification",
					ev.iteration ?? lastReviewIteration,
					`Review ${ev.iteration ?? lastReviewIteration}: NEEDS_CLARIFICATION — ${ev.open_question ?? "(no question)"}`,
				);
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
						implementTaskId,
						lastReviewTaskId,
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
						implementTaskId,
						lastReviewTaskId,
						lastReviewVerdict,
						ev.phase,
						ev.error,
					),
				);
				return;
			}

			if (ev.phase === "implement") {
				implementDone = true;
				implementTaskId = ev.task_id;
				tasksDone += 1;
				state.current_phase = "review";
			} else if (ev.phase === "review") {
				lastReviewVerdict = ev.verdict;
				lastReviewIteration = ev.iteration ?? lastReviewIteration + 1;
				lastReviewTaskId = ev.task_id;
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
				mergeTaskId = ev.task_id;
				tasksDone += 1;
				state.current_phase = "completed";
			}
			saveWorkflowState(repoCwd, state);

			// GC-2026-workflow-chat-stream: emit a partial progress update to
			// the host (pi-coding-agent's onUpdate channel) so the user sees
			// the phase transition in the chat thread live. Phases are
			// reported AFTER state mutations so the payload reflects the
			// post-transition counters.
			//
			// `currentPhase` = the phase that just completed. The summary
			// label already names what comes next, so the phase field stays
			// pinned to "what just happened" for the user's mental model.
			const currentPhase =
				ev.phase === "implement"
					? "implement"
					: ev.phase === "review"
						? "review"
						: ev.phase === "fix"
							? "fix"
							: ev.phase === "merge"
								? "merge"
								: (ev.phase as WorkflowProgressDetails["current_phase"]);
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
				currentPhase as WorkflowProgressDetails["current_phase"],
				ev.iteration ?? lastReviewIteration,
				summaryLabel,
			);

			// ── Resolve conditions ──
			// Success: implement + last review (CLEAN) + merge all done
			if (implementDone && lastReviewVerdict === "CLEAN" && mergeDone) {
				unsub();
				resolveFn(
					buildSuccessOutput(
						goalId,
						maxFixIterations,
						redesignsCount,
						worktreePath,
						branch,
						taskSummaries,
						implementTaskId,
						lastReviewTaskId,
						mergeTaskId,
						lastReviewIteration,
						lastReviewVerdict,
					),
				);
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
						implementTaskId,
						lastReviewTaskId,
						lastReviewVerdict,
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
						implementTaskId,
						lastReviewTaskId,
						lastReviewVerdict,
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
	// GC-2026-097 H1: real task ids captured from phase-complete events,
	// not the old "t-implement" / "t-review-final" / "t-merge" literals.
	implementTaskId: string | undefined,
	lastReviewTaskId: string | undefined,
	mergeTaskId: string | undefined,
	lastReviewIteration: number,
	lastReviewVerdict: "CLEAN" | "NEEDS_WORK" | "NEEDS_REDESIGN" | "NEEDS_CLARIFICATION" | undefined,
): WorkflowRunOutput {
	const reviewId = lastReviewTaskId ?? "t-review-final";
	const reviewSummary: ReviewSummary = {
		...tasks[reviewId] ?? {},
		id: reviewId,
		status: "completed",
		agent_id: reviewId,
		verdict: lastReviewVerdict ?? "CLEAN",
		findings_count: tasks[reviewId]?.error ? 0 : 0,
		iterations: Math.max(1, lastReviewIteration),
		duration_ms: 0,
	};
	const implId = implementTaskId ?? "t-implement";
	const mrgId = mergeTaskId ?? "t-merge";
	return {
		status: "success",
		goal_id: goalId,
		iterations_used: 0,
		redesigns_used: redesignsUsed,
		tasks: {
			implement: { ...tasks[implId] ?? { id: implId, status: "completed" }, agent_id: implId },
			review: reviewSummary,
			merge: { ...tasks[mrgId] ?? { id: mrgId, status: "completed" }, agent_id: mrgId },
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
	// GC-2026-097 H1: real task ids captured from phase-complete events.
	implementTaskId: string | undefined,
	lastReviewTaskId: string | undefined,
	lastReviewVerdict: "CLEAN" | "NEEDS_WORK" | "NEEDS_REDESIGN" | "NEEDS_CLARIFICATION" | undefined,
	// GC-2026-pi-tasks-cascade-agentid: when a phase's subagent itself
	// crashes (status: "failed" on the phase-complete), surface the
	// failing phase + the error message in the LLM-facing output.
	failedPhase?: "implement" | "review" | "fix" | "merge",
	error?: string,
): WorkflowRunOutput {
	const isFailure = failedPhase !== undefined;
	const implId = implementTaskId ?? "t-implement";
	const reviewId = lastReviewTaskId ?? "t-review-final";
	return {
		status: "blocked",
		goal_id: goalId,
		iterations_used: iterationsUsed,
		redesigns_used: redesignsUsed,
		blocked_at: isFailure ? failedPhase : "review",
		tasks: {
			implement: {
				...(tasks[implId] ?? {}),
				id: implId,
				agent_id: implId,
				status: failedPhase === "implement" ? "failed" : "completed",
				...(isFailure && failedPhase === "implement" && error ? { error } : {}),
			},
			review: {
				...tasks[reviewId] ?? {},
				id: reviewId,
				status: "completed",
				agent_id: reviewId,
				verdict: lastReviewVerdict ?? "NEEDS_WORK",
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
	// GC-2026-097 H1: real task ids captured from phase-complete events.
	implementTaskId: string | undefined,
	lastReviewTaskId: string | undefined,
	openQuestion: string | undefined,
	// GC-2026-needs-clarification-resume: when the user re-dispatches with
	// options.clarification_answer, echo it back so the orchestrator main
	// agent can confirm the answer was recorded before deciding the next
	// move. The orchestrator main agent then decides whether to start a
	// fresh pipeline or to manually flip the paused Review to CLEAN in
	// `workflow-{goal_id}.yaml` before re-running.
	clarificationAnswerRecorded: string | undefined,
): WorkflowRunOutput {
	const implId = implementTaskId ?? "t-implement";
	const reviewId = lastReviewTaskId ?? "t-review-final";
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
				...(tasks[implId] ?? {}),
				id: implId,
				agent_id: implId,
				status: "completed",
			},
			review: {
				...tasks[reviewId] ?? {},
				id: reviewId,
				status: "completed",
				agent_id: reviewId,
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

/**
 * GC-2026-102 V5: build the resume output when a paused run's
 * clarification_answer is provided. status=success (the user's
 * answer was recorded; the orchestrator main agent can now act).
 *
 * The "tasks" block is intentionally minimal: we don't have real
 * task ids from the paused run's phase-complete events (pi-tasks's
 * cascade paused before they fired for the next phase). The orchestrator
 * can read the recorded answer from workflow-{goal_id}.yaml.
 */
function buildResumeOutput(
	goalId: string,
	state: WorkflowState,
	clarificationAnswer: string,
	_maxFixIterations: number,
): WorkflowRunOutput {
	return {
		status: "success",
		goal_id: goalId,
		iterations_used: state.iterations_used,
		redesigns_used: state.redesigns_used,
		// GC-2026-needs-clarification-resume: echo the answer back so the
		// orchestrator main agent can confirm the recording succeeded.
		clarification_answer_recorded: clarificationAnswer,
		tasks: {
			implement: {
				id: "t-implement",
				agent_id: "t-implement",
				status: "completed",
			},
			review: {
				id: "t-review-paused",
				agent_id: "t-review-paused",
				status: "completed",
				verdict: "NEEDS_CLARIFICATION",
				findings_count: 0,
				iterations: state.iterations_used,
				duration_ms: 0,
			},
		},
		pi_tasks: { implement: "", review: "", fix: "", merge: "" },
		unresolved_findings: [],
		paths: {
			worktree: state.worktree_path,
			branch: state.branch,
			goal_yaml: `.pi/orchestrator/goal-${goalId}.yaml`,
		},
		summary:
			`Goal ${goalId} resume: clarification recorded. Re-dispatch workflow_run with a clarified goal in scope, or flip the paused Review's verdict to CLEAN in workflow-${goalId}.yaml and re-run.`,
	};
}
