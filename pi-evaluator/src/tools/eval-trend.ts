/**
 * pi-evaluator/src/tools/eval-trend.ts
 *
 * `eval_trend` tool — STUB in T2. Compares the active Sages workflow against
 * historical similar workflows and reports percentile + trend direction.
 *
 * STUB scope (locked for T2):
 *   - mode off → blocked (same envelope as eval_score)
 *   - cold start (no history) → INSUFFICIENT_DATA, percentiles 0
 *   - with history (≥ 1 report) → STUB: sample_size=N, trend="STABLE",
 *     trend_delta=0, percentiles all 50
 *
 * The intent always marks "STUB" so the agent can tell the real algorithm
 * hasn't landed yet.
 *
 * Real algorithm (T3):
 *   - Read `.pi/orchestrator/evals/report-*.json` (machine-readable snapshots)
 *   - Filter similar workflows by signature (scope_dirs 50% intersection +
 *     sc_count within 2x)
 *   - Compute percentile of current total + each dimension against the sample
 *   - Compute trend as UP / DOWN / STABLE vs the most-recent 5 similar
 *     workflows' mean
 *
 * Two layers (mirrors eval-score):
 *   1. `computeEvalTrend(state, historical)` — pure: state + history → output.
 *   2. `makeEvalTrendTool(state, historical)` — ToolDefinition factory.
 *
 * `@sages/pi-evaluator` is shippable at T2 with the STUB; T3 just replaces
 * the body of `computeEvalTrend`'s history branch. The locked shape does
 * NOT change in T3.
 */

import { Type } from "typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

import type { Dimension } from "../types.ts";
import { createEvalState, type EvalState } from "../state.ts";

/** Empty parameter schema — this tool takes no input. */
export const EvalTrendParams = Type.Object({});

/** Trend direction. Locked per spec. */
export type TrendDirection = "UP" | "DOWN" | "STABLE" | "INSUFFICIENT_DATA";

/** Locked output shape (GC-2026-019 spec). */
export interface EvalTrendOutput {
	status: "ok" | "blocked";
	intent: string;
	workflow_id: string | null;
	sample_size: number;
	trend: TrendDirection;
	/** Relative to mean of recent similar workflows; 0 when INSUFFICIENT_DATA. */
	trend_delta: number;
	percentile: {
		/** 0-100. */
		total: number;
		by_dimension: Record<Dimension, number>;
	};
}

/**
 * Minimum shape of a historical report snapshot. T3 will load these from
 * `.pi/orchestrator/evals/report-*.json`. Defined here so T2's stub and T3's
 * real implementation share one contract.
 */
export interface HistoricalReport {
	workflow_id: string;
	session_id: string;
	total_score: number;
	dimensions: Record<Dimension, number>;
}

/** Build all-zero percentile dimension map (used in cold start). */
function zeroPercentile(): Record<Dimension, number> {
	return { goal: 0, dag: 0, implement: 0, audit: 0, coordination: 0 };
}

/** Build the STUB 50-everywhere percentile map. */
function stubPercentile(): Record<Dimension, number> {
	return { goal: 50, dag: 50, implement: 50, audit: 50, coordination: 50 };
}

/**
 * Pure compute: given current state + historical reports, produce the locked
 * EvalTrendOutput.
 *
 * T2: stub. T3: real algorithm.
 */
export function computeEvalTrend(state: EvalState, historical: HistoricalReport[]): EvalTrendOutput {
	if (state.mode === "off") {
		return {
			status: "blocked",
			intent: "reward mode is off; set sages.rewardMode=true in ~/.pi/agent/settings.json to enable",
			workflow_id: null,
			sample_size: 0,
			trend: "INSUFFICIENT_DATA",
			trend_delta: 0,
			percentile: { total: 0, by_dimension: zeroPercentile() },
		};
	}

	const wf = state.active_workflow;
	const workflowId = wf?.workflow_id ?? null;

	if (historical.length === 0) {
		return {
			status: "ok",
			intent: `no historical similar workflows yet (active: ${workflowId ?? "none"}); T3 will fill this in`,
			workflow_id: workflowId,
			sample_size: 0,
			trend: "INSUFFICIENT_DATA",
			trend_delta: 0,
			percentile: { total: 0, by_dimension: zeroPercentile() },
		};
	}

	// STUB branch: real algorithm in T3.
	return {
		status: "ok",
		intent: `STUB: compared ${workflowId ?? "active workflow"} to ${historical.length} similar workflows; T3 will compute percentiles`,
		workflow_id: workflowId,
		sample_size: historical.length,
		trend: "STABLE",
		trend_delta: 0,
		percentile: { total: 50, by_dimension: stubPercentile() },
	};
}

/**
 * Build the pi `ToolDefinition` for `eval_trend`. Takes historical reports
 * explicitly so T2 can wire a stub feed; T3 will change the caller to load
 * from disk but the factory signature stays the same.
 *
 * The `description` follows the GC-2026-019 3-layer LLM-hint contract.
 */
export function makeEvalTrendTool(
	state: EvalState,
	historical: HistoricalReport[] = [],
): ToolDefinition<typeof EvalTrendParams> {
	const description = [
		"Compare the active Sages workflow against historical similar workflows.",
		"Call with no arguments.",
		"Returns { sample_size, trend (UP/DOWN/STABLE/INSUFFICIENT_DATA), trend_delta, percentile: { total, by_dimension } }.",
		"Use this to know if your current approach is above or below your historical baseline.",
		"INSUFFICIENT_DATA means fewer than 1 similar workflow has been recorded — keep going.",
		"Trend and percentiles are computed by the signal engine from report-*.json snapshots.",
	].join(" ");

	const stateRef = state;
	const historicalRef = historical;
	return {
		name: "eval_trend",
		label: "Eval Trend",
		description,
		parameters: EvalTrendParams,
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const data = computeEvalTrend(stateRef, historicalRef);
			return {
				content: [{ type: "text", text: JSON.stringify(data) }],
				details: data,
			};
		},
	};
}

// Re-export for callers that may import from this module directly.
export { createEvalState };
