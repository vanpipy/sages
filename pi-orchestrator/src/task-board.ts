/**
 * task-board.ts — the orchestrator's domain abstraction over the
 * pi-tasks TaskStore.
 *
 * The orchestrator is the sole writer + sole consumer of the board
 * (see `AGENTS.md` § Task Feeding). That role lives here:
 *
 *   - `materializePlan(input)` — creation side: take a list of phases,
 *     create one task per phase, wire `blockedBy` / `blocks` in both
 *     directions by subject.
 *   - `consume(taskId)` — consumption side: read a completed task in a
 *     structured way. For Reviewer tasks, parse the 4-state verdict
 *     and emit a verdict-tailored follow-up suggestion. Mark the task
 *     consumed in metadata for the audit trail.
 *   - `parseVerdict(result)` / `suggestFollowUp(verdict)` — verdict
 *     helpers, exposed as methods so callers (and tests) can reach them
 *     without going through `consume`.
 *   - `get(taskId)` / `list()` — raw access for inspection + edge cases.
 *
 * The class holds a `TaskStore` instance pointed at the orchestrator's
 * project task file (the same file the board's own `taskScope: "project"`
 * mode uses — see `pi-tasks/src/task-paths.ts:orchestratorProjectTaskFile`).
 * The two `TaskStore` instances (orchestrator's and the board's)
 * coordinate through `TaskStore`'s file lock, so concurrent writes are
 * safe.
 *
 * The two orchestrator tools (`orchestrate`, `task_consume`) are thin
 * wrappers around `materializePlan` and `consume` respectively —
 * see `orchestrator-tool.ts` and `orchestrator-consume-tool.ts`. All
 * the actual logic lives here.
 */

import { TaskStore } from "@sages/pi-tasks/task-store";
import { orchestratorProjectTaskFile } from "@sages/pi-tasks/task-paths";

// `Task` is defined in `@sages/pi-tasks/types` but not re-exported through
// the `task-store` subpath, so we infer it from `TaskStore.create()`'s
// return type when needed in this file.
type Task = ReturnType<TaskStore["create"]>;
type TaskList = ReturnType<TaskStore["list"]>;
type TaskGet = ReturnType<TaskStore["get"]>;

/**
 * The 4-state verdict the Reviewer agent emits. Matches the contract
 * documented in `pi-subagents/src/default-agents.ts:DEFAULT_AGENTS
 * .get("Reviewer").description`.
 */
export type Verdict =
	| "CLEAN"
	| "NEEDS_WORK"
	| "NEEDS_REDESIGN"
	| "NEEDS_CLARIFICATION";

const VERDICTS: readonly Verdict[] = [
	"CLEAN",
	"NEEDS_WORK",
	"NEEDS_REDESIGN",
	"NEEDS_CLARIFICATION",
] as const;

/** The two shipped agent types the orchestrator dispatches. */
export type AgentType = "Developer" | "Reviewer";

export interface TaskBoardOptions {
	/** Workspace cwd. Resolved against the orchestrator's project task file. */
	cwd: string;
	/**
	 * Inject a `TaskStore` for tests. Default is
	 * `new TaskStore(orchestratorProjectTaskFile(cwd))` — the same file
	 * the board's own `taskScope: "project"` mode writes to.
	 */
	store?: TaskStore;
}

// ─── Creation: plan input/output ──────────────────────────────────────────

export interface TaskBoardPlanPhase {
	subject: string;
	agentType: AgentType;
	detail?: string;
	/**
	 * `subject` strings of earlier phases this one depends on. Resolved
	 * to task IDs after the first create pass and wired into both
	 * `blocks` (on the predecessor) and `blockedBy` (on this phase).
	 */
	blockedBy?: string[];
}

export interface TaskBoardPlanInput {
	intent: string;
	phases: TaskBoardPlanPhase[];
}

export interface TaskBoardPlanOutput {
	intent: string;
	tasks: Array<{
		id: string;
		subject: string;
		status: string;
		agentType: string;
		blockedBy: string[];
		blocks: string[];
	}>;
}

