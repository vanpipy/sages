/**
 * pi-evaluator/src/engine/scoring-engine.ts
 *
 * Per-dim signal aggregator. `scoreWorkflow(workflowPath, coefficients, cwd)`
 * iterates the 5 canonical dimensions, computes each signal via the runner,
 * applies `norm` + `direction`, and weighted-sums into a 0-100 dim score.
 *
 * `data_missing: true` signals are excluded from the weighted sum — the
 * dim's score reflects only what the metric layer could actually measure.
 * The 0-100 dim score is `Math.round((weightedSum / weightTotal) * 100)`
 * where `weightTotal` sums only the participating (non-data_missing) signal
 * weights, so a dim with all 4 signals data_missing returns score=0 with
 * `weightTotal === 0`.
 *
 * Norms / directions are kept as a small lookup table — the supported set
 * matches the `Norm` union in `coefficients-schema.ts`. Adding a new norm
 * means: extend the table + extend the union (TypeBox will catch type drift).
 */
import type { Dimension } from "../types.ts";
import type { DimensionScore, EvidenceRef } from "../state.ts";
import type { CoefficientsConfig, SignalConfig } from "./coefficients-schema.ts";
import { DIMENSIONS } from "./coefficients-schema.ts";
import { computeSignalValue, type SignalValue } from "../signals/metric-runner.ts";
import type { MetricContext } from "../metrics/types.ts";

type NormFn = (raw: number) => number;
const NORM_TABLE: Record<string, NormFn> = {
	identity: (r) => r,
	ratio_0_1: (r) => Math.max(0, Math.min(1, r)),
	count: (r) => r,
	log_count: (r) => Math.log(1 + r) / Math.log(11),
	boolean: (r) => (r >= 0.5 ? 1 : 0),
	invert_count: (r) => 1 - Math.max(0, Math.min(1, r)),
	invert_log_count: (r) => 1 - Math.log(1 + r) / Math.log(11),
	signed_pct: (r) => (r + 1) / 2,
};

const DIRECTION_TABLE: Record<string, (v: number) => number> = {
	higher_better: (v) => v,
	lower_better: (v) => 1 - v,
};

function applyNorm(raw: number, norm: string, direction: string): number {
	const n = NORM_TABLE[norm] ?? ((r: number) => r);
	const d = DIRECTION_TABLE[direction] ?? ((v: number) => v);
	return d(n(raw));
}

function emptyDimensions(): Record<Dimension, DimensionScore> {
	return {
		goal: { score: 0, evidence: [] },
		dag: { score: 0, evidence: [] },
		implement: { score: 0, evidence: [] },
		audit: { score: 0, evidence: [] },
		coordination: { score: 0, evidence: [] },
	};
}

/**
 * Compute a per-dim 0-100 score for one dimension from its declared signals.
 * Exposed for unit testing — production callers should use `scoreWorkflow`.
 */
export async function scoreDimension(
	signals: Record<string, SignalConfig>,
	ctx: MetricContext,
): Promise<DimensionScore> {
	let weightedSum = 0;
	let weightTotal = 0;
	const allRefs: EvidenceRef[] = [];
	for (const [name, cfg] of Object.entries(signals)) {
		const r: SignalValue = await computeSignalValue(name, cfg, ctx);
		if (r.data_missing) continue;
		const normed = applyNorm(r.value, cfg.norm, cfg.direction);
		weightedSum += normed * cfg.weight;
		weightTotal += cfg.weight;
		allRefs.push(...r.evidence);
	}
	return {
		score: weightTotal === 0 ? 0 : Math.round((weightedSum / weightTotal) * 100),
		evidence: allRefs,
	};
}

/**
 * Score all 5 dimensions for a workflow.
 * Returns a 5-key record; each value is `{ score: 0-100, evidence: EvidenceRef[] }`.
 */
export async function scoreWorkflow(
	workflowPath: string,
	coefficients: CoefficientsConfig,
	cwd: string,
): Promise<Record<Dimension, DimensionScore>> {
	const ctx: MetricContext = { cwd, workflowPath };
	const out = emptyDimensions();
	for (const dim of DIMENSIONS) {
		out[dim] = await scoreDimension(coefficients.dimensions[dim].signals, ctx);
	}
	return out;
}

/**
 * Global total score: weighted sum of per-dim scores using
 * `coefficients.global.dimension_weights`. Returns 0 when all dims are 0
 * (the conventional "no data yet" signal).
 */
export function globalScore(
	dims: Record<Dimension, DimensionScore>,
	coefficients: CoefficientsConfig,
): number {
	const w = coefficients.global.dimension_weights;
	const totalWeight = w.goal + w.dag + w.implement + w.audit + w.coordination;
	if (totalWeight === 0) return 0;
	const weighted =
		dims.goal.score * w.goal +
		dims.dag.score * w.dag +
		dims.implement.score * w.implement +
		dims.audit.score * w.audit +
		dims.coordination.score * w.coordination;
	return Math.round(weighted / totalWeight);
}
