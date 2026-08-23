/**
 * pi-evaluator/test/integration/heuristic-benchmark.test.ts
 *
 * Heuristic path timing assertion. The 5 heuristic + hybrid metrics (no LLM)
 * must produce 5 dim scores in <500ms on the scoring-1 fixture (3 tasks,
 * 1 audit, 3 task reports, 18-line session.jsonl). The benchmark uses
 * `heuristicOnlyCoefficients()` to disable LLM-only metrics and prevent the
 * API-key throw path from polluting the timing.
 *
 * 500ms ceiling is intentionally generous — the actual heuristic path runs
 * well under 50ms on commodity hardware. CI variance is the main reason for
 * the 10× margin.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { scoreWorkflow } from "../../src/engine/scoring-engine.ts";
import type { CoefficientsConfig } from "../../src/engine/coefficients-schema.ts";
import { registerBuiltinMetrics } from "../../src/metrics/registry.ts";
import { setJudgeFn } from "../../src/metrics/llm-judge/seam.ts";

const FIXTURE_PATH = resolve(
	import.meta.dir,
	"../../fixtures/workflow-scoring-1/.pi/orchestrator",
);

function heuristicOnlyCoefficients(): CoefficientsConfig {
	return {
		version: "0.3.0",
		global: {
			dimension_weights: {
				goal: 0.2,
				dag: 0.2,
				implement: 0.2,
				audit: 0.2,
				coordination: 0.2,
			},
			thresholds: { pass: 80, pass_with_gaps: 50 },
		},
		dimensions: {
			goal: {
				signals: {
					goal_accuracy_heuristic: {
						weight: 1.0,
						norm: "ratio_0_1",
						direction: "higher_better",
					},
				},
			},
			dag: {
				signals: {
					plan_adherence: {
						weight: 1.0,
						norm: "ratio_0_1",
						direction: "higher_better",
					},
				},
			},
			implement: {
				signals: {
					argument_correctness: {
						weight: 1.0,
						norm: "ratio_0_1",
						direction: "lower_better",
					},
				},
			},
			audit: {
				signals: {
					goal_accuracy: {
						weight: 1.0,
						norm: "ratio_0_1",
						direction: "higher_better",
					},
				},
			},
			coordination: {
				signals: {
					step_efficiency: {
						weight: 1.0,
						norm: "ratio_0_1",
						direction: "higher_better",
					},
				},
			},
		},
	};
}

beforeAll(() => {
	setJudgeFn(null);
	registerBuiltinMetrics();
});

describe("scoring-pipeline heuristic benchmark", () => {
	test("scoreWorkflow on scoring-1 fixture completes in <500ms", async () => {
		const coefs = heuristicOnlyCoefficients();
		// Warm-up pass to amortize module-load cost.
		await scoreWorkflow(FIXTURE_PATH, coefs, FIXTURE_PATH);

		const start = performance.now();
		const scores = await scoreWorkflow(FIXTURE_PATH, coefs, FIXTURE_PATH);
		const elapsed = performance.now() - start;

		expect(scores.goal).toBeDefined();
		expect(scores.dag).toBeDefined();
		expect(scores.implement).toBeDefined();
		expect(scores.audit).toBeDefined();
		expect(scores.coordination).toBeDefined();
		expect(elapsed).toBeLessThan(500);
	});

	test("20 consecutive scoreWorkflow runs average <500ms each", async () => {
		const coefs = heuristicOnlyCoefficients();
		// Warm-up
		await scoreWorkflow(FIXTURE_PATH, coefs, FIXTURE_PATH);

		const N = 20;
		const samples: number[] = [];
		for (let i = 0; i < N; i += 1) {
			const start = performance.now();
			await scoreWorkflow(FIXTURE_PATH, coefs, FIXTURE_PATH);
			samples.push(performance.now() - start);
		}
		const avg = samples.reduce((s, x) => s + x, 0) / N;
		const max = Math.max(...samples);
		expect(avg).toBeLessThan(500);
		// Soft warn on per-run max — useful diagnostic for CI flake hunts.
		// (Not an assertion failure — comment with the max for the test log.)
		console.log(
			`[benchmark] 20 runs: avg=${avg.toFixed(1)}ms max=${max.toFixed(1)}ms samples=${samples.map((x) => x.toFixed(0)).join(",")}ms`,
		);
	});
});
