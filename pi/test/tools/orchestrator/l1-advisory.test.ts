/**
 * l1-advisory.test.ts — GC-2026-053
 *
 * Tests the L1 (orchestrator self-audit) advisory mirror. The L1 layer
 * observes the orchestrator's own tool-call history (NOT agent message
 * text — that's L2) and emits advisory strings via `pi.appendEntry("system", ...)`.
 *
 * Pattern mirrors L2 (pi-subagents/src/agent-runner.ts:2180-2305):
 *   - severity filter (>= major)
 *   - dedup via ctx.alreadyAdvisedRules
 *   - cap at ADVISORY_MAX_PER_DISPATCH per call
 *   - per-advisory token cap
 *   - format: [orchestrator audit advisory — N/M] <rule>: <issue>. Fix: <directive>
 *
 * Token cap is approximate (text.length / 4). The test verifies that
 * each advisory element is ≤ 200 tokens (≈ 800 chars).
 */

import { describe, expect, it } from "bun:test";

import {
	ADVISORY_MAX_PER_DISPATCH,
	ADVISORY_MAX_TOKENS,
	RULE_FIX_DIRECTIVES,
	orchestratorAdvisoryFor,
	extractOrchestratorFindings,
	type OrchestratorToolCall,
	type OrchestratorAdvisoryContext,
	type OrchestratorAdvisoryOptions,
	type GoalScopeSnapshot,
} from "@/tools/orchestrator/l1-advisory.js";

function approxTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function makeCall(
	toolName: string,
	input: Record<string, unknown>,
	timestamp = Date.now(),
): OrchestratorToolCall {
	return { toolName, input, timestamp };
}

/** Default options used by tests that don't exercise scope/dag lookups. */
const DEFAULT_OPTS: OrchestratorAdvisoryOptions = {
	dagSynthesizeToolName: "dag_synthesize",
	taskDispatchToolName: "task_dispatch",
	orchestratorAuditToolName: "orchestrator_audit",
};

/** Goal scope fixture — keeps the "in scope" test files narrow. */
const SCOPE_IN: GoalScopeSnapshot = {
	goal_id: "GC-2026-053",
	scope_include: ["pi/src/tools/orchestrator/", "pi/test/tools/orchestrator/"],
	scope_exclude: ["node_modules/", "dist/"],
};

