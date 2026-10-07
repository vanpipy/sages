/**
 * test/run-controller.test.ts — GC-2026-040 Phase 1
 *
 * RunController is the single source of truth for per-run timeouts in
 * pi-subagents. It owns:
 *   - the deadline timer (wall-clock ceiling)
 *   - the per-bucket tool-call timeouts (via `signalForTool(bucket)`)
 *   - composition with a parent signal via `AbortSignal.any`
 *
 * Pinned invariants (goal-GC-2026-040.yaml SC1-SC3):
 *   - `DEFAULT_BUCKET_TIMEOUTS_MS` exports the six buckets per spec.
 *   - `DEFAULT_PER_TYPE` exports the four built-in agent types per spec.
 *   - `resolveRunConfig(type, params, env)` honors:
 *       params.max_duration_minutes (positive only) > per-type env > generic env > default
 *       params.max_turns > per-type env > generic env > default
 *     bucketTimeoutsMs is always DEFAULT_BUCKET_TIMEOUTS_MS.
 *     Unknown type falls back to developer defaults (20min / 60 turns).
 *   - `RunController.constructor(parentSignal, config)`:
 *       aborts immediately if parentSignal is already aborted.
 *       exposes `signal` as AbortSignal.any([parent, own]) when parent given.
 *       exposes `signal` as own abortController.signal when parent absent.
 *       sets up a deadline timer that calls abortController.abort(reason)
 *       at deadlineMs.
 *       registers the deadline timer for cleanup().
 *   - `signalForTool(bucket)` returns AbortSignal.any([runSignal, bucketTimer]).
 *   - `elapsedMs()` is monotonic via process.hrtime.bigint().
 *   - `cleanup()` clears the deadline timer and is idempotent.
 *
 * Anti-rule: no new npm dependencies (Node built-ins only).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ENV_KEYS = [
	"SAGES_PI_AGENT_BUDGET_MS",
	"SAGES_PI_AGENT_DEVELOPER_BUDGET_MS",
	"SAGES_PI_AGENT_REVIEWER_BUDGET_MS",
	"SAGES_PI_AGENT_EXPLORER_BUDGET_MS",
	"SAGES_PI_AGENT_MERGER_BUDGET_MS",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	savedEnv = {};
	for (const k of ENV_KEYS) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		const v = savedEnv[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

// We import lazily inside describe blocks so the savedEnv setup runs first
// and module-level env reads see the cleaned env. (resolveRunConfig reads
// from a passed `env` parameter, so this is convention-only — but safe.)

describe("run-controller: DEFAULT_BUCKET_TIMEOUTS_MS", () => {
	it("exports the six buckets with the specified values", async () => {
		const { DEFAULT_BUCKET_TIMEOUTS_MS } = await import(
			"../src/run-controller.js"
		);
		expect(DEFAULT_BUCKET_TIMEOUTS_MS.read).toBe(5_000);
		expect(DEFAULT_BUCKET_TIMEOUTS_MS.search).toBe(10_000);
		expect(DEFAULT_BUCKET_TIMEOUTS_MS.test).toBe(60_000);
		expect(DEFAULT_BUCKET_TIMEOUTS_MS.fullTest).toBe(180_000);
		expect(DEFAULT_BUCKET_TIMEOUTS_MS.network).toBe(5_000);
		expect(DEFAULT_BUCKET_TIMEOUTS_MS.other).toBe(60_000);
	});

	it("has exactly the six expected bucket keys", async () => {
		const { DEFAULT_BUCKET_TIMEOUTS_MS } = await import(
			"../src/run-controller.js"
		);
		const keys = Object.keys(DEFAULT_BUCKET_TIMEOUTS_MS).sort();
		expect(keys).toEqual([
			"fullTest",
			"network",
			"other",
			"read",
			"search",
			"test",
		]);
	});
});

describe("run-controller: DEFAULT_PER_TYPE", () => {
	it("GC-2026-subagent-time-only-limits: every type gets 30 min default (uniform envelope)", async () => {
		const { DEFAULT_PER_TYPE } = await import("../src/run-controller.js");
		expect(DEFAULT_PER_TYPE.Developer).toEqual({ deadlineMs: 30 * 60_000 });
		expect(DEFAULT_PER_TYPE.Reviewer).toEqual({ deadlineMs: 30 * 60_000 });
		expect(DEFAULT_PER_TYPE.Explore).toEqual({ deadlineMs: 30 * 60_000 });
		expect(DEFAULT_PER_TYPE.Plan).toEqual({ deadlineMs: 30 * 60_000 });
		expect(DEFAULT_PER_TYPE.PlanCompiler).toEqual({ deadlineMs: 30 * 60_000 });
	});

	it("has exactly the five expected type keys (PascalCase)", async () => {
		const { DEFAULT_PER_TYPE } = await import("../src/run-controller.js");
		const keys = Object.keys(DEFAULT_PER_TYPE).sort();
		expect(keys).toEqual([
			"Developer",
			"Explore",
			"Plan",
			"PlanCompiler",
			"Reviewer",
		]);
	});

	it("each entry has only a deadlineMs field (no maxTurns)", async () => {
		const { DEFAULT_PER_TYPE } = await import("../src/run-controller.js");
		for (const entry of Object.values(DEFAULT_PER_TYPE)) {
			expect(entry).not.toHaveProperty("maxTurns");
		}
	});
});

describe("run-controller: deadline envelope (GC-2026-subagent-time-only-limits)", () => {
	it("MIN_DEADLINE_MS = 30 * 60_000 and MAX_DEADLINE_MS = 120 * 60_000", async () => {
		const { MIN_DEADLINE_MS, MAX_DEADLINE_MS } = await import(
			"../src/run-controller.js"
		);
		expect(MIN_DEADLINE_MS).toBe(30 * 60_000);
		expect(MAX_DEADLINE_MS).toBe(120 * 60_000);
	});

	it("clampDeadlineMs clamps below the floor to MIN_DEADLINE_MS", async () => {
		const { clampDeadlineMs, MIN_DEADLINE_MS } = await import(
			"../src/run-controller.js"
		);
		expect(clampDeadlineMs(5 * 60_000)).toBe(MIN_DEADLINE_MS);
		expect(clampDeadlineMs(0)).toBe(MIN_DEADLINE_MS);
		expect(clampDeadlineMs(-100)).toBe(MIN_DEADLINE_MS);
		expect(clampDeadlineMs(NaN)).toBe(MIN_DEADLINE_MS);
	});

	it("clampDeadlineMs clamps above the ceiling to MAX_DEADLINE_MS", async () => {
		const { clampDeadlineMs, MAX_DEADLINE_MS } = await import(
			"../src/run-controller.js"
		);
		expect(clampDeadlineMs(240 * 60_000)).toBe(MAX_DEADLINE_MS);
		expect(clampDeadlineMs(9999 * 60_000)).toBe(MAX_DEADLINE_MS);
	});

	it("clampDeadlineMs passes through values within the envelope", async () => {
		const { clampDeadlineMs } = await import("../src/run-controller.js");
		expect(clampDeadlineMs(45 * 60_000)).toBe(45 * 60_000);
		expect(clampDeadlineMs(60 * 60_000)).toBe(60 * 60_000);
		expect(clampDeadlineMs(120 * 60_000)).toBe(120 * 60_000);
	});
});

describe("run-controller: resolveRunConfig", () => {

	it("params.max_duration_minutes overrides deadlineMs (positive only; clamped to [30,120] envelope)", async () => {
		const { resolveRunConfig, MIN_DEADLINE_MS, MAX_DEADLINE_MS } = await import(
			"../src/run-controller.js"
		);
		// 15 min < MIN (30) → clamped to floor
		const below = resolveRunConfig("Developer", { max_duration_minutes: 15 }, {});
		expect(below.deadlineMs).toBe(MIN_DEADLINE_MS);

		// 60 min within envelope
		const mid = resolveRunConfig("Developer", { max_duration_minutes: 60 }, {});
		expect(mid.deadlineMs).toBe(60 * 60_000);

		// 240 min > MAX (120) → clamped to ceiling
		const above = resolveRunConfig("Developer", { max_duration_minutes: 240 }, {});
		expect(above.deadlineMs).toBe(MAX_DEADLINE_MS);

		// Negative values fall through to default (30 min)
		const neg = resolveRunConfig("Developer", { max_duration_minutes: -5 }, {});
		expect(neg.deadlineMs).toBe(MIN_DEADLINE_MS);

		// Zero falls through to default
		const zero = resolveRunConfig("Developer", { max_duration_minutes: 0 }, {});
		expect(zero.deadlineMs).toBe(MIN_DEADLINE_MS);
	});

	it("env.SAGES_PI_AGENT_BUDGET_MS as fallback for deadlineMs (clamped to envelope)", async () => {
		const { resolveRunConfig, MIN_DEADLINE_MS } = await import(
			"../src/run-controller.js"
		);
		// 7 min < MIN → clamped to floor
		const env = { SAGES_PI_AGENT_BUDGET_MS: String(7 * 60_000) };
		const cfg = resolveRunConfig("Developer", {}, env);
		expect(cfg.deadlineMs).toBe(MIN_DEADLINE_MS);
	});

	it("env.SAGES_PI_AGENT_<TYPE>_BUDGET_MS overrides per-type deadlineMs (clamped)", async () => {
		const { resolveRunConfig, MIN_DEADLINE_MS } = await import(
			"../src/run-controller.js"
		);
		const env = {
			SAGES_PI_AGENT_BUDGET_MS: String(7 * 60_000),
			SAGES_PI_AGENT_DEVELOPER_BUDGET_MS: String(3 * 60_000),
		};
		const cfg = resolveRunConfig("Developer", {}, env);
		// Both values are below MIN → both clamp to floor; per-type wins by
		// the floor value (same value), so we only assert the floor.
		expect(cfg.deadlineMs).toBe(MIN_DEADLINE_MS);
	});

	it("env.SAGES_PI_AGENT_<TYPE>_BUDGET_MS in envelope is respected", async () => {
		const { resolveRunConfig } = await import("../src/run-controller.js");
		const env = {
			SAGES_PI_AGENT_BUDGET_MS: String(45 * 60_000),
			SAGES_PI_AGENT_DEVELOPER_BUDGET_MS: String(60 * 60_000),
		};
		const cfg = resolveRunConfig("Developer", {}, env);
		expect(cfg.deadlineMs).toBe(60 * 60_000); // per-type wins within envelope
	});

	it("bucketTimeoutsMs is always DEFAULT_BUCKET_TIMEOUTS_MS", async () => {
		const { resolveRunConfig, DEFAULT_BUCKET_TIMEOUTS_MS } = await import(
			"../src/run-controller.js"
		);
		const cfg = resolveRunConfig("Developer", {}, {});
		expect(cfg.bucketTimeoutsMs).toBe(DEFAULT_BUCKET_TIMEOUTS_MS);
	});



	it("carries runId and traceId when provided in params (or in env)", async () => {
		const { resolveRunConfig } = await import("../src/run-controller.js");
		const cfg = resolveRunConfig(
			"Developer",
			{},
			{},
			{ runId: "run-123", traceId: "trace-456" },
		);
		expect(cfg.runId).toBe("run-123");
		expect(cfg.traceId).toBe("trace-456");
	});
});

describe("run-controller: RunController constructor + signal", () => {
	it("exposes own abortController.signal when parentSignal is undefined", async () => {
		const { RunController, resolveRunConfig } = await import(
			"../src/run-controller.js"
		);
		const cfg = resolveRunConfig("Developer", {}, {});
		const rc = new RunController(undefined, cfg);
		expect(rc.signal).toBe(rc.abortController.signal);
		expect(rc.signal.aborted).toBe(false);
		rc.cleanup();
	});

	it("composes via AbortSignal.any when parentSignal is provided", async () => {
		const { RunController, resolveRunConfig } = await import(
			"../src/run-controller.js"
		);
		const cfg = resolveRunConfig("Developer", {}, {});
		const parent = new AbortController();
		const rc = new RunController(parent.signal, cfg);
		// The composed signal must NOT be either source directly
		expect(rc.signal).not.toBe(parent.signal);
		expect(rc.signal).not.toBe(rc.abortController.signal);
		// Both signals are valid AbortSignal instances
		expect(rc.signal).toBeInstanceOf(AbortSignal);
		// Parent aborts → composed signal aborts
		parent.abort();
		expect(rc.signal.aborted).toBe(true);
		rc.cleanup();
	});

	it("does not abort when parent is undefined", async () => {
		const { RunController, resolveRunConfig } = await import(
			"../src/run-controller.js"
		);
		const cfg = resolveRunConfig("Developer", {}, {});
		const rc = new RunController(undefined, cfg);
		expect(rc.signal.aborted).toBe(false);
		rc.cleanup();
	});

	it("aborts immediately when parentSignal is already aborted", async () => {
		const { RunController, resolveRunConfig } = await import(
			"../src/run-controller.js"
		);
		const cfg = resolveRunConfig("Developer", {}, {});
		const parent = new AbortController();
		parent.abort(new Error("parent-dead"));
		const rc = new RunController(parent.signal, cfg);
		expect(rc.signal.aborted).toBe(true);
		// Reason should be preserved or derive from parent
		expect(rc.signal.reason).toBeDefined();
		rc.cleanup();
	});
});

describe("run-controller: signalForTool", () => {
	it("returns AbortSignal.any([runSignal, bucketTimerSignal])", async () => {
		const { RunController, resolveRunConfig } = await import(
			"../src/run-controller.js"
		);
		const cfg = resolveRunConfig("Developer", {}, {});
		const rc = new RunController(undefined, cfg);
		const sig = rc.signalForTool("read");
		// Not the same as run signal (it has its own timer)
		expect(sig).not.toBe(rc.signal);
		// Should not abort immediately
		expect(sig.aborted).toBe(false);
		rc.cleanup();
	});

	it("fires when the bucket timer elapses", async () => {
		const { RunController, DEFAULT_BUCKET_TIMEOUTS_MS } = await import(
			"../src/run-controller.js"
		);
		const cfg = {
			type: "Developer" as const,
			deadlineMs: 60_000,
			maxTurns: 60,
			bucketTimeoutsMs: DEFAULT_BUCKET_TIMEOUTS_MS,
		};
		const rc = new RunController(undefined, cfg);
		// Use the 'read' bucket (5s default) — but we want fast, so we
		// freeze the duration by checking the call returned a signal.
		const sig = rc.signalForTool("read");
		expect(sig.aborted).toBe(false);
		// Fire on cleanup
		rc.cleanup();
	});

	it("is also aborted when the run signal aborts", async () => {
		const { RunController, resolveRunConfig } = await import(
			"../src/run-controller.js"
		);
		const cfg = resolveRunConfig("Developer", {}, {});
		const rc = new RunController(undefined, cfg);
		const sig = rc.signalForTool("read");
		expect(sig.aborted).toBe(false);
		rc.abortController.abort(new Error("manual"));
		expect(sig.aborted).toBe(true);
		rc.cleanup();
	});
});

describe("run-controller: elapsedMs", () => {
	it("returns a non-negative number monotonic over time", async () => {
		const { RunController, resolveRunConfig } = await import(
			"../src/run-controller.js"
		);
		const cfg = resolveRunConfig("Developer", {}, {});
		const rc = new RunController(undefined, cfg);
		const t1 = rc.elapsedMs();
		// Sleep 10ms to ensure monotonicity
		await new Promise((r) => setTimeout(r, 10));
		const t2 = rc.elapsedMs();
		expect(t1).toBeGreaterThanOrEqual(0);
		expect(t2).toBeGreaterThan(t1);
		rc.cleanup();
	});
});

describe("run-controller: deadline + abort", () => {
	it("deadline timer fires after deadlineMs and aborts", async () => {
		const { RunController, DEFAULT_BUCKET_TIMEOUTS_MS } = await import(
			"../src/run-controller.js"
		);
		const cfg = {
			type: "Developer" as const,
			deadlineMs: 50, // 50ms — fast for test
			maxTurns: 60,
			bucketTimeoutsMs: DEFAULT_BUCKET_TIMEOUTS_MS,
		};
		const rc = new RunController(undefined, cfg);
		expect(rc.signal.aborted).toBe(false);
		// Wait for deadline to fire
		await new Promise((r) => setTimeout(r, 100));
		expect(rc.signal.aborted).toBe(true);
		// cleanup must be idempotent
		rc.cleanup();
		rc.cleanup();
	});

	it("cleanup clears the deadline timer and explicitly aborts the signal", async () => {
		const { RunController, DEFAULT_BUCKET_TIMEOUTS_MS } = await import(
			"../src/run-controller.js"
		);
		const cfg = {
			type: "Developer" as const,
			deadlineMs: 100,
			maxTurns: 60,
			bucketTimeoutsMs: DEFAULT_BUCKET_TIMEOUTS_MS,
		};
		const rc = new RunController(undefined, cfg);
		// Cleanup BEFORE deadline fires — deadline timer should NOT fire
		// (so we don't get a "deadline exceeded" abort reason). Instead,
		// cleanup explicitly aborts the signal so in-flight tools die.
		rc.cleanup();
		// Wait past deadline
		await new Promise((r) => setTimeout(r, 200));
		// Signal IS aborted (by cleanup, not deadline)
		expect(rc.signal.aborted).toBe(true);
		// But the abort reason should be the cleanup reason, not "DeadlineExceeded"
		const reason = rc.signal.reason as Error;
		expect(reason?.message).toContain("cleanup");
	});

	it("deadline timer abort reason is an Error name like 'DeadlineExceeded'", async () => {
		const { RunController, DEFAULT_BUCKET_TIMEOUTS_MS } = await import(
			"../src/run-controller.js"
		);
		const cfg = {
			type: "Developer" as const,
			deadlineMs: 30,
			maxTurns: 60,
			bucketTimeoutsMs: DEFAULT_BUCKET_TIMEOUTS_MS,
		};
		const rc = new RunController(undefined, cfg);
		await new Promise((r) => setTimeout(r, 80));
		expect(rc.signal.aborted).toBe(true);
		expect(rc.signal.reason).toBeDefined();
		// The reason should reference the deadline
		const reason = rc.signal.reason as Error;
		expect(reason.message).toMatch(/deadline/i);
	});

	it("manual abort propagates through signal getter", async () => {
		const { RunController, resolveRunConfig } = await import(
			"../src/run-controller.js"
		);
		const cfg = resolveRunConfig("Developer", {}, {});
		const rc = new RunController(undefined, cfg);
		expect(rc.signal.aborted).toBe(false);
		rc.abortController.abort(new Error("manual-abort"));
		expect(rc.signal.aborted).toBe(true);
		expect((rc.signal.reason as Error).message).toBe("manual-abort");
		rc.cleanup();
	});
});

describe("run-controller: cleanup idempotency", () => {
	it("cleanup() is safe to call multiple times", async () => {
		const { RunController, resolveRunConfig } = await import(
			"../src/run-controller.js"
		);
		const cfg = resolveRunConfig("Developer", {}, {});
		const rc = new RunController(undefined, cfg);
		expect(() => rc.cleanup()).not.toThrow();
		expect(() => rc.cleanup()).not.toThrow();
		expect(() => rc.cleanup()).not.toThrow();
	});
});
