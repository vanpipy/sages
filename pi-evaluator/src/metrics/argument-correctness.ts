/**
 * pi-evaluator/src/metrics/argument-correctness.ts
 *
 * Implement-dim heuristic. Reads session.jsonl and aggregates
 * `toolResult.isError === true` per tool name. Returns the **error rate**
 * (errors / total tool results) — lower is better.
 *
 * Counts every toolResult block regardless of tool name. Returns 0 when
 * no tool results are seen (no data yet — preserved by engine as data_missing
 * when the metric returns 0 with empty evidence, but we also return
 * `data_missing: true` here since 0 with no input is ambiguous between
 * "no calls yet" and "all calls succeeded"; the engine has no way to tell).
 *
 * No regression vs v0.2.0: disabled by default.
 */
import { readSession } from "../lib/jsonl-reader.ts";
import type { Metric, MetricContext, MetricResult } from "./types.ts";

export class ArgumentCorrectness implements Metric {
	readonly id = "argument_correctness" as const;
	readonly dim = "implement" as const;
	readonly kind = "heuristic" as const;
	readonly description =
		"Fraction of toolResult blocks with isError === true (implement)";

	async compute(_input: unknown, ctx: MetricContext): Promise<MetricResult> {
		const t0 = performance.now();
		if (!ctx.workflowPath) {
			return { value: 0, evidence: [], duration_ms: 0, data_missing: true };
		}
		const sessionPath = `${ctx.workflowPath}/session.jsonl`;

		let total = 0;
		let errors = 0;
		const perToolErrors = new Map<string, number>();
		try {
			const { entries } = await readSession(sessionPath);
			for (const e of entries) {
				if (e.type !== "message" || !e.message) continue;
				for (const b of e.message.content) {
					if (b.type !== "toolResult") continue;
					total += 1;
					if ((b as { is_error?: boolean }).is_error === true) {
						errors += 1;
						const toolName = (b as { name?: string }).name ?? "unknown";
						perToolErrors.set(toolName, (perToolErrors.get(toolName) ?? 0) + 1);
					}
				}
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				value: 0,
				evidence: [
					{
						artifact: "session.jsonl",
						location: sessionPath,
						note: `failed to read: ${message}`,
					},
				],
				duration_ms: performance.now() - t0,
				data_missing: true,
			};
		}

		if (total === 0) {
			return {
				value: 0,
				evidence: [],
				duration_ms: performance.now() - t0,
				data_missing: true,
			};
		}

		const errorRate = errors / total;
		const evidence: MetricResult["evidence"] = [];
		for (const [toolName, errCount] of perToolErrors) {
			evidence.push({
				artifact: "session.jsonl",
				location: toolName,
				note: `${errCount} error(s) out of ${total} tool results`,
			});
		}
		return {
			value: errorRate,
			evidence,
			duration_ms: performance.now() - t0,
			data_missing: false,
		};
	}
}