describe("l1 orchestrator advisory (GC-2026-053)", () => {
	it("T-L1-01: empty history -> no advisories", () => {
		const out = orchestratorAdvisoryFor([], undefined, DEFAULT_OPTS);
		expect(out).toEqual([]);
	});

	it("T-L1-02: dispatch_no_audit (critical) -> 1 advisory", () => {
		// Orchestrator dispatched a task but never called audit.
		const history: OrchestratorToolCall[] = [
			makeCall("goal_contract_create", { id: "GC-2026-053" }, 1000),
			makeCall("dag_synthesize", { goal_id: "GC-2026-053" }, 2000),
			makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto" }, 3000),
		];
		const out = orchestratorAdvisoryFor(history, undefined, DEFAULT_OPTS);
		expect(out.length).toBe(1);
		expect(out[0]).toMatch(/\[orchestrator audit advisory/);
		expect(out[0]).toMatch(/dispatch_no_audit/);
	});

	it("T-L1-SEV: critical findings are emitted before major (severity sort)", () => {
		// Two rules fire: dispatch_no_audit (critical) and
		// no_progress_no_audit (major, after >10 calls since audit).
		const history: OrchestratorToolCall[] = [
			makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto" }, 1000),
			...Array.from({ length: 12 }, (_, i) =>
				makeCall("read", { path: `src/file${i}.ts` }, 2000 + i),
			),
		];
		const out = orchestratorAdvisoryFor(history, undefined, DEFAULT_OPTS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		// First advisory must be the critical one (dispatch_no_audit).
		expect(out[0]).toMatch(/dispatch_no_audit/);
	});

	it("T-L1-DEDUP: rule in ctx.alreadyAdvisedRules is suppressed", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto" }, 1000),
		];
		const ctx: OrchestratorAdvisoryContext = {
			alreadyAdvisedRules: new Set(["dispatch_no_audit"]),
			advisoriesSent: 1,
		};
		const out = orchestratorAdvisoryFor(history, ctx, DEFAULT_OPTS);
		expect(out).toEqual([]);
	});

	it("T-L1-CAP: at most ADVISORY_MAX_PER_DISPATCH advisories per call", () => {
		// History designed to fire 4+ rules:
		//   - dag_resynth_loop (4 dag_synthesize calls to same goal)
		//   - dispatch_no_audit (no audit after task_dispatch)
		//   - transition_skip_failed (dep is failed)
		//   - no_progress_no_audit (15 tool calls without audit)
		const history: OrchestratorToolCall[] = [
			makeCall("dag_synthesize", { goal_id: "GC-2026-053" }, 1000),
			makeCall("dag_synthesize", { goal_id: "GC-2026-053" }, 2000),
			makeCall("dag_synthesize", { goal_id: "GC-2026-053" }, 3000),
			makeCall("dag_synthesize", { goal_id: "GC-2026-053" }, 4000),
			makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto", transition: { task_id: "T2" } }, 5000),
			makeCall("read", { path: "src/foo.ts" }, 6000),
			makeCall("read", { path: "src/bar.ts" }, 7000),
			makeCall("read", { path: "src/baz.ts" }, 8000),
			makeCall("bash", { command: "ls" }, 9000),
		];
		const out = orchestratorAdvisoryFor(history, undefined, {
			...DEFAULT_OPTS,
			loadDagPlan: () => ({
				tasks: [
					{ id: "T1", status: "failed", depends_on: [] },
					{ id: "T2", status: "in_progress", depends_on: ["T1"] },
				],
			}),
		});
		expect(out.length).toBeLessThanOrEqual(ADVISORY_MAX_PER_DISPATCH);
		expect(out.length).toBeGreaterThan(0);
	});

	it("T-L1-TOK: each advisory is <= ADVISORY_MAX_TOKENS tokens", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto" }, 1000),
			makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto", transition: { task_id: "T1" } }, 2000),
			// Long path that bloats the evidence line.
			makeCall("write", { path: "/very/long/path/".repeat(50) + "file.ts", content: "" }, 3000),
		];
		const out = orchestratorAdvisoryFor(history, undefined, DEFAULT_OPTS);
		for (const a of out) {
			expect(approxTokens(a)).toBeLessThanOrEqual(ADVISORY_MAX_TOKENS);
		}
	});

	it("T-L1-04: format includes N/M counter", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto" }, 1000),
		];
		const out = orchestratorAdvisoryFor(history, undefined, DEFAULT_OPTS);
		expect(out[0]).toMatch(/^\[orchestrator audit advisory — 1\/\d+\]/);
	});

	it("T-L1-05: well-formed history (dispatch followed by audit) -> no advisories", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("goal_contract_create", { id: "GC-2026-053" }, 1000),
			makeCall("dag_synthesize", { goal_id: "GC-2026-053" }, 2000),
			makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto" }, 3000),
			makeCall("orchestrator_audit", { dag_id: "DAG-053" }, 4000),
		];
		const out = orchestratorAdvisoryFor(history, undefined, DEFAULT_OPTS);
		expect(out).toEqual([]);
	});
});

