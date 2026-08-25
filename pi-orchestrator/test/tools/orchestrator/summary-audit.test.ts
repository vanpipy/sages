/**
 * summary-audit.test.ts — GC-2026-063
 *
 * Tests that orchestrator_audit INIT returns a compact summary by default
 * (dropping the verbose guidance/report fields), while `verbose: true`
 * restores the full init payload. The complete/findings paths stay
 * unchanged (verdict/score/findings are already summary-like).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { executeOrchestratorAudit } from "@/orchestrator-audit.js";
import type { OrchestrationPlan, TaskNode } from "@/types.js";

// ─── helpers ───────────────────────────────────────────────────────────

function makeTask(id: string, opts: Partial<TaskNode> = {}): TaskNode {
	return {
		id,
		description: `task ${id}`,
		plane: "Business",
		priority: "medium",
		depends_on: [],
		files: [],
		subagent_type: "developer",
		batch: 1,
		isolation: "worktree",
		tdd: "strict",
		prompt: `prompt ${id}`,
		acceptance: { covers: ["SC1"] },
		output_schema: { kind: "code_changes" },
		status: "pending",
		retry_count: 0,
		max_retries: 2,
		...opts,
	} as TaskNode;
}

function makePlan(tasks: TaskNode[]): OrchestrationPlan {
	return {
		id: "DAG-test",
		goal_id: "GC-test",
		title: "test plan",
		tasks,
		created_at: "2025-01-01T00:00:00Z",
		updated_at: "2025-01-01T00:00:00Z",
		state: "approved",
		prompts: {},
	};
}

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "sages-summary-audit-test-"));
	mkdirSync(join(cwd, ".pi", "orchestrator"), { recursive: true, mode: 0o700 });
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function writePlan(plan: OrchestrationPlan) {
	writeFileSync(
		join(cwd, ".pi", "orchestrator", `dag-${plan.id}.yaml`),
		yaml.dump(plan, { indent: 2, lineWidth: 120, noRefs: true }),
		"utf-8",
	);
}

function writeTaskReport(taskId: string, verdict: "CERTIFIED" | "NEEDS WORK" | "BLOCKED") {
	const path = join(cwd, ".pi", "orchestrator", `audit-${taskId}.md`);
	writeFileSync(
		path,
		`# Audit Report: ${taskId}\n\n## Final Verdict\n\n**${verdict}**\n\n## Concerns\n\n- none\n`,
		"utf-8",
	);
}

function parseResult(resp: any): any {
	return JSON.parse(resp.content[0].text);
}

// ─── tests ─────────────────────────────────────────────────────────────

describe("orchestrator_audit init summary-by-default (GC-2026-063)", () => {
	it("init (default, verbose omitted) returns a compact summary without verbose fields", async () => {
		const t1 = makeTask("P1", { batch: 1 });
		const plan = makePlan([t1]);
		writePlan(plan);
		writeTaskReport("P1", "CERTIFIED");

		const r = parseResult(
			await executeOrchestratorAudit({ dag_id: plan.id }, { cwd }),
		);

		// always-present summary fields
		expect(r.status).toBe("in_progress");
		expect(r.workflow_summary).toBeDefined();
		expect(r.audit_identity).toBeDefined();
		expect(r.validation.findings_required_min).toBe(1); // default fast

		// verbose fields must be dropped in compact mode
		expect(r.phase_guidance).toBeUndefined();
		expect(r.tasks_to_audit).toBeUndefined();
		expect(r.inline_findings).toBeUndefined();
		expect(r.failure_mode_stats).toBeUndefined();
		expect(r.phases).toBeUndefined();
	});

	it("init verbose:true includes the verbose guidance/report fields", async () => {
		const t1 = makeTask("P1", { batch: 1 });
		const plan = makePlan([t1]);
		writePlan(plan);
		writeTaskReport("P1", "CERTIFIED");

		const r = parseResult(
			await executeOrchestratorAudit({ dag_id: plan.id, verbose: true }, { cwd }),
		);

		expect(r.phase_guidance).toBeDefined();
		expect(r.tasks_to_audit).toBeDefined();
		expect(r.inline_findings).toBeDefined();
		expect(r.failure_mode_stats).toBeDefined();
		expect(r.phases).toBeDefined();
		// summary fields still present alongside
		expect(r.workflow_summary).toBeDefined();
		expect(r.audit_identity).toBeDefined();
	});

	it("complete path is unchanged — verdict/score/findings still present", async () => {
		const t1 = makeTask("P1", { batch: 1 });
		const plan = makePlan([t1]);
		writePlan(plan);
		writeTaskReport("P1", "CERTIFIED");

		await executeOrchestratorAudit({ dag_id: plan.id }, { cwd });
		const r = parseResult(
			await executeOrchestratorAudit(
				{
					dag_id: plan.id,
					observation: { complete: { verdict: "PASS", score: 100, summary: "clean" } },
				},
				{ cwd },
			),
		);

		expect(r.verdict).toBe("PASS");
		expect(r.score).toBe(100);
		expect(r.findings).toEqual([]);
	});
});
