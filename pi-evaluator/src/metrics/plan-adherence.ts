/**
 * pi-evaluator/src/metrics/plan-adherence.ts
 *
 * Dag-dim heuristic. For each task in the DAG, checks whether the task's
 * report mentions each `acceptance.covers[]` entry. Returns the average
 * coverage across all tasks — 1 means every task report referenced every
 * SC id it claims to cover.
 *
 * Matching strategy: case-insensitive substring check for each SC id token
 * (e.g. "SC1", "SC2"). Conservative — false positives are unlikely because
 * SC ids are Sages-minted and rarely appear in prose.
 *
 * No regression vs v0.2.0: disabled by default.
 */
import { readDag, readTaskReports } from "../lib/artifact-reader.ts";
import type { Metric, MetricContext, MetricResult } from "./types.ts";

export class PlanAdherence implements Metric {
	readonly id = "plan_adherence" as const;
	readonly dim = "dag" as const;
	readonly kind = "heuristic" as const;
	readonly description =
		"Fraction of DAG's acceptance.covers[] entries mentioned in each task report (dag)";

	async compute(_input: unknown, ctx: MetricContext): Promise<MetricResult> {
		const t0 = performance.now();
		if (!ctx.workflowPath) {
			return { value: 0, evidence: [], duration_ms: 0, data_missing: true };
		}

		let taskCount = 0;
		let totalCoverage = 0;
		const evidence: MetricResult["evidence"] = [];

		try {
			const dag = await readDag(ctx.workflowPath);
			const reports = await readTaskReports(ctx.workflowPath);
			const reportsById = new Map(reports.map((r) => [r.task_id, r.raw_markdown]));

			for (const task of dag.tasks) {
				const covers = task.acceptance?.covers ?? [];
				if (covers.length === 0) continue;
				const rawText = (reportsById.get(task.id) ?? "").toLowerCase();
				let hits = 0;
				const missing: string[] = [];
				for (const scId of covers) {
					const needle = scId.toLowerCase();
					if (rawText.includes(needle)) {
						hits += 1;
					} else {
						missing.push(scId);
					}
				}
				const ratio = hits / covers.length;
				totalCoverage += ratio;
				taskCount += 1;
				if (missing.length > 0) {
					evidence.push({
						artifact: `task-${task.id}-report.md`,
						location: `acceptance.covers[]`,
						note: `missing references: ${missing.join(", ")}`,
					});
				}
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				value: 0,
				evidence: [
					{
						artifact: "DAG + task reports",
						location: ctx.workflowPath,
						note: `failed to read: ${message}`,
					},
				],
				duration_ms: performance.now() - t0,
				data_missing: true,
			};
		}

		if (taskCount === 0) {
			return {
				value: 0,
				evidence: [],
				duration_ms: performance.now() - t0,
				data_missing: true,
			};
		}

		return {
			value: totalCoverage / taskCount,
			evidence,
			duration_ms: performance.now() - t0,
			data_missing: false,
		};
	}
}