describe("l1 orchestrator advisory: 5 rules (GC-2026-053)", () => {
	it("T-L1-R1: dag_resynth_loop fires when dag_synthesize called > 2 times for same goal", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 1000),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 2000),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 3000),
		];
		const findings = extractOrchestratorFindings(history, DEFAULT_OPTS);
		expect(findings.some((f) => f.rule === "dag_resynth_loop")).toBe(true);
	});

	it("T-L1-R2: dispatch_no_audit fires when task_dispatch never followed by audit", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto" }, 1000),
			makeCall("read", { path: "src/foo.ts" }, 2000),
		];
		const findings = extractOrchestratorFindings(history, DEFAULT_OPTS);
		expect(findings.some((f) => f.rule === "dispatch_no_audit")).toBe(true);
	});

	it("T-L1-R3: transition_skip_failed fires when dispatching T2 while T1 (dep) is failed", () => {
		const history: OrchestratorToolCall[] = [
			makeCall(
				"task_dispatch",
				{
					dag_id: "DAG-053",
					strategy: "auto",
					transition: { task_id: "T2", status: "in_progress", agent_id: "agent-1" },
				},
				1000,
			),
		];
		const findings = extractOrchestratorFindings(history, {
			...DEFAULT_OPTS,
			loadDagPlan: () => ({
				tasks: [
					{ id: "T1", status: "failed", depends_on: [] },
					{ id: "T2", status: "in_progress", depends_on: ["T1"] },
				],
			}),
		});
		expect(findings.some((f) => f.rule === "transition_skip_failed")).toBe(true);
	});

	it("T-L1-R3-NEG: transition_skip_failed does NOT fire when deps are all completed", () => {
		const history: OrchestratorToolCall[] = [
			makeCall(
				"task_dispatch",
				{
					dag_id: "DAG-053",
					strategy: "auto",
					transition: { task_id: "T2", status: "in_progress", agent_id: "agent-1" },
				},
				1000,
			),
		];
		const findings = extractOrchestratorFindings(history, {
			...DEFAULT_OPTS,
			loadDagPlan: () => ({
				tasks: [
					{ id: "T1", status: "completed", depends_on: [] },
					{ id: "T2", status: "in_progress", depends_on: ["T1"] },
				],
			}),
		});
		expect(findings.some((f) => f.rule === "transition_skip_failed")).toBe(false);
	});

	it("T-L1-R4: goal_drift_detected fires when a tool call references files outside scope", () => {
		// scope.include = ["pi/src/tools/orchestrator/"] — out-of-scope file is "lib/extra.ts".
		const history: OrchestratorToolCall[] = [
			makeCall(
				"dag_synthesize",
				{
					goal_id: "GC-2026-053",
					tasks: [{ id: "T1", files: ["lib/extra.ts"] }],
				},
				1000,
			),
		];
		const findings = extractOrchestratorFindings(history, {
			...DEFAULT_OPTS,
			loadGoalScope: () => SCOPE_IN,
		});
		expect(findings.some((f) => f.rule === "goal_drift_detected")).toBe(true);
	});

	it("T-L1-R4-NEG: goal_drift_detected does NOT fire when files are within scope", () => {
		const history: OrchestratorToolCall[] = [
			makeCall(
				"dag_synthesize",
				{
					goal_id: "GC-2026-053",
					tasks: [{ id: "T1", files: ["pi/src/tools/orchestrator/foo.ts"] }],
				},
				1000,
			),
		];
		const findings = extractOrchestratorFindings(history, {
			...DEFAULT_OPTS,
			loadGoalScope: () => SCOPE_IN,
		});
		expect(findings.some((f) => f.rule === "goal_drift_detected")).toBe(false);
	});

	it("T-L1-R5: no_progress_no_audit fires after > 10 tool calls without audit", () => {
		const history: OrchestratorToolCall[] = Array.from({ length: 12 }, (_, i) =>
			makeCall("read", { path: `src/file${i}.ts` }, 1000 + i),
		);
		const findings = extractOrchestratorFindings(history, {
			...DEFAULT_OPTS,
			loadDagPlan: () => ({ tasks: [] }),
		});
		expect(findings.some((f) => f.rule === "no_progress_no_audit")).toBe(true);
	});

	it("T-L1-R5-NEG: no_progress_no_audit does NOT fire when audit was called recently", () => {
		const history: OrchestratorToolCall[] = [
			...Array.from({ length: 8 }, (_, i) => makeCall("read", { path: `src/file${i}.ts` }, 1000 + i)),
			makeCall("orchestrator_audit", { dag_id: "DAG-053" }, 9000),
			makeCall("read", { path: "src/x.ts" }, 10000),
		];
		const findings = extractOrchestratorFindings(history, DEFAULT_OPTS);
		expect(findings.some((f) => f.rule === "no_progress_no_audit")).toBe(false);
	});
});

describe("l1 orchestrator advisory: rule fix directives (GC-2026-053)", () => {
	it("T-L1-FIX-1: dag_resynth_loop fix mentions amend or revise goal", () => {
		expect(RULE_FIX_DIRECTIVES.dag_resynth_loop).toContain("amend");
	});

	it("T-L1-FIX-2: dispatch_no_audit fix mentions orchestrator_audit", () => {
		expect(RULE_FIX_DIRECTIVES.dispatch_no_audit).toContain("orchestrator_audit");
	});

	it("T-L1-FIX-3: transition_skip_failed fix mentions failed dep", () => {
		expect(RULE_FIX_DIRECTIVES.transition_skip_failed).toContain("failed");
	});

	it("T-L1-FIX-4: goal_drift_detected fix mentions scope", () => {
		expect(RULE_FIX_DIRECTIVES.goal_drift_detected).toContain("scope");
	});

	it("T-L1-FIX-5: no_progress_no_audit fix mentions stopping to verify", () => {
		expect(RULE_FIX_DIRECTIVES.no_progress_no_audit).toMatch(/audit|verif/i);
	});

	it("T-L1-FIX-6: RULE_FIX_DIRECTIVES map covers all 5 L1 rules", () => {
		const rules: Array<keyof typeof RULE_FIX_DIRECTIVES> = [
			"dag_resynth_loop",
			"dispatch_no_audit",
			"transition_skip_failed",
			"goal_drift_detected",
			"no_progress_no_audit",
		];
		for (const r of rules) {
			expect(RULE_FIX_DIRECTIVES[r]).toBeDefined();
		}
	});

	it("T-L1-FIX-7: advisory injects the per-rule fix directive verbatim", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto" }, 1000),
		];
		const out = orchestratorAdvisoryFor(history, undefined, DEFAULT_OPTS);
		expect(out[0]).toContain(RULE_FIX_DIRECTIVES.dispatch_no_audit);
	});
});