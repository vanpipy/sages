/**
 * pi-evaluator/test/integration/tool-correctness-pipeline.test.ts
 *
 * End-to-end test for the ToolCorrectness metric (GC-2026-066 T3).
 * Reads fixtures/workflow-tool-correctness/.pi/orchestrator/ and runs
 * scoreWorkflow with a coefficient override that enables
 * tool_correctness at weight:1.
 *
 * Expected F1 values:
 *   - goal_contract_create window: actual=[read, grep], expected=[read, grep]
 *     intersection=[read, grep], P=1, R=1, F1=1.0
 *   - dag_synthesize window: actual=[edit, read], expected=[edit, bash]
 *     intersection=[edit], P=0.5, R=0.5, F1=0.5
 *   - task_dispatch window: actual=[], expected=[read]
 *     P=0, R=0, F1=0 (special case for empty actual)
 *
 * Average F1 across 3 tasks = (1.0 + 0.5 + 0) / 3 ≈ 0.5
 * After norm=ratio_0_1 + direction=higher_better: 0.5
 * Score = 50.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { scoreWorkflow, globalScore } from "../../src/engine/scoring-engine.ts";
import type { CoefficientsConfig } from "../../src/engine/coefficients-schema.ts";
import { registerBuiltinMetrics } from "../../src/metrics/registry.ts";
import { setJudgeFn } from "../../src/metrics/llm-judge/seam.ts";

const FIXTURE_PATH = resolve(
	import.meta.dir,
	"../../fixtures/workflow-tool-correctness/.pi/orchestrator",
);

function toolCorrectnessOnlyCoefficients(): CoefficientsConfig {
	return {
		version: "0.4.0",
		global: {
			dimension_weights: {
				goal: 0,
				dag: 0,
				implement: 1,
				audit: 0,
				coordination: 0,
			},
			thresholds: { pass: 80, pass_with_gaps: 50 },
		},
		dimensions: {
			goal: { signals: {} },
			dag: { signals: {} },
			implement: {
				signals: {
					tool_correctness: {
						weight: 1,
						norm: "ratio_0_1",
						direction: "higher_better",
					},
				},
			},
			audit: { signals: {} },
			coordination: { signals: {} },
		},
	};
}

beforeAll(() => {
	setJudgeFn(null);
	registerBuiltinMetrics();
});

describe("tool-correctness pipeline (end-to-end)", () => {
	test("scoreWorkflow runs without errors against the fixture", async () => {
		const coefs = toolCorrectnessOnlyCoefficients();
		const scores = await scoreWorkflow(FIXTURE_PATH, coefs, FIXTURE_PATH);
		expect(scores.implement).toBeDefined();
	});

	test("tool_correctness scores ~50 (1.0 + 0.5 + 0)/3 avg F1", async () => {
		const coefs = toolCorrectnessOnlyCoefficients();
		const scores = await scoreWorkflow(FIXTURE_PATH, coefs, FIXTURE_PATH);
		// Score = round(0.5 * 100) = 50; allow ±5 tolerance for rounding
		// + window-detection edge cases (the initial "(unknown)" window
		// before the first boundary tool call is dropped).
		expect(scores.implement.score).toBeGreaterThanOrEqual(45);
		expect(scores.implement.score).toBeLessThanOrEqual(55);
	});

	test("evidence surfaces per-task F1 + P + R", async () => {
		const coefs = toolCorrectnessOnlyCoefficients();
		const scores = await scoreWorkflow(FIXTURE_PATH, coefs, FIXTURE_PATH);
		const locations = scores.implement.evidence.map((e) => e.location);
		const notes = scores.implement.evidence.map((e) => e.note);
		// 3 tasks contributed.
		expect(notes.length).toBeGreaterThanOrEqual(3);
		expect(locations.some((l) => l.includes("goal_contract_create"))).toBe(true);
		expect(locations.some((l) => l.includes("dag_synthesize"))).toBe(true);
		expect(locations.some((l) => l.includes("task_dispatch"))).toBe(true);
		expect(notes.some((n) => n.startsWith("F1="))).toBe(true);
	});

	test("globalScore aggregates per-dim scores with dimension_weights", async () => {
		const coefs = toolCorrectnessOnlyCoefficients();
		const scores = await scoreWorkflow(FIXTURE_PATH, coefs, FIXTURE_PATH);
		const total = globalScore(scores, coefs);
		// Only implement dim contributes at weight:1; others at weight:0.
		expect(total).toBe(scores.implement.score);
	});
});