/**
 * orchestrator-tool.ts — the orchestrator's three LLM-facing tools.
 *
 * The orchestrator is a CONSUMER of the task flow, not its manager.
 * It does three things on the flow:
 *
 *   1. READ — `task_inspect(task_id)` returns routing-relevant fields
 *      (type + status + agentType) so the LLM can route without a full
 *      TaskGet.
 *
 *   2. READ — `task_consume(task_id, include_transcript?)` reads a
 *      completed plan task in a structured way. It does NOT mark the
 *      task consumed or otherwise mutate state. Parses the Reviewer's
 *      4-state verdict from the result text and returns it together
 *      with a verdict-tailored follow-up suggestion.
 *
 *   3. WRITE — `task_convert_intent(task_id, plan)` is the
 *      orchestrator's unique intent → plan conversion operator. Reads
 *      an intent task, marks it converted, and creates N plan tasks
 *      wired from the structured plan. The caller (LLM) does the
 *      planning — the schema forces a structured object (intent_shape +
 *      rationale + phases[]) and runtime validation enforces per-shape
 *      rules. See `phase-validation.ts` for the rules. Phase →
 *      agentType is mapped deterministically (review → Reviewer, all
 *      others → Developer) so the LLM cannot mis-assign roles.
 *
 * The orchestrator does NOT have an `orchestrate` tool, does NOT have
 * a `task_create` tool, does NOT have `drain` / `findNextConsumable`
 * / `awaitNextConsumable` tools. The LLM uses pi-tasks's existing
 * `TaskCreate` / `TaskList` / `TaskGet` / `TaskUpdate` / `TaskOutput`
 * / `TaskExecute` directly. The orchestrator's three tools add: routing
 * on the read side, verdict parsing on the read side, and structured
 * intent → plan conversion on the write side.
 *
 * Both tools read/write the same TaskStore the board's own
 * `taskScope: "project"` mode uses — see
 * `pi-tasks/src/task-paths.ts:orchestratorProjectTaskFile`. They go
 * through the store's file lock, so concurrent writes are safe.
 */

