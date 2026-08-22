/**
 * pi-evaluator/src/metrics/types.ts
 *
 * Metric layer for the Sages workflow self-evaluation. The Metric interface
 * decouples the scoring engine (which aggregates per-dim signals) from the
 * concrete measurement code (heuristic / programmatic / LLM-judge).
 *
 * `registerBuiltinMetrics()` is called from `src/extension.ts` on
 * session_start. After registration, every signal name in a `CoefficientsConfig`
 * looks up its Metric via `getMetric(name)`. Unknown signals produce
 * `data_missing: true` in the runner — the dim score falls back to "not yet
 * observed" semantics, never throwing.
 *
 * `MetricContext` carries whatever the metric needs to know about the run
 * environment. The scoring engine fills in `cwd` + `workflowPath`; metrics
 * that need to read session.jsonl / orchestrator artifacts can use those
 * paths directly.
 */
import type { Dimension } from "../types.ts";
import type { EvidenceRef } from "../state.ts";

/** Free-form input the metric's `compute` accepts. Per-metric types narrow this. */
export interface MetricContext {
	/** Process working directory. */
	cwd: string;
	/** Path to the workflow dir (e.g. `.pi/orchestrator/`). Optional — metrics may run before any workflow is active. */
	workflowPath?: string;
	/** Workflow id (e.g. "DAG-2026-XXX"). Optional. */
	workflowId?: string;
}

export type MetricKind = "heuristic" | "programmatic" | "llm_judge";

/**
 * Per-metric result. The scoring engine treats `value` as the raw input to
 * `norm` + `direction`; `evidence` is forwarded into the per-dim `DimensionScore`.
 *
 * `data_missing` propagates "no signal yet" semantics — the engine excludes
 * the signal from the weighted sum but doesn't deduct points.
 */
export interface MetricResult {
	/** Raw [0, 1] BEFORE `norm` and `direction` are applied. */
	value: number;
	evidence: EvidenceRef[];
	duration_ms: number;
	/** When true, the engine skips this signal (no data — "not yet observed"). */
	data_missing: boolean;
}

export interface Metric<I = unknown> {
	/** Signal name = Metric id. The coefficient file's signal key maps 1:1. */
	readonly id: string;
	readonly dim: Dimension;
	readonly kind: MetricKind;
	/** Human-readable description for docs / debug output. */
	readonly description: string;
	compute(input: I, ctx: MetricContext): Promise<MetricResult>;
}
