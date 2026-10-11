/**
 * orchestrator-consume-tool.ts — the orchestrator's consumption tool:
 * `task_consume(task_id, include_transcript?)` reads a completed task's
 * result in a structured way so the LLM doesn't have to parse raw
 * `TaskOutput` text and infer state from prose.
 *
 * Closes the Task Feeding loop. The orchestrator is the sole consumer
 * of the board; `task_consume` is the dedicated end of that path. It:
 *
 *   - Reads the task via `TaskStore` at the orchestrator's project task
 *     file (same path `orchestrate` writes to — see
 *     `pi-tasks/src/task-paths.ts:orchestratorProjectTaskFile`).
 *   - Verifies status === "completed". A still-running task returns an
 *     error instructing the LLM to use `TaskOutput(task_id, block: true)`
 *     first — `task_consume` is the decision step, not the wait step.
 *   - For Reviewer tasks, extracts the 4-state verdict from the result
 *     text and emits a follow-up suggestion tailored to each.
 *   - Marks the task consumed in metadata (`metadata.consumed_at`) so a
 *     future consume call knows the orchestrator has already processed it.
 *
 * The two shipped agent types — Developer (full read/write/edit/bash,
 * TDD) and Reviewer (read-only, verdict) — drive the suggestion text.
 */

import { Type, type Static } from "typebox";
import type { ExtensionAPI, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
// Import path-mapped by tsconfig `paths`. Same imports as `orchestrator-tool.ts`:
// the orchestrator reads the same `TaskStore` the board uses, at the same
// file path. See the file header in `orchestrator-tool.ts` for the
// coordination rationale (file lock, no event bus, no globalThis).
import { TaskStore } from "@sages/pi-tasks/task-store";
import { orchestratorProjectTaskFile } from "@sages/pi-tasks/task-paths";

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

export const ConsumeParams = Type.Object({
	task_id: Type.String({
		description:
			"The task ID to consume. Must be `completed`; if the task is still running, use `TaskOutput(task_id, block: true)` first and call `task_consume` after.",
	}),
	include_transcript: Type.Optional(
		Type.Boolean({
			description:
				"If true, include the agent's full transcript in the returned result (otherwise just the final assistant text). Default false.",
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
	/** Wall-clock ms when the orchestrator consumed the task. */
	consumed_at: number;
	/** Tailored next-step hint based on the verdict (Reviewer tasks only). */
	follow_up_suggestion?: string;
}

/**
 * Find the verdict in a Reviewer task's result text. Looks for one of the
 * four states as a standalone token — accepts `verdict: CLEAN`,
 * `Verdict = NEEDS_WORK`, a bare `CLEAN`, etc.
 *
 * Returns undefined when no verdict token appears; the orchestrator
 * decides what to do with a verdict-less Reviewer task (the Reviewer
 * contract says it emits one, but be tolerant of malformed output).
 */
export function parseVerdict(result: string): Verdict | undefined {
	// The Reviewer contract says it emits a 4-state verdict but doesn't pin
	// a serialization format, so we accept either:
	//
	//   1. Prefixed form: `verdict: STATE`, `Verdict = STATE`, `**verdict:** STATE`
	//      (case-insensitive; canonical is UPPER_SNAKE but agents may write
	//      mixed case).
	//   2. Standalone line: a line that is just the verdict token, possibly
	//      with surrounding whitespace and `**` markdown emphasis.
	//
	// Both checks anchor the verdict so prose like "Let me clean up the
	// code" or "The code is clean" doesn't false-match. The prefix
	// alternation enforces a `verdict:`-style marker; the standalone
	// alternation requires the token to occupy its own line.
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
export function suggestFollowUp(verdict: Verdict): string {
	switch (verdict) {
		case "CLEAN":
			return "Phase complete. Move to the next task or declare the goal done.";
		case "NEEDS_WORK":
			return "Spawn a Developer follow-up task with the Reviewer's feedback as its description; set its `blockedBy` to this Review so the chain stays causal.";
		case "NEEDS_REDESIGN":
			return "The approach is wrong, not just the execution. Spawn a new Implement task rather than a fix — `blockedBy` this Review so the chain documents the redirect.";
		case "NEEDS_CLARIFICATION":
			return "Pause and surface the Reviewer's questions to the user before continuing. Do not spawn follow-up work until the user answers.";
	}
}

/**
 * Tool wrapper — reads cwd from the pi ExecuteContext, instantiates a
 * TaskStore at the orchestrator's project task file, and returns the
 * structured consumption payload.
 */
async function taskConsume(
	_toolCallId: string,
	params: ConsumeInput,
	_signal: AbortSignal | undefined,
	_onUpdate: AgentToolUpdateCallback<ConsumeOutput> | undefined,
	ctx: { cwd: string },
): Promise<AgentToolResult<ConsumeOutput | undefined>> {
	const store = new TaskStore(orchestratorProjectTaskFile(ctx.cwd));
	const task = store.get(params.task_id);
	if (!task) {
		return {
			content: [
				{
					type: "text",
					text: `No task with ID #${params.task_id}. Use TaskList to find the right ID.`,
				},
			],
			details: undefined,
		};
	}
	if (task.status !== "completed") {
		return {
			content: [
				{
					type: "text",
					text:
						`Task #${task.id} is '${task.status}', not 'completed'. ` +
						(task.status === "in_progress"
							? "Wait for it to finish first: call TaskOutput with block=true, then call task_consume again."
							: "Use TaskExecute to start it, or TaskUpdate to set it back to pending."),
				},
			],
			details: undefined,
		};
	}

	const result =
		typeof task.metadata?.result === "string" ? task.metadata.result : "";
	const agentType = typeof task.metadata?.agentType === "string"
		? task.metadata.agentType
		: "Developer";
	const verdict =
		agentType === "Reviewer" && result ? parseVerdict(result) : undefined;

	// Mark consumed in metadata. Both the timestamp and a `consumed: true`
	// flag — the flag is the authoritative state, the timestamp is the
	// audit trail. Idempotent: a second consume is a no-op for the flag.
	const consumedAt = Date.now();
	store.update(task.id, {
		metadata: { consumed: true, consumed_at: consumedAt },
	});

	const data: ConsumeOutput = {
		id: task.id,
		subject: task.subject,
		status: task.status,
		agentType,
		result,
		...(verdict ? { verdict } : {}),
		consumed_at: consumedAt,
		...(verdict ? { follow_up_suggestion: suggestFollowUp(verdict) } : {}),
	};

	return {
		content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
		details: data,
	};
}

/**
 * Register the `task_consume` tool on the given pi extension. Idempotent.
 */
export function registerConsumeTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "task_consume",
		label: "task_consume",
		description:
			"Consume a completed task's result in a structured way. " +
			"Reads the task from the orchestrator's project store, parses " +
			"the Reviewer's 4-state verdict (CLEAN / NEEDS_WORK / " +
			"NEEDS_REDESIGN / NEEDS_CLARIFICATION) when present, and " +
			"returns a verdict-tailored follow-up suggestion. Marks the " +
			"task consumed in metadata so a repeat call sees the audit " +
			"trail. The task must be `completed`; if it's still running, " +
			"use TaskOutput(task_id, block: true) first. This is the " +
			"decision step of the Task Feeding loop — pair it with " +
			"`orchestrate` for creation and `TaskExecute` for dispatch.",
		parameters: ConsumeParams,
		execute: taskConsume,
	});
}