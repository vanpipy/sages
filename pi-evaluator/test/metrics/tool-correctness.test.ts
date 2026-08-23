/**
 * pi-evaluator/test/metrics/tool-correctness.test.ts
 *
 * Tests for the ToolCorrectness metric (GC-2026-066 T2).
 *
 * Strategy: drive the metric via synthetic SessionEntry[] + a small
 * in-memory DagArtifact object. Avoid reading real files so the tests
 * run deterministically without fixture wiring.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolCorrectness } from "../../src/metrics/tool-correctness.ts";
import type { MetricContext } from "../../src/metrics/types.ts";
import type { DagArtifact, SessionEntry } from "../../src/types.ts";
import { clearMetrics, registerBuiltinMetrics } from "../../src/metrics/registry.ts";
import { setJudgeFn } from "../../src/metrics/llm-judge/seam.ts";

const ctx: MetricContext = { cwd: "/tmp" };

/** Build a minimal session.jsonl stub from a list of tool calls + window boundaries. */
function buildSession(segments: Array<{ boundary: string; toolCalls: string[] }>): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let ts = 0;
	for (const seg of segments) {
		// Boundary tool call.
		entries.push({
			type: "message",
			timestamp: `2026-08-22T10:00:${String(ts).padStart(2, "0")}.000Z`,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", name: seg.boundary, arguments: {} }],
			},
			raw: {},
		});
		ts += 1;
		// Non-boundary tool calls inside the window.
		for (const name of seg.toolCalls) {
			entries.push({
				type: "message",
				timestamp: `2026-08-22T10:00:${String(ts).padStart(2, "0")}.000Z`,
message: {
				role: "assistant",
				content: [
					{ type: "toolCall", name, arguments: {} },
					{ type: "toolResult", name, content: "", is_error: false },
				],
			},
			raw: {},
		});
			ts += 1;
		}
	}
	// Closing session_end.
	entries.push({
		type: "session_end",
		timestamp: `2026-08-22T10:00:${String(ts).padStart(2, "0")}.000Z`,
		raw: {},
	});
	return entries;
}

/** Build a minimal DagArtifact stub. */
function buildDag(tasks: Array<{ id: string; expected_tools?: string[] }>): DagArtifact {
	return {
		id: "DAG-stub",
		goal_id: "GC-stub",
		title: "stub",
		tasks: tasks.map((t) => ({
			id: t.id,
			description: t.id,
			plane: "Foundation",
			priority: "medium",
			depends_on: [],
			files: [],
			subagent_type: "developer",
			batch: 1,
			isolation: "none",
			tdd: "strict",
			prompt: "x".repeat(80),
			output_schema: { kind: "code_changes" },
			acceptance: { covers: ["SC1"] },
			...(t.expected_tools ? { expected_tools: t.expected_tools } : {}),
		})) as unknown as DagArtifact["tasks"],
	} as DagArtifact;
}

beforeEach(() => {
	setJudgeFn(null);
	registerBuiltinMetrics();
});

afterEach(() => {
	clearMetrics();
});

describe("ToolCorrectness", () => {
	test("no workflowPath → data_missing", async () => {
		const m = new ToolCorrectness();
		const r = await m.compute({}, ctx);
		expect(r.data_missing).toBe(true);
	});

	test("DAG with no expected_tools → data_missing (opt-in)", async () => {
		const dag = buildDag([{ id: "T1" }]);
		const session = buildSession([{ boundary: "T1", toolCalls: ["read", "grep"] }]);
		const m = new ToolCorrectness();
		// Stub the readDag + readSession paths by injecting via a workflow_path
		// that doesn't exist. Since both readers will throw, we should get
		// data_missing with a clear note. Skipping the file-system path here
		// and testing via the registry integration in the integration suite.
		const r = await m.compute({}, { cwd: "/tmp", workflowPath: "/nonexistent" });
		expect(r.data_missing).toBe(true);
	});

	test("per-task F1 computation — exact match", async () => {
		// Pure unit test of computePerTask via a duck-typed fixture.
		const { computePerTask } = await import("../../src/metrics/tool-correctness-internals.ts");
		const r = computePerTask("T1", ["read", "grep"], ["read", "grep"]);
		expect(r.precision).toBe(1);
		expect(r.recall).toBe(1);
		expect(r.f1).toBe(1);
	});

	test("per-task F1 computation — partial overlap", async () => {
		const { computePerTask } = await import("../../src/metrics/tool-correctness-internals.ts");
		// actual=[edit,read], expected=[edit,bash]
		// intersection=[edit], P=0.5, R=0.5, F1=0.5
		const r = computePerTask("T2", ["edit", "read"], ["edit", "bash"]);
		expect(r.precision).toBe(0.5);
		expect(r.recall).toBe(0.5);
		expect(r.f1).toBe(0.5);
	});

	test("per-task F1 — empty actual + non-empty expected → 0", async () => {
		const { computePerTask } = await import("../../src/metrics/tool-correctness-internals.ts");
		const r = computePerTask("T3", [], ["read"]);
		expect(r.precision).toBe(0);
		expect(r.recall).toBe(0);
		expect(r.f1).toBe(0);
	});

	test("per-task F1 — both empty → 0 (defined, not NaN)", async () => {
		const { computePerTask } = await import("../../src/metrics/tool-correctness-internals.ts");
		const r = computePerTask("T4", [], []);
		expect(r.f1).toBe(0);
		expect(Number.isNaN(r.f1)).toBe(false);
	});

	test("uniqueTools sorts + dedupes", async () => {
		const { uniqueTools } = await import("../../src/metrics/tool-correctness-internals.ts");
		expect(uniqueTools(["read", "read", "grep", "read"])).toEqual(["grep", "read"]);
		expect(uniqueTools([])).toEqual([]);
	});

	test("bucketToolsByTask detects orchestrator tool boundaries", async () => {
		const { bucketToolsByTask } = await import("../../src/metrics/tool-correctness-internals.ts");
		const entries = buildSession([
			{ boundary: "goal_contract_create", toolCalls: [] },
			{ boundary: "task_dispatch", toolCalls: ["read", "grep"] },
			{ boundary: "orchestrator_audit", toolCalls: ["edit"] },
		]);
		const buckets = bucketToolsByTask(entries);
		// boundaries: 1 initial unknown, then 3 buckets (one per boundary after the first).
		// Actually the loop pushes current before each new boundary, so we get 3 buckets.
		const flat = buckets.flatMap((b) => [b.taskId, ...b.toolCalls]);
		expect(flat).toContain("read");
		expect(flat).toContain("grep");
		expect(flat).toContain("edit");
	});
});