// ─── Consumption: options/output ──────────────────────────────────────────

export interface TaskBoardConsumeOptions {
	/**
	 * If true, include the full agent transcript in `result`. Default
	 * false (just the final assistant text). Wired from the
	 * `task_consume` tool's `include_transcript` parameter.
	 */
	includeTranscript?: boolean;
}

export interface TaskBoardConsumeOutput {
	id: string;
	subject: string;
	status: string;
	agentType: string;
	result: string;
	/** Only set for Reviewer tasks whose result text contains a 4-state verdict. */
	verdict?: Verdict;
	/** Wall-clock ms when the orchestrator consumed the task. */
	consumed_at: number;
	/** Tailored next-step hint based on the verdict (Reviewer tasks only). */
	follow_up_suggestion?: string;
}

// ─── Creation: single-task input ────────────────────────────────────────────

export interface TaskBoardCreateInput {
	subject: string;
	description: string;
	agentType?: AgentType;
	activeForm?: string;
	/** Other metadata keys to merge into `metadata.agentType` (if set) or directly. */
	metadata?: Record<string, unknown>;
	/** Task IDs this new task should block (set on the predecessor's `blocks`). */
	blocks?: string[];
	/** Task IDs this new task depends on (set on this task's `blockedBy`). */
	blockedBy?: string[];
}

/** Errors `consume` throws — caught and formatted by the tool wrapper. */
export class TaskBoardConsumeError extends Error {
	constructor(
		public readonly kind: "not_found" | "not_completed",
		message: string,
	) {
		super(message);
		this.name = "TaskBoardConsumeError";
	}
}

// ─── TaskBoard ─────────────────────────────────────────────────────────────

export class TaskBoard {
	private readonly store: TaskStore;

	constructor(opts: TaskBoardOptions) {
		this.store =
			opts.store ?? new TaskStore(orchestratorProjectTaskFile(opts.cwd));
	}

	/**
	 * Materialize a multi-phase plan as a DAG with auto-wired dependencies.
	 *
	 * Two-pass: first pass creates every task and maps subject -> id; second
	 * pass wires `blockedBy` / `blocks` in both directions. Missing
	 * predecessor references are silently dropped (the caller will see the
	 * missing-subject count in the returned payload's `tasks` and can
	 * surface it). Cyclic dependencies are not detected (caller's
	 * responsibility).
	 */
	materializePlan(input: TaskBoardPlanInput): TaskBoardPlanOutput {
		const subjectToId = new Map<string, string>();
		const createdIds: string[] = [];

		for (const phase of input.phases) {
			const task = this.store.create(
				phase.subject,
				phase.detail ?? input.intent,
				undefined,
				{ agentType: phase.agentType },
			);
			subjectToId.set(phase.subject, task.id);
			createdIds.push(task.id);
		}

		for (const phase of input.phases) {
			const blockedBySubjects = phase.blockedBy ?? [];
			if (blockedBySubjects.length === 0) continue;
			const myId = subjectToId.get(phase.subject);
			if (myId === undefined) continue;
			const predIds: string[] = [];
			for (const subject of blockedBySubjects) {
				const id = subjectToId.get(subject);
				if (id !== undefined) predIds.push(id);
			}
			if (predIds.length === 0) continue;
			for (const predId of predIds) {
				this.store.update(predId, { addBlocks: [myId] });
			}
			this.store.update(myId, { addBlockedBy: predIds });
		}

		const tasks = createdIds
			.map((id) => this.store.get(id))
			.filter((t): t is TaskGet & NonNullable<typeof t> => t !== undefined)
			.map((t) => ({
				id: t.id,
				subject: t.subject,
				status: t.status,
				agentType: (t.metadata?.agentType as string | undefined) ?? "Developer",
				blockedBy: t.blockedBy,
				blocks: t.blocks,
			}));
		return { intent: input.intent, tasks };
	}

