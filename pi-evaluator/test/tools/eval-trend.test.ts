/**
 * pi-evaluator/test/tools/eval-trend.test.ts
 *
 * RED-first: tests fail before src/tools/eval-trend.ts exists, pass after.
 *
 * T2 ships eval_trend as a STUB. The real algorithm (cross-workflow
 * similarity, percentile calculation, trend direction) lands in T3
 * (signal engine). For T2 we lock:
 *
 *   1. mode off → blocked (same envelope as eval_score)
 *   2. mode on + no active workflow + no historical → INSUFFICIENT_DATA shape,
 *      sample_size=0, trend_delta=0, percentiles=0
 *   3. mode on + active workflow + no historical → INSUFFICIENT_DATA shape
 *   4. mode on + active workflow + non-empty historical → STUB: sample_size=N,
 *      trend="STABLE", trend_delta=0, percentiles all 50
 *
 * The stub returns trend=STABLE / percentiles=50 for the "has historical"
 * case so it's distinguishable from cold-start (INSUFFICIENT_DATA) but
 * still obviously not the real signal.
 *
 * Locked output shape (GC-2026-019 spec):
 *   {
 *     status: "ok" | "blocked",
 *     intent: string,
 *     workflow_id: string | null,
 *     sample_size: number,
 *     trend: "UP" | "DOWN" | "STABLE" | "INSUFFICIENT_DATA",
 *     trend_delta: number,
 *     percentile: { total: number, by_dimension: Record<Dimension, number> }
 *   }
 */

import { describe, expect, test } from "bun:test";

import {
	computeEvalTrend,
	makeEvalTrendTool,
	type HistoricalReport,
} from "../../src/tools/eval-trend.ts";
import { createEvalState, type WorkflowScoreState } from "../../src/state.ts";
import type { Dimension } from "../../src/types.ts";

function activeWorkflowFixture(): WorkflowScoreState {
	return {
		workflow_id: "GC-2026-018",
		started_at: "2026-07-25T10:00:00Z",
		total_score: 72,
		dimensions: {
			goal: { score: 95, evidence: [] },
			dag: { score: 60, evidence: [] },
			implement: { score: 0, evidence: [] },
			audit: { score: 0, evidence: [] },
			coordination: { score: 50, evidence: [] },
		},
		signature: { sc_count: 4, task_count: 2, scope_dirs: ["src"], planes: ["core"] },
	};
}

function historicalFixture(count: number): HistoricalReport[] {
	const out: HistoricalReport[] = [];
	for (let i = 0; i < count; i++) {
		out.push({
			workflow_id: `GC-2026-0${10 + i}`,
			session_id: `sess-${i}`,
			total_score: 60 + (i * 3) % 40,
			dimensions: {
				goal: 75,
				dag: 65,
				implement: 55,
				audit: 70,
				coordination: 60,
			},
		});
	}
	return out;
}

describe("computeEvalTrend", () => {
	test("returns blocked shape when mode is off", () => {
		const state = createEvalState();
		const out = computeEvalTrend(state, []);
		expect(out.status).toBe("blocked");
		expect(out.intent).toContain("reward mode");
	});

	test("cold start (mode on, no workflow, no history) → INSUFFICIENT_DATA", () => {
		const state = createEvalState();
		state.mode = "on";
		const out = computeEvalTrend(state, []);
		expect(out.status).toBe("ok");
		expect(out.workflow_id).toBeNull();
		expect(out.sample_size).toBe(0);
		expect(out.trend).toBe("INSUFFICIENT_DATA");
		expect(out.trend_delta).toBe(0);
		expect(out.percentile.total).toBe(0);
	});

	test("cold start (mode on, active workflow, no history) → INSUFFICIENT_DATA", () => {
		const state = createEvalState();
		state.mode = "on";
		state.active_workflow = activeWorkflowFixture();
		const out = computeEvalTrend(state, []);
		expect(out.status).toBe("ok");
		expect(out.workflow_id).toBe("GC-2026-018");
		expect(out.sample_size).toBe(0);
		expect(out.trend).toBe("INSUFFICIENT_DATA");
		expect(out.trend_delta).toBe(0);
	});

	test("with historical reports → STUB returns sample_size=N, trend=STABLE, percentile=50", () => {
		const state = createEvalState();
		state.mode = "on";
		state.active_workflow = activeWorkflowFixture();
		const out = computeEvalTrend(state, historicalFixture(7));
		expect(out.sample_size).toBe(7);
		expect(out.trend).toBe("STABLE");
		expect(out.trend_delta).toBe(0);
		expect(out.percentile.total).toBe(50);
	});

	test("all five percentile dimensions get a value", () => {
		const state = createEvalState();
		state.mode = "on";
		state.active_workflow = activeWorkflowFixture();
		const out = computeEvalTrend(state, historicalFixture(5));
		const dims: Dimension[] = ["goal", "dag", "implement", "audit", "coordination"];
		for (const d of dims) {
			expect(typeof out.percentile.by_dimension[d]).toBe("number");
		}
		expect(Object.keys(out.percentile.by_dimension).sort()).toEqual(
			["audit", "coordination", "dag", "goal", "implement"],
		);
	});

	test("intent non-empty and references sample size when historical exists", () => {
		const state = createEvalState();
		state.mode = "on";
		state.active_workflow = activeWorkflowFixture();
		const out = computeEvalTrend(state, historicalFixture(3));
		expect(out.intent.length).toBeGreaterThan(0);
		expect(out.intent).toContain("3");
	});

	test("intent says STUB to make algorithm-status visible to caller", () => {
		const state = createEvalState();
		state.mode = "on";
		state.active_workflow = activeWorkflowFixture();
		const out = computeEvalTrend(state, historicalFixture(3));
		// Mark this as a stub so the agent doesn't read STABLE as truth.
		expect(out.intent.toLowerCase()).toContain("stub");
	});
});

describe("makeEvalTrendTool", () => {
	test("returned tool definition has canonical shape", () => {
		const tool = makeEvalTrendTool(createEvalState());
		expect(tool.name).toBe("eval_trend");
		expect(typeof tool.label).toBe("string");
		expect(tool.label.length).toBeGreaterThan(0);
		expect(typeof tool.description).toBe("string");
		expect(tool.description.length).toBeGreaterThanOrEqual(100);
	});

	test("execute() wraps computeEvalTrend in { content, details } envelope", async () => {
		const state = createEvalState();
		state.mode = "on";
		state.active_workflow = activeWorkflowFixture();
		const tool = makeEvalTrendTool(state, historicalFixture(4));
		const result = await tool.execute("call-id", {} as never, undefined, undefined, {} as never);
		expect(result.content).toHaveLength(1);
		const first = result.content[0]!;
		expect(first.type).toBe("text");
		const text = (first as { type: "text"; text: string }).text;
		const parsed = JSON.parse(text);
		expect(parsed.status).toBe("ok");
		expect(parsed.sample_size).toBe(4);
		expect(parsed.trend).toBe("STABLE");
	});
});
