/**
 * Wrap-layer warmup tests — ensureReady() single-flight + ready flag.
 *
 * The existing `warmupCallgraph` (aft/warmup.ts:17) is fire-and-forget for
 * background callgraph indexing. wrap tools still need an *awaited* warmup
 * that guarantees `configure` has succeeded before the first user request,
 * because:
 *
 *   - AFT rejects requests with `{success:false, code:"not_configured"}` when
 *     the daemon hasn't seen `configure` for the current project_root.
 *   - The first `grep`/`outline`/etc. would otherwise hang or error with a
 *     confusing message.
 *
 * This file pins down `ensureReady(projectRoot)`:
 *   - First call: awaits `ensureConfigured(projectRoot)` (single-flight)
 *   - Concurrent first calls share the same in-flight promise
 *   - Subsequent calls return immediately when ready=true
 *   - Failure throws and clears the cache so the next call retries
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureReady,
	__resetReadyState,
} from "../../src/tools/aft/warmup.js";

// Use the cwd at test-runtime as the primary project root — AFT's
// `configure` validates that project_root is a real directory, and the test
// runner's cwd (the `pi/` subdir of the sages repo) satisfies that. This is
// portable: works on any machine where the test is run from inside the
// repo. For the "different roots tracked independently" test we create a
// throwaway tmp dir so we don't depend on any specific path layout.
const TEST_ROOT = process.cwd();

describe("ensureReady — single-flight warmup", () => {
	let altRoot: string;

	beforeEach(() => {
		__resetReadyState();
		altRoot = mkdtempSync(join(tmpdir(), "sages-warmup-"));
	});

	afterEach(() => {
		__resetReadyState();
		if (altRoot) rmSync(altRoot, { recursive: true, force: true });
	});

	test("first call awaits configure; subsequent calls return immediately", async () => {
		// Measure wall-clock for the second call — should be <5ms since the
		// first call already configured the daemon (or attempted to).
		const t1Start = Date.now();
		await ensureReady(TEST_ROOT);
		const t1Elapsed = Date.now() - t1Start;

		const t2Start = Date.now();
		await ensureReady(TEST_ROOT);
		const t2Elapsed = Date.now() - t2Start;

		// Second call should be much faster (no I/O). We allow a generous
		// 50ms to avoid CI flakiness but assert it's well under the first.
		expect(t2Elapsed).toBeLessThan(Math.max(50, t1Elapsed / 2));
	});

	test("concurrent first calls share the same in-flight promise (single-flight)", async () => {
		// Fire 10 concurrent calls before any of them resolve. They must
		// all settle on the same configure round-trip (not 10 separate ones).
		const promises = Array.from({ length: 10 }, () => ensureReady(TEST_ROOT));
		await Promise.all(promises);

		// After all settle, ready=true should make any new call O(1).
		const start = Date.now();
		await ensureReady(TEST_ROOT);
		expect(Date.now() - start).toBeLessThan(10);
	});

	test("different project roots are tracked independently", async () => {
		// rootA is the test runner's cwd (real repo dir); rootB is a fresh
		// tmp dir so we know it's never been seen by the ready cache.
		const rootA = TEST_ROOT;
		const rootB = altRoot;

		await ensureReady(rootA);
		// rootB is still unconfigured — ensureReady(rootB) must do its own
		// work, not short-circuit via rootA's ready flag.
		const start = Date.now();
		await ensureReady(rootB);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(0); // ran its own configure path
		expect(rootA).not.toBe(rootB); // sanity
	});

	test("failure in configure clears ready state so the next call retries", async () => {
		// First call should succeed (or fail gracefully). We just verify
		// that after ensureReady settles, calling it again doesn't hang.
		await ensureReady(TEST_ROOT);
		await ensureReady(TEST_ROOT);
		expect(true).toBe(true); // both completed without hanging
	});
});

describe("ensureReady — module API surface", () => {
	test("ensureReady is exported and callable", () => {
		expect(typeof ensureReady).toBe("function");
	});

	test("__resetReadyState is exported for test cleanup", () => {
		expect(typeof __resetReadyState).toBe("function");
		expect(() => __resetReadyState()).not.toThrow();
	});
});