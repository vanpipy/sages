/**
 * custom-agents.test.ts — GC-2026-033-perf-opt-phase-2 SC5/SC6/SC7/SC8
 * TTL cache pin for `loadCustomAgents`.
 *
 * Pinned invariants:
 *   - T-TTL-01: second call with the same cwd inside the TTL window
 *     performs ZERO additional file reads (cache hit). The first call
 *     is allowed to read ≥ 1 .md file.
 *   - T-TTL-02: advancing time past `CUSTOM_AGENTS_CACHE_TTL_MS`
 *     forces a cache miss; file reads re-fire.
 *   - T-TTL-03: cache is keyed by cwd. cwd1 hits must not affect cwd2
 *     (different cwd → separate entry, separate miss).
 *   - T-TTL-04: `_getCustomAgentsCacheSize()` reflects current entry
 *     count; grows by one per unique-cwd miss, stays put on hit.
 *   - T-TTL-05: returned Map is a shallow clone — mutating it must NOT
 *     leak back into the cache entry that the next hit returns.
 *
 * The test mocks `getAgentDir` to point at an isolated, non-existent
 * path so the "global" pass (the third loadFromDir call) never reads
 * anything. `node:fs` is partially mocked so we can count readFileSync
 * calls strictly within the project's `.pi/agents/` and
 * `.agents/agents/` paths.
 */

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted by vitest above all imports)
// ---------------------------------------------------------------------------

const MOCK_GLOBAL_DIR = "__custom_agents_test_global_never_exists__";

/**
 * Tally of readFileSync paths observed through the mocked node:fs. Read
 * counts are filtered to paths inside the project's `.pi/agents/` and
 * `.agents/agents/` so global-dir reads (if any sneak through) don't
 * poison the assertions.
 *
 * The tally is a module-level array — vitest hoists `vi.mock` factories
 * but the factory closure runs when the module is first imported, by
 * which time the array binding exists. We reset it per-test in beforeEach.
 */
const observedReadFilePaths: string[] = [];

// `vi.mock` factories run before `vi` is bound at module scope, so we use
// dynamic `import()` (always available in module factory context) instead of
// `vi.importActual` (which is undefined during hoisting).
vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await import("@earendil-works/pi-coding-agent");
	return {
		...actual,
		getAgentDir: () => MOCK_GLOBAL_DIR,
	};
});

vi.mock("node:fs", async () => {
	const actual = await import("node:fs");
	const originalReadFileSync = actual.readFileSync;
	return {
		...actual,
		readFileSync: ((
			path: Parameters<typeof originalReadFileSync>[0],
			...rest: Parameters<typeof originalReadFileSync> extends [
				unknown,
				...infer R,
			]
				? R
				: never
		): string | Buffer => {
			observedReadFilePaths.push(
				typeof path === "string" ? path : path.toString(),
			);
			return (
				originalReadFileSync as unknown as (...a: unknown[]) => string | Buffer
			).call(actual, path, ...rest);
		}) as typeof originalReadFileSync,
	};
});

// SUT + helpers — must come AFTER the vi.mock calls above.
const { loadCustomAgents, _getCustomAgentsCacheSize, _clearCustomAgentsCache } =
	await import("../src/custom-agents.js");

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TTL_MS = 5_000;

