/**
 * test/metrics/step-efficiency.test.ts
 *
 * Unit tests for the Step Efficiency metric. The metric counts tool calls
 * per "task window" (segments between orchestrator tool invocations) in
 * session.jsonl, then averages the budget-saturation across all windows.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StepEfficiency } from "../../src/metrics/step-efficiency.ts";
import type { MetricContext } from "../../src/metrics/types.ts";

let tmp: string;
const ctx: MetricContext = { cwd: "/tmp" };

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-eval-step-eff-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

async function writeSessionAndRun(
	jsonl: string,
	budget?: number,
): Promise<number> {
	const wfDir = join(tmp, "wf");
	mkdirSync(wfDir, { recursive: true });
	const f = join(wfDir, "session.jsonl");
	writeFileSync(f, jsonl, "utf8");
	const m = new StepEfficiency();
	const r = await m.compute({ budgetPerTask: budget }, { ...ctx, workflowPath: wfDir });
	if (r.data_missing) throw new Error("unexpected data_missing");
	return r.value;
}

describe("StepEfficiency", () => {
	test("no workflowPath → data_missing", async () => {
		const m = new StepEfficiency();
		const r = await m.compute({}, ctx);
		expect(r.data_missing).toBe(true);
	});

	test("empty session.jsonl → no tasks → score 0 with data_missing", async () => {
		const wfDir = join(tmp, "wf");
		mkdirSync(wfDir, { recursive: true });
		writeFileSync(join(wfDir, "session.jsonl"), "");
		const m = new StepEfficiency();
		const r = await m.compute({}, { ...ctx, workflowPath: wfDir });
		expect(r.data_missing).toBe(true);
		expect(r.value).toBe(0);
	});

	test("single task under budget → score (dag_synthesize starts window; 2 work tool calls in window)", async () => {
		// dag_synthesize is an orchestrator tool that STARTS the task window
		// without counting itself. The 2 follow-up toolCalls (read, bash) are
		// in the window. budget=30 → 2/30 ≈ 0.0667.
		const session = JSON.stringify({
			type: "message",
			timestamp: "2026-08-22T10:00:00Z",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", name: "dag_synthesize", arguments: {} },
					{ type: "toolCall", name: "read", arguments: {} },
					{ type: "toolCall", name: "bash", arguments: {} },
					{ type: "toolResult", name: "bash", content: [] },
				],
			},
		});
		const v = await writeSessionAndRun(session, 30);
		expect(v).toBeCloseTo(2 / 30, 5);
	});

	test("single task over budget → score 1", async () => {
		// 50 tool calls in one task window, budget 30.
		const calls = Array.from({ length: 50 }, (_, i) =>
			JSON.stringify({
				type: "message",
				timestamp: `2026-08-22T10:00:${String(i).padStart(2, "0")}Z`,
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "read", arguments: {} }],
				},
			}),
		).join("\n");
		const v = await writeSessionAndRun(calls, 30);
		expect(v).toBeCloseTo(1, 5);
	});

	test("two task windows, average saturation", async () => {
		// Window 1: 10 tool calls (budget 30 → 0.33)
		// Window 2: 30 tool calls (budget 30 → 1.0)
		// Average: (0.33 + 1.0) / 2 = 0.667
		const part1 = Array.from({ length: 10 }, (_, i) =>
			JSON.stringify({
				type: "message",
				timestamp: `2026-08-22T10:00:${String(i).padStart(2, "0")}Z`,
				message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }] },
			}),
		).join("\n");
		const orchestrator = JSON.stringify({
			type: "message",
			timestamp: "2026-08-22T10:00:30Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", name: "task_dispatch", arguments: {} }],
			},
		});
		const part2 = Array.from({ length: 30 }, (_, i) =>
			JSON.stringify({
				type: "message",
				timestamp: `2026-08-22T10:01:${String(i).padStart(2, "0")}Z`,
				message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }] },
			}),
		).join("\n");
		const jsonl = [part1, orchestrator, part2].join("\n");
		const v = await writeSessionAndRun(jsonl, 30);
		expect(v).toBeCloseTo((1 / 3 + 1.0) / 2, 1);
	});
});
