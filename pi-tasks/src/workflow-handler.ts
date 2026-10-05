/**
 * workflow-handler.ts — Event-driven workflow entry point for path B.
 *
 * Replaces the in-process state machine that path A ran inside
 * `pi-orchestrator/workflow-run.ts`. Path B's contract:
 *
 *   planning layer (pi-orchestrator)  →  emit "workflow:start"
 *                                          │
 *   tracking layer (this module)       ←  subscribeWorkflow(store, …)
 *                                          │
 *                                          ├─ buildStaticWorkflowGraph(goal, opts)
 *                                          ├─ store.create() × K  (no events)
 *                                          ├─ wire blockedBy edges with real ids
 *                                          ├─ spawnAgent(Implement) ──→  execution layer
 *                                          │
 *                                          │  (execution layer runs agents, then emits)
 *                                          │
 *                                          ←  "subagents:completed" {id, result}
 *                                          │
 *                                          ├─ mark task completed (status + metadata)
 *                                          ├─ if phase==review: parseReviewerVerdict,
 *                                          │   stamp metadata.verdict, emit
 *                                          │   "workflow:phase-complete"
 *                                          └─ cascade: find unblocked tasks, spawn them
 *
 * The handler is a pure transformation of events → store mutations → spawn
 * calls + emitted events. Tests use a fake event bus + a spy for spawnAgent;
 * production wires it into `pi.events` + the AgentManager singleton.
 */

import { join } from "node:path";
import type { TaskStore } from "./task-store.js";
import type { Task } from "./types.js";
import { parseReviewerVerdict, type ReviewerVerdict } from "./verdict-parser.js";
import {
	buildStaticWorkflowGraph,
	buildFixTaskSpec,
	buildRedesignImplementTaskSpec,
	PLACEHOLDER_IMPLEMENT,
	PLACEHOLDER_MERGE,
	placeholderFix,
	placeholderReview,
	type WorkflowGoal,
} from "./workflow-graph.js";

// ── Public surface ──────────────────────────────────────────────────────

/** Payload of the `workflow:start` event emitted by pi-orchestrator/workflow_run. */
export interface WorkflowStartPayload {
	workflow_id: string;
	goal_id: string;
	goal: WorkflowGoal;
	/**
	 * Default 3. Produces 4-5 tasks in the static graph (Implement + N
	 * Reviews + Merge; Fix tasks are created dynamically on NEEDS_WORK).
	 * Bumped from 3 in the prior 7-task design.
	 */
	max_fix_iterations: number;
	/**
	 * GC-2026-verdict-states-and-dynamic-cascade: caps NEEDS_REDESIGN
	 * dispatches so the workflow can't loop forever on a redesign. Default 1.
	 */
	max_redesigns?: number;
	/** Absolute path to the managed worktree for Implement/Fix/Merge agents. */
	worktree_path: string;
}

/**
 * Minimal event-bus contract. Matches `pi.events` shape:
 *   - `on(channel, handler)` returns an unsubscribe fn
 *   - `emit(channel, data)` is fire-and-await (handlers may be async)
 */
export interface WorkflowEventBus {
	on(channel: string, handler: (data: unknown) => void | Promise<void>): () => void;
	emit(channel: string, data: unknown): Promise<void> | void;
}

/** Spawns the given task as a subagent. Returns the agent id the executor will use. */
export type WorkflowSpawnAgent = (
	task: Task,
	ctx?: { worktreePath?: string },
) => Promise<string>;

export interface SubscribeWorkflowOptions {
	events: WorkflowEventBus;
	spawnAgent: WorkflowSpawnAgent;
}

/**
 * Subscribe to the workflow events. Returns an unsubscribe function that
 * detaches both listeners.
 *
 * The handler keeps two pieces of internal state:
 *   - `agentToTask` — reverse index from agent id → task id, populated at
 *     spawn time (workflow:start + each cascade spawn) using the real id
 *     returned by spawnAgent. The previous design pre-populated this map
 *     with synthetic `agent-${task.id}` keys at workflow:start, which only
 *     matched the same synthetic shape tests used. Production spawn (pi-subagents
 *     returns real UUID prefixes) never matched, so the cascade stalled on
 *     the first phase (GC-2026-pi-tasks-cascade-agentid).
 *   - `completedIds` — set of task ids that have completed, used to drive
 *     the cascade without scanning the store on every event.
 */
