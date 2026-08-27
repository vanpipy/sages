/**
 * todowrite-tool-result.test.ts — GC-2026-085
 *
 * Pins the ToolResult return shape on the *registered* todowrite tools
 * (`todowrite_compile` + `todowrite_progress`). The existing
 * `test/tools/orchestrator/todowrite.test.ts` covers the underlying
 * `executeTodowriteCompile` / `executeTodowriteProgress` functions
 * directly — but those bypass the `pi.registerTool(...)` boundary, so
 * they did not catch the shipping bug from GC-2026-074 where the
 * registered execute arrow returned a plain object instead of the
 * canonical ToolResult shape.
 *
 * Background: pi-coding-agent's `render-utils.js#getTextOutput` reads
 * `result.content.filter((c) => c.type === "text")`. Without the
 * `.content` wrapper, `result.content` is undefined, `.filter` throws
 * a `TypeError`, and pi's interactive TUI catches the uncaught
 * exception and exits. Reproduced live in the GC-2026-081 follow-up
 * test session. The fix wraps the registered execute's return in
 * `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }`.
 *
 * Run: cd pi-orchestrator && bun test ./test/todowrite-tool-result.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerTodowriteTools } from "../src/todowrite.js";
import { atomicWriteOrchestratorFile } from "../src/state-persistence.js";
import type { OrchestrationPlan, TaskNode } from "../src/types.js";

// ───────────────────────────────────────────────────────────────────────
// MockPi + fixture helpers
// ───────────────────────────────────────────────────────────────────────

interface RegisteredTool {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (
		_toolCallId: string,
		params: unknown,
		_signal: unknown,
		_onUpdate: unknown,
		_ctx: unknown,
	) => unknown;
}

function makeMockPi(): {
	pi: unknown;
	getRegistered: (name: string) => RegisteredTool | undefined;
} {
	const registered = new Map<string, RegisteredTool>();
	const pi = {
		registerTool: (tool: RegisteredTool) => {
			registered.set(tool.name, tool);
		},
	};
	return {
		pi,
		getRegistered: (name: string) => registered.get(name),
	};
}

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "todowrite-tool-result-"));
});

afterEach(() => {
	if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
});

function makeTask(id: string, status: TaskNode["status"] = "pending"): TaskNode {
	return {
		id,
		description: `description for ${id}`,
		plane: "Business",
		priority: "medium",
		depends_on: [],
		files: [],
		subagent_type: "developer",
		isolation: { dag_id: "GC-2026-085", task_id: id, mode: "create" },
		tdd: "none",
		batch: 1,
		status,
		retry_count: 0,
		max_retries: 2,
		prompt: `stub prompt for ${id}`,
		output_schema: { kind: "file_list" },
		acceptance: {},
	};
}

function writePlan(plan: OrchestrationPlan): void {
	atomicWriteOrchestratorFile(cwd, `dag-${plan.id}.yaml`, JSON.stringify(plan, null, 2), {
		owner: "orchestrator",
		validate: (v): v is OrchestrationPlan => true,
	});
}

function makePlan(id: string, tasks: TaskNode[]): OrchestrationPlan {
	return {
		id,
		goal_id: `goal-${id}`,
		title: `Plan ${id}`,
		tasks,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		state: "draft",
		prompts: {},
	};
}

interface ToolContent {
	type?: string;
	text?: string;
}

function asToolResult(result: unknown): { content?: ToolContent[] } {
	return result as { content?: ToolContent[] };
}

// ───────────────────────────────────────────────────────────────────────
// todowrite_compile — ToolResult shape (SC1, SC3)
// ───────────────────────────────────────────────────────────────────────

describe("todowrite_compile registered-tool result shape (GC-2026-085)", () => {
	it("SC1: execute returns { content: [{ type: 'text', text: <JSON.stringify> }] } — not a plain object", () => {
		const { pi, getRegistered } = makeMockPi();
		registerTodowriteTools(pi);

		const tool = getRegistered("todowrite_compile");
		expect(tool).toBeDefined();

		const plan = makePlan("GC-2026-085-COMPILE-SHAPE", [makeTask("P1")]);
		writePlan(plan);

		const result = tool!.execute(
			"tool-call-id",
			{ dag_id: "GC-2026-085-COMPILE-SHAPE" },
			undefined,
			undefined,
			{ cwd },
		);
		const wrapped = asToolResult(result);

		// SC1: canonical ToolResult shape — content must be an array of
		// `{type:"text", text:...}` blocks. Pre-fix this throws because
		// result.content was undefined.
		expect(Array.isArray(wrapped.content)).toBe(true);
		expect(wrapped.content).toHaveLength(1);
		expect(wrapped.content?.[0]?.type).toBe("text");
		expect(typeof wrapped.content?.[0]?.text).toBe("string");
	});

	it("SC1: text field contains JSON.parse-able string of the underlying CompileResult", () => {
		const { pi, getRegistered } = makeMockPi();
		registerTodowriteTools(pi);
		const tool = getRegistered("todowrite_compile")!;

		const plan = makePlan("GC-2026-085-COMPILE-JSON", [makeTask("P1"), makeTask("P2")]);
		writePlan(plan);

		const result = tool.execute(
			"id",
			{ dag_id: "GC-2026-085-COMPILE-JSON" },
			undefined,
			undefined,
			{ cwd },
		);
		const text = asToolResult(result).content?.[0]?.text ?? "";
		const parsed = JSON.parse(text);

		// The wrapper preserves every existing CompileResult field so
		// the unit-level contract is unchanged.
		expect(parsed).toHaveProperty("ok", true);
		expect(parsed).toHaveProperty("dag_id", "GC-2026-085-COMPILE-JSON");
		expect(parsed).toHaveProperty("total", 2);
		expect(parsed.items).toHaveLength(2);
		expect(parsed.by_status).toBeDefined();
		expect(typeof parsed.persisted_to).toBe("string");
		expect(parsed.persisted_to.length).toBeGreaterThan(0);
	});

	it("SC1: error path (DAG not found) still returns ToolResult shape, not a throw", () => {
		const { pi, getRegistered } = makeMockPi();
		registerTodowriteTools(pi);
		const tool = getRegistered("todowrite_compile")!;

		const result = tool.execute(
			"id",
			{ dag_id: "GC-2026-DOES-NOT-EXIST" },
			undefined,
			undefined,
			{ cwd },
		);
		const wrapped = asToolResult(result);

		// Error responses still go through the wrapper — the renderer
		// must not crash on an "ok:false" payload either.
		expect(Array.isArray(wrapped.content)).toBe(true);
		const parsed = JSON.parse(wrapped.content?.[0]?.text ?? "{}");
		expect(parsed.ok).toBe(false);
		expect(parsed.dag_id).toBe("GC-2026-DOES-NOT-EXIST");
	});
});

// ───────────────────────────────────────────────────────────────────────
// todowrite_progress — ToolResult shape (SC2, SC3)
// ───────────────────────────────────────────────────────────────────────

describe("todowrite_progress registered-tool result shape (GC-2026-085)", () => {
	it("SC2: execute returns { content: [{ type: 'text', text: <JSON.stringify> }] } — not a plain object", () => {
		const { pi, getRegistered } = makeMockPi();
		registerTodowriteTools(pi);

		const tool = getRegistered("todowrite_progress");
		expect(tool).toBeDefined();

		const plan = makePlan("GC-2026-085-PROGRESS-SHAPE", [makeTask("P1")]);
		writePlan(plan);

		const result = tool!.execute(
			"tool-call-id",
			{ dag_id: "GC-2026-085-PROGRESS-SHAPE" },
			undefined,
			undefined,
			{ cwd },
		);
		const wrapped = asToolResult(result);

		expect(Array.isArray(wrapped.content)).toBe(true);
		expect(wrapped.content).toHaveLength(1);
		expect(wrapped.content?.[0]?.type).toBe("text");
		expect(typeof wrapped.content?.[0]?.text).toBe("string");
	});

	it("SC2: text field contains JSON.parse-able string of the underlying ProgressResult", () => {
		const { pi, getRegistered } = makeMockPi();
		registerTodowriteTools(pi);
		const tool = getRegistered("todowrite_progress")!;

		const plan = makePlan("GC-2026-085-PROGRESS-JSON", [
			makeTask("P1", "completed"),
			makeTask("P2", "pending"),
		]);
		writePlan(plan);

		const result = tool.execute(
			"id",
			{ dag_id: "GC-2026-085-PROGRESS-JSON" },
			undefined,
			undefined,
			{ cwd },
		);
		const text = asToolResult(result).content?.[0]?.text ?? "";
		const parsed = JSON.parse(text);

		expect(parsed).toHaveProperty("ok", true);
		expect(parsed).toHaveProperty("dag_id", "GC-2026-085-PROGRESS-JSON");
		expect(parsed.items).toHaveLength(2);
		expect(parsed.summary).toBeDefined();
		expect(parsed.drift).toBeDefined();
		// Drift surfaces in the wrapped payload (orthogonal to the
		// shape fix; included to confirm no field is dropped).
		expect(Array.isArray(parsed.drift)).toBe(true);
	});

	it("SC2: missing dag_id returns ToolResult shape with ok:false (no throw)", () => {
		const { pi, getRegistered } = makeMockPi();
		registerTodowriteTools(pi);
		const tool = getRegistered("todowrite_progress")!;

		// No dag_id — progress tool should respond ok:false, not crash.
		const result = tool.execute("id", {}, undefined, undefined, { cwd });
		const wrapped = asToolResult(result);

		expect(Array.isArray(wrapped.content)).toBe(true);
		const parsed = JSON.parse(wrapped.content?.[0]?.text ?? "{}");
		expect(parsed.ok).toBe(false);
	});
});

// ───────────────────────────────────────────────────────────────────────
// SC3 — integration test pins the ToolResult shape on the registered
// `pi.registerTool` boundary (not just on the underlying execute fn).
// ───────────────────────────────────────────────────────────────────────

describe("registered-tool boundary integration (GC-2026-085 / SC3)", () => {
	it("SC3: the registered tool object — not the underlying function — has the ToolResult-shape contract", () => {
		const { pi, getRegistered } = makeMockPi();
		registerTodowriteTools(pi);

		// Sanity: both tools must be registered with the expected names.
		expect(getRegistered("todowrite_compile")).toBeDefined();
		expect(getRegistered("todowrite_progress")).toBeDefined();

		// Direct-call check: invoking execute on the *registered* tool
		// (not the underlying executeTodowriteCompile function)
		// produces the ToolResult shape. This is the exact code path
		// pi-coding-agent exercises in production.
		const compileTool = getRegistered("todowrite_compile")!;
		const progressTool = getRegistered("todowrite_progress")!;

		const plan = makePlan("GC-2026-085-INTEGRATION", [makeTask("P1")]);
		writePlan(plan);

		const compileResult = compileTool.execute(
			"id",
			{ dag_id: "GC-2026-085-INTEGRATION" },
			undefined,
			undefined,
			{ cwd },
		);
		const progressResult = progressTool.execute(
			"id",
			{ dag_id: "GC-2026-085-INTEGRATION" },
			undefined,
			undefined,
			{ cwd },
		);

		// Both produce the canonical ToolResult shape, including the
		// "type" discriminator and string "text" payload.
		expect(compileResult).toMatchObject({
			content: [
				{
					type: "text",
					text: expect.any(String),
				},
			],
		});
		expect(progressResult).toMatchObject({
			content: [
				{
					type: "text",
					text: expect.any(String),
				},
			],
		});

		// The pre-fix bug would have surfaced here as compileResult.content
		// being undefined (TypeError on .filter in the renderer).
		expect(compileResult).not.toHaveProperty("ok");
		expect(progressResult).not.toHaveProperty("ok");
	});
});
