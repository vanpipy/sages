/**
 * pi-evaluator/src/metrics/plan-quality.ts
 *
 * dag-dim LLM-only metric. Subjective: how well-constructed is the DAG?
 *
 * Reads `dag-{id}.yaml` from the workflow path, builds evidence text
 * summarizing the DAG structure (task count, plane distribution, batch
 * layout, dependency graph depth, isolation discipline), and calls the
 * installed JudgeFn with criteria tuned to DAG quality.
 *
 * No heuristic fallback — this is a pure-LLM metric. If the user has
 * `plan_quality` enabled (weight > 0 in coeff override) but the LLM judge
 * isn't installed (no API key) or returns data_missing, the engine treats
 * that signal as data_missing (T1 engine behavior).
 */
import { readDag } from "../lib/artifact-reader.ts";
import type { Metric, MetricContext, MetricResult } from "./types.ts";
import type { JudgeInput } from "./llm-judge/seam.ts";
import { judge } from "./llm-judge/seam.ts";

const PLAN_QUALITY_CRITERIA = `Evaluate the DAG's structural quality on these dimensions:
- Task decomposition: are tasks sized appropriately (not too large, not trivially small)?
- Dependency ordering: do dependencies reflect real data/control flow without unnecessary serialization?
- Batching: are independent tasks grouped into the same batch for parallelism?
- Plane distribution: are Foundation/Data/Observer/etc. planes used meaningfully or all lumped into one?
- Isolation discipline: do production-code tasks use managed worktrees?
- Coverage traceability: does every success_criterion have at least one task's acceptance.covers[]?
Score 0-1 based on overall quality.`;

export class PlanQuality implements Metric {
	readonly id = "plan_quality" as const;
	readonly dim = "dag" as const;
	readonly kind = "llm_judge" as const;
	readonly description = "DAG structural quality (LLM-only, dag dim)";

	async compute(_input: unknown, ctx: MetricContext): Promise<MetricResult> {
		const t0 = performance.now();
		if (!ctx.workflowPath) {
			return { value: 0, evidence: [], duration_ms: 0, data_missing: true };
		}
		const dagPath = `${ctx.workflowPath}/dag-*.yaml`;
		let dag;
		try {
			dag = await readDag(ctx.workflowPath);
		} catch (err) {
			return {
				value: 0,
				evidence: [
					{
						artifact: dagPath,
						location: "readDag",
						note: `failed: ${err instanceof Error ? err.message : String(err)}`,
					},
				],
				duration_ms: performance.now() - t0,
				data_missing: true,
			};
		}
		if (!dag || !dag.tasks || dag.tasks.length === 0) {
			return { value: 0, evidence: [], duration_ms: performance.now() - t0, data_missing: true };
		}

		const evidence = summarizeDag(dag);
		const judgeInput: JudgeInput = {
			criteria: PLAN_QUALITY_CRITERIA,
			evidence,
			from: "llm",
		};
		const r = await judge(judgeInput);
		return {
			value: r.value,
			evidence: [
				{
					artifact: "dag-*.yaml",
					location: `${dag.tasks.length} tasks`,
					note: `LLM judge: ${r.evidence[0]?.note ?? "(no rationale)"}`,
				},
			],
			duration_ms: performance.now() - t0,
			data_missing: r.data_missing,
		};
	}
}

function summarizeDag(dag: {
	tasks: Array<{
		id: string;
		plane?: string;
		batch?: number;
		description?: string;
		depends_on?: string[];
		isolation?: unknown;
		acceptance?: { covers?: string[] };
	}>;
}): string {
	const tasks = dag.tasks;
	const planeDist = new Map<string, number>();
	const batchSizes = new Map<number, number>();
	const isolationCounts = { worktree: 0, current_workspace: 0, none: 0, other: 0 };
	const allCovers = new Set<string>();
	for (const t of tasks) {
		const plane = t.plane ?? "(none)";
		planeDist.set(plane, (planeDist.get(plane) ?? 0) + 1);
		const batch = t.batch ?? 0;
		batchSizes.set(batch, (batchSizes.get(batch) ?? 0) + 1);
		const iso = JSON.stringify(t.isolation ?? null);
		if (iso.includes('"worktree"')) isolationCounts.worktree += 1;
		else if (iso.includes('"current_workspace"')) isolationCounts.current_workspace += 1;
		else if (iso === "null") isolationCounts.none += 1;
		else isolationCounts.other += 1;
		for (const sc of t.acceptance?.covers ?? []) allCovers.add(sc);
	}
	const lines: string[] = [];
	lines.push(`# DAG Summary (${tasks.length} tasks)`);
	lines.push("");
	lines.push(`Planes: ${[...planeDist.entries()].map(([p, n]) => `${p}=${n}`).join(", ")}`);
	lines.push(
		`Batches: ${[...batchSizes.entries()]
			.sort(([a], [b]) => a - b)
			.map(([b, n]) => `b${b}=${n}`)
			.join(", ")}`,
	);
	lines.push(
		`Isolation: worktree=${isolationCounts.worktree}, current_workspace=${isolationCounts.current_workspace}, none=${isolationCounts.none}, other=${isolationCounts.other}`,
	);
	lines.push(`Coverage: ${allCovers.size} unique SC ids referenced across all tasks' acceptance.covers[]`);
	lines.push("");
	lines.push("## Tasks (id | plane | batch | deps | covers)");
	for (const t of tasks) {
		lines.push(
			`- ${t.id} | ${t.plane ?? "(none)"} | b${t.batch ?? "?"} | deps=[${(t.depends_on ?? []).join(",")}] | covers=[${(t.acceptance?.covers ?? []).join(",")}] | ${(t.description ?? "").slice(0, 80)}`,
		);
	}
	return lines.join("\n");
}
