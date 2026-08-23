/**
 * pi-evaluator/src/metrics/task-completion.ts
 *
 * Implement+audit hybrid metric. Heuristic branch: for each task, the
 * fraction of `acceptance.covers[]` entries that appear as "PASS" in
 * the audit report. LLM branch (added by T4): judge task report text
 * against each SC criterion.
 *
 * `with.from === 'llm'` opts into the LLM branch. Default uses heuristic.
 */
import { readDag, readTaskReports, readAuditReports } from "../lib/artifact-reader.ts";
import { judge } from "./llm-judge/seam.ts";
import type { Metric, MetricContext, MetricResult } from "./types.ts";

export interface TaskCompletionInput {
	from?: "heuristic" | "llm";
	criteria?: string;
}

export class TaskCompletion implements Metric<TaskCompletionInput> {
	readonly id = "task_completion" as const;
	readonly dim = "implement" as const; // routed via implement dim in DEFAULT_COEFFICIENTS
	readonly kind = "heuristic" as const;
	readonly description =
		"Per-task covers[] verified by audit (heuristic) + LLM judge (implement)";

	async compute(
		input: TaskCompletionInput,
		ctx: MetricContext,
	): Promise<MetricResult> {
		if (!ctx.workflowPath) {
			return { value: 0, evidence: [], duration_ms: 0, data_missing: true };
		}
		if (input.from === "llm") return this.llmBranch(input, ctx);
		return this.heuristicBranch(ctx);
	}

	private async heuristicBranch(ctx: MetricContext): Promise<MetricResult> {
		const t0 = performance.now();
		let totalRatio = 0;
		let taskCount = 0;
		const evidence: MetricResult["evidence"] = [];
		try {
			const dag = await readDag(ctx.workflowPath!);
			const audits = await readAuditReports(ctx.workflowPath!);
			// Build a set of SC ids that audit reports marked PASS.
			// Heuristic: extract any "PASS" findings (line items under ## Findings).
			const passingScs = new Set<string>();
			for (const a of audits) {
				for (const f of a.findings) {
					const m = /\b(SC\d+)\b.*PASS/i.exec(f);
					if (m && m[1]) passingScs.add(m[1]);
					// Also accept bare "PASS" as global
					if (/^\s*PASS\b/i.test(f)) passingScs.add("*");
				}
			}
			for (const task of dag.tasks) {
				const covers = task.acceptance?.covers ?? [];
				if (covers.length === 0) continue;
				let hits = 0;
				const missing: string[] = [];
				for (const scId of covers) {
					if (passingScs.has(scId) || passingScs.has("*")) hits += 1;
					else missing.push(scId);
				}
				totalRatio += hits / covers.length;
				taskCount += 1;
				if (missing.length > 0) {
					evidence.push({
						artifact: `task-${task.id}-report.md`,
						location: missing.join(", "),
						note: "no PASS evidence in audit",
					});
				}
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				value: 0,
				evidence: [{ artifact: "DAG + audits", location: ctx.workflowPath!, note: `failed to read: ${message}` }],
				duration_ms: performance.now() - t0,
				data_missing: true,
			};
		}
		if (taskCount === 0) {
			return { value: 0, evidence: [], duration_ms: performance.now() - t0, data_missing: true };
		}
		return {
			value: totalRatio / taskCount,
			evidence,
			duration_ms: performance.now() - t0,
			data_missing: false,
		};
	}

	private async llmBranch(
		input: TaskCompletionInput,
		ctx: MetricContext,
	): Promise<MetricResult> {
		const t0 = performance.now();
		const criteria =
			input.criteria ?? "Does the task's report indicate the SC criterion is met?";
		let evidenceText = "";
		try {
			const dag = await readDag(ctx.workflowPath!);
			const reports = await readTaskReports(ctx.workflowPath!);
			const reportsById = new Map(reports.map((r) => [r.task_id, r.raw_markdown]));
			evidenceText = dag.tasks
				.map((t) => {
					const r = reportsById.get(t.id) ?? "(no report)";
					const covers = t.acceptance?.covers ?? [];
					return `Task ${t.id} (covers: ${covers.join(", ")})\nReport:\n${r}`;
				})
				.join("\n\n---\n\n");
		} catch (err) {
			evidenceText = `failed to read: ${err instanceof Error ? err.message : String(err)}`;
		}
		const j = await judge({ evidence: evidenceText, criteria });
		return {
			...j,
			duration_ms: j.duration_ms + (performance.now() - t0),
		};
	}
}