export function subscribeWorkflow(
	store: TaskStore,
	options: SubscribeWorkflowOptions,
): () => void {
	const { events, spawnAgent } = options;
	const agentToTask = new Map<string, string>();
	const completedIds = new Set<string>();
	// workflow_id is stamped onto every task's metadata so the cascade
	// filter only walks tasks belonging to the active workflow.
	let activeWorkflowId: string | null = null;
	let activeGoalId: string | null = null;
	// GC-2026-verdict-states-and-dynamic-cascade: track iteration + redesign
	// counters so the cascade can cap Fix/Redesign dispatches. The values
	// here mirror what workflow-run.ts reads from `workflow-{id}.yaml`.
	let maxFixIterations = 3;
	let maxRedesigns = 1;
	let fixIterationsUsed = 0; // count of Fix dispatches actually created
	let redesignsUsed = 0;     // count of NEEDS_REDESIGN Implement dispatches

	// ── workflow:start ──────────────────────────────────────────────

	const onWorkflowStart = async (raw: unknown): Promise<void> => {
		const payload = raw as WorkflowStartPayload;
		if (!payload?.goal || !payload.goal_id) {
			throw new Error("workflow:start payload missing goal / goal_id");
		}
		activeWorkflowId = payload.workflow_id;
		activeGoalId = payload.goal_id;
		payload_worktree_path = payload.worktree_path;
		maxFixIterations = payload.max_fix_iterations;
		maxRedesigns = payload.max_redesigns ?? 1;

		// 1. Build the static graph (pure function — no store side-effects).
		const specs = buildStaticWorkflowGraph({
			goal: payload.goal,
			max_fix_iterations: payload.max_fix_iterations,
			workflow_run_goal_id: payload.goal_id,
		});

		// 2. Create every task. order is preserved (Implement, Review_1, …, Merge).
		// GC-2026-prompt-parser-contract-cleanup #4: after creating each Review
		// task, replace the `__review_task_id__` placeholder in its description
		// with the real id. The Reviewer reads this to know where to write the
		// durable verdict-{task_id}.md backup, and the parser in
		// `onSubagentCompleted` uses the same path for the file-fallback.
		const created: Task[] = [];
		for (const spec of specs) {
			const t = store.create(
				spec.subject,
				spec.description,
				spec.subject,
				{ ...spec.metadata, workflow_id: payload.workflow_id },
			);
			if (spec.metadata.phase === "review") {
				const replaced = t.description.replace(/__review_task_id__/g, t.id);
				if (replaced !== t.description) {
					store.update(t.id, { description: replaced });
					t.description = replaced;
				}
			}
			created.push(t);
		}

		// 3. Wire blockedBy edges. Each spec lists placeholder ids; resolve
		//    them to real task ids by phase + iteration, then call
		//    store.update({ addBlockedBy }).
		const resolvePlaceholder = (placeholder: string): string => {
			if (placeholder === PLACEHOLDER_IMPLEMENT) {
				const t = created.find(x => x.metadata.phase === "implement");
				if (!t) throw new Error(`placeholder ${placeholder} unresolved`);
				return t.id;
			}
			if (placeholder === PLACEHOLDER_MERGE) {
				const t = created.find(x => x.metadata.phase === "merge");
				if (!t) throw new Error(`placeholder ${placeholder} unresolved`);
				return t.id;
			}
			const reviewMatch = placeholder.match(/^__review_(\d+)__$/);
			if (reviewMatch) {
				const iter = Number(reviewMatch[1]);
				const t = created.find(
					x => x.metadata.phase === "review" && x.metadata.iteration === iter,
				);
				if (!t) throw new Error(`placeholder ${placeholder} unresolved`);
				return t.id;
			}
			const fixMatch = placeholder.match(/^__fix_(\d+)__$/);
			if (fixMatch) {
				const iter = Number(fixMatch[1]);
				const t = created.find(
					x => x.metadata.phase === "fix" && x.metadata.iteration === iter,
				);
				if (!t) throw new Error(`placeholder ${placeholder} unresolved`);
				return t.id;
			}
			throw new Error(`unknown placeholder: ${placeholder}`);
		};

		for (let i = 0; i < specs.length; i++) {
			const spec = specs[i];
			const real = spec.blockedBy.map(resolvePlaceholder);
			for (const blockerId of real) {
				store.update(created[i].id, { addBlockedBy: [blockerId] });
			}
		}

		// 4. Spawn the Implement task. It has no blockedBy so it runs first;
//    its completion unblocks Review_1 via the cascade below.
//
//    GC-2026-pi-tasks-cascade-agentid: record the spawn's return value
//    as the agent id (post-spawn, not pre-registered). Pre-registering
//    synthetic IDs here used to "work" only because the test fixtures
//    returned that same synthetic shape; production spawn returns real
//    UUID prefixes and the lookup at onSubagentCompleted missed every
//    real id, stalling the cascade after the first phase.
		const implement = created.find(x => x.metadata.phase === "implement");
		if (!implement) throw new Error("Implement task missing from created graph");
		const agentId = await spawnAgent(implement, { worktreePath: payload.worktree_path });
		agentToTask.set(agentId, implement.id);
		store.update(implement.id, { status: "in_progress", owner: agentId });
	};

	// GC-2026-verdict-states-and-dynamic-cascade: dynamic task creation.
	// Helpers below are called from onSubagentCompleted when a Review verdict
	// requires spawning a new task that wasn't in the static graph. Each helper
	// stamps metadata, registers the agent id, and adds a blockedBy edge
	// from the next Review (Fix case) or Review_1 (Redesign case) so the
	// cascade respects the new task.

	/**
	 * NEEDS_WORK dispatch: create Fix_i (where i = fixIterationsUsed + 1).
	 * The new Fix is blockedBy the originating Review and adds itself to
	 * Review_{i+1}'s blockedBy list so the chain pauses for the fix.
	 * Returns silently if max_fix_iterations is reached.
	 */
	async function dispatchFixForReview(
		reviewTask: Task,
		_verdict: ReviewerVerdict,
	): Promise<void> {
		if (fixIterationsUsed >= maxFixIterations) {
			// Cap reached. The Review must have been NEEDS_WORK on the
			// last allowed Review iteration. workflow-run.ts will resolve
			// as blocked via the iterations_used check.
			return;
		}
		const nextIteration = fixIterationsUsed + 1;
		fixIterationsUsed = nextIteration;

		// Look up the next Review (if any) so we can wire Fix → Review_{i+1}.
		const allReviews = store.list().filter(
			(t) =>
				t.metadata.phase === "review" &&
				t.metadata.workflow_run_goal_id === activeGoalId,
		);
		const nextReview = allReviews.find(
			(t) => Number(t.metadata.iteration) === nextIteration + 1,
		);

		const goal = (reviewTask.metadata as { goal?: WorkflowGoal }).goal;
		if (!goal) {
			// Defensive: every workflow task should have the goal in metadata,
			// but fall back to a placeholder so the cascade doesn't crash.
			throw new Error("dispatchFixForReview: review task missing goal metadata");
		}
		const spec = buildFixTaskSpec({
			goal,
			iteration: nextIteration,
			worktreePath: payload_worktree_path,
			branch: `${goal.id.toLowerCase()}-implement`,
			reviewTaskId: reviewTask.id,
			nextReviewId: nextReview?.id,
			workflow_run_goal_id: activeGoalId ?? "",
		});
		const fixTask = store.create(
			spec.subject,
			spec.description,
			spec.subject,
			{ ...spec.metadata, workflow_id: activeWorkflowId ?? "" },
		);
		// Wire blockedBy edges. spec.blockedBy uses placeholder ids only when
		// Review_{i+1} doesn't exist yet — for the dynamic case we always have
		// a real review id.
		for (const blockerId of spec.blockedBy) {
			store.update(fixTask.id, { addBlockedBy: [blockerId] });
		}
		// Add Fix → Review_{i+1} edge if applicable.
		if (nextReview) {
			store.update(nextReview.id, { addBlockedBy: [fixTask.id] });
		}
		// Spawn immediately (Fix has all its blockers done by definition).
		const agentId = await spawnAgent(fixTask, { worktreePath: payload_worktree_path });
		agentToTask.set(agentId, fixTask.id);
		store.update(fixTask.id, { status: "in_progress", owner: agentId });
	}

	/**
	 * NEEDS_REDESIGN dispatch: create a new Implement task. Wired to
	 * Review_1 so the chain restarts from the top. Returns silently if
	 * max_redesigns is reached.
	 */
	async function dispatchRedesignForReview(reviewTask: Task): Promise<void> {
		if (redesignsUsed >= maxRedesigns) {
			// Cap reached. workflow-run.ts resolves as blocked via the
			// redesigns_used check.
			return;
		}
		const nextNumber = redesignsUsed + 1;
		redesignsUsed = nextNumber;

		const goal = (reviewTask.metadata as { goal?: WorkflowGoal }).goal;
		if (!goal) {
			throw new Error("dispatchRedesignForReview: review task missing goal metadata");
		}
		const spec = buildRedesignImplementTaskSpec({
			goal,
			redesignNumber: nextNumber,
			worktreePath: payload_worktree_path,
			branch: `${goal.id.toLowerCase()}-implement`,
			reviewTaskId: reviewTask.id,
			workflow_run_goal_id: activeGoalId ?? "",
		});
		const newImplement = store.create(
			spec.subject,
			spec.description,
			spec.subject,
			{ ...spec.metadata, workflow_id: activeWorkflowId ?? "" },
		);
		// Wire blockedBy: new Implement blockedBy the requesting Review.
		store.update(newImplement.id, { addBlockedBy: [reviewTask.id] });
		// Wire Review_1 to also wait on the new Implement (so the chain resets).
		const review1 = store.list().find(
			(t) =>
				t.metadata.phase === "review" &&
				Number(t.metadata.iteration) === 1 &&
				t.metadata.workflow_run_goal_id === activeGoalId,
		);
		if (review1) {
			store.update(review1.id, { addBlockedBy: [newImplement.id] });
		}
		const agentId = await spawnAgent(newImplement, { worktreePath: payload_worktree_path });
		agentToTask.set(agentId, newImplement.id);
		store.update(newImplement.id, { status: "in_progress", owner: agentId });
	}

	// GC-2026-verdict-states-and-dynamic-cascade: closure capture. The
	// dispatchFixForReview / dispatchRedesignForReview helpers above need
	// access to the start-payload's worktree_path, captured here from the
	// onWorkflowStart closure. We update it on each workflow:start call so
	// multiple sequential workflows (tests) don't share stale paths.
	let payload_worktree_path = "";

	// ── subagents:completed ─────────────────────────────────────────

	const onSubagentCompleted = async (raw: unknown): Promise<void> => {
		const data = raw as { id?: string; result?: string; error?: string };
		if (!data || typeof data.id !== "string") return;
		const taskId = agentToTask.get(data.id);
		if (!taskId) return; // not a workflow task — let the existing handler process it
		const task = store.get(taskId);
		if (!task) return;

		// Track completion BEFORE the cascade scan, so the just-completed task
		// counts as unblocking its dependents.
		agentToTask.delete(data.id);
		completedIds.add(taskId);

		const isReview = task.metadata.phase === "review";
		const resultStr = typeof data.result === "string" ? data.result : undefined;

		// Review tasks: parse verdict, stamp metadata.
		// All tasks (review, implement, fix, merge): emit workflow:phase-complete
		// so the planning layer can track each phase. GC-2026-path-B-swap extended
		// path B's event contract — only reviews have a `verdict` field; non-review
		// phases emit `phase: "implement" | "fix" | "merge"` with no verdict.
		if (isReview && resultStr !== undefined) {
			// GC-2026-prompt-parser-contract-cleanup: pass the durable
			// verdict-{task_id}.md path so the parser falls back to the
			// Reviewer's atomic-rename write when the message fence is
			// missing (e.g. max_turns hard-abort truncated the message).
			const verdictFilePath = join(
				process.cwd(),
				".pi",
				"orchestrator",
				`verdict-${taskId}.md`,
			);
			const verdict: ReviewerVerdict = parseReviewerVerdict(resultStr, {
				verdictFilePath,
			});
			store.update(taskId, {
				status: "completed",
				metadata: { verdict },
			});

			// GC-2026-verdict-states-and-dynamic-cascade: branch on the 4 verdict
			// states. NEEDS_WORK → create Fix on demand. NEEDS_REDESIGN → create
			// a new Implement. NEEDS_CLARIFICATION → emit a needs_clarification
			// phase-complete and let the orchestrator main agent surface the
			// question; do NOT cascade further.
			if (verdict.verdict === "NEEDS_WORK") {
				await dispatchFixForReview(task, verdict);
			} else if (verdict.verdict === "NEEDS_REDESIGN") {
				await dispatchRedesignForReview(task);
			} else if (verdict.verdict === "NEEDS_CLARIFICATION") {
				// Pause workflow: emit phase-complete with status marker; do
				// not cascade. workflow-run.ts reads status and resolves as
				// blocked. open_question propagates so the orchestrator can
				// surface it to the user.
				await events.emit("workflow:phase-complete", {
					workflow_id: task.metadata.workflow_id ?? activeWorkflowId,
					goal_id: task.metadata.workflow_run_goal_id ?? activeGoalId,
					phase: "review",
					iteration: task.metadata.iteration,
					status: "needs_clarification",
					verdict: verdict.verdict,
					findings_count: 0,
					open_question: verdict.open_question,
					task_id: taskId,
				});
				return; // skip cascade
			}

			await events.emit("workflow:phase-complete", {
				workflow_id: task.metadata.workflow_id ?? activeWorkflowId,
				goal_id: task.metadata.workflow_run_goal_id ?? activeGoalId,
				phase: "review",
				iteration: task.metadata.iteration,
				status: "completed",
				verdict: verdict.verdict,
				findings_count: verdict.findings?.length ?? 0,
				task_id: taskId,
			});
		} else {
			store.update(taskId, { status: "completed" });
			await events.emit("workflow:phase-complete", {
				workflow_id: task.metadata.workflow_id ?? activeWorkflowId,
				goal_id: task.metadata.workflow_run_goal_id ?? activeGoalId,
				phase: task.metadata.phase,
				iteration: task.metadata.iteration,
				status: "completed",
				task_id: taskId,
			});
		}

		// Cascade: spawn every pending task whose blockers are all completed.
		// We walk the whole store; in practice a workflow has 3–11 tasks so
		// the scan is cheap and avoids per-task subscription bookkeeping.
		//
		// GC-2026-pi-tasks-cascade-agentid: same fix as onWorkflowStart —
		// record the spawn's return value as the agent id, then stamp it
		// on the task as owner. The handler relies on agentToTask to map
		// subagents:completed → taskId, so the entry must reflect the real
		// id the subagent runtime (pi-subagents/agent-manager.ts:346) emits.
		const all = store.list();
		for (const t of all) {
			if (t.status !== "pending") continue;
			if (activeGoalId && t.metadata.workflow_run_goal_id !== activeGoalId) continue;
			if (!t.blockedBy.every(id => completedIds.has(id))) continue;

			const agentId = await spawnAgent(t);
			agentToTask.set(agentId, t.id);
			store.update(t.id, { status: "in_progress", owner: agentId });
		}
	};

	// GC-2026-pi-tasks-cascade-agentid: subagents:failed listener. Mirrors
	// onSubagentCompleted's contract — look up the task by the real agent id,
	// revert it to pending with lastError metadata so a retry can be driven
	// from the orchestrator, and emit workflow:phase-complete with status:
	// "failed" so workflow_run resolves the run as "blocked" instead of
	// hanging forever (the GC-2026-096 implement-failure case).
	const onSubagentFailed = async (raw: unknown): Promise<void> => {
		const data = raw as { id?: string; error?: string; status?: string };
		if (!data || typeof data.id !== "string") return;
		const taskId = agentToTask.get(data.id);
		if (!taskId) return; // not a workflow task; let the existing handler process it
		const task = store.get(taskId);
		if (!task) return;

		agentToTask.delete(data.id);

		const errMsg = typeof data.error === "string" ? data.error : data.status ?? "agent failed";
		store.update(taskId, {
			status: "pending",
			metadata: {
				...task.metadata,
				result: null,
				lastError: errMsg,
			},
		});

		await events.emit("workflow:phase-complete", {
			workflow_id: task.metadata.workflow_id ?? activeWorkflowId,
			goal_id: task.metadata.workflow_run_goal_id ?? activeGoalId,
			phase: task.metadata.phase,
			iteration: task.metadata.iteration,
			status: "failed",
			error: errMsg,
			task_id: taskId,
		});
	};

	const unsubStart = events.on("workflow:start", onWorkflowStart);
	const unsubComplete = events.on("subagents:completed", onSubagentCompleted);
	const unsubFailed = events.on("subagents:failed", onSubagentFailed);

	return () => {
		unsubStart();
		unsubComplete();
		unsubFailed();
	};
}

// Silence "unused import" lint for symbols re-exported for downstream callers.
// (placeholderReview / placeholderFix are exposed via workflow-graph; this file
// uses the named constants, but the helpers are also referenced via the type
// system to keep the public surface stable.)
void placeholderReview;
void placeholderFix;
