/**
 * l1-advisory.test.ts — GC-2026-053
 *
 * Tests the orchestrator advisory mirror. This layer
 * observes the orchestrator's own tool-call history (NOT agent message
 * text — that's L2) and emits advisory entries via `pi.appendEntry("system", ...)`.
 *
 * Pattern mirrors L2 (pi-subagents/src/agent-runner.ts:2180-2305):
 *   - severity filter (>= major; minor is hard-filtered)
 *   - dedup via ctx.alreadyAdvisedRules
 *   - per-severity budget (DEFAULT_ADVISORY_BUDGET_BY_SEVERITY)
 *   - per-advisory token cap
 *   - format: [orchestrator audit advisory — <severity> <N>/<M>] <rule>: <issue>. Fix: <directive>
 *
 * The advisory cap is per-severity (critical=∞, major=4, minor=0).
 * Critical mistakes must always surface; major findings are bounded to
 * avoid LLM noise. Dedup prevents the SAME rule from re-firing; the
 * per-severity budget prevents different rules at the same severity
 * from spamming.
 */

import { describe, expect, it } from "bun:test";

import {
	ADVISORY_MAX_TOKENS,
	DEFAULT_ADVISORY_BUDGET_BY_SEVERITY,
	RULE_FIX_DIRECTIVES,
	orchestratorAdvisoryFor,
	extractOrchestratorFindings,
	type OrchestratorToolCall,
	type OrchestratorToolResult,
	type OrchestratorAdvisoryContext,
	type OrchestratorAdvisoryOptions,
	type GoalScopeSnapshot,
	type L1AdvisoryEntry,
} from "@/l1-advisory.js";

function approxTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function makeCall(
	toolName: string,
	input: Record<string, unknown>,
	timestamp = Date.now(),
	callId?: string,
): OrchestratorToolCall {
	return { toolName, input, timestamp, callId };
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

/** Default ctx with empty dedup set + zero per-severity counters. */
const DEFAULT_CTX: OrchestratorAdvisoryContext = {
	alreadyAdvisedRules: new Set<string>(),
	advisoriesBySeverity: { critical: 0, major: 0, minor: 0 },
};

/** Convenience: read the formatted text of an advisory entry. */
function text(entry: L1AdvisoryEntry): string {
	return entry.text;
}

describe("l1 orchestrator advisory (GC-2026-053)", () => {
	it("T-L1-01: empty history -> no advisories", () => {
		const out = orchestratorAdvisoryFor([], DEFAULT_CTX, DEFAULT_OPTS);
		expect(out).toEqual([]);
	});

	it("T-L1-02: dispatch_no_audit (critical) -> 1 advisory", () => {
		// Orchestrator dispatched a task but never called audit.
		const history: OrchestratorToolCall[] = [
			makeCall("goal_contract_create", { id: "GC-2026-053" }, 1000),
			makeCall("dag_synthesize", { goal_id: "GC-2026-053" }, 2000),
			makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto" }, 3000),
		];
		const out = orchestratorAdvisoryFor(history, DEFAULT_CTX, DEFAULT_OPTS);
		expect(out.length).toBe(1);
		expect(out[0]!.rule).toBe("dispatch_no_audit");
		expect(text(out[0]!)).toMatch(/\[orchestrator audit advisory/);
		expect(text(out[0]!)).toMatch(/dispatch_no_audit/);
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
		const out = orchestratorAdvisoryFor(history, DEFAULT_CTX, DEFAULT_OPTS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		// First advisory must be the critical one (dispatch_no_audit).
		expect(out[0]!.rule).toBe("dispatch_no_audit");
	});

	it("T-L1-DEDUP: rule in ctx.alreadyAdvisedRules is suppressed", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto" }, 1000),
		];
		const ctx: OrchestratorAdvisoryContext = {
			alreadyAdvisedRules: new Set(["dispatch_no_audit"]),
			advisoriesBySeverity: { critical: 1, major: 0, minor: 0 },
		};
		const out = orchestratorAdvisoryFor(history, ctx, DEFAULT_OPTS);
		expect(out).toEqual([]);
	});

	it("T-L1-CAP-MAJOR: at most DEFAULT_ADVISORY_BUDGET_BY_SEVERITY.major major advisories", () => {
		// Force-fire 5 different major findings by tweaking thresholds.
		// dag_resynth_loop fires at >2; loop_call_chain (chain ≥ 3) fires
		// at 3 repeats of a NON-dag_synthesize tool.
		const history: OrchestratorToolCall[] = [
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 1000),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 2000),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 3000),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 4000),
			makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto", transition: { task_id: "T2" } }, 5000),
			makeCall("read", { path: "/tmp/looped.ts" }, 6000),
			makeCall("read", { path: "/tmp/looped.ts" }, 7000),
			makeCall("read", { path: "/tmp/looped.ts" }, 8000),
			makeCall("bash", { command: "ls" }, 9000),
		];
		const out = orchestratorAdvisoryFor(history, DEFAULT_CTX, {
			...DEFAULT_OPTS,
			loadDagPlan: () => ({
				tasks: [
					{ id: "T1", status: "failed", depends_on: [] },
					{ id: "T2", status: "in_progress", depends_on: ["T1"] },
				],
			}),
		});
		// Count major findings — must be ≤ major budget.
		const majorFindings = out.filter((e) => e.severity === "major");
		expect(majorFindings.length).toBeLessThanOrEqual(
			DEFAULT_ADVISORY_BUDGET_BY_SEVERITY.major,
		);
		// Critical (transition_skip_failed, dispatch_no_audit) must still fire.
		expect(out.some((e) => e.severity === "critical")).toBe(true);
	});

	it("T-L1-CAP-CRITICAL: critical has no cap (∞ budget)", () => {
		// Fire multiple distinct critical findings by varying the history
		// shape. Each is dedup-gated, but each is its own rule.
		const history: OrchestratorToolCall[] = [
			// dispatch_no_audit (critical) — task_dispatch with no audit
			makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto" }, 1000),
			// transition_skip_failed (critical) — dispatch with failed dep
			...Array.from({ length: 12 }, (_, i) =>
				makeCall("read", { path: `src/file${i}.ts` }, 2000 + i),
			),
			makeCall(
				"task_dispatch",
				{
					dag_id: "DAG-053",
					strategy: "auto",
					transition: { task_id: "T2", status: "in_progress", agent_id: "agent-1" },
				},
				3000,
			),
		];
		const out = orchestratorAdvisoryFor(history, DEFAULT_CTX, {
			...DEFAULT_OPTS,
			loadDagPlan: () => ({
				tasks: [
					{ id: "T1", status: "failed", depends_on: [] },
					{ id: "T2", status: "in_progress", depends_on: ["T1"] },
				],
			}),
		});
		const criticalCount = out.filter((e) => e.severity === "critical").length;
		// Both critical findings must surface (no cap on critical).
		expect(criticalCount).toBe(2);
	});

	it("T-L1-TOK: each advisory is <= ADVISORY_MAX_TOKENS tokens", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto" }, 1000),
			makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto", transition: { task_id: "T1" } }, 2000),
			// Long path that bloats the evidence line.
			makeCall("write", { path: "/very/long/path/".repeat(50) + "file.ts", content: "" }, 3000),
		];
		const out = orchestratorAdvisoryFor(history, DEFAULT_CTX, DEFAULT_OPTS);
		for (const a of out) {
			expect(approxTokens(text(a))).toBeLessThanOrEqual(ADVISORY_MAX_TOKENS);
		}
	});

	it("T-L1-04: format includes severity + per-severity N/M counter", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto" }, 1000),
		];
		const out = orchestratorAdvisoryFor(history, DEFAULT_CTX, DEFAULT_OPTS);
		// dispatch_no_audit is critical, so the counter shows N/∞.
		expect(out[0]!.severity).toBe("critical");
		expect(text(out[0]!)).toMatch(/^\[orchestrator audit advisory — critical 1\/∞\]/);
	});

	it("T-L1-04b: format shows major N/M with finite cap", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 1000),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 2000),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 3000),
		];
		const out = orchestratorAdvisoryFor(history, DEFAULT_CTX, DEFAULT_OPTS);
		const resynth = out.find((e) => e.rule === "dag_resynth_loop");
		expect(resynth).toBeDefined();
		expect(resynth!.severity).toBe("major");
		expect(text(resynth!)).toMatch(/^\[orchestrator audit advisory — major 1\/4\]/);
	});

	it("T-L1-05: well-formed history (dispatch followed by audit) -> no advisories", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("goal_contract_create", { id: "GC-2026-053" }, 1000),
			makeCall("dag_synthesize", { goal_id: "GC-2026-053" }, 2000),
			makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto" }, 3000),
			makeCall("orchestrator_audit", { dag_id: "DAG-053" }, 4000),
		];
		const out = orchestratorAdvisoryFor(history, DEFAULT_CTX, DEFAULT_OPTS);
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

	it("T-L1-R5: no_progress_no_audit fires after > 10 tool calls without audit AND a chain at length >= 3", () => {
		// 9 distinct reads + 3 reads of the SAME file (chain length 3)
		const history: OrchestratorToolCall[] = [
			...Array.from({ length: 9 }, (_, i) => makeCall("read", { path: `src/file${i}.ts` }, 1000 + i)),
			makeCall("read", { path: "/tmp/looped.ts" }, 2000),
			makeCall("read", { path: "/tmp/looped.ts" }, 3000),
			makeCall("read", { path: "/tmp/looped.ts" }, 4000),
		];
		const findings = extractOrchestratorFindings(history, {
			...DEFAULT_OPTS,
			loadDagPlan: () => ({ tasks: [] }),
		});
		expect(findings.some((f) => f.rule === "no_progress_no_audit")).toBe(true);
	});

	it("T-L1-R5-NO-CHAIN: no_progress_no_audit does NOT fire when all calls are distinct (no chain >= 3)", () => {
		// 12 distinct paths — no chain at length >= 3, even though total > 10
		const history: OrchestratorToolCall[] = Array.from({ length: 12 }, (_, i) =>
			makeCall("read", { path: `src/file${i}.ts` }, 1000 + i),
		);
		const findings = extractOrchestratorFindings(history, {
			...DEFAULT_OPTS,
			loadDagPlan: () => ({ tasks: [] }),
		});
		expect(findings.some((f) => f.rule === "no_progress_no_audit")).toBe(false);
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

describe("l1 orchestrator advisory: repeat_call_chain (GC-2026-059)", () => {
	it("RCC-01: fires when same (read, path) called 3+ times", () => {
		const history: OrchestratorToolCall[] = Array.from({ length: 4 }, (_, i) =>
			makeCall("read", { path: "/tmp/looped.ts" }, 1000 + i),
		);
		const findings = extractOrchestratorFindings(history, DEFAULT_OPTS);
		const rcc = findings.find((f) => f.rule === "repeat_call_chain");
		expect(rcc).toBeDefined();
		expect(rcc?.severity).toBe("major");
	});

	it("RCC-02: does NOT fire when read paths differ (3 distinct calls)", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("read", { path: "/tmp/a" }, 1000),
			makeCall("read", { path: "/tmp/b" }, 2000),
			makeCall("read", { path: "/tmp/c" }, 3000),
		];
		const findings = extractOrchestratorFindings(history, DEFAULT_OPTS);
		expect(findings.find((f) => f.rule === "repeat_call_chain")).toBeUndefined();
	});

	it("RCC-03: does NOT fire on only 2 calls (need 3+)", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("read", { path: "/tmp/looped.ts" }, 1000),
			makeCall("read", { path: "/tmp/looped.ts" }, 2000),
		];
		const findings = extractOrchestratorFindings(history, DEFAULT_OPTS);
		expect(findings.find((f) => f.rule === "repeat_call_chain")).toBeUndefined();
	});

	it("RCC-04: fires on task_dispatch with same args 3+ times", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("task_dispatch", { dag_id: "DAG-X", task_id: "T1" }, 1000),
			makeCall("task_dispatch", { dag_id: "DAG-X", task_id: "T1" }, 2000),
			makeCall("task_dispatch", { dag_id: "DAG-X", task_id: "T1" }, 3000),
		];
		const findings = extractOrchestratorFindings(history, DEFAULT_OPTS);
		const rcc = findings.find((f) => f.rule === "repeat_call_chain");
		expect(rcc).toBeDefined();
	});

	it("RCC-05: suppressed when chain is dag_synthesize (covered by dag_resynth_loop)", () => {
		// When dag_synthesize is the worst chain, repeat_call_chain is
		// suppressed — dag_resynth_loop has a more specific fixdirective.
		const history: OrchestratorToolCall[] = Array.from({ length: 3 }, (_, i) =>
			makeCall("dag_synthesize", { goal_id: "GC-1" }, 1000 + i),
		);
		const findings = extractOrchestratorFindings(history, DEFAULT_OPTS);
		// dag_resynth_loop should fire
		expect(findings.find((f) => f.rule === "dag_resynth_loop")).toBeDefined();
		// repeat_call_chain should be suppressed (not both fire for same chain)
		expect(findings.find((f) => f.rule === "repeat_call_chain")).toBeUndefined();
	});

	it("RCC-06: arg key order does NOT matter (canonical form)", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("read", { path: "/tmp/x", encoding: "utf-8" }, 1000),
			makeCall("read", { encoding: "utf-8", path: "/tmp/x" }, 2000),
			makeCall("read", { path: "/tmp/x", encoding: "utf-8" }, 3000),
		];
		const findings = extractOrchestratorFindings(history, DEFAULT_OPTS);
		expect(findings.find((f) => f.rule === "repeat_call_chain")).toBeDefined();
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

	it("T-L1-FIX-6: RULE_FIX_DIRECTIVES map covers all 6 L1 rules (5 original + repeat_call_chain)", () => {
		const rules: Array<keyof typeof RULE_FIX_DIRECTIVES> = [
			"dag_resynth_loop",
			"dispatch_no_audit",
			"transition_skip_failed",
			"goal_drift_detected",
			"no_progress_no_audit",
			"repeat_call_chain",
		];
		for (const r of rules) {
			expect(RULE_FIX_DIRECTIVES[r]).toBeDefined();
		}
	});

	it("T-L1-FIX-7: advisory injects the per-rule fix directive verbatim", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto" }, 1000),
		];
		const out = orchestratorAdvisoryFor(history, DEFAULT_CTX, DEFAULT_OPTS);
		expect(text(out[0]!)).toContain(RULE_FIX_DIRECTIVES.dispatch_no_audit);
	});
});

