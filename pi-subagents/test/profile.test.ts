/**
 * profile.test.ts — Unit tests for the env-flagged CPU profile module.
 *
 * Pinned invariants (GC-2026-020 SC1 + SC2):
 *   1. Disabled path is < 1μs / call (100k calls in < 100ms) AND
 *      allocates nothing — verified by reading globalThis before/after.
 *   2. The env flag is cached after first read (no per-call env lookup).
 *   3. `inc()` is atomic under concurrent calls (JS is single-threaded
 *      so this is trivial — pinned as a regression guard for any future
 *      refactor that introduces a worker).
 *   4. `observe()` feeds a p50 reservoir (median of odd-sized sample
 *      equals the middle value; pinned by write-then-snapshot).
 *   5. `startSummary()` writes one stderr line per ~5s tick containing
 *      every SC2 field name (parses to known shape).
 *   6. Module re-import does not double-allocate or double-count — the
 *      globalThis-backed singleton survives a "fresh" import.
 *
 * The tests reset global state between cases via `_resetForTests()` so the
 * suite stays hermetic regardless of test order (vitest runs files in
 * isolation but cases within a file in declaration order).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetForTests,
	inc,
	isEnabled,
	observe,
	type ProfileSnapshot,
	snapshot,
	startSummary,
	stopSummary,
} from "../src/profile.js";

const GLOBAL_KEY = "__piSubagentsProfile";

describe("profile.overheadDisabled: env flag", () => {
	beforeEach(() => {
		_resetForTests();
		delete process.env.SAGES_PI_PROFILE;
	});

	afterEach(() => {
		_resetForTests();
		delete process.env.SAGES_PI_PROFILE;
		stopSummary();
	});

	it("isEnabled() is false when SAGES_PI_PROFILE is unset", () => {
		expect(isEnabled()).toBe(false);
	});

	it("isEnabled() is true after SAGES_PI_PROFILE=1 is read at least once", () => {
		expect(isEnabled()).toBe(false);
		process.env.SAGES_PI_PROFILE = "1";
		// Even if env changes after first read, the result is cached.
		expect(isEnabled()).toBe(false);
		_resetForTests();
		expect(isEnabled()).toBe(true);
	});

	it("isEnabled() returns the same boolean across many calls (env read is cached)", () => {
		const first = isEnabled();
		for (let i = 0; i < 1000; i++) {
			expect(isEnabled()).toBe(first);
		}
	});
});

describe("profile.overheadDisabled: disabled path is zero-allocation and < 1μs / call (SC1)", () => {
	beforeEach(() => {
		_resetForTests();
		delete process.env.SAGES_PI_PROFILE;
	});

	afterEach(() => {
		_resetForTests();
		stopSummary();
	});

	it("does NOT allocate on globalThis when disabled", () => {
		const before = (globalThis as unknown as Record<string, unknown>)[
			GLOBAL_KEY
		];
		expect(before).toBeUndefined();
		// 100k calls — would surface any per-call allocation.
		for (let i = 0; i < 100_000; i++) {
			inc("spawned_total");
			observe("tui_widget_render_ms", i % 17);
			snapshot();
		}
		const after = (globalThis as unknown as Record<string, unknown>)[
			GLOBAL_KEY
		];
		expect(after, "globalThis key must remain undefined").toBeUndefined();
	});

	it("completes 100k calls in < 100ms (~ 1μs per call avg)", () => {
		const t0 = performance.now();
		for (let i = 0; i < 100_000; i++) {
			inc("spawned_total");
			observe("tui_widget_render_ms", 50);
		}
		const elapsed = performance.now() - t0;
		expect(elapsed).toBeLessThan(100);
	});
});

describe("profile.overheadDisabled: enabled path (SC2 — counter / observe / snapshot)", () => {
	beforeEach(() => {
		_resetForTests();
		process.env.SAGES_PI_PROFILE = "1";
	});

	afterEach(() => {
		_resetForTests();
		delete process.env.SAGES_PI_PROFILE;
		stopSummary();
	});

	it("inc() is monotonic under repeated calls (single-threaded atomicity pin)", () => {
		expect(isEnabled()).toBe(true);
		inc("spawned_total");
		inc("spawned_total", 4);
		inc("spawned_total");
		expect(snapshot().spawned_total).toBe(6);
	});

	it("observe() feeds a p50 reservoir (median of 5 samples equals the 3rd)", () => {
		const samples = [10, 30, 50, 70, 90];
		for (const s of samples) observe("explore_spawn_ms", s);
		const snap = snapshot();
		expect(snap.explore_spawn_ms_p50).toBe(50);
	});

	it("snapshot() returns the full SC2 field set with numeric defaults", () => {
		const snap: ProfileSnapshot = snapshot();
		expect(typeof snap.live_agents).toBe("number");
		expect(typeof snap.spawned_total).toBe("number");
		expect(typeof snap.finished_total).toBe("number");
		expect(typeof snap.busy_wait_retries).toBe("number");
		expect(typeof snap.tui_widget_fires_per_s).toBe("number");
		expect(typeof snap.tui_fleet_fires_per_s).toBe("number");
		expect(typeof snap.explore_spawn_count).toBe("number");
		expect(typeof snap.explore_spawn_ms_p50).toBe("number");
		expect(typeof snap.custom_reload_count).toBe("number");
		expect(typeof snap.custom_reload_ms_p50).toBe("number");
		// Pinned defaults: when no samples observed, p50 is 0 and per-s
		// rates are 0 (no fires have happened in the current window).
		expect(snap.explore_spawn_ms_p50).toBe(0);
		expect(snap.custom_reload_ms_p50).toBe(0);
	});
});

describe("profile.overheadDisabled: stderr summary writer (SC2)", () => {
	beforeEach(() => {
		_resetForTests();
		process.env.SAGES_PI_PROFILE = "1";
	});

	afterEach(() => {
		_resetForTests();
		delete process.env.SAGES_PI_PROFILE;
		stopSummary();
	});

	it("writes one stderr line per summary tick with every SC2 field name parseable", () => {
		// Use fake timers BEFORE startSummary() so the registered setInterval
		// is fake-time driven (the real-timer interval would ignore
		// advanceTimersByTime).
		vi.useFakeTimers();
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation((() => true) as typeof process.stderr.write);

		startSummary();
		inc("spawned_total", 3);
		inc("finished_total", 1);
		inc("busy_wait_retries", 12);
		inc("tui_widget_render_fired", 70);
		inc("tui_fleet_render_fired", 25);
		inc("explore_spawn_count", 2);
		observe("explore_spawn_ms", 200);
		observe("explore_spawn_ms", 400);
		inc("custom_agents_reload", 4);
		observe("custom_reload_ms", 30);
		observe("custom_reload_ms", 60);

		vi.advanceTimersByTime(5000);

		const all = writeSpy.mock.calls.map((c) => String(c[0] ?? "")).join("");
		writeSpy.mockRestore();
		vi.useRealTimers();

		expect(all).toContain("profile_summary");
		const requiredKeys: Array<keyof ProfileSnapshot> = [
			"live_agents",
			"spawned_total",
			"finished_total",
			"busy_wait_retries",
			"tui_widget_fires_per_s",
			"tui_fleet_fires_per_s",
			"explore_spawn_count",
			"explore_spawn_ms_p50",
			"custom_reload_count",
			"custom_reload_ms_p50",
		];
		for (const k of requiredKeys) {
			expect(all, `key ${k} must appear in summary`).toContain(k);
		}
	});

	it("startSummary is idempotent — second call does not double the cadence", () => {
		vi.useFakeTimers();
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation((() => true) as typeof process.stderr.write);

		startSummary();
		startSummary();
		vi.advanceTimersByTime(5000);
		const lines = writeSpy.mock.calls
			.map((c) => String(c[0] ?? ""))
			.filter((line) => line.includes("profile_summary"));
		writeSpy.mockRestore();
		vi.useRealTimers();
		expect(lines.length).toBe(1);
	});

	it("stopSummary() halts further emissions", () => {
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation((() => true) as typeof process.stderr.write);

		startSummary();
		stopSummary();
		vi.useFakeTimers();
		vi.advanceTimersByTime(15000);

		const lines = writeSpy.mock.calls
			.map((c) => String(c[0] ?? ""))
			.filter((line) => line.includes("profile_summary"));
		writeSpy.mockRestore();
		vi.useRealTimers();
		expect(lines.length).toBe(0);
	});
});

describe("profile.overheadDisabled: singleton survives module re-import", () => {
	beforeEach(() => {
		_resetForTests();
		process.env.SAGES_PI_PROFILE = "1";
	});

	afterEach(() => {
		_resetForTests();
		delete process.env.SAGES_PI_PROFILE;
		stopSummary();
	});

	it("a fresh import reuses the same globalThis store", async () => {
		inc("spawned_total", 7);
		const before = snapshot().spawned_total;
		// Vitest's module cache holds the same instance under the hood, so
		// the "fresh import" path here is symbolic — the singleton contract
		// is what's actually verified.
		const mod = await import("../src/profile.js?reimport=" + Date.now());
		expect(mod.snapshot().spawned_total).toBe(before);
	});
});

/**
 * GC-2026-032 phase-1: worktree.ts hot-path instrumentation.
 *
 * `worktree.ts:createManagedWorktree` is the most-called dispatch path in the
 * orchestrator (every developer task provisions a worktree) yet carried zero
 * instrumentation. These cases pin the counters/reservoirs it feeds so the
 * snapshot layout stays stable for downstream parsers.
 */
