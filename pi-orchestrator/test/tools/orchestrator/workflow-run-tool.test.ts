/**
 * workflow-run-tool.test.ts — Pins the AgentToolCallOutcome extraction contract.
 *
 * ctx.executeTool returns AgentToolCallOutcome = { toolCall, result, isError }
 * (see @earendil-works/pi-agent-core/dist/types.d.ts). workflow_run's
 * programmatic callers (piTasksCreate / piTasksUpdate) need result.details,
 * NOT the envelope. Before GC-2026-pi-tasks-extraction-fix the wrapper looked
 * at `outcome.details` (undefined) and `outcome.content` (undefined), so all
 * four phase IDs came back as "" and pi-tasks task status never moved off
 * pending. This suite locks down the correct extraction.
 */

import { describe, expect, it } from "bun:test";
import { unwrapExecuteToolOutcome } from "../../../src/workflow-run-tool.js";

describe("unwrapExecuteToolOutcome (AgentToolCallOutcome extraction)", () => {
	it("extracts result.details from a TaskCreate-shaped outcome", () => {
		const outcome = {
			toolCall: { id: "tc-1", name: "TaskCreate", args: {} },
			result: {
				content: [{ type: "text" as const, text: "Task #1 created successfully: Implement" }],
				details: { id: "1", task: { id: "1", subject: "Implement" } },
			},
			isError: false,
		};
		expect(unwrapExecuteToolOutcome(outcome)).toEqual({
			id: "1",
			task: { id: "1", subject: "Implement" },
		});
	});

	it("extracts result.details from a TaskUpdate-shaped outcome", () => {
		const outcome = {
			toolCall: { id: "tc-2", name: "TaskUpdate", args: {} },
			result: { content: [], details: { id: "1" } },
			isError: false,
		};
		expect(unwrapExecuteToolOutcome(outcome)).toEqual({ id: "1" });
	});

	it("falls back to the whole outcome when result.details is undefined", () => {
		// Defensive: tools that don't set details (early pi-orchestrator
		// versions, or any tool we forgot to update) should still surface
		// *something* rather than swallow the call silently.
		const outcome = {
			toolCall: { id: "tc-3", name: "Unknown", args: {} },
			result: { content: [], details: undefined },
			isError: false,
		};
		expect(unwrapExecuteToolOutcome(outcome)).toBe(outcome);
	});

	it("survives a malformed envelope (no .result key) without throwing", () => {
		// A buggy host could conceivably hand us the bare AgentToolResult
		// or something totally unexpected. We must not crash the workflow.
		expect(unwrapExecuteToolOutcome(undefined)).toBeUndefined();
		expect(unwrapExecuteToolOutcome(null)).toBeNull();
		expect(unwrapExecuteToolOutcome({ result: undefined })).toEqual({ result: undefined });
	});
});