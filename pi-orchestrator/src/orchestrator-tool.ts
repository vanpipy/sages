/**
 * orchestrator-tool.ts — the orchestrator's two LLM-facing tools.
 *
 * The orchestrator is a CONSUMER of the task flow, not its manager.
 * It does only two things on the flow:
 *
 *   1. READ — `task_consume(task_id, include_transcript?)` reads a
 *      completed plan task in a structured way. It does NOT mark the
 *      task consumed or otherwise mutate state. Parses the Reviewer's
 *      4-state verdict from the result text and returns it together
 *      with a verdict-tailored follow-up suggestion.
 *
 *   2. WRITE — `task_convert_intent(intent_task_id, plan)` is the
 *      orchestrator's unique intent → plan conversion operator. Reads
 *      an intent task, marks it converted, and creates a new plan task
 *      wired with the spec. Audit trail: intent's
 *      `metadata.converted / converted_at`, plan's
 *      `metadata.source_intent`.
 *
 * The orchestrator does NOT have an `orchestrate` tool, does NOT have
 * a `task_create` tool, does NOT have `drain` / `findNextConsumable`
 * / `awaitNextConsumable` tools. The LLM uses pi-tasks's existing
 * `TaskCreate` / `TaskList` / `TaskGet` / `TaskUpdate` / `TaskOutput`
 * / `TaskExecute` directly. The orchestrator's two tools add: verdict
 * parsing on the read side, and intent → plan conversion on the write
 * side.
 *
 * Both tools read/write the same TaskStore the board's own
 * `taskScope: "project"` mode uses — see
 * `pi-tasks/src/task-paths.ts:orchestratorProjectTaskFile`. They go
 * through the store's file lock, so concurrent writes are safe.
 */