import { Type, type Static } from "typebox";
import type { ExtensionAPI, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { TaskStore, type TaskType } from "@sages/pi-tasks/task-store";
import { orchestratorProjectTaskFile } from "@sages/pi-tasks/task-paths";
import { parseVerdict, suggestFollowUp, type Verdict } from "./verdict.js";
import {
	PhaseValidationError,
	type Phase,
	validatePlanShape,
	validateRationale,
} from "./phase-validation.js";

// Re-exported for downstream callers. The orchestrator's consumer
// tools (`task_inspect`, `task_consume`, `task_convert_intent`) all
// import `TaskType` from this module.
export type { TaskType };
export type { Phase };

/** The two shipped agent types. */
export type AgentType = "Developer" | "Reviewer";

/**
 * Phase → agentType mapping. Encoded once, never overridable.
 * The LLM never types `agentType` directly — it picks a phase, and
 * this map assigns the agent type at conversion time.
 */
export const PHASE_AGENT_TYPE: Record<Phase, AgentType> = {
	investigate: "Developer",
	design: "Developer",
	implement: "Developer",
	test: "Developer",
	review: "Reviewer",
};

// ─── `task_inspect` — read just the routing-relevant fields ──────────────────

export const InspectParams = Type.Object({
	task_id: Type.String({
		description:
			"The task ID to inspect. Use this before deciding which other orchestrator tool to call: " +
			"`task_consume` works only on completed `plan` tasks, `task_convert_intent` works only on " +
			"`intent` tasks, and `TaskExecute` works only on pending plan tasks. This tool returns " +
			"`type`, `status`, and `agentType` so the LLM can route correctly.",
	}),
});
export type InspectInput = Static<typeof InspectParams>;

export interface InspectOutput {
	id: string;
	subject: string;
	type: TaskType;
	status: string;
	agentType?: string;
	hasResult: boolean;
}

/** Errors `task_inspect` throws. */
export class TaskInspectError extends Error {
	constructor(public readonly kind: "not_found", message: string) {
		super(message);
		this.name = "TaskInspectError";
	}
}

/**
 * Read just the routing-relevant fields of a task. Lighter than TaskGet
 * (which returns the full raw task); this returns only what the
 * orchestrator's LLM needs to decide which follow-up tool to call.
 *
 * The flow:
 *   - type='intent'                       → call `task_convert_intent(intent_id, plan)`
 *   - type='plan' + status='pending'      → call `TaskExecute([id])`
 *   - type='plan' + status='in_progress'  → wait via `TaskOutput(task_id, block=true)`
 *   - type='plan' + status='completed'    → call `task_consume(id)`
 */
export async function taskInspect(
	toolCallId: string,
	params: InspectInput,
	_signal: AbortSignal | undefined,
	_onUpdate: AgentToolUpdateCallback<InspectOutput | undefined> | undefined,
	ctx: { cwd: string },
): Promise<AgentToolResult<InspectOutput | undefined>> {
	const store = new TaskStore(orchestratorProjectTaskFile(ctx.cwd));
	const task = store.get(params.task_id);
	if (!task) {
		throw new TaskInspectError(
			"not_found",
			`No task with ID #${params.task_id}. Use TaskList to find the right ID.`,
		);
	}

	const data: InspectOutput = {
		id: task.id,
		subject: task.subject,
		// task.type is normalized at load: legacy tasks default to "plan".
		type: task.type,
		status: task.status,
		agentType:
			typeof task.metadata?.agentType === "string"
				? task.metadata.agentType
				: undefined,
		// Only plan tasks have results (intent tasks don't reach the executor).
		hasResult: typeof task.metadata?.result === "string",
	};
	return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
}

// ─── `task_consume` — read a plan task's result in a structured way ──────────────

export const ConsumeParams = Type.Object({
	task_id: Type.String({
		description:
			"The task ID to read. Must be `completed` and `type='plan'`; intent tasks throw a `not_plan` error pointing the LLM at `task_convert_intent`. If the task is still running, the LLM should call `TaskOutput(task_id, block=true)` first.",
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
	if (task.type === "intent") {
		throw new TaskConsumeError(
			"not_plan",
			`Task #${task.id} is an intent task; convert it to a plan via task_convert_intent(task_id) before consume.`,
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
//
// SCHEMA-DRIVEN METHODOLOGY:
// The plan is a STRUCTURED OBJECT, not a free-form array. The LLM MUST:
//   1. Classify the intent into one of 6 shapes (intent_shape).
//   2. Justify the shape choice in one sentence (rationale).
//   3. Sequence ordered phases (phases[]) — each phase maps to exactly
//      one agentType via PHASE_AGENT_TYPE (review → Reviewer, all others
//      → Developer). The LLM never types agentType.
//   4. Pass per-phase description (≥ 20 chars) — forces real acceptance
//      criteria instead of inherited intent prose.
//
// Runtime validation in `phase-validation.ts` enforces shape-specific
// rules (phase count bounds, first/last phase match, ≤ 1 review phase,
// rationale length). Rejected plans throw ConvertIntentError with
// `kind: "shape_violation"` and a message that names the violated rule
// + lists the expected shape. The LLM can fix and retry.

export const ConvertIntentParams = Type.Object({
	task_id: Type.String({
		description:
			"The ID of the intent task to convert. Must have type='intent' and not yet be converted (each intent converts once). Call task_inspect first to confirm the type — the parameter name is just `task_id` for consistency with task_inspect / task_consume; the routing is what makes it an intent.",
	}),
	plan: Type.Object(
		{
			intent_shape: Type.Union([
				Type.Literal("trivial"),
				Type.Literal("small"),
				Type.Literal("standard"),
				Type.Literal("investigate-then-fix"),
				Type.Literal("multi-phase"),
				Type.Literal("multi-track"),
			], {
				description:
					"MUST classify the intent first — one of 6 shapes. Drives the expected phase count and Reviewer placement. " +
					"The LLM should commit to a shape in its own response before calling this tool. " +
					"Shapes: trivial = 1 phase (implement), no review. small / standard = 2 phases (implement, review). " +
					"investigate-then-fix = 3+ phases (investigate first, implement next, review last). " +
					"multi-phase = 3+ phases (design first, …, review last). " +
					"multi-track = 2+ implement phases (no review; join via a SECOND intent once the parallel tracks complete).",
			}),
			rationale: Type.String({
				description:
					"MUST justify the chosen shape in one sentence (10–500 chars). " +
					"Forces the LLM to plan before committing. Example: 'Multi-file within one package with a full RED → GREEN → REFACTOR cycle; one Reviewer at the end.'",
				minLength: 10,
				maxLength: 500,
			}),
			phases: Type.Array(
				Type.Object({
					phase: Type.Union([
						Type.Literal("investigate"),
						Type.Literal("design"),
						Type.Literal("implement"),
						Type.Literal("test"),
						Type.Literal("review"),
					], {
						description:
							"Phase for this spec. Maps deterministically to agentType via PHASE_AGENT_TYPE: " +
							"review → Reviewer, all others → Developer. The LLM never types agentType directly.",
					}),
					subject: Type.String({
						description: "Imperative, 1–80 chars. 'Implement /login endpoint'.",
						minLength: 1,
						maxLength: 80,
					}),
					description: Type.String({
						description:
							"MUST cover What / Where / Acceptance / Evidence. Minimum 20 chars forces real acceptance criteria — " +
							"do not inherit the intent's description verbatim.",
						minLength: 20,
					}),
					activeForm: Type.Optional(
						Type.String({
							description:
								"Present continuous form for the widget spinner. 'Implementing /login endpoint'. Optional but recommended.",
						}),
					),
					metadata: Type.Optional(
						Type.Record(Type.String(), Type.Any(), {
							description:
								"Per-phase metadata for the dispatcher: goal_id, isolation, tdd, priority, tag, etc. " +
								"source_intent + phase + agentType are stamped automatically by the function — do not duplicate them.",
						}),
					),
				}),
				{
					minItems: 1,
					maxItems: 12,
					description:
						"Ordered phases. Phase count + ordering must match the declared intent_shape (see phase-validation.ts). " +
						"Defaults to 0 if omitted, but that fails the empty-phases check immediately.",
				},
			),
		},
		{
			description:
				"Structured plan object. The LLM MUST classify intent_shape, justify with rationale, and sequence phases. " +
				"Runtime validation in `phase-validation.ts` enforces shape-specific phase count + ordering. " +
				"Phase → agentType is mapped deterministically via PHASE_AGENT_TYPE — the LLM never types agentType directly.",
		},
	),
});
export type ConvertIntentInput = Static<typeof ConvertIntentParams>;

export interface ConvertIntentOutput {
	plan_task_ids: string[];
	intent_task_id: string;
	intent_shape: string;
	rationale: string;
	converted_at: number;
}

/** Errors `task_convert_intent` throws. */
export class ConvertIntentError extends Error {
	constructor(
		public readonly kind:
			| "intent_not_found"
			| "not_intent"
			| "already_converted"
			| "shape_violation"
			| "empty_phases",
		message: string,
	) {
		super(message);
		this.name = "ConvertIntentError";
	}
}

/**
 * The orchestrator's unique intent → plan conversion. Read the intent,
 * verify state, validate the structured plan (shape + rationale +
 * per-shape phase rules), create the plan tasks, mark the intent as
 * converted. One-way: an already-converted intent can't be re-converted.
 */
export async function taskConvertIntent(
	toolCallId: string,
	params: ConvertIntentInput,
	_signal: AbortSignal | undefined,
	_onUpdate: AgentToolUpdateCallback<ConvertIntentOutput | undefined> | undefined,
	ctx: { cwd: string },
): Promise<AgentToolResult<ConvertIntentOutput | undefined>> {
	const store = new TaskStore(orchestratorProjectTaskFile(ctx.cwd));
	const intent = store.get(params.task_id);
	if (!intent) {
		throw new ConvertIntentError(
			"intent_not_found",
			`No intent task with ID #${params.task_id}.`,
		);
	}
	if (intent.type !== "intent") {
		throw new ConvertIntentError(
			"not_intent",
			`Task #${intent.id} is not an intent task (type=${intent.type}).`,
		);
	}
	if (intent.metadata?.converted) {
		throw new ConvertIntentError(
			"already_converted",
			`Intent task #${intent.id} was already converted at ${intent.metadata.converted_at}.`,
		);
	}

	// Reject empty phase arrays: a conversion with no plan tasks is a no-op
	// that still flips the intent's `converted` flag — better caught at the
	// boundary than after the audit lands.
	if (params.plan.phases.length === 0) {
		throw new ConvertIntentError(
			"empty_phases",
			`Intent task #${intent.id} would convert into zero plan tasks; pass at least one phase.`,
		);
	}

	// Validate the structured plan. Both validators throw
	// PhaseValidationError with a `rule` identifier and a clear message;
	// wrap into ConvertIntentError("shape_violation", ...) so the LLM
	// sees one error kind for all plan-shape failures.
	try {
		validateRationale(params.plan);
		validatePlanShape(params.plan);
	} catch (err) {
		if (err instanceof PhaseValidationError) {
			throw new ConvertIntentError("shape_violation", err.message);
		}
		throw err;
	}

	const convertedAt = Date.now();
	// The intent task keeps its `type='intent'` on the Task field; only the
	// audit fields land in metadata. We do NOT redundantly stamp
	// `metadata.type='intent'` — task.type is the single source of truth.
	// Once conversion succeeds the intent is terminal: it has been fully
	// decomposed into plan tasks, so flip its status to `completed` so the
	// board no longer shows a stale "pending intent" after routing. The
	// metadata audit (`converted` / `converted_at` + `intent_shape` +
	// `rationale`) and the type field are unchanged by this flip.
	store.update(intent.id, {
		status: "completed",
		metadata: {
			converted: true,
			converted_at: convertedAt,
			intent_shape: params.plan.intent_shape,
			rationale: params.plan.rationale,
		},
	});

	// Create each plan task in order. agentType is derived from phase via
	// PHASE_AGENT_TYPE — the LLM cannot mis-assign roles. source_intent +
	// phase + agentType are stamped AFTER the user-provided metadata so
	// they win on conflict (a user can't forge source_intent or downgrade
	// a Reviewer to a Developer).
	const planTaskIds: string[] = [];
	for (const ph of params.plan.phases) {
		const agentType = PHASE_AGENT_TYPE[ph.phase];
		const planMeta: Record<string, unknown> = {
			...ph.metadata,
			agentType,
			source_intent: intent.id,
			phase: ph.phase,
		};
		const planTask = store.create(
			ph.subject,
			ph.description,
			ph.activeForm,
			planMeta,
			"plan",
		);
		planTaskIds.push(planTask.id);
	}

	const data: ConvertIntentOutput = {
		plan_task_ids: planTaskIds,
		intent_task_id: intent.id,
		intent_shape: params.plan.intent_shape,
		rationale: params.plan.rationale,
		converted_at: convertedAt,
	};
	return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
}

// ─── Registration ────────────────────────────────────────────────────────

/**
 * Register the orchestrator's three LLM-facing tools on the given pi
 * extension (in addition to pi-tasks's 7 tools, which are separately
 * registered by pi-tasks itself):
 *
 *   - `task_inspect(task_id)` — read type + status + agentType so the LLM
 *     can route (intent → convert, plan-pending → execute,
 *     plan-completed → consume).
 *   - `task_consume(task_id, include_transcript?)` — read + parse
 *   - `task_convert_intent(task_id, plan)` — the unique converter. The
 *     plan is a STRUCTURED OBJECT (intent_shape + rationale + phases[]);
 *     runtime validation in phase-validation.ts enforces per-shape rules.
 */
export function registerOrchestratorTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "task_inspect",
		label: "task_inspect",
		description:
			"Inspect a task — returns its `type` ('intent' | 'plan'), `status`, " +
			"and `agentType`. Use this BEFORE deciding which other tool to call: " +
			"intent → `task_convert_intent`, plan-pending → `TaskExecute`, " +
			"plan-completed → `task_consume`. Lighter than `TaskGet` (returns " +
			"only the routing-relevant fields, not the full raw task).",
		parameters: InspectParams,
		execute: taskInspect,
	});

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
			"The orchestrator's unique intent → plan converter. Reads an intent " +
			"task (type='intent'), marks it converted (audit: metadata.converted / " +
			"converted_at + intent_shape + rationale), and creates plan tasks from " +
			"a STRUCTURED plan object (intent_shape + rationale + phases[]). The " +
			"LLM MUST classify the intent shape, MUST justify the choice in " +
			"rationale (10–500 chars), and MUST sequence ordered phases — the " +
			"schema + runtime validation (phase-validation.ts) enforce shape-specific " +
			"rules (phase count bounds, first/last phase match, ≤ 1 review phase). " +
			"Phase → agentType is mapped deterministically via PHASE_AGENT_TYPE " +
			"(review → Reviewer, all others → Developer). Refuses non-intent " +
			"sources, already-converted intents, and plans that violate the " +
			"shape rules. Use this for every intent task you see — until an " +
			"intent is on the board, task_consume and TaskExecute won't pick it up.",
		parameters: ConvertIntentParams,
		execute: taskConvertIntent,
	});
}
