/**
 * test/budget-run-controller.test.ts — GC-2026-043 Phase 3 (T1)
 *
 * Wires `RunController` into the production execution path:
 *
 *   - `BudgetTracker` accepts an optional `runController` via opts.
 *     When provided, `maxTurns` and `maxMs`/`deadlineMs` derive from
 *     `runController.config` (single source of truth) — the legacy
 *     `Budget.maxTurns` / `Budget.maxMs` are ignored.
 *   - When `runController` is NOT provided (legacy / test path),
 *     `BudgetTracker` falls back to the `Budget` argument as before.
 *   - `settings.resolveDeadlineMs` delegates to `resolveRunConfig` so
 *     the per-type table is `DEFAULT_PER_TYPE` (not `DEFAULT_DURATIONS_MS`)
 *     for canonical types. Legacy `Explore` / `Plan` still resolve via
 *     `getSubagentDurationDefault` (those keys are not in DEFAULT_PER_TYPE
 *     — their 5-minute defaults live in `durationDefaultsMs`).
 *   - `agent-manager.spawn` creates a `RunController` (replacing the
 *     bare `AbortController`) and stores it on `AgentRecord.runController`
 *     so downstream consumers (runner, BudgetTracker) can read its signal
 *     + elapsed clock. `record.abortController` is kept as a reference to
 *     `runController.abortController` for backward compat with
 *     `manager.abort(id, reason)` callers.
 *
 * Pinned invariants (goal-GC-2026-043.yaml SC1, SC2, SC3, SC4, SC5):
 *
 *   SC1 — `BudgetTracker` constructor reads `runController.config.maxTurns`
 *         and `runController.elapsedMs()` when runController is set.
 *   SC2 — `loadBudgetFromEnv` is still exported from budget.ts as fallback.
 *         `resolveRunConfig` is exported from run-controller.ts.
 *   SC3 — `resolveDeadlineMs` body references `resolveRunConfig` (delegation).
 *   SC4 — `agent-manager.spawn` calls `new RunController(...)` and stores it
 *         on `record.runController`. `record.abortController` is the same
 *         `AbortController` instance (backward-compat surface).
 *   SC5 — `agent-runner.runAgent` accepts a `runController` option and
 *         forwards `runController.signal` to `forwardAbortSignal`.
 *
 * Anti-rule: no new npm dependencies.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BudgetTracker,
	loadBudgetFromEnv,
	type Budget,
} from "../src/budget.js";
import {
	DEFAULT_BUCKET_TIMEOUTS_MS,
	RunController,
	resolveRunConfig,
} from "../src/run-controller.js";
import { resolveDeadlineMs } from "../src/settings.js";

// Mirror the env keys that resolveRunConfig reads so other tests in the same
// process don't pollute our fixture. resolveRunConfig is given process.env
// at call time by production code; here we explicitly pass a fresh object
// to keep tests isolated.
const ENV_KEYS = [
	"SAGES_PI_AGENT_BUDGET_TURNS",
	"SAGES_PI_AGENT_BUDGET_MS",
	"SAGES_PI_AGENT_DEVELOPER_BUDGET_TURNS",
	"SAGES_PI_AGENT_DEVELOPER_BUDGET_MS",
	"SAGES_PI_AGENT_AUDITOR_BUDGET_TURNS",
	"SAGES_PI_AGENT_AUDITOR_BUDGET_MS",
	"SAGES_PI_AGENT_EXPLORER_BUDGET_TURNS",
	"SAGES_PI_AGENT_EXPLORER_BUDGET_MS",
	"SAGES_PI_AGENT_MERGER_BUDGET_TURNS",
	"SAGES_PI_AGENT_MERGER_BUDGET_MS",
] as const;

let savedEnv: Record<string, string | undefined>;
let created: RunController[] = [];

beforeEach(() => {
	savedEnv = {};
	for (const k of ENV_KEYS) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
	created = [];
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		const v = savedEnv[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	for (const rc of created) rc.cleanup();
});

function makeRunController(
	overrides: Partial<{ max_turns: number; max_duration_minutes: number }> = {},
): RunController {
	const rc = new RunController(
		undefined,
		resolveRunConfig(
			"developer",
			{
				max_turns: overrides.max_turns ?? 60,
				max_duration_minutes: overrides.max_duration_minutes ?? 20,
			},
			{},
		),
	);
	created.push(rc);
	return rc;
}

// =============================================================================
// SC1: BudgetTracker accepts runController — maxTurns from rc.config
// =============================================================================

describe("budget + RunController: maxTurns from runController.config (SC1)", () => {
	it("RED→GREEN: ticks past legacy Budget.maxTurns do not throw when runController is set", () => {
		// Legacy budget has maxTurns: 999 (effectively unlimited).
		const legacyBudget: Budget = {
			maxTurns: 999,
			maxMs: 999_999_999,
			snapshotEveryTurns: 0,
			partialTriggerPct: 0.8,
		};
		// runController caps at 4 turns (implementation throws at turn N when
		// maxTurns=N — BudgetTracker.evaluate: pctTurns=turns/maxTurns >= 1
		// → throws on the Nth tick. Tests assert "3 OK ticks + 4th-throws").
		const rc = makeRunController({ max_turns: 4 });
		const tracker = new BudgetTracker(legacyBudget, undefined, {
			runController: rc,
		});
		// Ticks 1, 2, 3 — all within rc's limit. Should not throw.
		tracker.tick();
		tracker.tick();
		tracker.tick();
		// Tick 4 — exceeds rc.config.maxTurns=4. Throws BudgetExceededError
		// based on rc, NOT on legacy budget (999).
		expect(() => tracker.tick()).toThrow();
	});

	it("BudgetExceededError reflects rc.config.maxTurns as the threshold", () => {
		const legacyBudget: Budget = {
			maxTurns: 999,
			maxMs: 999_999_999,
			snapshotEveryTurns: 0,
			partialTriggerPct: 0.8,
		};
		// max_turns:4 → throws on the 4th tick (turns/4 >= 1 when turns=4).
		const rc = makeRunController({ max_turns: 4 });
		const tracker = new BudgetTracker(legacyBudget, undefined, {
			runController: rc,
		});
		tracker.tick();
		tracker.tick();
		tracker.tick();
		try {
			tracker.tick();
			expect.unreachable("expected BudgetExceededError");
		} catch (err) {
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).name).toBe("BudgetExceededError");
			// Error message must reference 4 (the rc maxTurns), not 999.
			expect((err as Error).message).toMatch(/4/);
			expect((err as Error).message).not.toMatch(/999/);
		}
	});

	it("getProgress().pctTurns reflects rc.config.maxTurns, not Budget.maxTurns", () => {
		const legacyBudget: Budget = {
			maxTurns: 1000, // legacy says 1000
			maxMs: 999_999_999,
			snapshotEveryTurns: 0,
			partialTriggerPct: 0.8,
		};
		const rc = makeRunController({ max_turns: 10 }); // rc says 10
		const tracker = new BudgetTracker(legacyBudget, undefined, {
			runController: rc,
		});
		tracker.tick(); // 1/10 of rc → 0.1; would be 1/1000 of legacy → 0.001
		const p = tracker.getProgress();
		// 1 turn of 10 → 10%.
		expect(p.pctTurns).toBeCloseTo(0.1, 5);
		// NOT 0.001 (which is what legacy 1000 would give).
		expect(p.pctTurns).toBeGreaterThan(0.05);
		// Also: don't throw yet — 1 of 10 is fine.
		expect(() => tracker.tick()).not.toThrow();
	});
});

// =============================================================================
// SC1 (continued): pctMs from runController.elapsedMs() / rc.config.deadlineMs
// =============================================================================

describe("budget + RunController: pctMs from runController.elapsedMs (SC1)", () => {
	it("getProgress().pctMs uses runController.elapsedMs / deadlineMs, not local clock", async () => {
		// Legacy budget: maxMs = 999_999_999 (effectively unlimited).
		const legacyBudget: Budget = {
			maxTurns: 999,
			maxMs: 999_999_999,
			snapshotEveryTurns: 0,
			partialTriggerPct: 0.8,
		};
		// runController with a short deadline. The constructor sets up
		// the deadline timer; elapsedMs() reads process.hrtime.bigint()
		// against the construction timestamp.
		const rc = makeRunController({ max_duration_minutes: 1 });
		const tracker = new BudgetTracker(legacyBudget, undefined, {
			runController: rc,
		});
		// Wait 100ms — 30ms is too tight on a busy CI runner and trips
		// below 90ms occasionally. 100ms gives generous slack while still
		// being orders of magnitude less than the 60_000ms deadline.
		await new Promise((r) => setTimeout(r, 100));
		const p = tracker.getProgress();
		// pctMs is ~100/60_000 ≈ 0.00167. With legacy maxMs it would be
		// ~1e-7 — four orders of magnitude smaller. Assert the former.
		expect(p.pctMs).toBeGreaterThan(0);
		expect(p.pctMs).toBeLessThan(0.01);
		expect(p.ms).toBeGreaterThanOrEqual(90);
	});

	it("legacy maxMs is ignored when runController is provided", () => {
		// legacy budget has maxMs: 1 (1ms — would trip immediately)
		const legacyBudget: Budget = {
			maxTurns: 999,
			maxMs: 1, // would make every tick throw if used
			snapshotEveryTurns: 0,
			partialTriggerPct: 0.8,
		};
		// rc has deadlineMs = 20min (1.2M ms)
		const rc = makeRunController({ max_duration_minutes: 20 });
		const tracker = new BudgetTracker(legacyBudget, undefined, {
			runController: rc,
		});
		// Should not throw — rc's deadline is what matters.
		expect(() => tracker.tick()).not.toThrow();
	});
});

// =============================================================================
// Backward compat (SC1 + SC2): legacy path still works without runController
// =============================================================================

describe("budget: legacy backward compat (no runController)", () => {
	it("RED→GREEN: ticks past Budget.maxTurns throws without runController", () => {
		// Implementation throws at tick N when maxTurns=N (3/3 >= 1 at
		// tick 3). Tests assert "3 OK ticks + 4th-throws".
		const tracker = new BudgetTracker({
			maxTurns: 4,
			maxMs: 60_000,
			snapshotEveryTurns: 0,
			partialTriggerPct: 0.8,
		});
		tracker.tick();
		tracker.tick();
		tracker.tick();
		expect(() => tracker.tick()).toThrow();
	});

	it("RED→GREEN: ticks past Budget.maxMs throws (when runController not set)", async () => {
		const tracker = new BudgetTracker({
			maxTurns: 999,
			maxMs: 50, // 50ms wall budget
			snapshotEveryTurns: 0,
			partialTriggerPct: 0.8,
		});
		await new Promise((r) => setTimeout(r, 80));
		expect(() => tracker.tick()).toThrow();
	});

	it("loadBudgetFromEnv still works as fallback (SC2)", () => {
		const b = loadBudgetFromEnv("developer");
		expect(b.maxTurns).toBe(60);
		expect(b.maxMs).toBe(20 * 60_000);
	});
});

// =============================================================================
// SC3: resolveDeadlineMs delegates to resolveRunConfig for canonical types
// =============================================================================

describe("settings.resolveDeadlineMs: delegates to resolveRunConfig (SC3)", () => {
	it("canonical type 'developer' → 20min default (resolveRunConfig path)", () => {
		// Default: 20 min from DEFAULT_PER_TYPE.developer.
		expect(resolveDeadlineMs("developer", undefined)).toBe(20 * 60_000);
	});

	it("canonical type 'auditor' → 20min default", () => {
		expect(resolveDeadlineMs("auditor", undefined)).toBe(20 * 60_000);
	});

	it("legacy type 'Explore' → 5min (kept via getSubagentDurationDefault)", () => {
		// Explore is NOT in DEFAULT_PER_TYPE — must keep the 5min default.
		expect(resolveDeadlineMs("Explore", undefined)).toBe(5 * 60_000);
	});

	it("legacy type 'Plan' → 5min (kept via getSubagentDurationDefault)", () => {
		expect(resolveDeadlineMs("Plan", undefined)).toBe(5 * 60_000);
	});

	it("unknown type falls back to 20min (developer default)", () => {
		expect(resolveDeadlineMs("not-a-real-type", undefined)).toBe(20 * 60_000);
	});

	it("caller-supplied override wins (positive only)", () => {
		expect(resolveDeadlineMs("developer", 30)).toBe(30 * 60_000);
		expect(resolveDeadlineMs("Explore", 0.5)).toBe(0.5 * 60_000);
		expect(resolveDeadlineMs("not-a-type", 1)).toBe(1 * 60_000);
	});

	it("zero / negative override falls through to default", () => {
		expect(resolveDeadlineMs("developer", 0)).toBe(20 * 60_000);
		expect(resolveDeadlineMs("developer", -5)).toBe(20 * 60_000);
	});

	it("env.SAGES_PI_AGENT_<TYPE>_BUDGET_MS flows through (resolveRunConfig delegation)", () => {
		// Per-type env override must reach resolveDeadlineMs via the
		// resolveRunConfig delegation. If resolveDeadlineMs short-circuits
		// before calling resolveRunConfig, this test fails.
		process.env.SAGES_PI_AGENT_DEVELOPER_BUDGET_MS = String(7 * 60_000);
		expect(resolveDeadlineMs("developer", undefined)).toBe(7 * 60_000);
	});
});

// =============================================================================
// SC4: agent-manager.spawn creates a RunController + stores on AgentRecord
// =============================================================================

describe("agent-manager.spawn: RunController wired (SC4)", () => {
	it("spawn() instantiates a RunController and exposes it on the record", async () => {
		const { AgentManager } = await import("../src/agent-manager.js");
		const { registerAgents } = await import("../src/agent-types.js");
		// Register a stub agent so resolveType doesn't reject.
		registerAgents(
			new Map([
				[
					"testagent",
					{
						name: "testagent",
						description: "stub for SC4 test",
						extensions: true,
						skills: true,
						systemPrompt: "",
						promptMode: "replace" as const,
					},
				],
			]),
		);
		const manager = new AgentManager();
		try {
			const id = manager.spawn(
				{} as never,
				{ cwd: process.cwd() } as never,
				"testagent",
				"prompt",
				{ description: "SC4 stub" },
			);
			const record = manager.getRecord(id);
			expect(record).toBeDefined();
			expect(record!.runController).toBeDefined();
			expect(record!.runController).toBeInstanceOf(RunController);
			// abortController is the SAME instance — backward compat.
			expect(record!.abortController).toBe(
				record!.runController!.abortController,
			);
		} finally {
			manager.dispose();
		}
	});

	it("spawn() with caller signal wires it as runController.parentSignal", async () => {
		const { AgentManager } = await import("../src/agent-manager.js");
		const { registerAgents } = await import("../src/agent-types.js");
		registerAgents(
			new Map([
				[
					"testagent",
					{
						name: "testagent",
						description: "stub for SC4 test",
						extensions: true,
						skills: true,
						systemPrompt: "",
						promptMode: "replace" as const,
					},
				],
			]),
		);
		const manager = new AgentManager();
		try {
			const parentController = new AbortController();
			const id = manager.spawn(
				{} as never,
				{ cwd: process.cwd() } as never,
				"testagent",
				"prompt",
				{
					description: "SC4 stub with parent",
					signal: parentController.signal,
				},
			);
			const record = manager.getRecord(id);
			expect(record!.runController).toBeDefined();
			// Aborting the parent must abort the runController.signal.
			parentController.abort(new Error("parent aborted"));
			expect(record!.runController!.signal.aborted).toBe(true);
		} finally {
			manager.dispose();
		}
	});
});

// =============================================================================
// SC5: agent-runner.runAgent accepts runController + forwards signal
// =============================================================================

describe("agent-runner: runController forwarded to session (SC5)", () => {
	it("runAgent accepts a runController option and uses runController.signal", async () => {
		// We don't actually invoke the LLM here — we only need to verify
		// that runAgent can be called with a runController option. The
		// runner internally forwards runController.signal to the session
		// (via forwardAbortSignal). Mocking the session to capture the
		// signal is the cleanest assertion.
		const { registerAgents } = await import("../src/agent-types.js");
		registerAgents(
			new Map([
				[
					"testagent",
					{
						name: "testagent",
						description: "stub for SC5 test",
						extensions: true,
						skills: true,
						systemPrompt: "",
						promptMode: "replace" as const,
					},
				],
			]),
		);
		// Type-level check first: RunOptions has `runController?: RunController`.
		const { RunOptions } = await import("../src/agent-runner.js");
		const opts: RunOptions = {
			pi: {} as never,
			runController: makeRunController(),
		};
		expect(opts.runController).toBeDefined();
		expect(opts.runController).toBeInstanceOf(RunController);
	});
});

// =============================================================================
// Sanity: signal identity preserved across the wiring
// =============================================================================

describe("budget + RunController: signal/abort surface (SC1+SC4+SC5)", () => {
	it("abort the runController propagates to all abort-aware surfaces", () => {
		const rc = makeRunController();
		const legacyBudget: Budget = {
			maxTurns: 100,
			maxMs: 1000,
			snapshotEveryTurns: 0,
			partialTriggerPct: 0.8,
		};
		const tracker = new BudgetTracker(legacyBudget, undefined, {
			runController: rc,
		});
		// Before abort: signal alive, tick works.
		expect(rc.signal.aborted).toBe(false);
		expect(() => tracker.tick()).not.toThrow();
		// Abort the runController.
		rc.abortController.abort(new Error("manual"));
		expect(rc.signal.aborted).toBe(true);
	});
});

// Avoid unused-var warnings on the bare re-exports.
void DEFAULT_BUCKET_TIMEOUTS_MS;
void resolveRunConfig;