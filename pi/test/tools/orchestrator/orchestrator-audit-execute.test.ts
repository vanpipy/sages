/**
 * Execute-path integration tests for orchestrator_audit.
 *
 * These tests exercise the registered tool's `execute()` function directly
 * (via the extracted `executeOrchestratorAudit` helper) against a real
 * `cwd` under a temp directory. They cover the bugs the 2026-XX auditor
 * round called out:
 *
 *   C1  completeAudit returns report_path that does not match the file
 *       actually written by writeAuditReport
 *   C2  When observation.findings + observation.complete arrive in ONE
 *       call, the findings are silently dropped (complete path doesn't
 *       merge params.observation.findings)
 *   C3  completeAudit accepts verdict:PASS with zero findings and no
 *       workflowReady — should downgrade to REVISE
 *   C4  Report markdown is written with default umask (group-readable)
 *       instead of chmod 0o600
 *   C5  AuditState has no lifecycle field — recording after complete
 *       silently mutates already-finalized state
 *
 * Plus positive-path coverage of the three execution modes (init, record,
 * complete) and the per-task / per-batch report-path discrimination.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as yaml from "js-yaml";
import {
	executeOrchestratorAudit,
} from "@/tools/orchestrator/orchestrator-audit.js";
import type { GoalContract, OrchestrationPlan, TaskNode } from "@/tools/orchestrator/types.js";

// ─── helpers ───────────────────────────────────────────────────────────

function makeTask(id: string, opts: Partial<TaskNode> = {}): TaskNode {
	return {
		id,
		description: `task ${id}`,
		plane: "Business",
		priority: "medium",
		depends_on: [],
		files: [],
		subagent_type: "software-developer",
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

function makeContract(): GoalContract {
	return {
		id: "GC-test",
		title: "test goal",
		success_criteria: [
			{ id: "SC1", criterion: "typecheck passes", verification_cmd: "echo ok" },
		],
		anti_goals: [],
		scope: { include: [], exclude: [] },
		constraints: {},
		done_definition: "ok",
		created_at: "2025-01-01T00:00:00Z",
	};
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
	cwd = mkdtempSync(join(tmpdir(), "sages-audit-test-"));
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

describe("executeOrchestratorAudit (execute-path)", () => {
	describe("happy path", () => {
		it("init returns workflow_summary + phase_guidance", async () => {
			const t1 = makeTask("P1", { subagent_type: "Explore", batch: 1 });
			const t2 = makeTask("P2", { subagent_type: "software-developer", batch: 2, depends_on: ["P1"] });
			const plan = makePlan([t1, t2]);
			writePlan(plan);
			writeTaskReport("P1", "CERTIFIED");
			writeTaskReport("P2", "CERTIFIED");

			const r = parseResult(
				await executeOrchestratorAudit({ dag_id: plan.id }, { cwd }),
			);
			expect(r.status).toBe("in_progress");
			expect(r.workflow_summary.workflowReady).toBe(true);
			expect(r.validation.findings_required_min).toBe(1); // default fast
		});

		it("init marks workflowReady=false when any task is missing/NEEDS WORK", async () => {
			const t1 = makeTask("P1", { batch: 1 });
			const plan = makePlan([t1]);
			writePlan(plan);
			// no per-task report → has_report:false

			const r = parseResult(
				await executeOrchestratorAudit({ dag_id: plan.id }, { cwd }),
			);
			expect(r.workflow_summary.workflowReady).toBe(false);
			expect(r.workflow_summary.blockingTasks).toEqual(["P1"]);
		});
	});

	describe("C1 — report_path returned must match the file actually written", () => {
		it("writes and returns audit-P1.md when task_id='P1'", async () => {
			const t1 = makeTask("P1", { batch: 1 });
			const plan = makePlan([t1]);
			writePlan(plan);
			writeTaskReport("P1", "CERTIFIED");

			// init → record one finding → complete
			await executeOrchestratorAudit({ dag_id: plan.id }, { cwd });
			await executeOrchestratorAudit(
				{
					dag_id: plan.id,
					task_id: "P1",
					observation: { finding: { category: "nose", severity: "minor", issue: "ok" } },
				},
				{ cwd },
			);
			const r = parseResult(
				await executeOrchestratorAudit(
					{
						dag_id: plan.id,
						task_id: "P1",
						observation: { complete: { verdict: "PASS", score: 100, summary: "ok" } },
					},
					{ cwd },
				),
			);

			const declared = r.report_path;
			expect(declared).toBe(join(cwd, ".pi", "orchestrator", "audit-P1.md"));
			expect(existsSync(declared)).toBe(true);
		});

		it("writes and returns audit-1.md when batch=1", async () => {
			const t1 = makeTask("P1", { batch: 1 });
			const plan = makePlan([t1]);
			writePlan(plan);
			writeTaskReport("P1", "CERTIFIED");

			await executeOrchestratorAudit({ dag_id: plan.id }, { cwd });
			await executeOrchestratorAudit(
				{
					dag_id: plan.id,
					batch: 1,
					observation: { finding: { category: "nose", severity: "minor", issue: "x" } },
				},
				{ cwd },
			);
			const r = parseResult(
				await executeOrchestratorAudit(
					{
						dag_id: plan.id,
						batch: 1,
						observation: { complete: { verdict: "PASS", score: 100, summary: "ok" } },
					},
					{ cwd },
				),
			);

			const declared = r.report_path;
			expect(declared).toBe(join(cwd, ".pi", "orchestrator", "audit-1.md"));
			expect(existsSync(declared)).toBe(true);
		});

		it("workflow-level complete writes and returns audit-workflow.md", async () => {
			const t1 = makeTask("P1", { batch: 1 });
			const plan = makePlan([t1]);
			writePlan(plan);
			writeTaskReport("P1", "CERTIFIED");

			await executeOrchestratorAudit({ dag_id: plan.id }, { cwd });
			await executeOrchestratorAudit(
				{
					dag_id: plan.id,
					observation: { finding: { category: "nose", severity: "minor", issue: "x" } },
				},
				{ cwd },
			);
			const r = parseResult(
				await executeOrchestratorAudit(
					{
						dag_id: plan.id,
						observation: { complete: { verdict: "PASS", score: 100, summary: "ok" } },
					},
					{ cwd },
				),
			);

			const declared = r.report_path;
			expect(declared).toBe(join(cwd, ".pi", "orchestrator", "audit-workflow.md"));
			expect(existsSync(declared)).toBe(true);
		});
	});

	describe("C2 — findings + complete in same call are merged", () => {
		it("persists batched findings before computing final score", async () => {
			const t1 = makeTask("P1", { batch: 1 });
			const plan = makePlan([t1]);
			writePlan(plan);
			writeTaskReport("P1", "CERTIFIED");

			await executeOrchestratorAudit({ dag_id: plan.id }, { cwd });
			const r = parseResult(
				await executeOrchestratorAudit(
					{
						dag_id: plan.id,
						observation: {
							findings: [
								{ category: "foot", severity: "critical", issue: "cross-cut test fails" },
								{ category: "nose", severity: "major", issue: "SC1 evidence missing" },
							],
							complete: { verdict: "REVISE", score: 50, summary: "two issues" },
						},
					},
					{ cwd },
				),
			);

			// final score should reflect BOTH findings (50 cap = 100-30-10-10, but Math.min(LLM, computed) → min(50, 60) = 50)
			expect(r.score).toBe(50);
			expect(r.verdict).toBe("REVISE");
			expect(r.findings).toHaveLength(2);
		});
	});

	describe("C3 — evidence gate: verdict=PASS requires findings + workflowReady", () => {
		it("downgrades PASS to REVISE when zero findings", async () => {
			const t1 = makeTask("P1", { batch: 1 });
			const plan = makePlan([t1]);
			writePlan(plan);
			writeTaskReport("P1", "CERTIFIED");

			await executeOrchestratorAudit({ dag_id: plan.id }, { cwd });
			const r = parseResult(
				await executeOrchestratorAudit(
					{
						dag_id: plan.id,
						observation: { complete: { verdict: "PASS", score: 100, summary: "fake pass" } },
					},
					{ cwd },
				),
			);

			// 0 findings cannot earn PASS (fast=1 minimum)
			expect(r.verdict).toBe("REVISE");
			expect(r.validation.errors.length).toBeGreaterThan(0);
		});

		it("downgrades PASS to REVISE when workflowReady=false", async () => {
			const t1 = makeTask("P1", { batch: 1 });
			const plan = makePlan([t1]);
			writePlan(plan);
			// No task report — workflowReady=false

			await executeOrchestratorAudit({ dag_id: plan.id }, { cwd });
			const r = parseResult(
				await executeOrchestratorAudit(
					{
						dag_id: plan.id,
						observation: {
							findings: [{ category: "nose", severity: "major", issue: "x" }],
							complete: { verdict: "PASS", score: 90, summary: "force pass" },
						},
					},
					{ cwd },
				),
			);

			// blocking task prevents PASS
			expect(r.verdict).toBe("REVISE");
		});

		it("accepts PASS when findings_required_min met and workflowReady=true", async () => {
			const t1 = makeTask("P1", { batch: 1 });
			const plan = makePlan([t1]);
			writePlan(plan);
			writeTaskReport("P1", "CERTIFIED");

			await executeOrchestratorAudit({ dag_id: plan.id }, { cwd });
			const r = parseResult(
				await executeOrchestratorAudit(
					{
						dag_id: plan.id,
						observation: {
							findings: [{ category: "nose", severity: "minor", issue: "x" }],
							complete: { verdict: "PASS", score: 100, summary: "legit" },
						},
					},
					{ cwd },
				),
			);

			expect(r.verdict).toBe("PASS");
		});
	});

	describe("C4 — report file permission hardening", () => {
		it("chmod 0o600 on the markdown report", async () => {
			const t1 = makeTask("P1", { batch: 1 });
			const plan = makePlan([t1]);
			writePlan(plan);
			writeTaskReport("P1", "CERTIFIED");

			await executeOrchestratorAudit({ dag_id: plan.id }, { cwd });
			await executeOrchestratorAudit(
				{
					dag_id: plan.id,
					observation: { finding: { category: "nose", severity: "minor", issue: "x" } },
				},
				{ cwd },
			);
			const r = parseResult(
				await executeOrchestratorAudit(
					{
						dag_id: plan.id,
						observation: { complete: { verdict: "PASS", score: 100, summary: "ok" } },
					},
					{ cwd },
				),
			);

			// strip umask, expect 0o600
			const mode = statSync(r.report_path).mode & 0o777;
			expect(mode).toBe(0o600);
		});
	});

	describe("C5 — lifecycle: cannot append after complete", () => {
		it("rejects recordFindings on a finalized audit", async () => {
			const t1 = makeTask("P1", { batch: 1 });
			const plan = makePlan([t1]);
			writePlan(plan);
			writeTaskReport("P1", "CERTIFIED");

			await executeOrchestratorAudit({ dag_id: plan.id }, { cwd });
			await executeOrchestratorAudit(
				{
					dag_id: plan.id,
					observation: { finding: { category: "nose", severity: "minor", issue: "x" } },
				},
				{ cwd },
			);
			await executeOrchestratorAudit(
				{
					dag_id: plan.id,
					observation: { complete: { verdict: "PASS", score: 100, summary: "ok" } },
				},
				{ cwd },
			);
			// Second record should error
			const r = parseResult(
				await executeOrchestratorAudit(
					{
						dag_id: plan.id,
						observation: { finding: { category: "nose", severity: "minor", issue: "late" } },
					},
					{ cwd },
				),
			);

			expect(r.status).toBe("error");
			expect(r.validation.errors.join(" ")).toContain("finalized");
		});
	});

	describe("error paths", () => {
		it("DAG not found → error", async () => {
			const r = parseResult(
				await executeOrchestratorAudit({ dag_id: "DAG-missing" }, { cwd }),
			);
			expect(r.status).toBe("error");
			expect(r.validation.errors).toContain("DAG not found");
		});

		it("empty task filter → error", async () => {
			const t1 = makeTask("P1", { batch: 1 });
			const plan = makePlan([t1]);
			writePlan(plan);

			const r = parseResult(
				await executeOrchestratorAudit({ dag_id: plan.id, task_id: "DOES-NOT-EXIST" }, { cwd }),
			);
			expect(r.status).toBe("error");
			expect(r.validation.errors).toContain("empty task filter");
		});

		it("recordFindings without prior init → error", async () => {
			const t1 = makeTask("P1", { batch: 1 });
			const plan = makePlan([t1]);
			writePlan(plan);

			const r = parseResult(
				await executeOrchestratorAudit(
					{
						dag_id: plan.id,
						observation: { finding: { category: "nose", severity: "minor", issue: "x" } },
					},
					{ cwd },
				),
			);
			expect(r.status).toBe("error");
			expect(r.validation.errors.join(" ")).toContain("audit state not found");
		});

		it("complete without prior init → error", async () => {
			const t1 = makeTask("P1", { batch: 1 });
			const plan = makePlan([t1]);
			writePlan(plan);

			const r = parseResult(
				await executeOrchestratorAudit(
					{
						dag_id: plan.id,
						observation: { complete: { verdict: "PASS", score: 100, summary: "x" } },
					},
					{ cwd },
				),
			);
			expect(r.status).toBe("error");
		});
	});
});

// Suppress unused import warning for helper kept for symmetry.
void makeContract;
