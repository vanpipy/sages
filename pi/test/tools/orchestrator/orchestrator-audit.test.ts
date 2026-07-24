/**
 * Tests for orchestrator-audit core scoring & phase logic.
 *
 * Covers:
 *   - computeScore: severity deductions, floor at 0
 *   - getPhasesForDepth: fast vs full phase selection
 *   - buildPhaseGuidance: only enabled phases appear in guidance
 *   - appendFindings: batched write semantics (single recompute, single persist)
 */

import { describe, it, expect } from "bun:test";
import {
	computeScore,
	getPhasesForDepth,
	buildPhaseGuidance,
	appendFindings,
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
});