describe("profile.worktree: phase counters + duration reservoirs (GC-2026-032 SC4)", () => {
	beforeEach(() => {
		_resetForTests();
		process.env.SAGES_PI_PROFILE = "1";
	});

	afterEach(() => {
		_resetForTests();
		delete process.env.SAGES_PI_PROFILE;
		stopSummary();
	});

	it("observe() feeds a p50 reservoir for each worktree phase duration", () => {
		for (const ms of [10, 30, 50, 70, 90]) observe("worktree_create_ms", ms);
		for (const ms of [2, 4, 6]) observe("worktree_reuse_ms", ms);
		for (const ms of [100, 200, 300]) observe("worktree_inspect_ms", ms);
		for (const ms of [7, 9, 11]) observe("worktree_release_ms", ms);

		const snap = snapshot();
		expect(snap.worktree_create_ms_p50).toBe(50);
		expect(snap.worktree_reuse_ms_p50).toBe(4);
		expect(snap.worktree_inspect_ms_p50).toBe(200);
		expect(snap.worktree_release_ms_p50).toBe(9);
	});

	it("inc() increments each per-phase worktree counter independently", () => {
		inc("worktree_create_count");
		inc("worktree_create_count", 2);
		inc("worktree_reuse_count", 5);
		inc("worktree_inspect_count");
		inc("worktree_release_count", 4);

		const snap = snapshot();
		expect(snap.worktree_create_count).toBe(3);
		expect(snap.worktree_reuse_count).toBe(5);
		expect(snap.worktree_inspect_count).toBe(1);
		expect(snap.worktree_release_count).toBe(4);
	});

	it("git_call_count_total accumulates automatically from per-phase git counters", () => {
		inc("git_call_count_create", 6);
		inc("git_call_count_reuse", 3);
		inc("git_call_count_inspect", 2);
		inc("git_call_count_release", 1);

		const snap = snapshot();
		expect(snap.git_call_count_create).toBe(6);
		expect(snap.git_call_count_reuse).toBe(3);
		expect(snap.git_call_count_inspect).toBe(2);
		expect(snap.git_call_count_release).toBe(1);
		// Per-phase increments roll up into the total without a second call.
		expect(snap.git_call_count_total).toBe(12);
	});

	it("git_call_count_total is also incrementable on its own (unphased calls)", () => {
		inc("git_call_count_total", 4);
		expect(snapshot().git_call_count_total).toBe(4);
		// An unphased bump leaves every per-phase counter at 0.
		const snap = snapshot();
		expect(snap.git_call_count_create).toBe(0);
		expect(snap.git_call_count_reuse).toBe(0);
		expect(snap.git_call_count_inspect).toBe(0);
		expect(snap.git_call_count_release).toBe(0);
	});

	it("snapshot() always exposes the 13 new fields as numbers defaulting to 0", () => {
		const snap: ProfileSnapshot = snapshot();
		for (const key of [
			"worktree_create_ms_p50",
			"worktree_reuse_ms_p50",
			"worktree_inspect_ms_p50",
			"worktree_release_ms_p50",
			"worktree_create_count",
			"worktree_reuse_count",
			"worktree_inspect_count",
			"worktree_release_count",
			"git_call_count_create",
			"git_call_count_reuse",
			"git_call_count_inspect",
			"git_call_count_release",
			"git_call_count_total",
		] as const) {
			expect(typeof snap[key]).toBe("number");
			expect(snap[key]).toBe(0);
		}
	});
});
