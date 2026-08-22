/**
 * pi-evaluator/src/metrics/llm-judge/seam.ts
 *
 * LLM-judge seam for hybrid metrics (Goal Accuracy, Task Completion).
 *
 * T3 ships the seam only — the actual `complete()` call to
 * `@mariozechner/pi-ai` lands in T4. Today `judge()` returns a
 * `data_missing: true` result so the calling metric falls back to its
 * heuristic branch without throwing.
 *
 * Test surface: `setJudgeFn(fn)` overrides the default no-op for tests
 * (mirroring the metric-registry seam). Production code never calls
 * `setJudgeFn` directly.
 */
import type { MetricResult } from "../types.ts";

export interface JudgeInput {
	/** What we're judging — typically SC content, report text, or audit findings. */
	evidence: string;
	/** Human-readable criteria string ("Does the task report indicate the SC is met?"). */
	criteria: string;
	/** Optional provider + modelId override; T4 will use this when picking the Model. */
	provider?: string;
	modelId?: string;
}

export interface JudgeFnResult {
	/** 0-1 confidence the evidence satisfies the criteria. */
	score: number;
	/** 1-3 sentence rationale. */
	rationale: string;
	input_tokens?: number;
	output_tokens?: number;
}

export type JudgeFn = (input: JudgeInput) => Promise<JudgeFnResult>;

const NO_OP_JUDGE: JudgeFn = async (_input) => {
	throw new Error("no judge registered (T4 will install one)");
};

let _judgeFn: JudgeFn = NO_OP_JUDGE;

export function setJudgeFn(fn: JudgeFn | null): void {
	_judgeFn = fn ?? NO_OP_JUDGE;
}

export function getJudgeFn(): JudgeFn {
	return _judgeFn;
}

/**
 * Default judge entry point. Calls the registered `judgeFn`. Returns a
 * `MetricResult` so hybrid metrics can wrap the judge output directly
 * (data_missing on judge failure, value + evidence on success).
 */
export async function judge(input: JudgeInput): Promise<MetricResult> {
	const t0 = performance.now();
	try {
		const fn = getJudgeFn();
		const result = await fn(input);
		const score = Math.max(0, Math.min(1, result.score));
		return {
			value: score,
			evidence: [
				{
					artifact: "llm-judge",
					location: input.criteria.slice(0, 80),
					note: result.rationale,
				},
			],
			duration_ms: performance.now() - t0,
			data_missing: false,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			value: 0,
			evidence: [
				{
					artifact: "llm-judge",
					location: input.criteria.slice(0, 80),
					note: `judge failed: ${message}`,
				},
			],
			duration_ms: performance.now() - t0,
			data_missing: true, // signals "fall back to heuristic" without crashing
		};
	}
}
