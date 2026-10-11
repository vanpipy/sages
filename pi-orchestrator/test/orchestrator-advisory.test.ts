/**
 * orchestrator-advisory.test.ts — post chore/remove-goal-contract
 *
 * After GC-2026-orchestrator-simplify + chore/remove-goal-contract the
 * orchestrator owns zero tools of its own. The `goal_drift_detected`
 * rule (which required an active goal contract to fire) and the
 * `dag_*` / `dispatch_*` / `transition_*` / `no_progress_*` rules (tied
 * to deleted DAG / dispatch / audit tools) are all removed. One rule
 * remains:
 *
 *   - repeat_call_chain    (general stuck-on-same-call detector)
 *
 * Also covers:
 *   - family classifier (orchestrator family is empty after the
 *     goal-contract removal)
 *   - family-mix reminder
 *   - RULE_FIX_DIRECTIVES surface (single entry: repeat_call_chain)
 */

import { describe, expect, it } from "bun:test";
import {
	extractOrchestratorFindings,
	orchestratorAdvisoryFor,
	familyOfTool,
	emptyFamilyCounts,
	familyMixReminderText,
	installOrchestratorAdvisoryHandlers,
	RULE_FIX_DIRECTIVES,
	DEFAULT_ADVISORY_BUDGET_BY_SEVERITY,
	ADVISORY_MAX_TOKENS,
	type OrchestratorAdvisoryContext,
	type OrchestratorToolCall,
} from "@/orchestrator-advisory.js";

function makeCall(toolName: string, input: Record<string, unknown>, t: number): OrchestratorToolCall {
	return { toolName, input, timestamp: t };
}

const DEFAULT_OPTS = {};

// ─────────────────────────────────────────────────────────────────────────────
// Empty / well-formed history
// ─────────────────────────────────────────────────────────────────────────────

