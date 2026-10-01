/**
 * workflow-run-tool.ts — LLM-facing tool registration for workflow_run
 * (GC-2026-workflow-run + GC-2026-pi-tasks-integration).
 *
 * The tool wraps executeWorkflowRun from ./workflow-run.js. Unlike the
 * other Sages tools (which use the narrow ExecuteContext wrapper), this
 * tool needs access to ctx.executeTool so it can drive pi-tasks'
 * TaskCreate / TaskUpdate from inside the workflow_run state machine.
 *
 * We bypass wrapRegisteredTool here and define execute() directly with
 * the full ExtensionToolContext signature.
 */

import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { executeWorkflowRun, WorkflowRunParams, type WorkflowRunInput } from "./workflow-run.js";

export function registerWorkflowRunTool(pi: ExtensionAPI): void {
	// Same `pi: any` workaround as goal_contract_create: pi-coding-agent's
	// ToolDefinition uses AgentToolResult<unknown> internally which is
	// structurally incompatible with our local ToolResult.
	const piAsAny = pi as unknown as {
		registerTool(def: {
			name: string;
			label: string;
			description: string;
			parameters: typeof WorkflowRunParams;
			execute: (
				toolCallId: string,
				params: WorkflowRunInput,
				signal: AbortSignal | undefined,
				onUpdate: ((update: unknown) => void) | undefined,
				ctx: ExtensionToolContext,
			) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
		}): void;
	};
	piAsAny.registerTool({
		name: "workflow_run",
		label: "Workflow Run",
		description:
			"GC-2026-workflow-run: run the 5-phase pipeline (Implement → Review ⇆ Fix → Merge) " +
			"for a goal contract. Blocks until all phases complete or the pipeline is blocked. " +
			"Returns status (success/blocked), task summaries, paths, and any unresolved findings. " +
			"GC-2026-pi-tasks-integration: also creates 4 pi-tasks tasks (Implement / Review / " +
			"Fix / Merge) tagged with metadata.workflow_run_goal_id so the LLM can see live " +
			"progress via TaskList.",
		parameters: WorkflowRunParams,
		execute: async (
			_toolCallId: string,
			params: WorkflowRunInput,
			_signal: AbortSignal | undefined,
			_onUpdate: ((update: unknown) => void) | undefined,
			ctx: ExtensionToolContext,
		) => {
			const result = await executeWorkflowRun(params, {
				pi,
				ctx,
				repoCwd: ctx.cwd,
				executeTool: async (
					name: string,
					args: unknown,
				): Promise<unknown> => {
					const outcome = await ctx.executeTool(name, args);
					// AgentToolCallOutcome — extract details if present.
					const anyOutcome = outcome as { details?: unknown; content?: unknown };
					return anyOutcome.details ?? anyOutcome.content ?? outcome;
				},
			});
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		},
	});
}