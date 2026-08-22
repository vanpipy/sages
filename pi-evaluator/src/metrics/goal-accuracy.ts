/**
 * pi-evaluator/src/metrics/goal-accuracy.ts
 *
 * Audit-dim hybrid metric. Heuristic branch: workflowReady from
 * audit-DAG-{id}.md + presence of any "CERTIFIED" verdict. LLM branch
 * (added by T4): compare the audit's findings + verdict against the
 * goal's `done_definition` to score accuracy (not just completion).
 *
 * `with.from === 'llm'` opts into the LLM branch. Default (no `from`)
 * uses heuristic only — zero LLM tokens.
 */
import { readAuditReports, readGoal } from "../lib/artifact-reader.ts";
import { judge } from "./llm-judge/seam.ts";
import type { Metric, MetricContext, MetricResult } from "./types.ts";

export interface GoalAccuracyInput {
	from?: "heuristic" | "llm";
	criteria?: string;
}

export class GoalAccuracy implements Metric<GoalAccuracyInput> {
	readonly id = "goal_accuracy" as const;
	readonly dim = "audit" as const;
	readonly kind = "heuristic" as const; // hybrid: heuristic + opt-in LLM via with.from
	readonly description =
		"WorkflowReady binary (heuristic) + LLM judge against done_definition (audit)";

	async compute(
		input: GoalAccuracyInput,
		ctx: MetricContext,
	): Promise<MetricResult> {
		const t0 = performance.now();
		if (!ctx.workflowPath) {
			return { value: 0, evidence: [], duration_ms: 0, data_missing: true };
		}
		if (input.from === "llm") {
			return this.llmBranch(input, ctx);
		}
		return this.heuristicBranch(ctx, t0);
	}

	private async heuristicBranch(
		ctx: MetricContext,
		t0: number,
	): Promise<MetricResult> {
		let audits;
		try {
			audits = await readAuditReports(ctx.workflowPath!);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				value: 0,
				evidence: [
					{
						artifact: "audit-*.md",
						location: ctx.workflowPath!,
						note: `failed to read: ${message}`,
					},
				],
				duration_ms: performance.now() - t0,
				data_missing: true,
			};
		}
		if (audits.length === 0) {
			return {
				value: 0,
				evidence: [],
				duration_ms: performance.now() - t0,
				data_missing: true,
			};
		}
		// Aggregate: ratio of audits that are workflowReady AND verdict contains CERTIFIED.
		let pass = 0;
		const evidence: MetricResult["evidence"] = [];
		for (const a of audits) {
			const ok = a.workflowReady && /CERTIFIED/i.test(a.verdict);
			if (ok) pass += 1;
			else {
				evidence.push({
					artifact: a.file_path,
					location: `verdict=${a.verdict} workflowReady=${a.workflowReady}`,
					note: "did not pass",
				});
			}
		}
		return {
			value: pass / audits.length,
			evidence,
			duration_ms: performance.now() - t0,
			data_missing: false,
		};
	}

	private async llmBranch(
		input: GoalAccuracyInput,
		ctx: MetricContext,
	): Promise<MetricResult> {
		const t0 = performance.now();
		const criteria =
			input.criteria ?? "Does the workflow's verdict + findings indicate the goal was achieved?";
		let evidenceText = "";
		try {
			const audits = await readAuditReports(ctx.workflowPath!);
			const goal = await readGoal(ctx.workflowPath!);
			evidenceText =
				`Goal done_definition: ${goal.done_definition ?? "(none)"}\n\n` +
				audits
					.map((a) => `Audit ${a.audit_id}: verdict=${a.verdict} workflowReady=${a.workflowReady}\n${a.findings.map((f) => `  - ${f}`).join("\n")}`)
					.join("\n\n");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			evidenceText = `failed to read: ${message}`;
		}
		const j = await judge({ evidence: evidenceText, criteria, provider: input.criteria && undefined, modelId: undefined });
		return {
			...j,
			duration_ms: j.duration_ms + (performance.now() - t0),
		};
	}
}
