/**
 * orchestrator-tool.ts — thin shim around `TaskBoard.materializePlan`.
 *
 * All the actual logic lives in `task-board.ts`. This file exists only
 * to register the `orchestrate` tool with pi and translate its
 * TypeBox schema into the call format `materializePlan` expects.
 *
 *   - LLM calls `orchestrate(intent, phases)` with a list of phase specs.
 *   - The wrapper instantiates a `TaskBoard` at the orchestrator's
 *     project task file (see
 *     `pi-tasks/src/task-paths.ts:orchestratorProjectTaskFile`) and calls
 *     `board.materializePlan(params)`.
 *   - Phase-level `blockedBy` references (by subject) are resolved to
 *     task IDs and wired into both the predecessor's `blocks` and the
 *     dependent's `blockedBy`. After this call, pi-tasks's normal cascade
 *     (via `TaskExecute`) drives the phases in dependency order.
 *
 * The two shipped agent types are `Developer` and `Reviewer`. Custom
 * agents via `~/.pi/agent/agents/*.md` extend the set, but the tool's
 * static `AgentType` union stays at the shipped set so the typebox
 * schema is tight.
 */

import { Type, type Static } from "typebox";
import type { ExtensionAPI, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { TaskBoard, type AgentType } from "./task-board.js";

export const AGENT_TYPES: readonly AgentType[] = ["Developer", "Reviewer"];

export const OrchestrateParams = Type.Object({
	intent: Type.String({
		description:
			"What this plan accomplishes. Free text — surfaced in the orchestrator's audit and in each phase's task description if the phase doesn't supply its own.",
		minLength: 1,
	}),
	phases: Type.Array(
		Type.Object({
			subject: Type.String({
				description:
					"One-line summary of what this phase produces. Used as the task subject in pi-tasks and as the lookup key for `blockedBy` references.",
				minLength: 1,
			}),
			agentType: Type.Union([
				Type.Literal("Developer"),
				Type.Literal("Reviewer"),
			]),
			detail: Type.Optional(
				Type.String({
					description:
						"What this phase does. Defaults to `intent` when omitted.",
				}),
			),
			blockedBy: Type.Optional(
				Type.Array(Type.String({
					description:
						"`subject` of earlier phases this phase depends on. Resolved to task IDs after the first create-pass.",
				})),
			),
		}),
		{ minItems: 1 },
	),
});
export type OrchestrateInput = Static<typeof OrchestrateParams>;

export interface OrchestrateOutput {
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

/**
 * Tool wrapper — reads cwd from the pi ExecuteContext, instantiates a
 * TaskBoard, and delegates to `materializePlan`. Returns the DAG as a
 * structured AgentToolResult.
 */
async function orchestrate(
	toolCallId: string,
	params: OrchestrateInput,
	_signal: AbortSignal | undefined,
	_onUpdate: AgentToolUpdateCallback<OrchestrateOutput> | undefined,
	ctx: { cwd: string },
): Promise<AgentToolResult<OrchestrateOutput>> {
	const board = new TaskBoard({ cwd: ctx.cwd });
	const data = board.materializePlan(params);
	return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
}

/**
 * Register the `orchestrate` tool on the given pi extension. Idempotent.
 */
export function registerOrchestrateTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "orchestrate",
		label: "Orchestrate",
		description:
				"Materialize a multi-phase plan as a task DAG. " +
				"For each phase, a task is created with the chosen agentType " +
				"recorded in metadata. `blockedBy` references (by phase subject) " +
				"are resolved to task IDs and wired into both sides of the " +
				"dependency. After this call, the standard cascade (via " +
				"`TaskExecute` on the first ready task) drives the phases in " +
				"dependency order. The two shipped agent types are " +
				"Developer and Reviewer.",
		parameters: OrchestrateParams,
		execute: orchestrate,
	});
}