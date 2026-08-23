/**
 * pi-evaluator/src/signals/metric-runner.ts
 *
 * Bridges the coefficient-config world (signal names declared in
 * `CoefficientsConfig.dimensions.<dim>.signals.<name>`) to the metric world
 * (`Metric` instances registered at startup).
 *
 * `computeSignalValue(name, cfg, ctx)` is called once per signal per
 * `scoreWorkflow` invocation. It looks up the registered Metric by name,
 * runs it, and translates the result. Unknown signal names produce
 * `data_missing: true` — the engine excludes them from the weighted sum.
 *
 * The `with` field on `SignalConfig` is the opt-in gate for per-signal
 * input (e.g. `with: { budgetPerTask: 30 }` for Step Efficiency, or
 * `with: { from: 'llm', criteria: '...' }` for hybrid metrics).
 */
import { getMetric } from "../metrics/registry.ts";
import type { MetricContext, MetricResult } from "../metrics/types.ts";
import type { SignalConfig } from "../engine/coefficients-schema.ts";
import type { EvidenceRef } from "../state.ts";

export interface SignalValue {
	value: number;
	evidence: EvidenceRef[];
	data_missing: boolean;
}

export async function computeSignalValue(
	signalName: string,
	signalCfg: SignalConfig,
	ctx: MetricContext,
): Promise<SignalValue> {
	const metric = getMetric(signalName);
	if (!metric) {
		return {
			value: 0,
			evidence: [
				{
					artifact: "coefficients.json",
					location: signalName,
					note: "no metric registered for this signal name (treated as data_missing)",
				},
			],
			data_missing: true,
		};
	}
	const result: MetricResult = await metric.compute(signalCfg.with ?? {}, ctx);
	return {
		value: result.value,
		evidence: result.evidence,
		data_missing: result.data_missing,
	};
}
