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
	/** Default 3 — produces 7 tasks (Implement + 3 Review + 2 Fix + Merge). */
	max_fix_iterations: number;
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

	// ── workflow:start ──────────────────────────────────────────────

	const onWorkflowStart = async (raw: unknown): Promise<void> => {
		const payload = raw as WorkflowStartPayload;
		if (!payload?.goal || !payload.goal_id) {
			throw new Error("workflow:start payload missing goal / goal_id");
		}
		activeWorkflowId = payload.workflow_id;
		activeGoalId = payload.goal_id;

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