describe("l1 orchestrator advisory: budget override (per-severity)", () => {
	it("T-L1-BUDGET-1: options.maxAdvisoriesBySeverity caps a severity below default", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto" }, 1000),
		];
		// Override critical budget to 0 — no critical advisories should fire.
		const out = orchestratorAdvisoryFor(history, DEFAULT_CTX, {
			...DEFAULT_OPTS,
			maxAdvisoriesBySeverity: { critical: 0 },
		});
		expect(out.some((e) => e.rule === "dispatch_no_audit")).toBe(false);
	});

	it("T-L1-BUDGET-2: options.maxAdvisoriesBySeverity.raises a severity above default", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 1000),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 2000),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 3000),
		];
		// Override major budget to 10 — should accept more than default 4.
		const out = orchestratorAdvisoryFor(history, DEFAULT_CTX, {
			...DEFAULT_OPTS,
			maxAdvisoriesBySeverity: { major: 10 },
		});
		// dag_resynth_loop is major; with budget 10 it still fires here.
		expect(out.some((e) => e.rule === "dag_resynth_loop")).toBe(true);
	});
});
describe("l1 orchestrator advisory: interval gate (stuck-loop detection)", () => {
	it("T-L1-INT-1: dag_resynth_loop fires when 3 identical calls within stuckIntervalMs", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 1000),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 1500), // +500ms
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 2000), // +500ms
		];
		const out = orchestratorAdvisoryFor(history, DEFAULT_CTX, DEFAULT_OPTS);
		expect(out.some((e) => e.rule === "dag_resynth_loop")).toBe(true);
	});

	it("T-L1-INT-2: dag_resynth_loop does NOT fire when intervals exceed stuckIntervalMs", () => {
		// 3 identical dag_synthesize but spaced 8s apart — looks like retry-with-thinking.
		const history: OrchestratorToolCall[] = [
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 1000),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 9000), // +8s
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 17000), // +8s
		];
		const out = orchestratorAdvisoryFor(history, DEFAULT_CTX, DEFAULT_OPTS);
		expect(out.some((e) => e.rule === "dag_resynth_loop")).toBe(false);
	});

	it("T-L1-INT-3: repeat_call_chain respects interval gate", () => {
		// 3 identical read calls within 500ms — stuck.
		const stuck: OrchestratorToolCall[] = [
			makeCall("read", { path: "/tmp/x.ts" }, 1000),
			makeCall("read", { path: "/tmp/x.ts" }, 1500),
			makeCall("read", { path: "/tmp/x.ts" }, 2000),
		];
		const out1 = orchestratorAdvisoryFor(stuck, DEFAULT_CTX, DEFAULT_OPTS);
		expect(out1.some((e) => e.rule === "repeat_call_chain")).toBe(true);

		// 3 identical read calls spaced 8s apart — likely intentional.
		const retry: OrchestratorToolCall[] = [
			makeCall("read", { path: "/tmp/x.ts" }, 1000),
			makeCall("read", { path: "/tmp/x.ts" }, 9000),
			makeCall("read", { path: "/tmp/x.ts" }, 17000),
		];
		const out2 = orchestratorAdvisoryFor(retry, DEFAULT_CTX, DEFAULT_OPTS);
		expect(out2.some((e) => e.rule === "repeat_call_chain")).toBe(false);
	});

	it("T-L1-INT-4: stuckIntervalMs option overrides default threshold", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 1000),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 2000), // +1s
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 3000), // +1s
		];
		// With stuckIntervalMs=500, the 1s intervals disqualify the chain.
		const out = orchestratorAdvisoryFor(history, DEFAULT_CTX, {
			...DEFAULT_OPTS,
			stuckIntervalMs: 500,
		});
		expect(out.some((e) => e.rule === "dag_resynth_loop")).toBe(false);
	});
});