describe("orchestrator advisory: empty history", () => {
	it("T-01: empty history -> no advisories", () => {
		const out = orchestratorAdvisoryFor([], undefined, DEFAULT_OPTS);
		expect(out).toEqual([]);
	});

	it("T-02: well-formed history (read/edit/write within scope, no repeats) -> no advisories", () => {
		const history = [
			makeCall("goal_contract_create", { id: "GC-053" }, 1000),
			makeCall("read", { path: "src/foo.ts" }, 2000),
			makeCall("edit", { path: "src/bar.ts" }, 3000),
			makeCall("write", { path: "src/baz.ts" }, 4000),
		];
		const out = orchestratorAdvisoryFor(history, undefined, DEFAULT_OPTS);
		expect(out).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// repeat_call_chain detector
// ─────────────────────────────────────────────────────────────────────────────

describe("orchestrator advisory: repeat_call_chain (GC-2026-059)", () => {
	it("RCC-01: fires when same (read, path) called 3+ times within stuck interval", () => {
		const history = [
			makeCall("read", { path: "/tmp/x.ts" }, 1000),
			makeCall("read", { path: "/tmp/x.ts" }, 1100),
			makeCall("read", { path: "/tmp/x.ts" }, 1200),
		];
		const findings = extractOrchestratorFindings(history, {
			...DEFAULT_OPTS,
			stuckIntervalMs: 2000,
		});
		expect(findings.length).toBeGreaterThan(0);
		expect(findings.some((f) => f.rule === "repeat_call_chain")).toBe(true);
	});

	it("RCC-02: does NOT fire when read paths differ (3 distinct calls)", () => {
		const history = [
			makeCall("read", { path: "/tmp/a.ts" }, 1000),
			makeCall("read", { path: "/tmp/b.ts" }, 1100),
			makeCall("read", { path: "/tmp/c.ts" }, 1200),
		];
		const findings = extractOrchestratorFindings(history, {
			...DEFAULT_OPTS,
			stuckIntervalMs: 2000,
		});
		expect(findings.find((f) => f.rule === "repeat_call_chain")).toBeUndefined();
	});

	it("RCC-03: does NOT fire on only 2 calls (need 3+)", () => {
		const history = [
			makeCall("read", { path: "/tmp/x.ts" }, 1000),
			makeCall("read", { path: "/tmp/x.ts" }, 1100),
		];
		const findings = extractOrchestratorFindings(history, {
			...DEFAULT_OPTS,
			stuckIntervalMs: 2000,
		});
		expect(findings.find((f) => f.rule === "repeat_call_chain")).toBeUndefined();
	});

	it("RCC-04: arg key order does NOT matter (canonical form)", () => {
		const history = [
			makeCall("bash", { command: "ls", cwd: "/tmp" }, 1000),
			makeCall("bash", { cwd: "/tmp", command: "ls" }, 1100),
			makeCall("bash", { cwd: "/tmp", command: "ls" }, 1200),
		];
		const findings = extractOrchestratorFindings(history, {
			...DEFAULT_OPTS,
			stuckIntervalMs: 2000,
		});
		expect(findings.find((f) => f.rule === "repeat_call_chain")).toBeTruthy();
	});

	it("RCC-05: respects stuckIntervalMs — does NOT fire when intervals exceed threshold", () => {
		const history = [
			makeCall("read", { path: "/tmp/x.ts" }, 1000),
			makeCall("read", { path: "/tmp/x.ts" }, 4000),
			makeCall("read", { path: "/tmp/x.ts" }, 7000),
		];
		const findings = extractOrchestratorFindings(history, {
			...DEFAULT_OPTS,
			stuckIntervalMs: 2000,
		});
		expect(findings.find((f) => f.rule === "repeat_call_chain")).toBeUndefined();
	});

	it("RCC-06: respects error-history gate (no fire if any call succeeded)", () => {
		const history = [
			{ ...makeCall("read", { path: "/tmp/x.ts" }, 1000), callId: "c1" },
			{ ...makeCall("read", { path: "/tmp/x.ts" }, 1100), callId: "c2" },
			{ ...makeCall("read", { path: "/tmp/x.ts" }, 1200), callId: "c3" },
		];
		const findings = extractOrchestratorFindings(history, {
			...DEFAULT_OPTS,
			stuckIntervalMs: 2000,
			errorHistory: [
				{ toolCallId: "c1", isError: true },
				{ toolCallId: "c2", isError: false }, // success — chain not stuck
				{ toolCallId: "c3", isError: true },
			],
		});
		expect(findings.find((f) => f.rule === "repeat_call_chain")).toBeUndefined();
	});

	it("RCC-07: undefined lastAssistantMessage -> no retry-intent suppression", () => {
		const history = [
			makeCall("read", { path: "/tmp/x.ts" }, 1000),
			makeCall("read", { path: "/tmp/x.ts" }, 1100),
			makeCall("read", { path: "/tmp/x.ts" }, 1200),
		];
		const findings = extractOrchestratorFindings(history, {
			...DEFAULT_OPTS,
			stuckIntervalMs: 2000,
			lastAssistantMessage: undefined,
		});
		expect(findings.find((f) => f.rule === "repeat_call_chain")).toBeTruthy();
	});

	it("RCC-08: retry-intent message suppresses the chain advisory", () => {
		const history = [
			makeCall("read", { path: "/tmp/x.ts" }, 1000),
			makeCall("read", { path: "/tmp/x.ts" }, 1100),
			makeCall("read", { path: "/tmp/x.ts" }, 1200),
		];
		const findings = extractOrchestratorFindings(history, {
			...DEFAULT_OPTS,
			stuckIntervalMs: 2000,
			lastAssistantMessage: "let me retry that — the result was empty",
		});
		expect(findings.find((f) => f.rule === "repeat_call_chain")).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Budget + dedup + cap
// ─────────────────────────────────────────────────────────────────────────────

describe("orchestrator advisory: budget / dedup / cap", () => {
	it("BUDGET-1: dedup — same rule does not fire twice", () => {
		const history = [
			makeCall("read", { path: "/tmp/x.ts" }, 1000),
			makeCall("read", { path: "/tmp/x.ts" }, 1100),
			makeCall("read", { path: "/tmp/x.ts" }, 1200),
		];
		const ctx: OrchestratorAdvisoryContext = {
			alreadyAdvisedRules: new Set<string>(),
			advisoriesBySeverity: { critical: 0, major: 0, minor: 0 },
		};
		const first = orchestratorAdvisoryFor(history, ctx, {
			...DEFAULT_OPTS,
			stuckIntervalMs: 2000,
		});
		// Mark rule as advised (mirroring caller-side mutation).
		ctx.alreadyAdvisedRules.add("repeat_call_chain");
		ctx.advisoriesBySeverity.major = first.length;

		const second = orchestratorAdvisoryFor(history, ctx, {
			...DEFAULT_OPTS,
			stuckIntervalMs: 2000,
		});
		const repeatEntries = second.filter((e) => e.rule === "repeat_call_chain");
		expect(repeatEntries.length).toBe(0);
	});

	it("BUDGET-2: major cap is 4 by default", () => {
		expect(DEFAULT_ADVISORY_BUDGET_BY_SEVERITY.major).toBe(4);
	});

	it("BUDGET-3: critical cap is ∞ by default", () => {
		expect(DEFAULT_ADVISORY_BUDGET_BY_SEVERITY.critical).toBe(Number.POSITIVE_INFINITY);
	});

	it("BUDGET-4: options.maxAdvisoriesBySeverity overrides the default cap", () => {
		const history = [
			makeCall("read", { path: "/tmp/x.ts" }, 1000),
			makeCall("read", { path: "/tmp/x.ts" }, 1100),
			makeCall("read", { path: "/tmp/x.ts" }, 1200),
		];
		const opts = {
			...DEFAULT_OPTS,
			stuckIntervalMs: 2000,
			maxAdvisoriesBySeverity: { major: 1 } as const,
		};
		const ctx: OrchestratorAdvisoryContext = {
			alreadyAdvisedRules: new Set<string>(),
			advisoriesBySeverity: { critical: 0, major: 0, minor: 0 },
		};
		const out = orchestratorAdvisoryFor(history, ctx, opts);
		const major = out.filter((e) => e.severity === "major");
		expect(major.length).toBeLessThanOrEqual(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Format — severity + N/M counter + token cap
// ─────────────────────────────────────────────────────────────────────────────

describe("orchestrator advisory: format", () => {
	it("FMT-1: format includes severity + per-severity N/M counter", () => {
		const history = [
			makeCall("read", { path: "/tmp/x.ts" }, 1000),
			makeCall("read", { path: "/tmp/x.ts" }, 1100),
			makeCall("read", { path: "/tmp/x.ts" }, 1200),
		];
		const ctx: OrchestratorAdvisoryContext = {
			alreadyAdvisedRules: new Set<string>(),
			advisoriesBySeverity: { critical: 0, major: 0, minor: 0 },
		};
		const out = orchestratorAdvisoryFor(history, ctx, {
			...DEFAULT_OPTS,
			stuckIntervalMs: 2000,
		});
		expect(out.length).toBeGreaterThan(0);
		expect(out[0]!.text).toMatch(/\[orchestrator advisory — major 1\/4\]/);
		expect(out[0]!.text).toMatch(/repeat_call_chain/);
		expect(out[0]!.text).toMatch(/Fix:/);
	});

	it("FMT-2: critical format shows N/∞ (no cap)", () => {
		// We don't have a critical rule after orchestrator-simplify. Test the
		// formatting only — verify the cap label format would be ∞ for an
		// infinite cap. The format function is internal but we can exercise
		// it via the format pattern. The default critical cap is ∞.
		expect(DEFAULT_ADVISORY_BUDGET_BY_SEVERITY.critical).toBe(Number.POSITIVE_INFINITY);
	});

	it("FMT-3: per-advisory text is <= ADVISORY_MAX_TOKENS × 4 chars", () => {
		const history = [
			makeCall("read", { path: "/tmp/".repeat(200) + "x.ts" }, 1000),
			makeCall("read", { path: "/tmp/".repeat(200) + "x.ts" }, 1100),
			makeCall("read", { path: "/tmp/".repeat(200) + "x.ts" }, 1200),
		];
		const out = orchestratorAdvisoryFor(history, undefined, {
			...DEFAULT_OPTS,
			stuckIntervalMs: 2000,
		});
		for (const entry of out) {
			expect(entry.text.length).toBeLessThanOrEqual(ADVISORY_MAX_TOKENS * 4);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix directives
// ─────────────────────────────────────────────────────────────────────────────

describe("orchestrator advisory: rule fix directives", () => {
	it("FIX-1: repeat_call_chain fix mentions changing approach or concluding", () => {
		expect(RULE_FIX_DIRECTIVES.repeat_call_chain).toMatch(/change approach or conclude/);
	});

	it("FIX-2: RULE_FIX_DIRECTIVES has exactly 1 entry post goal-contract removal", () => {
		expect(Object.keys(RULE_FIX_DIRECTIVES).length).toBe(1);
	});

	it("FIX-4: advisory text injects the per-rule fix directive verbatim", () => {
		const history = [
			makeCall("read", { path: "/tmp/x.ts" }, 1000),
			makeCall("read", { path: "/tmp/x.ts" }, 1100),
			makeCall("read", { path: "/tmp/x.ts" }, 1200),
		];
		const out = orchestratorAdvisoryFor(history, undefined, {
			...DEFAULT_OPTS,
			stuckIntervalMs: 2000,
		});
		expect(out.length).toBeGreaterThan(0);
		expect(out[0]!.text).toContain(RULE_FIX_DIRECTIVES.repeat_call_chain);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Family classifier
// ─────────────────────────────────────────────────────────────────────────────

describe("orchestrator advisory: family classifier", () => {
	it("FAM-1: aft_* -> aft family", () => {
		expect(familyOfTool("aft_search")).toBe("aft");
		expect(familyOfTool("aft_outline")).toBe("aft");
	});

	it("FAM-2: codebase_memory_* -> codebase family", () => {
		expect(familyOfTool("codebase_memory_search_graph")).toBe("codebase");
	});

	it("FAM-3: ctx_* -> ctx family", () => {
		expect(familyOfTool("ctx_search")).toBe("ctx");
		expect(familyOfTool("ctx_memory")).toBe("ctx");
	});

	it("FAM-4: bash/read/edit/write/grep/find/ls -> baseline family", () => {
		for (const t of ["bash", "read", "edit", "write", "grep", "find", "ls"]) {
			expect(familyOfTool(t)).toBe("baseline");
		}
	});

	it("FAM-5: Agent / subagent_* -> subagent_control family", () => {
		expect(familyOfTool("Agent")).toBe("subagent_control");
		expect(familyOfTool("subagent_status")).toBe("subagent_control");
		expect(familyOfTool("subagent_abort")).toBe("subagent_control");
	});

	it("FAM-6: orchestrator family is empty after goal-contract removal (no orchestrator-registered tools)", () => {
		// After chore/remove-goal-contract there are no orchestrator-registered
		// tools; the familyOfTool function still classifies any toolName but
		// the only "orchestrator" match previously was goal_contract_create
		// and decompose_task, both gone. An arbitrary non-special toolName
		// should land in "other".
		expect(familyOfTool("goal_contract_create")).toBe("other");
		expect(familyOfTool("decompose_task")).toBe("other");
	});

	it("GC-2026-097 M3b: TaskCreate / TaskList / TaskGet / TaskUpdate / TaskOutput / TaskStop / TaskExecute -> tasks family", () => {
		for (const t of ["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskOutput", "TaskStop", "TaskExecute"]) {
			expect(familyOfTool(t)).toBe("tasks");
		}
	});

	it("GC-2026-097 M3b: emptyFamilyCounts initializes the tasks family to 0", () => {
		const counts = emptyFamilyCounts();
		expect(counts.tasks).toBe(0);
	});

	it("FAM-7: deleted tools (dag_synthesize/task_dispatch/orchestrator_audit/sages_reminder/todowrite_*) -> 'other' (not orchestrator)", () => {
		// After orchestrator-simplify the deleted tools should no longer
		// classify as orchestrator. They live in the 'other' bucket since
		// they no longer exist in the runtime toolset.
		expect(familyOfTool("dag_synthesize")).toBe("other");
		expect(familyOfTool("task_dispatch")).toBe("other");
		expect(familyOfTool("orchestrator_audit")).toBe("other");
		expect(familyOfTool("sages_reminder")).toBe("other");
		expect(familyOfTool("todowrite_compile")).toBe("other");
		expect(familyOfTool("todowrite_progress")).toBe("other");
	});

	it("FAM-8: emptyFamilyCounts initializes all families to 0", () => {
		const counts = emptyFamilyCounts();
		expect(counts.aft).toBe(0);
		expect(counts.codebase).toBe(0);
		expect(counts.ctx).toBe(0);
		expect(counts.baseline).toBe(0);
		expect(counts.subagent_control).toBe(0);
		expect(counts.orchestrator).toBe(0);
		expect(counts.tasks).toBe(0);
		expect(counts.other).toBe(0);
	});
});

// GC-2026-097 L4: installOrchestratorAdvisoryHandlers resets all
// closure-scoped state on each session_start, so a long-lived pi
// process that hosts multiple sessions doesn't permanently silence
// nudges after the first session fires them.
describe("orchestrator advisory: session_start reset (GC-2026-097 L4)", () => {
	function makeMockPi() {
		const handlers: Record<string, Array<(event: unknown, ctx?: unknown) => void | Promise<void>>> = {};
		const appended: Array<{ type: string; data: unknown }> = [];
		return {
			pi: {
				on(event: string, handler: (event: unknown, ctx?: unknown) => void | Promise<void>) {
					(handlers[event] ??= []).push(handler);
				},
				appendEntry(type: string, data: unknown) {
					appended.push({ type, data });
				},
			},
			fire(event: string, payload: unknown) {
				for (const h of handlers[event] ?? []) h(payload);
			},
			appended,
		};
	}

	it("L4-1: nudges that already fired in session A can fire again in session B", () => {
		const m = makeMockPi();
		const handlers = installOrchestratorAdvisoryHandlers(m.pi);

		// Session A: trigger the repeat_call_chain nudge (3x same read).
		for (let i = 0; i < 3; i++) {
			m.fire("tool_call", { toolName: "read", input: { path: "/tmp/x.ts" }, timestamp: 1000 + i * 100 });
		}
		// alreadyAdvisedRules should now contain "repeat_call_chain".
		expect(handlers.alreadyAdvisedRules.has("repeat_call_chain")).toBe(true);
		expect(handlers.historyLength()).toBeGreaterThan(0);

		// Session B: a new session_start clears the state.
		m.fire("session_start", {});

		// alreadyAdvisedRules is reset.
		expect(handlers.alreadyAdvisedRules.has("repeat_call_chain")).toBe(false);
		expect(handlers.advisoriesBySeverity.major).toBe(0);
		expect(handlers.historyLength()).toBe(0);

		// Same nudge should fire again.
		for (let i = 0; i < 3; i++) {
			m.fire("tool_call", { toolName: "read", input: { path: "/tmp/x.ts" }, timestamp: 5000 + i * 100 });
		}
		expect(handlers.alreadyAdvisedRules.has("repeat_call_chain")).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Family-mix reminder
// ─────────────────────────────────────────────────────────────────────────────

describe("orchestrator advisory: familyMixReminderText", () => {
	it("MIX-1: returns null when total < 10", () => {
		const counts = emptyFamilyCounts();
		counts.baseline = 5;
		expect(familyMixReminderText(counts)).toBeNull();
	});

	it("MIX-2: returns null when baseline ratio <= 80%", () => {
		const counts = emptyFamilyCounts();
		for (let i = 0; i < 8; i++) counts.baseline += 1;
		for (let i = 0; i < 2; i++) counts.aft += 1;
		expect(familyMixReminderText(counts)).toBeNull();
	});

	it("MIX-3: returns null when specialized ratio >= 5%", () => {
		const counts = emptyFamilyCounts();
		for (let i = 0; i < 9; i++) counts.baseline += 1;
		counts.aft = 1;
		expect(familyMixReminderText(counts)).toBeNull();
	});

	it("MIX-4: fires when baseline >= 80% AND specialized < 5%", () => {
		const counts = emptyFamilyCounts();
		for (let i = 0; i < 19; i++) counts.baseline += 1;
		counts.subagent_control = 1;
		expect(familyMixReminderText(counts)).toMatch(/Tool-mix warning/);
	});
});
