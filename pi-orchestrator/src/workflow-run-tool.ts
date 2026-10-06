/**
 * workflow-run-tool.ts — LLM-facing tool registration for workflow_run
 * (GC-2026-workflow-run + GC-2026-pi-tasks-integration).
 *
 * The tool wraps executeWorkflowRun from ./workflow-run.js. Unlike the
 * other Sages tools (which use the narrow ExecuteContext wrapper), this
 * tool uses the full ExtensionToolContext signature so it can pass
 * through the host's `onUpdate` for live progress streaming.
 *
 * GC-2026-100 R3: dropped the dead `executeTool` wiring that was
 * declared on `RunContext` but never read inside executeWorkflowRun.
 * After path B (GC-2026-path-B-swap) workflow_run drives pi-tasks
 * purely via the `workflow:start` / `workflow:phase-complete` event
 * contract; the `ctx.executeTool` round-trip was a path-A leftover.
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
			"GC-2026-workflow-run: run the 4-phase pipeline (Implement → Review ⇆ Fix → Merge) " +
			"for a goal contract. Blocks until all phases complete or the pipeline is blocked. " +
			"Returns status (success/blocked), task summaries, paths, and any unresolved findings. " +
			"GC-2026-pi-tasks-integration: also creates 4 pi-tasks tasks (Implement / Review / " +
			"Fix / Merge) tagged with metadata.workflow_run_goal_id so the LLM can see live " +
			"progress via TaskList. " +
			"GC-2026-workflow-chat-stream: streams partial progress via the host's " +
			"`onUpdate` callback so the user sees phases appearing live in the chat thread " +
			"(host renders each call as a partial tool-result block).",
		parameters: WorkflowRunParams,
		execute: async (
			_toolCallId: string,
			params: WorkflowRunInput,
			_signal: AbortSignal | undefined,
			onUpdate: ((update: unknown) => void) | undefined,
			ctx: ExtensionToolContext,
		) => {
			const result = await executeWorkflowRun(params, {
				pi,
				ctx,
				repoCwd: ctx.cwd,
				// GC-2026-workflow-chat-stream: forward the host's onUpdate so
				// workflow_run can stream partial progress to the chat. The
				// typing is loose here (pi-coding-agent exposes it as
				// `(update: unknown) => void`); workflow-run narrows it to
				// WorkflowProgressUpdate internally.
				onUpdate,
			});
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		},
	});
}