describe("l1 orchestrator advisory: error-history gate (Item 2)", () => {
	it("T-L1-ERR-1: dag_resynth_loop fires only when all calls in chain errored", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 1000, "call-1"),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 1500, "call-2"),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 2000, "call-3"),
		];
		// All errored → fires.
		const errorAll: OrchestratorToolResult[] = [
			{ toolCallId: "call-1", isError: true },
			{ toolCallId: "call-2", isError: true },
			{ toolCallId: "call-3", isError: true },
		];
		const out1 = orchestratorAdvisoryFor(history, DEFAULT_CTX, {
			...DEFAULT_OPTS,
			errorHistory: errorAll,
		});
		expect(out1.some((e) => e.rule === "dag_resynth_loop")).toBe(true);

		// One succeeded → does NOT fire.
		const errorMixed: OrchestratorToolResult[] = [
			{ toolCallId: "call-1", isError: true },
			{ toolCallId: "call-2", isError: false },
			{ toolCallId: "call-3", isError: true },
		];
		const out2 = orchestratorAdvisoryFor(history, DEFAULT_CTX, {
			...DEFAULT_OPTS,
			errorHistory: errorMixed,
		});
		expect(out2.some((e) => e.rule === "dag_resynth_loop")).toBe(false);
	});

	it("T-L1-ERR-2: repeat_call_chain respects error-history gate", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("read", { path: "/tmp/x.ts" }, 1000, "rc-1"),
			makeCall("read", { path: "/tmp/x.ts" }, 1500, "rc-2"),
			makeCall("read", { path: "/tmp/x.ts" }, 2000, "rc-3"),
		];
		// One call succeeded → suppress.
		const errorMixed: OrchestratorToolResult[] = [
			{ toolCallId: "rc-1", isError: true },
			{ toolCallId: "rc-2", isError: true },
			{ toolCallId: "rc-3", isError: false },
		];
		const out = orchestratorAdvisoryFor(history, DEFAULT_CTX, {
			...DEFAULT_OPTS,
			errorHistory: errorMixed,
		});
		expect(out.some((e) => e.rule === "repeat_call_chain")).toBe(false);
	});

	it("T-L1-ERR-3: missing errorHistory for some calls doesn't gate (be permissive)", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 1000, "call-1"),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 1500, "call-2"),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 2000, "call-3"),
		];
		// Only call-1 has an error record (call-2 and call-3 are unknown)
		const errorPartial: OrchestratorToolResult[] = [
			{ toolCallId: "call-1", isError: true },
		];
		const out = orchestratorAdvisoryFor(history, DEFAULT_CTX, {
			...DEFAULT_OPTS,
			errorHistory: errorPartial,
		});
		// Still fires — unknown results don't suppress.
		expect(out.some((e) => e.rule === "dag_resynth_loop")).toBe(true);
	});

	it("T-L1-ERR-4: no errorHistory option → existing behavior (fires on chain count)", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 1000),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 1500),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 2000),
		];
		const out = orchestratorAdvisoryFor(history, DEFAULT_CTX, DEFAULT_OPTS);
		expect(out.some((e) => e.rule === "dag_resynth_loop")).toBe(true);
	});
});

