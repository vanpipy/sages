/**
 * task-board.ts — the orchestrator's domain abstraction over the
 * pi-tasks TaskStore.
 *
 * The orchestrator is the sole writer + sole consumer of the board
 * (see `AGENTS.md` § Task Feeding). That role lives here:
 *
 *   - `materializePlan(input)` — creation side: take a list of phases,
 *     create one task per phase, wire `blockedBy` / `blocks` in both
 *     directions.
 *   - `consume(taskId)` — consumption side: read a completed plan task
 *     in a structured way. For Reviewer tasks, parse the 4-state verdict
 *     and emit a verdict-tailored follow-up suggestion. Mark the task
 *     consumed in metadata for the audit trail.
 *   - `createIntent(input)` — /tasks side: write an intent task onto the
 *     board. Intent tasks are raw material — never matched to a subagent,
 *     never dispatched, never consumed directly. They wait for the
 *     orchestrator's `convertIntent()` to turn them into plan tasks.
 *   - `convertIntent(input)` — the orchestrator's unique conversion
 *     operator: take an intent task off the "intent surface" and produce
 *     one plan task in its place. Audit trail: intent's
 *     `metadata.converted: true, converted_at: <ts>`; plan's
 *     `metadata.source_intent: <intentId>`.
 *   - `drain()` / `findNextConsumable()` / `awaitNextConsumable(opts)` —
 *     the consumer loop's iteration surface. All three return ONLY plan
 *     tasks (intent tasks stay on the board as audit material but never
 *     reach the executor).
 *   - `get(taskId)` / `list()` — raw read access for inspection.
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

/**
 * Two kinds of tasks live on the board. The orchestrator is the unique
 * operator that converts intent → plan.
 *
 *   - `intent` — created by `/tasks` (or any user-facing custom-task path).
 *     Raw material that the orchestrator has to interpret and turn into
 *     a plan. Never matched to a subagent; never dispatched; never consumed
 *     directly. The orchestrator reads the board, decides how to shape each
 *     intent, and calls `board.convertIntent()` to produce one plan task.
 *   - `plan`   — created by the orchestrator (`board.create()`,
 *     `board.materializePlan()`, or `board.convertIntent()`). Has an
 *     `agentType`, is matched to a subagent, dispatched via `TaskExecute`,
 *     and consumed by the orchestrator after the executor reports back.
 *
 * Only `plan` tasks appear in the consumer loop's
 * `findNextConsumable() / drain() / awaitNextConsumable()` results.
 */
export type TaskKind = "intent" | "plan";

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

// ─── Errors ──────────────────────────────────────────────────────────────────

/** Errors `consume` throws — caught and formatted by the tool wrapper. */
export class TaskBoardConsumeError extends Error {
	constructor(
		public readonly kind: "not_found" | "not_completed" | "not_plan",
		message: string,
	) {
		super(message);
		this.name = "TaskBoardConsumeError";
	}
}

/** Errors `TaskBoard` throws — the convert-* family uses these. */
export class TaskBoardError extends Error {
	constructor(
		public readonly kind:
			| "intent_not_found"
			| "not_intent"
			| "already_converted"
			| "plan_requires_agent_type",
		message: string,
	) {
		super(message);
		this.name = "TaskBoardError";
	}
}

// ─── Creation: plan input/output ────────────────────────────────────────────

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

// ─── Consumption: options/output ────────────────────────────────────────────

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
	agentType: AgentType;
	activeForm?: string;
	/** Other metadata keys to merge into `metadata.kind` (default "plan") + agentType. */
	metadata?: Record<string, unknown>;
	/** Task IDs this new task should block (set on the predecessor's `blocks`). */
	blocks?: string[];
	/** Task IDs this new task depends on (set on this task's `blockedBy`). */
	blockedBy?: string[];
}

export interface TaskBoardCreateIntentInput {
	subject: string;
	description: string;
	activeForm?: string;
	metadata?: Record<string, unknown>;
}