	/**
	 * Create a single task on the board. The orchestrator's single-creator
	 * role — when the LLM wants to add one follow-up task (e.g. a
	 * NEEDS_WORK Developer task after a Reviewer verdict, or a single
	 * ad-hoc task outside a full plan), it calls `board.create({...})`.
	 *
	 * `agentType` (when set) is stored under `metadata.agentType` so the
	 * later consumption side can identify Developer vs Reviewer tasks for
	 * verdict parsing. `blocks` / `blockedBy` are wired in both directions
	 * just like `materializePlan` does. Returns the freshly-created task
	 * (re-read from the store after wiring).
	 */
	create(input: TaskBoardCreateInput): TaskGet {
		const meta: Record<string, unknown> = { ...(input.metadata ?? {}) };
		if (input.agentType) meta.agentType = input.agentType;

		const task = this.store.create(
			input.subject,
			input.description,
			input.activeForm,
			meta,
		);
		if (input.blocks) {
			for (const target of input.blocks) {
				this.store.update(task.id, { addBlocks: [target] });
			}
		}
		if (input.blockedBy) {
			for (const pred of input.blockedBy) {
				this.store.update(task.id, { addBlockedBy: [pred] });
			}
		}
		return this.store.get(task.id)!;
	}

	/**
	 * Read a completed task's result in a structured way. Parses the
	 * Reviewer's 4-state verdict when present and emits a verdict-tailored
	 * follow-up suggestion. Marks the task consumed in metadata.
	 *
	 * Throws `TaskBoardConsumeError` when the task is missing or not yet
	 * completed — the tool wrapper translates that to an error response
	 * the LLM can act on.
	 */
	consume(taskId: string, opts: TaskBoardConsumeOptions = {}): TaskBoardConsumeOutput {
		const task = this.store.get(taskId);
		if (!task) {
			throw new TaskBoardConsumeError(
				"not_found",
				`No task with ID #${taskId}. Use TaskList to find the right ID.`,
			);
		}
		if (task.status !== "completed") {
			const hint =
				task.status === "in_progress"
					? "Wait for it to finish first: call TaskOutput with block=true, then call task_consume again."
					: "Use TaskExecute to start it, or TaskUpdate to set it back to pending.";
			throw new TaskBoardConsumeError(
				"not_completed",
				`Task #${task.id} is '${task.status}', not 'completed'. ${hint}`,
			);
		}

		const result =
			typeof task.metadata?.result === "string" ? task.metadata.result : "";
		const agentType =
			typeof task.metadata?.agentType === "string"
				? (task.metadata.agentType as AgentType)
				: "Developer";
		const verdict =
			agentType === "Reviewer" && result ? this.parseVerdict(result) : undefined;

		const consumedAt = Date.now();
		this.store.update(task.id, {
			metadata: { consumed: true, consumed_at: consumedAt },
		});

		return {
			id: task.id,
			subject: task.subject,
			status: task.status,
			agentType,
			result,
			...(verdict ? { verdict } : {}),
			consumed_at: consumedAt,
			...(verdict ? { follow_up_suggestion: this.suggestFollowUp(verdict) } : {}),
		};
	}

	/**
	 * Find the verdict in a Reviewer task's result text. The Reviewer
	 * contract says it emits a 4-state verdict but doesn't pin a
	 * serialization format, so we accept either:
	 *
	 *   1. Prefixed form: `verdict: STATE`, `Verdict = STATE`, `**verdict:** STATE`
	 *      (case-insensitive; canonical is UPPER_SNAKE but agents may write
	 *      mixed case).
	 *   2. Standalone line: a line that is just the verdict token, possibly
	 *      with surrounding whitespace and `**` markdown emphasis.
	 *
	 * Both checks anchor the verdict so prose like "Let me clean up the
	 * code" or "The code is clean" doesn't false-match. The prefix
	 * alternation enforces a `verdict:`-style marker; the standalone
	 * alternation requires the token to occupy its own line.
	 */
	parseVerdict(result: string): Verdict | undefined {
		const tokens = "(CLEAN|NEEDS_WORK|NEEDS_REDESIGN|NEEDS_CLARIFICATION)";
		const prefixedRe = new RegExp(`\\bverdict\\s*[:=]\\s*\\*?\\*?${tokens}\\b`, "i");
		const standaloneRe = new RegExp(`^\\s*\\*?\\*?${tokens}\\b\\s*$`, "im");
		const match = result.match(prefixedRe) ?? result.match(standaloneRe);
		if (!match) return undefined;
		const upper = match[1].toUpperCase();
		return VERDICTS.includes(upper as Verdict) ? (upper as Verdict) : undefined;
	}

