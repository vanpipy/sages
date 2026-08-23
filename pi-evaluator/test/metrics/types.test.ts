/**
 * test/metrics/types.test.ts
 *
 * Compile-time + runtime shape tests for the Metric interface.
 * These don't exercise computation — that lives in registry.test.ts and the
 * per-metric test files (chunks T2-T6).
 */
import { describe, expect, test } from "bun:test";
import type { Metric, MetricContext, MetricResult } from "../../src/metrics/types.ts";

describe("Metric types (compile-time shape)", () => {
	test("Metric<I> is structurally a valid object", () => {
		// A bare-bones Metric stub is enough — this test exists to prove the
		// runtime can construct a Metric-shaped value without TS errors.
		const m: Metric = {
			id: "stub",
			dim: "goal",
			kind: "heuristic",
			description: "stub",
			async compute(_input, _ctx): Promise<MetricResult> {
				return { value: 0.5, evidence: [], duration_ms: 1, data_missing: false };
			},
		};
		expect(m.id).toBe("stub");
		expect(m.dim).toBe("goal");
		expect(m.kind).toBe("heuristic");
	});

	test("MetricContext accepts the documented fields", () => {
		const ctx: MetricContext = { cwd: "/tmp", workflowPath: "/x", workflowId: "DAG-1" };
		expect(ctx.cwd).toBe("/tmp");
		expect(ctx.workflowPath).toBe("/x");
		expect(ctx.workflowId).toBe("DAG-1");
	});

	test("MetricContext is valid with only the required cwd field", () => {
		const ctx: MetricContext = { cwd: "/tmp" };
		expect(ctx.workflowPath).toBeUndefined();
	});

	test("MetricResult.data_missing defaults to false in real metrics, true when no data", () => {
		const ok: MetricResult = { value: 0.5, evidence: [], duration_ms: 0, data_missing: false };
		const miss: MetricResult = { value: 0, evidence: [], duration_ms: 0, data_missing: true };
		expect(ok.data_missing).toBe(false);
		expect(miss.data_missing).toBe(true);
	});
});
