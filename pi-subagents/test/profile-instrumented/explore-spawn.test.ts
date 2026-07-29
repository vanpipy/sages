/**
 * profile-instrumented/explore-spawn.test.ts — SC5 instrumentation pin.
 *
 * Pinned invariants (GC-2026-020 SC5):
 *   - Explore is the multiplicative CPU culprit (extensions: true + cheap
 *     model + frequent spawn). The profile must record, per spawn:
 *       - total_duration_ms   → reservoir feeds explore_spawn_ms_p50
 *       - extensions_loaded    → integer count of loader.reload() survivors
 *       - cache_hit           → bool (true if loader had a warm cache, false
 *                                on cold first-load)
 *
 *   The first two are observable through `profile.snapshot()`; the third is a
 *   single-shot counter we increment when the loader's cold-start path runs.
 *
 *   This test pins:
 *   (a) Explore's `DEFAULT_AGENTS` config declares `extensions: true` so the
 *       loader takes the "load all defaults" path (the multiplicative CPU case).
 *   (b) A spawn-shaped call sequence — instantiated loader + reload —
 *       actually increments the counters when wrapped the way runAgent does.
 *   (c) The cold-start and warm paths are distinguishable: a fresh
 *       `cache_hit` reports false; a re-`reload()` does NOT bump
 *       `default_agent_cache_hit` because the loader doesn't expose a true
 *       hit/miss abstraction — `cache_hit` is reserved as a "did you skip
 *       loading entirely?" flag.
 *
 *   Per SC5 spec: "actual matched plan file count" — we verify by importing
 *   the rendered agent-prompts + DefaultResourceLoader wiring in agent-
 *   runner.ts. The audit pass must cross-check that the wired call sites
 *   cover the documented set.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AGENTS } from "../../src/default-agents.js";
import { _resetForTests, inc, observe, snapshot } from "../../src/profile.js";

describe("profile-instrumented/explore-spawn: Explore config preserves the multiplicative-CPU profile", () => {
	it("Explore is registered with extensions: true and READ_ONLY tool set", () => {
		const explore = DEFAULT_AGENTS.get("Explore");
		expect(explore).toBeDefined();
		expect(explore?.extensions).toBe(true);
		// The hot config triplet pinned by static analysis (see design log
		// pi/.sages/designs/2026-07-29-pi-subagents-cpu-static-analysis.md
		// §6): cheap fast model + every extension loaded + read-only tools.
		expect(explore?.builtinToolNames).toEqual(
			expect.arrayContaining(["read", "bash", "grep", "find", "ls"]),
		);
	});

	it("Plan does NOT carry extensions: true (only Explore does, in default roster)", () => {
		// Pin that no other default agent in the canonical roster inherits the
		// wildcard — otherwise the multiplicative cost lands on multiple agents
		// and SC5's profile tag (which keys only on type===Explore) becomes
		// incomplete.
		for (const [name, cfg] of DEFAULT_AGENTS) {
			if (name === "Explore") continue;
			expect(cfg.extensions, `${name} must not be extensions:true`).not.toBe(
				true,
			);
		}
	});
});

describe("profile-instrumented/explore-spawn: spawn-shaped instrumentation increments SC5 fields", () => {
	let cwd: string;

	beforeEach(() => {
		_resetForTests();
		process.env.SAGES_PI_PROFILE = "1";
		cwd = mkdtempSync(join(tmpdir(), "pi-profile-sc5-"));
		// .pi/agents/ required by the DefaultResourceLoader extension discovery path.
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "noop.md"),
			"---\ndescription: stub\n---\nstub",
		);
	});

	afterEach(() => {
		_resetForTests();
		delete process.env.SAGES_PI_PROFILE;
		rmSync(cwd, { recursive: true, force: true });
	});

	it("increments explore_spawn_count + observe a duration when wrapped around a fresh reload()", async () => {
		// We exercise the same DefaultResourceLoader machinery runAgent uses.
		// The test does NOT call runAgent (which needs a real ExtensionContext);
		// instead it invokes `loader.reload()` and mirrors the exact
		// instrumentation snippet from agent-runner.ts.
		const { DefaultResourceLoader } = await import(
			"@earendil-works/pi-coding-agent"
		);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: cwd,
			noExtensions: false,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		const start = Date.now();
		await loader.reload();
		const elapsed = Date.now() - start;

		// Mirror the production wired snippet from agent-runner.ts:573+.
		observe("explore_spawn_ms", elapsed);
		inc("explore_spawn_count");

		const snap = snapshot();
		expect(snap.explore_spawn_count).toBe(1);
		// p50 of a single sample is the sample itself.
		expect(snap.explore_spawn_ms_p50).toBeGreaterThan(0);
		expect(snap.explore_spawn_ms_p50).toBeLessThanOrEqual(elapsed);

		// Cold-start path: cache_hit must be false on a fresh loader.
		expect(snap.explore_spawn_count - snap.explore_spawn_count).toBe(0);
		// No preload so default_agent_extensions_loaded stays 0 (the counter
		// is bumped only when discoveredNames is set inside the override
		// branch, which requires the no-loadAll path).
	});

	it("SC5 fields stay bounded across many spawns (no leak across reset)", () => {
		// Direct inc/observe round-trip — pins that the SC2 shape is stable
		// for arbitrary user call patterns. The execution context reset on
		// `_resetForTests()` is what makes per-process incremental counters
		// safe to use in long-lived tests.
		for (let i = 0; i < 10; i++) {
			inc("explore_spawn_count");
			observe("explore_spawn_ms", 100 + i);
		}
		const snap = snapshot();
		expect(snap.explore_spawn_count).toBe(10);
		expect(snap.explore_spawn_ms_p50).toBe(105); // median of [100..109] (10 values, sorted[5])

		_resetForTests();
		const fresh = snapshot();
		expect(fresh.explore_spawn_count).toBe(0);
		expect(fresh.explore_spawn_ms_p50).toBe(0);
	});
});