	/**
	 * Generate a follow-up suggestion tailored to each verdict. The
	 * orchestrator uses this as a hint, not a directive — the LLM still
	 * makes the final call.
	 */
	suggestFollowUp(verdict: Verdict): string {
		switch (verdict) {
			case "CLEAN":
				return "Phase complete. Move to the next task or declare the goal done.";
			case "NEEDS_WORK":
				return "Spawn a Developer follow-up task with the Reviewer's feedback as its description; set its `blockedBy` to this Review so the chain stays causal.";
			case "NEEDS_REDESIGN":
				return "The approach is wrong, not just the execution. Spawn a new Implement task rather than a fix — `blockedBy` this review so the chain documents the redirect.";
			case "NEEDS_CLARIFICATION":
				return "Pause and surface the Reviewer's questions to the user before continuing. Do not spawn follow-up work until the user answers.";
		}
	}

	/**
	 * Raw read access to a task. Useful for inspection; `consume` is the
	 * domain operation that also marks the audit trail.
	 */
	get(taskId: string): TaskGet {
		return this.store.get(taskId);
	}

	/** List all tasks, sorted by id (TaskStore's default). */
	list(): TaskList {
		return this.store.list();
	}

	/**
	 * Find the next task that is `completed` and not yet consumed.
	 * Returns undefined when none exists. Sorted by id ascending so the
	 * consumer loop drains in FIFO order; a follow-up child task created
	 * mid-drain naturally lands at the end of the list and gets picked up
	 * after its parent.
	 *
	 * Internal helper — exposed for tests.
	 */
	findNextConsumable(): TaskGet | undefined {
		return this.store
			.list()
			.filter(
				(t) =>
					t.status === "completed" &&
					!t.metadata?.consumed,
			)
			.sort((a, b) => Number(a.id) - Number(b.id))[0];
	}

	/**
	 * Drain every currently-consumable task: each call to `consume` in
	 * turn until `findNextConsumable()` returns undefined. Returns the
	 * structured payload for each in the order they were consumed.
	 *
	 * The orchestrator's consumer loop is `while (true) { const out =
	 * board.drain(); if (out.length === 0) break; ...process each... }`
	 * — i.e. drain until empty, then `awaitNextConsumable()` to wait
	 * for the next completion. Each `consume()` call inside `drain`
	 * still marks its task consumed in metadata; calling `drain()`
	 * twice in a row is a no-op on the second call.
	 */
	drain(): TaskBoardConsumeOutput[] {
		const out: TaskBoardConsumeOutput[] = [];
		while (true) {
			const next = this.findNextConsumable();
			if (!next) break;
			out.push(this.consume(next.id));
		}
		return out;
	}

	/**
	 * Wait for the next completed-but-unconsumed task to appear on the
	 * board, polling the store at `pollIntervalMs`. Returns the task
	 * when one is found, or undefined if `timeoutMs` is reached first.
	 *
	 * Used by the orchestrator's consumer loop after `drain()` returns
	 * empty: the consumer switches from "drain in a tight loop" to
	 * "wait for the next one" once the board is momentarily empty. A
	 * real production deployment would prefer a push-based subscription
	 * (TaskStore change events or `subagents:completed`); polling is the
	 * self-contained test-friendly option.
	 */
	async awaitNextConsumable(
		opts: {
			timeoutMs?: number;
			pollIntervalMs?: number;
		} = {},
	): Promise<TaskGet | undefined> {
		const timeoutMs = opts.timeoutMs ?? 60_000;
		const pollMs = opts.pollIntervalMs ?? 100;
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			const next = this.findNextConsumable();
			if (next) return next;
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}
		return undefined;
	}
}