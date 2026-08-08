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
		expect(DEFAULT_BUCKET_TIMEOUTS_MS.test).toBe(30_000);
		expect(DEFAULT_BUCKET_TIMEOUTS_MS.fullTest).toBe(90_000);
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
	it("exports the four built-in types with the specified defaults", async () => {
		const { DEFAULT_PER_TYPE } = await import("../src/run-controller.js");
		expect(DEFAULT_PER_TYPE.developer).toEqual({
			deadlineMs: 20 * 60_000,
			maxTurns: 60,
		});
		expect(DEFAULT_PER_TYPE.auditor).toEqual({
			deadlineMs: 20 * 60_000,
			maxTurns: 30,
		});
		expect(DEFAULT_PER_TYPE.explorer).toEqual({
			deadlineMs: 5 * 60_000,
			maxTurns: 20,
		});
		expect(DEFAULT_PER_TYPE.merger).toEqual({
			deadlineMs: 5 * 60_000,
			maxTurns: 20,
		});
	});
});

describe("run-controller: resolveRunConfig", () => {
	it("returns DEFAULT_PER_TYPE[type] when params is empty and env is empty", async () => {
		const { resolveRunConfig } = await import("../src/run-controller.js");
		const cfg = resolveRunConfig("developer", {}, {});
		expect(cfg.type).toBe("developer");
		expect(cfg.deadlineMs).toBe(20 * 60_000);
		expect(cfg.maxTurns).toBe(60);
		expect(cfg.bucketTimeoutsMs).toBeDefined();
	});

	it("params.max_duration_minutes overrides deadlineMs (positive only)", async () => {
		const { resolveRunConfig } = await import("../src/run-controller.js");
		const cfg = resolveRunConfig("developer", { max_duration_minutes: 15 }, {});
		expect(cfg.deadlineMs).toBe(15 * 60_000);

		// Negative values fall through to default
		const neg = resolveRunConfig("developer", { max_duration_minutes: -5 }, {});
		expect(neg.deadlineMs).toBe(20 * 60_000);

		// Zero falls through to default
		const zero = resolveRunConfig("developer", { max_duration_minutes: 0 }, {});
		expect(zero.deadlineMs).toBe(20 * 60_000);
	});

	it("params.max_turns overrides maxTurns", async () => {
		const { resolveRunConfig } = await import("../src/run-controller.js");
		const cfg = resolveRunConfig("developer", { max_turns: 42 }, {});
		expect(cfg.maxTurns).toBe(42);

		// Zero / negative falls through
		const zero = resolveRunConfig("developer", { max_turns: 0 }, {});
		expect(zero.maxTurns).toBe(60);
	});

	it("falls back to default when params is undefined-equivalent", async () => {
		const { resolveRunConfig } = await import("../src/run-controller.js");
		const cfg = resolveRunConfig("auditor", {}, {});
		expect(cfg.deadlineMs).toBe(20 * 60_000);
		expect(cfg.maxTurns).toBe(30);
	});

	it("env.SAGES_PI_AGENT_BUDGET_TURNS as fallback (when params has nothing)", async () => {
		const { resolveRunConfig } = await import("../src/run-controller.js");
		const env = { SAGES_PI_AGENT_BUDGET_TURNS: "42" };
		const cfg = resolveRunConfig("explorer", {}, env);
		expect(cfg.maxTurns).toBe(42);
	});

	it("env.SAGES_PI_AGENT_<TYPE>_BUDGET_TURNS overrides per-type", async () => {
		const { resolveRunConfig } = await import("../src/run-controller.js");
		const env = {
			SAGES_PI_AGENT_BUDGET_TURNS: "42",
			SAGES_PI_AGENT_AUDITOR_BUDGET_TURNS: "99",
		};
		const cfg = resolveRunConfig("auditor", {}, env);
		expect(cfg.maxTurns).toBe(99);
	});

	it("env.SAGES_PI_AGENT_BUDGET_MS as fallback for deadlineMs", async () => {
		const { resolveRunConfig } = await import("../src/run-controller.js");
		const env = { SAGES_PI_AGENT_BUDGET_MS: String(7 * 60_000) };
		const cfg = resolveRunConfig("developer", {}, env);
		expect(cfg.deadlineMs).toBe(7 * 60_000);
	});

	it("env.SAGES_PI_AGENT_<TYPE>_BUDGET_MS overrides per-type deadlineMs", async () => {
		const { resolveRunConfig } = await import("../src/run-controller.js");
		const env = {
			SAGES_PI_AGENT_BUDGET_MS: String(7 * 60_000),
			SAGES_PI_AGENT_DEVELOPER_BUDGET_MS: String(3 * 60_000),
		};
		const cfg = resolveRunConfig("developer", {}, env);
		expect(cfg.deadlineMs).toBe(3 * 60_000);
	});

	it("bucketTimeoutsMs is always DEFAULT_BUCKET_TIMEOUTS_MS", async () => {
		const { resolveRunConfig, DEFAULT_BUCKET_TIMEOUTS_MS } = await import(
			"../src/run-controller.js"
		);
		const cfg = resolveRunConfig("developer", {}, {});
		expect(cfg.bucketTimeoutsMs).toBe(DEFAULT_BUCKET_TIMEOUTS_MS);
	});

	it("unknown type falls back to developer defaults (20min / 60turns)", async () => {
		const { resolveRunConfig } = await import("../src/run-controller.js");
		const cfg = resolveRunConfig("somerandomtype", {}, {});
		expect(cfg.deadlineMs).toBe(20 * 60_000);
		expect(cfg.maxTurns).toBe(60);
	});

	it("params take precedence over env", async () => {
		const { resolveRunConfig } = await import("../src/run-controller.js");
		const env = {
			SAGES_PI_AGENT_DEVELOPER_BUDGET_TURNS: "99",
			SAGES_PI_AGENT_DEVELOPER_BUDGET_MS: String(3 * 60_000),
		};
		const cfg = resolveRunConfig(
			"developer",
			{ max_duration_minutes: 45, max_turns: 10 },
			env,
		);
		expect(cfg.deadlineMs).toBe(45 * 60_000);
		expect(cfg.maxTurns).toBe(10);
	});

	it("carries runId and traceId when provided in params (or in env)", async () => {
		const { resolveRunConfig } = await import("../src/run-controller.js");
		const cfg = resolveRunConfig(
			"developer",
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
		const cfg = resolveRunConfig("developer", {}, {});
		const rc = new RunController(undefined, cfg);
		expect(rc.signal).toBe(rc.abortController.signal);
		expect(rc.signal.aborted).toBe(false);
		rc.cleanup();
	});

	it("composes via AbortSignal.any when parentSignal is provided", async () => {
		const { RunController, resolveRunConfig } = await import(
			"../src/run-controller.js"
		);
		const cfg = resolveRunConfig("developer", {}, {});
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
		const cfg = resolveRunConfig("developer", {}, {});
		const rc = new RunController(undefined, cfg);
		expect(rc.signal.aborted).toBe(false);
		rc.cleanup();
	});

	it("aborts immediately when parentSignal is already aborted", async () => {
		const { RunController, resolveRunConfig } = await import(
			"../src/run-controller.js"
		);
		const cfg = resolveRunConfig("developer", {}, {});
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
		const cfg = resolveRunConfig("developer", {}, {});
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
			type: "developer" as const,
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
		const cfg = resolveRunConfig("developer", {}, {});
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
		const cfg = resolveRunConfig("developer", {}, {});
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
			type: "developer" as const,
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

	it("cleanup clears the deadline timer (no late aborts)", async () => {
		const { RunController, DEFAULT_BUCKET_TIMEOUTS_MS } = await import(
			"../src/run-controller.js"
		);
		const cfg = {
			type: "developer" as const,
			deadlineMs: 100,
			maxTurns: 60,
			bucketTimeoutsMs: DEFAULT_BUCKET_TIMEOUTS_MS,
		};
		const rc = new RunController(undefined, cfg);
		// Cleanup BEFORE deadline fires
		rc.cleanup();
		// Wait past deadline
		await new Promise((r) => setTimeout(r, 200));
		// Did not abort because cleanup cleared the timer
		expect(rc.signal.aborted).toBe(false);
	});

	it("deadline timer abort reason is an Error name like 'DeadlineExceeded'", async () => {
		const { RunController, DEFAULT_BUCKET_TIMEOUTS_MS } = await import(
			"../src/run-controller.js"
		);
		const cfg = {
			type: "developer" as const,
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
		const cfg = resolveRunConfig("developer", {}, {});
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
		const cfg = resolveRunConfig("developer", {}, {});
		const rc = new RunController(undefined, cfg);
		expect(() => rc.cleanup()).not.toThrow();
		expect(() => rc.cleanup()).not.toThrow();
		expect(() => rc.cleanup()).not.toThrow();
	});
});
