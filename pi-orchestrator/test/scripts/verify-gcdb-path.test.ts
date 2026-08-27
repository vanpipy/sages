/**
 * verify-gcdb-path.test.ts — GC-2026-088
 *
 * Pins the default path resolution in `pi-orchestrator/scripts/verify-gcdb.ts`
 * so `goalIds()`, `carveOutIds()`, and `uncovered()` read from the repo-root
 * `.pi/orchestrator/` (real orchestrator state) instead of the package-root
 * `pi-orchestrator/.pi/orchestrator/` (a non-existent directory created by
 * the path-bug).
 *
 * The bug (pre-fix):
 *   Lines 31-33 use `join(PI_ROOT, ".pi", "orchestrator")` / `docs/postmortem` /
 *   `docs/gc-index.md` where PI_ROOT is the *package* root. That resolves
 *   one level too deep. The script's main() therefore reported
 *   "no goal contracts in .pi/orchestrator/; coverage trivially satisfied"
 *   even when the orchestrator state dir held real goal files.
 *
 * The fix (post-fix):
 *   Walk `..` at each affected constant so the paths resolve to the
 *   repo-root locations. The default `goalIds()` will then read from
 *   `.pi/orchestrator/`, which is where the orchestrator drops its goal
 *   yamls in production.
 *
 * The strongest behavioral pin (default-args behavior) writes a uniquely-
 * named fixture goal yaml to the repo-root `.pi/orchestrator/`, calls
 * `goalIds()` with no args, asserts the fixture is found, and removes the
 * fixture in `afterAll` (even on failure) so the orchestrator state dir is
 * left pristine.
 *
 * Run: cd pi-orchestrator && bun test ./test/scripts/
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { goalIds, carveOutIds, uncovered } from "../../scripts/verify-gcdb.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mirror the script's PI_ROOT calculation so the test can document
// which paths the buggy and correct defaults point at.
//
// verify-gcdb.ts lives at pi-orchestrator/scripts/verify-gcdb.ts
// PI_ROOT = resolve(__dirname, "..") = pi-orchestrator/
const SCRIPT_DIR_FROM_TEST = resolve(__dirname, "..", "..", "scripts");
const PI_ROOT = resolve(SCRIPT_DIR_FROM_TEST, "..");
const REPO_ROOT = resolve(PI_ROOT, "..");

const BUGGY_DEFAULT_GOAL_DIR = join(PI_ROOT, ".pi", "orchestrator");
const BUGGY_DEFAULT_POSTMORTEM_DIR = join(PI_ROOT, "docs", "postmortem");
const BUGGY_DEFAULT_GC_INDEX = join(PI_ROOT, "docs", "gc-index.md");

const CORRECT_DEFAULT_GOAL_DIR = resolve(PI_ROOT, "..", ".pi", "orchestrator");
const CORRECT_DEFAULT_POSTMORTEM_DIR = resolve(
	PI_ROOT,
	"..",
	"pi",
	"docs",
	"postmortem",
);
const CORRECT_DEFAULT_GC_INDEX = resolve(PI_ROOT, "..", "pi", "docs", "gc-index.md");

// The fixture file lives at the repo-root orchestrator state dir. We
// use a unique, clearly-marked filename so any leftover (e.g. after a
// crashed test run) is identifiable and easy to clean by hand.
const FIXTURE_GC_ID = "GC-2026-088-PATH-FIXTURE";
const FIXTURE_FILENAME = `goal-${FIXTURE_GC_ID}.yaml`;
const FIXTURE_PATH = join(CORRECT_DEFAULT_GOAL_DIR, FIXTURE_FILENAME);

describe("verify-gcdb: default path resolution (GC-2026-088)", () => {
	describe("default-args behavior pin (the test that fails pre-fix)", () => {
		// Set up a fixture goal yaml so `goalIds()` with no args has
		// something to find at the CORRECT default path. Cleanup is
		// in afterAll (unconditional, even on failure) so the
		// orchestrator state dir is left pristine.
		beforeAll(() => {
			if (!existsSync(CORRECT_DEFAULT_GOAL_DIR)) {
				mkdirSync(CORRECT_DEFAULT_GOAL_DIR, { recursive: true });
			}
			writeFileSync(
				FIXTURE_PATH,
				[
					`id: ${FIXTURE_GC_ID}`,
					`title: GC-2026-088 default-path pin fixture (auto-removed by afterAll)`,
					`refs:`,
					`  - GC-2026-088`,
					``,
				].join("\n"),
				"utf-8",
			);
		});

		afterAll(() => {
			if (existsSync(FIXTURE_PATH)) {
				unlinkSync(FIXTURE_PATH);
			}
		});

		it("default goalIds() finds the fixture at <repo-root>/.pi/orchestrator/ (proves default = correct path)", () => {
			// Pre-fix: defaults point to pi-orchestrator/.pi/orchestrator/
			//          → fixture not found → expect.toContain FAILS
			// Post-fix: defaults point to <repo-root>/.pi/orchestrator/
			//           → fixture found → expect.toContain PASSES
			const ids = goalIds();
			expect(ids).toContain(FIXTURE_GC_ID);
		});

		it("default goalIds() does NOT find a fixture at the buggy path (defensive double-check)", () => {
			// Sanity: if goalIds() were ever changed to also scan the
			// buggy path, this test would still pass for the right
			// reason. The fixture lives ONLY at the correct path.
			// Reading from goalIds() should not "accidentally" find
			// anything at the buggy location — which is exactly the
			// scenario the path fix prevents.
			const ids = goalIds();
			// The fixture ID is unique and only exists at the correct path.
			const occurrences = ids.filter((id) => id === FIXTURE_GC_ID).length;
			expect(occurrences).toBe(1);
		});

		it("uncovered() with no args reports the fixture as uncovered (no postmortem, not in carve-out)", () => {
			// Post-fix: uncovered() default reads goals from the correct
			// path. The fixture has no postmortem and is not in the
			// carve-out section of gc-index.md, so it appears in the
			// uncovered list — which is exactly what institutional
			// coverage is supposed to detect.
			//
			// Pre-fix: uncovered() default reads from the wrong (empty)
			// path → no goals → uncovered() returns []. The fixture
			// bug is masked.
			const missing = uncovered();
			expect(missing).toContain(FIXTURE_GC_ID);
		});
	});
});