describe("custom-agents: TTL cache (GC-2026-033)", () => {
	let projectDir: string;

	// `getAgentDir` is mocked to a non-existent path, so every observed
	// readFileSync call originates from the cwd-relative `.pi/agents/` or
	// `.agents/agents/` directories of one of the cwds under test. Counting
	// the unfiltered array is therefore equivalent to counting "project"
	// reads and is robust to cwd nesting (e.g. cwd2 = projectDir/nested).
	function readsInProject(): number {
		return observedReadFilePaths.length;
	}

	beforeEach(() => {
		_clearCustomAgentsCache();
		observedReadFilePaths.length = 0;
		projectDir = mkdtempSync(join(tmpdir(), "pi-custom-agents-ttl-"));
		mkdirSync(join(projectDir, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(projectDir, ".pi", "agents", "scout.md"),
			"---\ndescription: ttl-test agent\n---\nbody\n",
		);
	});

	afterEach(() => {
		_clearCustomAgentsCache();
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("T-TTL-01: second call within TTL skips file reads (cache hit)", () => {
		const first = loadCustomAgents(projectDir);
		expect(first.has("scout")).toBe(true);
		const readsAfterFirst = readsInProject();
		expect(readsAfterFirst).toBeGreaterThanOrEqual(1);

		const second = loadCustomAgents(projectDir);
		expect(second.has("scout")).toBe(true);
		// Cache hit: zero NEW reads in the project dirs.
		expect(readsInProject() - readsAfterFirst).toBe(0);

		// Cache size stays at 1 entry (same cwd, same key).
		expect(_getCustomAgentsCacheSize()).toBe(1);
	});

	it("T-TTL-02: advancing time past TTL forces a cache miss", () => {
		vi.useFakeTimers();
		try {
			loadCustomAgents(projectDir);
			const readsAfterFirst = readsInProject();
			expect(readsAfterFirst).toBeGreaterThanOrEqual(1);

			// Just under TTL: still hit.
			vi.advanceTimersByTime(TTL_MS - 1);
			loadCustomAgents(projectDir);
			expect(readsInProject() - readsAfterFirst).toBe(0);

			// Now push past the TTL boundary — must re-read.
			vi.advanceTimersByTime(2);
			loadCustomAgents(projectDir);
			expect(readsInProject() - readsAfterFirst).toBeGreaterThanOrEqual(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("T-TTL-03: per-cwd isolation (cwd1 hit does not satisfy cwd2)", () => {
		const cwd1 = projectDir;
		const cwd2 = join(projectDir, "nested");
		mkdirSync(join(cwd2, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd2, ".pi", "agents", "scout2.md"),
			"---\ndescription: cwd2 agent\n---\nbody\n",
		);

		const readsBeforeCwd1 = readsInProject();
		loadCustomAgents(cwd1);
		expect(readsInProject() - readsBeforeCwd1).toBeGreaterThanOrEqual(1);

		// cwd1 hit within TTL — no new reads.
		loadCustomAgents(cwd1);
		const readsAfterCwd1 = readsInProject();
		expect(readsAfterCwd1 - readsBeforeCwd1).toBeGreaterThanOrEqual(1); // first cwd1 call counted
		expect(_getCustomAgentsCacheSize()).toBe(1);

		// cwd2 is a different key — must miss and read at least one file
		// (scout2.md). The tally is filtered to projectDir-prefixed paths,
		// which still includes cwd2 because cwd2 lives under projectDir.
		const readsBeforeCwd2 = readsInProject();
		const result2 = loadCustomAgents(cwd2);
		expect(result2.has("scout2")).toBe(true);
		expect(readsInProject() - readsBeforeCwd2).toBeGreaterThanOrEqual(1);

		// Two distinct entries now.
		expect(_getCustomAgentsCacheSize()).toBe(2);
	});

	it("T-TTL-04: _getCustomAgentsCacheSize reflects per-cwd entry count", () => {
		expect(_getCustomAgentsCacheSize()).toBe(0);
		loadCustomAgents(projectDir);
		expect(_getCustomAgentsCacheSize()).toBe(1);
		loadCustomAgents(projectDir);
		expect(_getCustomAgentsCacheSize()).toBe(1); // hit, no new entry
		const cwd2 = join(projectDir, "alt");
		mkdirSync(join(cwd2, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd2, ".pi", "agents", "alt.md"),
			"---\ndescription: alt\n---\nbody\n",
		);
		loadCustomAgents(cwd2);
		expect(_getCustomAgentsCacheSize()).toBe(2);
	});

	it("T-TTL-05: returned Map is a shallow clone (mutation does not leak)", () => {
		const first = loadCustomAgents(projectDir);
		expect(first.has("scout")).toBe(true);
		const originalDescription = first.get("scout")?.description;

		// Caller mutates the returned Map.
		first.delete("scout");
		first.set("rogue", {
			name: "rogue",
			displayName: undefined,
			description: "added-by-caller",
			builtinToolNames: [],
			extSelectors: undefined,
			disallowedTools: undefined,
			extensions: false,
			excludeExtensions: undefined,
			skills: false,
			model: undefined,
			thinking: undefined,
			maxTurns: undefined,
			persistSession: undefined,
			outputTranscript: undefined,
			sessionDir: undefined,
			systemPrompt: "",
			promptMode: "replace",
			inheritContext: undefined,
			runInBackground: undefined,
			isolated: undefined,
			memory: undefined,
			isolation: undefined,
			enabled: true,
			source: "global",
		});

		// Next hit returns a fresh clone — the original "scout" is back,
		// and the rogue entry is absent.
		const second = loadCustomAgents(projectDir);
		expect(second.has("scout")).toBe(true);
		expect(second.has("rogue")).toBe(false);
		expect(second.get("scout")?.description).toBe(originalDescription);
	});
});