import { Type, type Static } from "typebox";
import type { ExtensionAPI, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
// Both tools share the board's storage layer (TaskStore) and the path
// resolver. They do NOT own any state — they read + write through the
// store and let the LLM drive the lifecycle via pi-tasks's existing
// 7 tools.
import { TaskStore, type TaskKind } from "@sages/pi-tasks/task-store";
import { orchestratorProjectTaskFile } from "@sages/pi-tasks/task-paths";
import { parseVerdict, suggestFollowUp, type Verdict } from "./verdict.js";

// Re-exported for downstream callers (orchestrator-tool.ts was the
// original home of TaskKind before it moved to pi-tasks).
export type { TaskKind };

/** The two shipped agent types. */
export type AgentType = "Developer" | "Reviewer";

// ─── `task_consume` — read a plan task's result in a structured way ─────

export const ConsumeParams = Type.Object({
	task_id: Type.String({
		description:
			"The task ID to read. Must be `completed` and `kind='plan'`; intent tasks throw a `not_plan` error pointing the LLM at `task_convert_intent`. If the task is still running, the LLM should call `TaskOutput(task_id, block=true)` first.",
	}),
	include_transcript: Type.Optional(
		Type.Boolean({
			description:
				"If true, include the full agent transcript in `result` (otherwise just the final assistant text). Default false.",
			default: false,
		}),
	),
});
export type ConsumeInput = Static<typeof ConsumeParams>;

export interface ConsumeOutput {
	id: string;
	subject: string;
	status: string;
	agentType: string;
	result: string;
	/** Only set for Reviewer tasks whose result text contains a 4-state verdict. */
	verdict?: Verdict;
	/** Wall-clock ms when the orchestrator read the task. */
	read_at: number;
	/** Tailored next-step hint based on the verdict (Reviewer tasks only). */
	follow_up_suggestion?: string;
}

/** Errors `task_consume` throws — caught and shown to the LLM verbatim. */
export class TaskConsumeError extends Error {
	constructor(
		public readonly kind: "not_found" | "not_completed" | "not_plan",
		message: string,
	) {
		super(message);
		this.name = "TaskConsumeError";
	}
}

/**
 * Read a plan task's result. Pure read — does NOT mutate the store.
 * `TaskStore.get` is a read; the verdict parser is a pure function.
 * The only "side effect" is the structured payload back to the LLM.
 */
async function taskConsume(
	toolCallId: string,
	params: ConsumeInput,
	_signal: AbortSignal | undefined,
	_onUpdate: AgentToolUpdateCallback<ConsumeOutput | undefined> | undefined,
	ctx: { cwd: string },
): Promise<AgentToolResult<ConsumeOutput | undefined>> {
	const store = new TaskStore(orchestratorProjectTaskFile(ctx.cwd));
	const task = store.get(params.task_id);
	if (!task) {
		throw new TaskConsumeError(
			"not_found",
			`No task with ID #${params.task_id}. Use TaskList to find the right ID.`,
		);
	}
	if (task.metadata?.kind === "intent") {
		throw new TaskConsumeError(
			"not_plan",
			`Task #${task.id} is an intent task; convert it to a plan via task_convert_intent(intent_task_id) before consume.`,
		);
	}
	if (task.status !== "completed") {
		const hint =
			task.status === "in_progress"
				? "Wait for it to finish first: call TaskOutput with block=true, then call task_consume again."
				: "Use TaskExecute to start it, or TaskUpdate to set it back to pending.";
		throw new TaskConsumeError(
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
		agentType === "Reviewer" && result ? parseVerdict(result) : undefined;

	const data: ConsumeOutput = {
		id: task.id,
		subject: task.subject,
		status: task.status,
		agentType,
		result,
		...(verdict ? { verdict } : {}),
		read_at: Date.now(),
		...(verdict ? { follow_up_suggestion: suggestFollowUp(verdict) } : {}),
	};
	return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
}

// ─── `task_convert_intent` — the unique intent → plan operator ───────────

export const ConvertIntentParams = Type.Object({
	intent_task_id: Type.String({
		description:
			"The ID of an intent task to convert. The task must have kind='intent' and not yet be converted (each intent converts once).",
	}),
	plan: Type.Object({
		subject: Type.Optional(
			Type.String({
				description:
					"Subject for the new plan task. Defaults to the intent task's subject if omitted.",
			}),
		),
		description: Type.Optional(
			Type.String({
				description:
					"Description for the new plan task. Defaults to the intent task's description if omitted.",
			}),
		),
		agentType: Type.Union([
			Type.Literal("Developer"),
			Type.Literal("Reviewer"),
		]),
		activeForm: Type.Optional(Type.String()),
		blockedBy: Type.Optional(
			Type.Array(Type.String({ description: "Task IDs the new plan task depends on." })),
		),
		blocks: Type.Optional(
			Type.Array(Type.String({ description: "Task IDs the new plan task will block." })),
		),
		metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
	}),
});
export type ConvertIntentInput = Static<typeof ConvertIntentParams>;

export interface ConvertIntentOutput {
	plan_task_id: string;
	intent_task_id: string;
	converted_at: number;
}

/** Errors `task_convert_intent` throws. */
export class ConvertIntentError extends Error {
	constructor(
		public readonly kind:
			| "intent_not_found"
			| "not_intent"
			| "already_converted",
		message: string,
	) {
		super(message);
		this.name = "ConvertIntentError";
	}
}

/**
 * The orchestrator's unique intent → plan conversion. Read the intent,
 * verify state, create the plan, wire edges, mark the intent as
 * converted. One-way: an already-converted intent can't be re-converted.
 */
async function taskConvertIntent(
	toolCallId: string,
	params: ConvertIntentInput,
	_signal: AbortSignal | undefined,
	_onUpdate: AgentToolUpdateCallback<ConvertIntentOutput | undefined> | undefined,
	ctx: { cwd: string },
): Promise<AgentToolResult<ConvertIntentOutput | undefined>> {
	const store = new TaskStore(orchestratorProjectTaskFile(ctx.cwd));
	const intent = store.get(params.intent_task_id);
	if (!intent) {
		throw new ConvertIntentError(
			"intent_not_found",
			`No intent task with ID #${params.intent_task_id}.`,
		);
	}
	if (intent.metadata?.kind !== "intent") {
		throw new ConvertIntentError(
			"not_intent",
			`Task #${intent.id} is not an intent task (kind=${intent.metadata?.kind ?? "missing"}).`,
		);
	}
	if (intent.metadata?.converted) {
		throw new ConvertIntentError(
			"already_converted",
			`Intent task #${intent.id} was already converted at ${intent.metadata.converted_at}.`,
		);
	}

	const convertedAt = Date.now();
	store.update(intent.id, {
		metadata: {
			kind: "intent",
			converted: true,
			converted_at: convertedAt,
		},
	});

	const planMeta: Record<string, unknown> = {
		kind: "plan",
		agentType: params.plan.agentType,
		source_intent: intent.id,
		...params.plan.metadata,
	};
	const planTask = store.create(
		params.plan.subject ?? intent.subject,
		params.plan.description ?? intent.description,
		params.plan.activeForm,
		planMeta,
	);
	if (params.plan.blocks) {
		for (const target of params.plan.blocks) {
			store.update(planTask.id, { addBlocks: [target] });
		}
	}
	if (params.plan.blockedBy) {
		for (const pred of params.plan.blockedBy) {
			store.update(planTask.id, { addBlockedBy: [pred] });
		}
	}

	const data: ConvertIntentOutput = {
		plan_task_id: planTask.id,
		intent_task_id: intent.id,
		converted_at: convertedAt,
	};
	return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
}

// ─── Registration ────────────────────────────────────────────────────────

/**
 * Register both orchestrator tools on the given pi extension. The
 * orchestrator's full LLM-facing surface (in addition to pi-tasks's
 * 7 tools, which are separately registered by pi-tasks itself):
 *
 *   - `task_consume(task_id, include_transcript?)` — read + parse
 *   - `task_convert_intent(intent_task_id, plan)` — the unique converter
 */
export function registerOrchestratorTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "task_consume",
		label: "task_consume",
		description:
			"Read a completed plan task's result in a structured way. " +
			"Returns `{ id, subject, status, agentType, result, verdict?, read_at, follow_up_suggestion? }`. " +
			"For Reviewer tasks, parses the 4-state verdict (CLEAN / NEEDS_WORK / " +
			"NEEDS_REDESIGN / NEEDS_CLARIFICATION) and emits a verdict-tailored follow-up suggestion. " +
			"Pure read — does not mutate the store. The task must be `completed`; " +
			"if it's still running, use TaskOutput(task_id, block=true) first. " +
			"Intent tasks throw `not_plan` — use task_convert_intent to convert first.",
		parameters: ConsumeParams,
		execute: taskConsume,
	});

	pi.registerTool({
		name: "task_convert_intent",
		label: "task_convert_intent",
		description:
			"The orchestrator's unique intent → plan converter. " +
			"Reads an intent task (kind='intent'), marks it converted (audit: " +
			"`metadata.converted / converted_at`), and creates a new plan task " +
			"with `agentType` from the spec, `metadata.kind='plan'`, and " +
			"`metadata.source_intent` linking back to the intent. Refuses " +
			"non-intent sources and already-converted intents. Use this for " +
			"every intent task you see — until an intent is on the board, " +
			"`task_consume` and TaskExecute won't pick it up.",
		parameters: ConvertIntentParams,
		execute: taskConvertIntent,
	});
}