/**
 * test/metrics/tool-adoption.test.ts
 *
 * ToolAdoption heuristic — measures fraction of tool calls that reach for
 * specialized families (aft_* / codebase_memory_* / ctx_*) instead of
 * defaulting to baseline (bash / read / edit / write / grep / find / ls).
 * Score range [0, 1]; higher = better adoption.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolAdoption, classifyToolFamily } from "../../src/metrics/tool-adoption.ts";
import type { MetricContext } from "../../src/metrics/types.ts";

let tmp: string;
const ctx: MetricContext = { cwd: "/tmp" };

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-eval-adopt-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function writeAndRun(
	entries: object[],
): Promise<{
	value: number;
	data_missing: boolean;
	evidence: { location: string; note: string }[];
}> {
	const wfDir = join(tmp, "wf");
	mkdirSync(wfDir, { recursive: true });
	writeFileSync(join(wfDir, "session.jsonl"), makeSession(entries), "utf8");
	const m = new ToolAdoption();
	return m.compute(undefined, { ...ctx, workflowPath: wfDir });
}

function makeSession(entries: object[]): string {
	return entries.map((e) => JSON.stringify(e)).join("\n");
}

function tc(name: string, args: Record<string, unknown> = {}): object {
	return { type: "toolCall", name, arguments: args };
}

describe("classifyToolFamily", () => {
	test("aft_* → aft", () => {
		expect(classifyToolFamily("aft_search")).toBe("aft");
		expect(classifyToolFamily("aft_outline")).toBe("aft");
		expect(classifyToolFamily("aft_zoom")).toBe("aft");
	});
	test("codebase_memory_* → codebase", () => {
		expect(classifyToolFamily("codebase_memory_search_graph")).toBe("codebase");
		expect(classifyToolFamily("codebase_memory_list_projects")).toBe("codebase");
	});
	test("ctx_* → ctx", () => {
		expect(classifyToolFamily("ctx_search")).toBe("ctx");
		expect(classifyToolFamily("ctx_memory")).toBe("ctx");
	});
	test("subagent_* / Agent / get_subagent_result / steer_subagent → subagent_control", () => {
		expect(classifyToolFamily("Agent")).toBe("subagent_control");
		expect(classifyToolFamily("get_subagent_result")).toBe("subagent_control");
		expect(classifyToolFamily("steer_subagent")).toBe("subagent_control");
		expect(classifyToolFamily("subagent_status")).toBe("subagent_control");
		expect(classifyToolFamily("subagent_abort")).toBe("subagent_control");
	});
	test("orchestrator own tools → orchestrator", () => {
		expect(classifyToolFamily("goal_contract_create")).toBe("orchestrator");
		expect(classifyToolFamily("dag_synthesize")).toBe("orchestrator");
		expect(classifyToolFamily("task_dispatch")).toBe("orchestrator");
		expect(classifyToolFamily("orchestrator_audit")).toBe("orchestrator");
		expect(classifyToolFamily("sages_reminder")).toBe("orchestrator");
	});
	test("baseline tools → baseline", () => {
		expect(classifyToolFamily("bash")).toBe("baseline");
		expect(classifyToolFamily("read")).toBe("baseline");
		expect(classifyToolFamily("edit")).toBe("baseline");
		expect(classifyToolFamily("write")).toBe("baseline");
		expect(classifyToolFamily("grep")).toBe("baseline");
		expect(classifyToolFamily("find")).toBe("baseline");
		expect(classifyToolFamily("ls")).toBe("baseline");
	});
	test("unrecognized → other", () => {
		expect(classifyToolFamily("custom_tool")).toBe("other");
		expect(classifyToolFamily("todo_write")).toBe("other");
	});
});

describe("ToolAdoption", () => {
	test("no workflowPath → data_missing", async () => {
		const m = new ToolAdoption();
		const r = await m.compute(undefined, ctx);
		expect(r.data_missing).toBe(true);
		expect(r.value).toBe(0);
	});

	test("empty session.jsonl → data_missing", async () => {
		const r = await writeAndRun([]);
		expect(r.data_missing).toBe(true);
		expect(r.value).toBe(0);
	});

	test("session with no toolCall blocks → data_missing", async () => {
		const r = await writeAndRun([
			{ type: "message", timestamp: "2026-08-22T10:00:00Z", message: { role: "assistant", content: [{ type: "text", content: "no tools" }] } },
			{ type: "message", timestamp: "2026-08-22T10:00:01Z", message: { role: "user", content: [{ type: "text", content: "ok" }] } },
		]);
		expect(r.data_missing).toBe(true);
	});

	test("all baseline tools → adoption 0", async () => {
		const r = await writeAndRun([
			{ type: "message", timestamp: "2026-08-22T10:00:00Z", message: { role: "assistant", content: [
				tc("bash"), tc("read"), tc("edit"), tc("write"), tc("grep"), tc("find"), tc("ls"),
			] } },
		]);
		expect(r.data_missing).toBe(false);
		expect(r.value).toBe(0);
	});

	test("all specialized (aft + codebase + ctx) → adoption 1", async () => {
		const r = await writeAndRun([
			{ type: "message", timestamp: "2026-08-22T10:00:00Z", message: { role: "assistant", content: [
				tc("aft_search"), tc("aft_outline"),
				tc("codebase_memory_search_graph"),
				tc("ctx_search"), tc("ctx_memory"),
			] } },
		]);
		expect(r.data_missing).toBe(false);
		expect(r.value).toBe(1);
	});

	test("mixed scenario matches the post-GC-087 driver (5 baseline + 2 aft + 1 codebase + 1 ctx + 1 orch)", async () => {
		const r = await writeAndRun([
			{ type: "message", timestamp: "2026-08-22T10:00:00Z", message: { role: "assistant", content: [
				tc("bash"), tc("read"), tc("edit"), tc("write"), tc("grep"),      // 5 baseline
				tc("aft_search"), tc("aft_outline"),                              // 2 aft
				tc("codebase_memory_search_graph"),                                // 1 codebase
				tc("ctx_search"),                                                  // 1 ctx
				tc("goal_contract_create"),                                         // 1 orchestrator
			] } },
		]);
		expect(r.data_missing).toBe(false);
		// specialized = 2 + 1 + 1 = 4; recognized = 10; adoption = 0.4
		expect(r.value).toBeCloseTo(0.4, 5);
	});

	test("'other' tools are excluded from the denominator", async () => {
		const r = await writeAndRun([
			{ type: "message", timestamp: "2026-08-22T10:00:00Z", message: { role: "assistant", content: [
				tc("custom_unknown_tool"), tc("custom_unknown_tool"),
				tc("aft_search"),
			] } },
		]);
		expect(r.data_missing).toBe(false);
		// recognized = 3 - 2 = 1; specialized = 1; adoption = 1.0 (the one
		// recognized call is specialized, so adoption should be 100%)
		expect(r.value).toBe(1);
	});

	test("all 'other' (unrecognized) → data_missing so the engine doesn't penalize", async () => {
		const r = await writeAndRun([
			{ type: "message", timestamp: "2026-08-22T10:00:00Z", message: { role: "assistant", content: [
				tc("custom_unknown"), tc("vendor_tool"), tc("another_custom"),
			] } },
		]);
		expect(r.data_missing).toBe(true);
		expect(r.value).toBe(0);
	});

	test("evidence includes headline + per-family breakdown", async () => {
		const r = await writeAndRun([
			{ type: "message", timestamp: "2026-08-22T10:00:00Z", message: { role: "assistant", content: [
				tc("bash"), tc("read"),
				tc("aft_search"), tc("aft_search"),
				tc("codebase_memory_search_graph"),
				tc("ctx_search"),
			] } },
		]);
		expect(r.data_missing).toBe(false);
		// Headline row should be first.
		expect(r.evidence[0]?.note).toMatch(/adoption rate 66\.7%/);
		// Per-family rows: baseline (2), aft (2), codebase (1), ctx (1).
		const byFamily = Object.fromEntries(r.evidence.map((e) => [e.location, e.note]));
		expect(byFamily["aft"]).toMatch(/2 calls/);
		expect(byFamily["codebase"]).toMatch(/1 calls/);
		expect(byFamily["ctx"]).toMatch(/1 calls/);
		expect(byFamily["baseline"]).toMatch(/2 calls/);
		// 6 recognized total (no 'other'); specialized = 4; adoption = 4/6 = 0.6667
		expect(r.value).toBeCloseTo(0.6667, 3);
	});

	test("session.jsonl read failure → data_missing with note", async () => {
		const wfDir = join(tmp, "wf");
		mkdirSync(wfDir, { recursive: true });
		// No session.jsonl — readSession throws.
		const m = new ToolAdoption();
		const r = await m.compute(undefined, { ...ctx, workflowPath: wfDir });
		expect(r.data_missing).toBe(true);
		expect(r.evidence.some((e) => /failed to read/.test(e.note))).toBe(true);
	});
});

describe("ToolAdoption registration", () => {
	test("ToolAdoption is registered in the builtin registry", async () => {
		const { registerBuiltinMetrics, listMetricIds } = await import("../../src/metrics/registry.ts");
		const { clearMetrics } = await import("../../src/metrics/registry.ts");
		clearMetrics();
		registerBuiltinMetrics();
		const ids = listMetricIds();
		clearMetrics();
		expect(ids).toContain("tool_adoption");
	});
});
