/**
 * workflow-run-tool.ts — LLM-facing tool registration for workflow_run
 * (GC-2026-workflow-run).
 *
 * The tool wraps executeWorkflowRun from ./workflow-run.js with the
 * registry-backed runtime context (pi + ctx + repo cwd).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { executeWorkflowRun, WorkflowRunParams, type WorkflowRunInput } from "./workflow-run.js";
import { wrapRegisteredTool } from "./registered-tool-wrapper.js";

// Helper: pi: ExtensionAPI's registerTool signature uses pi-coding-agent's
// internal AgentToolResult<unknown> type which is structurally incompatible
// with our local ToolResult. goal_contract_create uses the same workaround
// (`pi: any`). We follow the same convention.
type PiWithRegister = { registerTool(def: unknown): void };

export function registerWorkflowRunTool(pi: ExtensionAPI): void {
	(pi as unknown as PiWithRegister).registerTool({
		name: "workflow_run",
		label: "Workflow Run",
		description:
			"GC-2026-workflow-run: run the 5-phase pipeline (Implement → Review ⇆ Fix → Merge) " +
			"for a goal contract. Blocks until all phases complete or the pipeline is blocked. " +
			"Returns status (success/blocked), task summaries, paths, and any unresolved findings.",
		parameters: WorkflowRunParams,
		execute: wrapRegisteredTool<WorkflowRunInput, string>(
			"workflow_run",
			async (params, ctx) => {
				const result = await executeWorkflowRun(params, {
					pi: pi as unknown as ExtensionAPI,
					ctx: ctx as unknown as ExtensionContext,
					repoCwd: ctx.cwd,
				});
				return JSON.stringify(result, null, 2);
			},
		),
	});
}