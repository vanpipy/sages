/**
 * Tests for orchestrator-audit core scoring & phase logic.
 *
 * Covers:
 *   - computeScore: severity deductions, floor at 0
 *   - getPhasesForDepth: fast vs full phase selection
 *   - buildPhaseGuidance: only enabled phases appear in guidance
 *   - appendFindings: batched write semantics (single recompute, single persist)
 *   - parseAuditReport: extract verdict + finding counts from software-auditor's
 *     report (the A3 contract: orchestrator_audit reads software-auditor's
 *     audit-{id}.md as the source of truth for task-level verdict)
 *   - aggregateTaskAudits: produce a workflow-level rollup
 */

import { describe, it, expect } from "bun:test";
import {
	computeScore,
	getPhasesForDepth,
	buildPhaseGuidance,
	appendFindings,
	parseAuditReport,
	aggregateTaskAudits,
} from "@/tools/orchestrator/orchestrator-audit.js";
import type { OrchestratorFinding, TaskNode } from "@/tools/orchestrator/types.js";

describe("orchestrator-audit", () => {
	describe("computeScore", () => {
		it("returns 100 with no findings", () => {
			expect(computeScore([])).toBe(100);
		});

		it("subtracts 30 for each critical finding", () => {
			const findings: OrchestratorFinding[] = [
				{ category: "death", severity: "critical", issue: "X" },
			];
			expect(computeScore(findings)).toBe(70);
		});

		it("subtracts 10 for each major finding", () => {
			const findings: OrchestratorFinding[] = [
				{ category: "foot", severity: "major", issue: "X" },
			];
			expect(computeScore(findings)).toBe(90);
		});

		it("subtracts 2 for each minor finding", () => {
			const findings: OrchestratorFinding[] = [
				{ category: "ink", severity: "minor", issue: "X" },
			];
			expect(computeScore(findings)).toBe(98);
		});

		it("floors at 0 even with many critical findings", () => {
			const findings: OrchestratorFinding[] = Array.from({ length: 10 }, (_, i) => ({
				category: "death" as const,
				severity: "critical" as const,
				issue: `f${i}`,
			}));
			expect(computeScore(findings)).toBe(0);
		});

		it("accumulates mixed severities", () => {
			const findings: OrchestratorFinding[] = [
				{ category: "death", severity: "critical", issue: "a" }, // -30
				{ category: "foot", severity: "major", issue: "b" }, // -10
				{ category: "ink", severity: "minor", issue: "c" }, // -2
				{ category: "nose", severity: "minor", issue: "d" }, // -2
			];
			expect(computeScore(findings)).toBe(56);
		});
	});

	describe("getPhasesForDepth", () => {
		it("returns 3 phases for 'fast' depth", () => {
			expect(getPhasesForDepth("fast")).toEqual(["ink", "nose", "foot"]);
		});

		it("returns 5 phases for 'full' depth", () => {
			expect(getPhasesForDepth("full")).toEqual([
				"ink",
				"nose",
				"foot",
				"castration",
				"death",
			]);
		});
	});

	describe("buildPhaseGuidance", () => {
		const tasks: TaskNode[] = [
			{
				id: "P1",
				description: "demo",
				plane: "Business",
				priority: "medium",
				depends_on: [],
				files: [],
				subagent_type: "Explore",
				batch: 1,
				isolation: "none",
				tdd: "none",
				prompt: "x",
				acceptance: { covers: ["SC1"] },
				output_schema: { kind: "file_list" },
				status: "pending",
				retry_count: 0,
				max_retries: 0,
			},
		];

		it("includes only ink/nose/foot for fast depth", () => {
			const g = buildPhaseGuidance(tasks, ["ink", "nose", "foot"]);
			expect(Object.keys(g).sort()).toEqual(["foot", "ink", "nose"]);
			expect(g.castration).toBeUndefined();
			expect(g.death).toBeUndefined();
		});

		it("includes all 5 phases for full depth", () => {
			const g = buildPhaseGuidance(tasks, [
				"ink",
				"nose",
				"foot",
				"castration",
				"death",
			]);
			expect(Object.keys(g).sort()).toEqual([
				"castration",
				"death",
				"foot",
				"ink",
				"nose",
			]);
		});

		it("foot phase guidance names verification_cmd", () => {
			const g = buildPhaseGuidance(tasks, ["foot"]);
			expect(g.foot).toContain("verification_cmd");
		});
	});

	describe("appendFindings (batch submission)", () => {
		// Helper: a minimal state for testing
		const baseState = {
			dag_id: "DAG-test",
			plan: {} as never,
			tasks: [] as never,
			findings: [] as OrchestratorFinding[],
			score: 100,
			depth: "fast" as const,
			created_at: "2025-01-01T00:00:00Z",
			updated_at: "2025-01-01T00:00:00Z",
		};

		it("appends all findings in a single call", () => {
			const batch: OrchestratorFinding[] = [
				{ category: "ink", severity: "minor", issue: "a" },
				{ category: "nose", severity: "major", issue: "b" },
				{ category: "foot", severity: "critical", issue: "c" },
			];
			const next = appendFindings(baseState, batch);
			expect(next.findings).toHaveLength(3);
			expect(next.findings.map((f) => f.issue)).toEqual(["a", "b", "c"]);
		});

		it("recomputes score once from all (existing + new) findings", () => {
			const stateWithOne = {
				...baseState,
				findings: [
					{ category: "foot", severity: "major", issue: "existing" } as OrchestratorFinding,
				],
			};
			const batch: OrchestratorFinding[] = [
				{ category: "death", severity: "critical", issue: "new1" },
				{ category: "ink", severity: "minor", issue: "new2" },
			];
			const next = appendFindings(stateWithOne, batch);
			// 100 - 10 (existing major) - 30 (new critical) - 2 (new minor) = 58
			expect(next.score).toBe(58);
		});

		it("preserves insertion order across multiple calls", () => {
			const a = appendFindings(baseState, [
				{ category: "ink", severity: "minor", issue: "first" },
			]);
			const b = appendFindings(a, [
				{ category: "nose", severity: "minor", issue: "second" },
			]);
			expect(b.findings.map((f) => f.issue)).toEqual(["first", "second"]);
		});

		it("updates updated_at timestamp", () => {
			const old = "2020-01-01T00:00:00Z";
			const state = { ...baseState, updated_at: old };
			const next = appendFindings(state, [
				{ category: "ink", severity: "minor", issue: "x" },
			]);
			expect(next.updated_at).not.toBe(old);
		});
	});

	describe("parseAuditReport (A3 — subagent audit aggregation)", () => {
		it("returns has_report:false when content is null", () => {
			const r = parseAuditReport("P1", null);
			expect(r.has_report).toBe(false);
			expect(r.task_id).toBe("P1");
			expect(r.verdict).toBeUndefined();
			expect(r.findings_total).toBe(0);
		});

		it("parses verdict from a CERTIFIED report", () => {
			const md = `# Audit Report: P1

**Auditor**: Software Auditor (sub-agent)
**Audit Date**: 2025-01-01T00:00:00Z

## Final Verdict

**CERTIFIED**
`;
			const r = parseAuditReport("P1", md);
			expect(r.has_report).toBe(true);
			expect(r.verdict).toBe("CERTIFIED");
		});

		it("parses verdict from a NEEDS WORK report", () => {
			const md = `## Final Verdict

**NEEDS WORK**

If NEEDS WORK: list the specific changes required for re-audit.
`;
			const r = parseAuditReport("P2", md);
			expect(r.has_report).toBe(true);
			expect(r.verdict).toBe("NEEDS WORK");
		});

		it("parses verdict from a BLOCKED report", () => {
			const md = `# Audit Report: P3

## Final Verdict

**BLOCKED**
`;
			const r = parseAuditReport("P3", md);
			expect(r.verdict).toBe("BLOCKED");
		});

		it("counts findings listed in the Concerns section", () => {
			const md = `# Audit Report: P1

## Concerns

- UserRepository.findByEmail() not tested — only findById and create are covered
- Hardcoded secret in fixtures/.env.example
- Test suite flaky on CI runner

## Final Verdict

**NEEDS WORK**
`;
			const r = parseAuditReport("P1", md);
			expect(r.findings_total).toBe(3);
		});

		it("returns VERDICT_UNKNOWN when no verdict line is found", () => {
			const md = `# Some other report

No verdict here.
`;
			const r = parseAuditReport("P1", md);
			expect(r.has_report).toBe(true);
			expect(r.verdict).toBe("UNKNOWN");
		});
	});

	describe("aggregateTaskAudits (A3 — workflow-level rollup)", () => {
		// Multi-task fixture for the rollup
		const tasks: TaskNode[] = [
			{
				id: "P1",
				description: "find",
				plane: "Business",
				priority: "medium",
				depends_on: [],
				files: [],
				subagent_type: "Explore",
				batch: 1,
				isolation: "none",
				tdd: "none",
				prompt: "x",
				acceptance: { covers: ["SC1"] },
				output_schema: { kind: "file_list" },
				status: "pending",
				retry_count: 0,
				max_retries: 0,
			},
			{
				id: "P2",
				description: "implement",
				plane: "Business",
				priority: "medium",
				depends_on: ["P1"],
				files: [],
				subagent_type: "software-developer",
				batch: 2,
				isolation: "worktree",
				tdd: "strict",
				prompt: "x",
				acceptance: { covers: ["SC2"] },
				output_schema: { kind: "code_changes" },
				status: "pending",
				retry_count: 0,
				max_retries: 0,
			},
		];

		it("returns one summary per task", () => {
			const r = aggregateTaskAudits(tasks, new Map());
			expect(r.tasks).toHaveLength(2);
			expect(r.tasks.map((s) => s.task_id)).toEqual(["P1", "P2"]);
		});

		it("marks tasks without reports as has_report:false", () => {
			const r = aggregateTaskAudits(tasks, new Map());
			expect(r.tasks.every((s) => !s.has_report)).toBe(true);
		});

		it("uses content from the report map when present", () => {
			const reports = new Map<string, string | null>([
				[
					"P1",
					`# Audit Report: P1

## Final Verdict

**CERTIFIED**
`,
				],
				["P2", null],
			]);
			const r = aggregateTaskAudits(tasks, reports);
			expect(r.tasks[0].verdict).toBe("CERTIFIED");
			expect(r.tasks[1].has_report).toBe(false);
		});

		it("workflow-level verdict checks all tasks are CERTIFIED", () => {
			const reports = new Map<string, string | null>([
				[
					"P1",
					`## Final Verdict

**CERTIFIED**`,
				],
				[
					"P2",
					`## Final Verdict

**NEEDS WORK**`,
				],
			]);
			const r = aggregateTaskAudits(tasks, reports);
			expect(r.workflowReady).toBe(false);
			expect(r.blockingTasks).toEqual(["P2"]);
		});

		it("workflow-level verdict is true when all tasks CERTIFIED", () => {
			const reports = new Map<string, string | null>([
				["P1", `## Final Verdict\n\n**CERTIFIED**`],
				["P2", `## Final Verdict\n\n**CERTIFIED**`],
			]);
			const r = aggregateTaskAudits(tasks, reports);
			expect(r.workflowReady).toBe(true);
			expect(r.blockingTasks).toEqual([]);
		});
	});
});
