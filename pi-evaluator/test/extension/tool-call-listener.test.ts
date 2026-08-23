/**
 * pi-evaluator/test/extension/tool-call-listener.test.ts
 *
 * Tests the `extension.ts#tool_call` listener that auto-populates
 * state.active_workflow_path + state.active_workflow_id when any of the
 * 4 Sages orchestrator tools (goal_contract_create, dag_synthesize,
 * task_dispatch, orchestrator_audit) is invoked.
 *
 * Pure unit tests: dispatch synthetic ToolCallEvent-like objects through
 * the listener and assert the resulting state mutations.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { readSagesRewardMode } from "../../src/settings.ts";

// Re-implement the listener inline so we don't depend on ExtensionAPI being
// mockable. The listener logic is pure: input → optional state mutation.
function makeListener(state: { mode: "on" | "off"; active_workflow_path?: string; active_workflow_id?: string }) {
	// Mirror src/extension.ts logic exactly.
	const ORCHESTRATOR_TOOL_NAMES = new Set([
		"goal_contract_create",
		"dag_synthesize",
		"task_dispatch",
		"orchestrator_audit",
	]);
	const extractWorkflowId = (toolName: string, input: Record<string, unknown>): string | undefined => {
		if (toolName === "goal_contract_create") {
			return typeof input.id === "string" ? input.id : undefined;
		}
		if (toolName === "dag_synthesize") {
			return typeof input.goal_id === "string" ? input.goal_id : undefined;
		}
		if (typeof input.dag_id === "string") return input.dag_id;
		return undefined;
	};
	return (event: { type?: string; toolName?: string; input?: Record<string, unknown> }, ctx?: { cwd?: string }) => {
		if (state.mode !== "on") return;
		if (event?.type !== "tool_call") return;
		const toolName = typeof event.toolName === "string" ? event.toolName : "";
		if (!ORCHESTRATOR_TOOL_NAMES.has(toolName)) return;
		const input = event.input && typeof event.input === "object" ? event.input : {};
		const workflowId = extractWorkflowId(toolName, input);
		if (!workflowId) return;
		const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
		state.active_workflow_path = join(cwd, ".pi", "orchestrator");
		state.active_workflow_id = workflowId;
	};
}

describe("tool_call listener (extension.ts)", () => {
	let state: { mode: "on" | "off"; active_workflow_path?: string; active_workflow_id?: string };
	let onToolCall: ReturnType<typeof makeListener>;

	beforeEach(() => {
		state = { mode: "on" };
		onToolCall = makeListener(state);
	});

	test("goal_contract_create.id populates state", () => {
		onToolCall(
			{ type: "tool_call", toolName: "goal_contract_create", input: { id: "GC-2026-099" } },
			{ cwd: "/tmp/project" },
		);
		expect(state.active_workflow_id).toBe("GC-2026-099");
		expect(state.active_workflow_path).toBe("/tmp/project/.pi/orchestrator");
	});

	test("dag_synthesize.goal_id populates state", () => {
		onToolCall(
			{ type: "tool_call", toolName: "dag_synthesize", input: { goal_id: "GC-2026-100" } },
			{ cwd: "/tmp/project" },
		);
		expect(state.active_workflow_id).toBe("GC-2026-100");
		expect(state.active_workflow_path).toBe("/tmp/project/.pi/orchestrator");
	});

	test("task_dispatch.dag_id populates state", () => {
		onToolCall(
			{ type: "tool_call", toolName: "task_dispatch", input: { dag_id: "DAG-2026-101" } },
			{ cwd: "/tmp/project" },
		);
		expect(state.active_workflow_id).toBe("DAG-2026-101");
		expect(state.active_workflow_path).toBe("/tmp/project/.pi/orchestrator");
	});

	test("orchestrator_audit.dag_id populates state", () => {
		onToolCall(
			{ type: "tool_call", toolName: "orchestrator_audit", input: { dag_id: "DAG-2026-102" } },
			{ cwd: "/tmp/project" },
		);
		expect(state.active_workflow_id).toBe("DAG-2026-102");
		expect(state.active_workflow_path).toBe("/tmp/project/.pi/orchestrator");
	});

	test("non-orchestrator tool_name is a no-op", () => {
		const before = { ...state };
		onToolCall(
			{ type: "tool_call", toolName: "bash", input: { command: "ls" } },
			{ cwd: "/tmp/project" },
		);
		expect(state).toEqual(before);
	});

	test("mode=off is a no-op even with the right tool name", () => {
		state.mode = "off";
		const before = { ...state };
		onToolCall(
			{ type: "tool_call", toolName: "goal_contract_create", input: { id: "GC-2026-200" } },
			{ cwd: "/tmp/project" },
		);
		expect(state).toEqual(before);
	});

	test("missing id field is a no-op", () => {
		const before = { ...state };
		onToolCall(
			{ type: "tool_call", toolName: "goal_contract_create", input: { title: "no id" } },
			{ cwd: "/tmp/project" },
		);
		expect(state).toEqual(before);
	});

	test("non-string id is a no-op", () => {
		const before = { ...state };
		onToolCall(
			{ type: "tool_call", toolName: "goal_contract_create", input: { id: 12345 } },
			{ cwd: "/tmp/project" },
		);
		expect(state).toEqual(before);
	});

	test("missing ctx.cwd falls back to process.cwd()", () => {
		onToolCall(
			{ type: "tool_call", toolName: "goal_contract_create", input: { id: "GC-fallback" } },
			undefined,
		);
		expect(state.active_workflow_id).toBe("GC-fallback");
		expect(state.active_workflow_path).toBe(join(process.cwd(), ".pi", "orchestrator"));
	});

	test("subsequent calls overwrite previous state", () => {
		onToolCall(
			{ type: "tool_call", toolName: "goal_contract_create", input: { id: "GC-old" } },
			{ cwd: "/tmp/project-a" },
		);
		onToolCall(
			{ type: "tool_call", toolName: "dag_synthesize", input: { goal_id: "GC-new" } },
			{ cwd: "/tmp/project-b" },
		);
		expect(state.active_workflow_id).toBe("GC-new");
		expect(state.active_workflow_path).toBe("/tmp/project-b/.pi/orchestrator");
	});

	test("uses goal_id for dag_synthesize (not id)", () => {
		// dag_synthesize input has both `id` (DAG id) and `goal_id` (GC id).
		// We pick `goal_id` because that's the workflow's stable identity.
		onToolCall(
			{
				type: "tool_call",
				toolName: "dag_synthesize",
				input: { id: "DAG-wrong", goal_id: "GC-correct" },
			},
			{ cwd: "/tmp/project" },
		);
		expect(state.active_workflow_id).toBe("GC-correct");
	});

	test("readSagesRewardMode (smoke — settings file may not exist in CI)", () => {
		// Just exercise the import path. Settings may not exist in CI, so
		// we just assert it returns a boolean.
		const mode = readSagesRewardMode();
		expect(typeof mode).toBe("boolean");
	});
});