describe("l1 orchestrator advisory: assistant-message retry-intent gate (Item 3)", () => {
	it("T-L1-MSG-1: dag_resynth_loop suppressed when last message signals retry intent", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 1000),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 1500),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 2000),
		];
		const out = orchestratorAdvisoryFor(history, DEFAULT_CTX, {
			...DEFAULT_OPTS,
			lastAssistantMessage: "Let me retry that — I need to amend the goal first.",
		});
		expect(out.some((e) => e.rule === "dag_resynth_loop")).toBe(false);
	});

	it("T-L1-MSG-2: dag_resynth_loop fires when last message has no retry intent", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 1000),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 1500),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 2000),
		];
		const out = orchestratorAdvisoryFor(history, DEFAULT_CTX, {
			...DEFAULT_OPTS,
			lastAssistantMessage: "Synthesizing the DAG with the new plan...",
		});
		expect(out.some((e) => e.rule === "dag_resynth_loop")).toBe(true);
	});

	it("T-L1-MSG-3: repeat_call_chain respects retry-intent gate", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("read", { path: "/tmp/x.ts" }, 1000),
			makeCall("read", { path: "/tmp/x.ts" }, 1500),
			makeCall("read", { path: "/tmp/x.ts" }, 2000),
		];
		const out = orchestratorAdvisoryFor(history, DEFAULT_CTX, {
			...DEFAULT_OPTS,
			lastAssistantMessage: "Re-attempting because the prior read was on a stale snapshot.",
		});
		expect(out.some((e) => e.rule === "repeat_call_chain")).toBe(false);
	});

	it("T-L1-MSG-4: undefined lastAssistantMessage → no suppression", () => {
		const history: OrchestratorToolCall[] = [
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 1000),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 1500),
			makeCall("dag_synthesize", { goal_id: "GC-053" }, 2000),
		];
		const out = orchestratorAdvisoryFor(history, DEFAULT_CTX, DEFAULT_OPTS);
		expect(out.some((e) => e.rule === "dag_resynth_loop")).toBe(true);
	});
});

