/**
 * orchestrator-consume-tool.ts — thin shim around `TaskBoard.consume`.
 *
 * All the actual logic lives in `task-board.ts`. This file exists only
 * to register the `task_consume` tool with pi, define its TypeBox
 * schema, and translate `TaskBoardConsumeError` into the error
 * response format the LLM can act on.
 *
 *   - LLM calls `task_consume(task_id, include_transcript?)`.
 *   - The wrapper instantiates a `TaskBoard` and calls `board.consume()`.
 *   - `board.consume()` returns a structured payload (id, subject,
 *     agentType, result, verdict?, consumed_at, follow_up_suggestion?)
 *     for completed tasks, or throws `TaskBoardConsumeError` for
 *     not-found / not-completed cases. The wrapper catches the throw
 *     and converts it to an error result.
 */

import { Type, type Static } from "typebox";
import type { ExtensionAPI, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { TaskBoard, TaskBoardConsumeError, type TaskBoardConsumeOutput } from "./task-board.js";

export type { Verdict, AgentType } from "./task-board.js";

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

/**
 * Tool wrapper — reads cwd from the pi ExecuteContext, instantiates a
 * TaskBoard, and delegates to `consume`. Catches TaskBoardConsumeError
 * and converts it to the error-response format.
 */
async function taskConsume(
	_toolCallId: string,
	params: ConsumeInput,
	_signal: AbortSignal | undefined,
	_onUpdate: AgentToolUpdateCallback<TaskBoardConsumeOutput | undefined> | undefined,
	ctx: { cwd: string },
): Promise<AgentToolResult<TaskBoardConsumeOutput | undefined>> {
	const board = new TaskBoard({ cwd: ctx.cwd });
	try {
		const data = board.consume(params.task_id, {
			includeTranscript: params.include_transcript ?? false,
		});
		return {
			content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
			details: data,
		};
	} catch (err) {
		if (err instanceof TaskBoardConsumeError) {
			return {
				content: [{ type: "text", text: err.message }],
				details: undefined,
			};
		}
		throw err;
	}
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