export interface TaskBoardConvertIntentInput {
	intentTaskId: string;
	plan: {
		subject?: string;
		description?: string;
		agentType: AgentType;
		activeForm?: string;
		blocks?: string[];
		blockedBy?: string[];
		metadata?: Record<string, unknown>;
	};
}

export interface TaskBoardConvertIntentOutput {
	planTask: TaskGet;
	intentTask: TaskGet;
	convertedAt: number;
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
	 * The orchestrator's plan-task batch entry point.
	 *
	 * Two-pass: first pass creates every task and maps subject -> id; second
	 * pass wires `blockedBy` / `blocks` in both directions. Missing
	 * predecessor references are silently dropped. Cyclic dependencies are
	 * not detected.
	 */
	materializePlan(input: TaskBoardPlanInput): TaskBoardPlanOutput {
		const subjectToId = new Map<string, string>();
		const createdIds: string[] = [];

		for (const phase of input.phases) {
			const task = this.store.create(
				phase.subject,
				phase.detail ?? input.intent,
				undefined,
				{ kind: "plan", agentType: phase.agentType },
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
	 * Create a single plan task. The orchestrator's single-creator
	 * plan-task entry point — when the LLM wants to add one follow-up
	 * task (e.g. a NEEDS_WORK Developer task after a Reviewer verdict)
	 * outside a full plan, it calls `board.create({...})`.
	 *
	 * `agentType` is REQUIRED: this entry point produces plan tasks only,
	 * and the consumer loop only matches plan tasks to subagents. Use
	 * `board.createIntent({...})` for /tasks-style intent tasks.
	 *
	 * Returns the freshly-created task (re-read from the store after
	 * wiring). Throws `TaskBoardError("plan_requires_agent_type")` if no
	 * agentType is given.
	 */
	create(input: TaskBoardCreateInput): TaskGet {
		if (!input.agentType) {
			throw new TaskBoardError(
				"plan_requires_agent_type",
				`board.create() is the orchestrator's plan-task entry point; agentType is required. Use board.createIntent() for user-facing custom tasks.`,
			);
		}
		const meta: Record<string, unknown> = {
			kind: "plan",
			agentType: input.agentType,
			...input.metadata,
		};

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
	 * Create an intent task. The /tasks-side (user-facing custom-task)
	 * entry point. No agentType: intent tasks are raw material for the
	 * orchestrator to interpret and convert.
	 *
	 * Intent tasks DO show up in `board.list()` so the orchestrator can
	 * see them, but `findNextConsumable()` filters them out — they wait
	 * for `convertIntent()` to become plan tasks.
	 */
	createIntent(input: TaskBoardCreateIntentInput): TaskGet {
		const meta: Record<string, unknown> = {
			kind: "intent",
			...input.metadata,
		};
		const task = this.store.create(
			input.subject,
			input.description,
			input.activeForm,
			meta,
		);
		return this.store.get(task.id)!;
	}

	/**
	 * The orchestrator's unique intent → plan conversion operator.
	 *
	 *   1. Verify the source task is an intent task (kind === "intent").
	 *      A non-intent source throws `TaskBoardError("not_intent")` so
	 *      callers can't accidentally double-convert.
	 *   2. Refuse already-converted intents — every intent converts once.
	 *   3. Mark the source as converted: `metadata.converted: true,
	 *      metadata.converted_at: <ts>`. It stays on the board as a
	 *      record of the user's original intent.
	 *   4. Create the new plan task with `kind: "plan"`, agentType from
	 *      the spec, and `metadata.source_intent: <intentId>` so the
	 *      audit trail survives both directions.
	 *   5. Wire `blocks` / `blockedBy` on the new task in both directions.
	 */
	convertIntent(
		input: TaskBoardConvertIntentInput,
	): TaskBoardConvertIntentOutput {
		const intent = this.store.get(input.intentTaskId);
		if (!intent) {
			throw new TaskBoardError(
				"intent_not_found",
				`No intent task with ID #${input.intentTaskId}.`,
			);
		}
		if (intent.metadata?.kind !== "intent") {
			throw new TaskBoardError(
				"not_intent",
				`Task #${intent.id} is not an intent task (kind=${intent.metadata?.kind ?? "missing"}).`,
			);
		}
		if (intent.metadata?.converted) {
			throw new TaskBoardError(
				"already_converted",
				`Intent task #${intent.id} was already converted at ${intent.metadata.converted_at}.`,
			);
		}

		const convertedAt = Date.now();
		this.store.update(intent.id, {
			metadata: {
				kind: "intent",
				converted: true,
				converted_at: convertedAt,
			},
		});

		const planMeta: Record<string, unknown> = {
			kind: "plan",
			agentType: input.plan.agentType,
			source_intent: intent.id,
			...input.plan.metadata,
		};
		const planTask = this.store.create(
			input.plan.subject ?? intent.subject,
			input.plan.description ?? intent.description,
			input.plan.activeForm,
			planMeta,
		);
		if (input.plan.blocks) {
			for (const target of input.plan.blocks) {
				this.store.update(planTask.id, { addBlocks: [target] });
			}
		}
		if (input.plan.blockedBy) {
			for (const pred of input.plan.blockedBy) {
				this.store.update(planTask.id, { addBlockedBy: [pred] });
			}
		}

		return {
			planTask: this.store.get(planTask.id)!,
			intentTask: this.store.get(intent.id)!,
			convertedAt,
		};
	}

	/**
	 * Read a completed task's result in a structured way. Parses the
	 * Reviewer's 4-state verdict when present and emits a verdict-tailored
	 * follow-up suggestion. Marks the task consumed in metadata.
	 *
	 * Only plan tasks are consumable. Intent tasks throw
	 * `TaskBoardConsumeError("not_plan")` — they need
	 * `board.convertIntent()` first.
	 *
	 * Throws `TaskBoardConsumeError` when the task is missing, an intent
	 * task, or not yet completed — the tool wrapper translates that to an
	 * error response.
	 */
	consume(taskId: string, opts: TaskBoardConsumeOptions = {}): TaskBoardConsumeOutput {
		const task = this.store.get(taskId);
		if (!task) {
			throw new TaskBoardConsumeError(
				"not_found",
				`No task with ID #${taskId}. Use TaskList to find the right ID.`,
			);
		}
		// Missing `kind` defaults to "plan" so tasks created directly via
		// store.create (e.g. older tests, hand-edited fixtures) still work
		// through the consumer loop. Only explicitly-intent tasks are filtered.
		if (task.metadata?.kind === "intent") {
			throw new TaskBoardConsumeError(
				"not_plan",
				`Task #${task.id} is an intent task; convert it to a plan via board.convertIntent() before consume.`,
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

	/** List all tasks (intent + plan), sorted by id (TaskStore's default). */
	list(): TaskList {
		return this.store.list();
	}

	/**
	 * Find the next task that is `completed`, `plan`, and not yet consumed.
	 * Returns undefined when none exists. Sorted by id ascending so the
	 * consumer loop drains in FIFO order; a follow-up child task created
	 * mid-drain naturally lands at the end of the list and gets picked up
	 * after its parent.
	 *
	 * Intent tasks never appear here — they wait for the orchestrator to
	 * convert them via `convertIntent()` before becoming consumable.
	 */
	findNextConsumable(): TaskGet | undefined {
		return this.store
			.list()
			.filter(
				(t) =>
					t.status === "completed" &&
					t.metadata?.kind !== "intent" &&
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
	 * for the next completion.
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
	 * Wait for the next completed-but-unconsumed `plan` task to appear
	 * on the board, polling the store at `pollIntervalMs`. Returns the task
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