import { preToolBlockDecision } from "@/l1-advisory.js";

describe("l1 orchestrator advisory: pre-tool block decision (Item 4)", () => {
	it("T-L1-PRE-1: preToolBlockDecision returns undefined when no critical finding", () => {
		const history: OrchestratorToolCall[] = [];
		const upcoming = makeCall("read", { path: "/tmp/x.ts" }, 1000);
		const decision = preToolBlockDecision(upcoming, history, DEFAULT_OPTS);
		expect(decision).toBeUndefined();
	});

	it("T-L1-PRE-2: preToolBlockDecision blocks critical on first dispatch (dispatch_no_audit fires first)", () => {
		// Note: dispatch_no_audit has a more eager trigger than
		// transition_skip_failed (the latter requires both a failed dep
		// AND a transition block). On a bare first dispatch with no
		// prior audit history, dispatch_no_audit fires first.
		const history: OrchestratorToolCall[] = [];
		const upcoming = makeCall(
			"task_dispatch",
			{
				dag_id: "DAG-053",
				strategy: "auto",
				transition: { task_id: "T2", status: "in_progress", agent_id: "agent-1" },
			},
			1000,
		);
		const decision = preToolBlockDecision(upcoming, history, {
			...DEFAULT_OPTS,
			loadDagPlan: () => ({
				tasks: [
					{ id: "T1", status: "failed", depends_on: [] },
					{ id: "T2", status: "in_progress", depends_on: ["T1"] },
				],
			}),
		});
		expect(decision).toBeDefined();
		expect(decision!.block).toBe(true);
		// Either critical rule is acceptable — the test asserts blocking
		// happens, not which specific rule fires first.
		expect(decision!.reason).toMatch(/dispatch_no_audit|transition_skip_failed/);
	});

	it("T-L1-PRE-3: preToolBlockDecision does NOT block on major findings (advisory only)", () => {
		const history: OrchestratorToolCall[] = [];
		const upcoming = makeCall("dag_synthesize", { goal_id: "GC-053" }, 1000);
		const decision = preToolBlockDecision(upcoming, history, DEFAULT_OPTS);
		// First call is not a chain yet — no finding → undefined.
		expect(decision).toBeUndefined();
	});

	it("T-L1-PRE-4: preToolBlockDecision blocks dispatch_no_audit after a task_dispatch without audit", () => {
		// Existing history: 1 dispatch, no audit. Upcoming: another dispatch.
		const history: OrchestratorToolCall[] = [
			makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto" }, 1000),
		];
		const upcoming = makeCall("task_dispatch", { dag_id: "DAG-053", strategy: "auto" }, 2000);
		const decision = preToolBlockDecision(upcoming, history, DEFAULT_OPTS);
		// dispatch_no_audit is critical; the upcoming call would trigger
		// it on first dispatch anyway. Pre-tool blocks even the FIRST
		// dispatch attempt when no audit has ever happened.
		expect(decision).toBeDefined();
		expect(decision!.block).toBe(true);
		expect(decision!.reason).toContain("dispatch_no_audit");
	});

	it("T-L1-PRE-5: preToolBlockDecision does NOT block on goal_drift (major)", () => {
		// goal_drift_detected is major (not critical), so it doesn't
		// pre-block — only post-call advisory fires. This test pins
		// the contract: only CRITICAL findings trigger the pre-tool block.
		const history: OrchestratorToolCall[] = [];
		const upcoming = makeCall(
			"dag_synthesize",
			{
				goal_id: "GC-2026-053",
				tasks: [{ id: "T1", files: ["lib/extra.ts"] }],
			},
			1000,
		);
		const decision = preToolBlockDecision(upcoming, history, {
			...DEFAULT_OPTS,
			loadGoalScope: () => SCOPE_IN,
		});
		expect(decision).toBeUndefined();
	});
});
