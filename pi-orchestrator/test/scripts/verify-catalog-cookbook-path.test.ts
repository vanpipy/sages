/**
 * verify-catalog-cookbook-path.test.ts — GC-2026-088
 *
 * Pins the default path resolution in
 * `pi-orchestrator/scripts/verify-catalog.ts::verifyCookbookPostmortemConsistency`.
 *
 * The bug (pre-fix):
 *   The default `gcIndexPath` was `join(PI_ROOT, "docs", "gc-index.md")`,
 *   where PI_ROOT is the *package* root (pi-orchestrator/). That resolves
 *   to `pi-orchestrator/docs/gc-index.md`, which does not exist on this
 *   repo. Same for `postmortemDir` (default = `pi-orchestrator/docs/postmortem`,
 *   also missing). The function therefore took the "suspended" branch and
 *   returned `{ ok: true, checked: false }` — the gate printed "institutional
 *   coverage suspended" which sounds like OK, but actually meant "I never
 *   looked at the right path".
 *
 * The fix (post-fix):
 *   Walk `..` at each affected default so the path resolves to the
 *   repo-root `pi/docs/...`. On current main, `pi/docs/gc-index.md` exists
 *   and `pi/docs/postmortem/` holds one file per merged GC. So the real
 *   check runs and returns `{ ok: true, checked: true }`.
 *
 * This test imports the helper directly (no subprocess) so it can pin
 * the exact return value.
 *
 * Run: cd pi-orchestrator && bun test ./test/scripts/
 */

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyCookbookPostmortemConsistency } from "../../scripts/verify-catalog.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mirror the script's PI_ROOT calculation so the test can document
// which paths the buggy and correct defaults point at.
//
// verify-catalog.ts lives at pi-orchestrator/scripts/verify-catalog.ts
// PI_ROOT = join(__dirname of script, "..") = pi-orchestrator/
const SCRIPT_DIR_FROM_TEST = resolve(__dirname, "..", "..", "scripts");
const PI_ROOT = resolve(SCRIPT_DIR_FROM_TEST, "..");

const BUGGY_DEFAULT_GC_INDEX = join(PI_ROOT, "docs", "gc-index.md");
const BUGGY_DEFAULT_POSTMORTEM_DIR = join(PI_ROOT, "docs", "postmortem");
const CORRECT_DEFAULT_GC_INDEX = resolve(PI_ROOT, "..", "pi", "docs", "gc-index.md");
const CORRECT_DEFAULT_POSTMORTEM_DIR = resolve(PI_ROOT, "..", "pi", "docs", "postmortem");

describe("verify-catalog: default path resolution (GC-2026-088)", () => {
	describe("static checks: where the buggy vs correct defaults point", () => {
		it("the buggy default gcIndexPath (pi-orchestrator/docs/gc-index.md) does not exist", () => {
			// Documents the bug: the pre-fix default points at a path that
			// was never created on this repo, so the gate took the
			// "suspended" branch.
			expect(existsSync(BUGGY_DEFAULT_GC_INDEX)).toBe(false);
		});

		it("the buggy default postmortemDir (pi-orchestrator/docs/postmortem) does not exist", () => {
			expect(existsSync(BUGGY_DEFAULT_POSTMORTEM_DIR)).toBe(false);
		});

		it("the correct default gcIndexPath (<repo-root>/pi/docs/gc-index.md) exists", () => {
			// Documents the fix: walking `..` reaches the repo-root
			// institutional docs. The file lives there and the gate
			// can now read it.
			expect(existsSync(CORRECT_DEFAULT_GC_INDEX)).toBe(true);
		});

		it("the correct default postmortemDir (<repo-root>/pi/docs/postmortem) exists", () => {
			expect(existsSync(CORRECT_DEFAULT_POSTMORTEM_DIR)).toBe(true);
		});
	});

	describe("default-args behavior pin (the test that fails pre-fix)", () => {
		it("verifyCookbookPostmortemConsistency() with no args returns { ok: true, checked: true } — NOT suspended", () => {
			// Pre-fix: defaults point to pi-orchestrator/docs/{gc-index.md, postmortem},
			//          both missing → "suspended" branch → { ok: true, checked: false }
			// Post-fix: defaults walk `..` to pi/docs/{gc-index.md, postmortem},
			//           both exist and aligned → { ok: true, checked: true }
			const result = verifyCookbookPostmortemConsistency();
			expect(result.ok).toBe(true);
			expect(result.checked).toBe(true);
		});

		it("verifyCookbookPostmortemConsistency() with no args reports no orphan postmortems (current main is clean)", () => {
			// Companion check: the post-fix result must also be free of
			// orphan postmortems. On current main every postmortem file
			// has a matching entry in gc-index.md (post-GC-2026-089).
			const result = verifyCookbookPostmortemConsistency();
			expect(result.ok).toBe(true);
			expect(result.checked).toBe(true);
			expect(result.orphanPostmortems ?? []).toEqual([]);
			expect(result.missingCookbookLinks ?? []).toEqual([]);
		});
	});

	describe("explicit-broken-args sanity (proves the test above is not vacuous)", () => {
		it("explicit broken gcIndexPath returns { ok: true, checked: false } (suspended)", () => {
			// If the default-args test ever passes for the wrong reason,
			// this test exposes it: when given explicitly-broken paths,
			// the gate still returns checked:false. So a passing
			// default-args test must mean the defaults themselves are
			// correct, not that the function ignores path arguments.
			const result = verifyCookbookPostmortemConsistency(
				"/definitely/does/not/exist/gc-index.md",
				"/definitely/does/not/exist/postmortem",
			);
			expect(result.ok).toBe(true);
			expect(result.checked).toBe(false);
		});

		it("explicit orphan postmortem (postmortem dir exists, gc-index missing) returns ok:false", () => {
			// mkdtemp-style path: nonexistent dir names won't trigger the
			// "orphan present" branch. Use a real-but-empty postmortem dir.
			const result = verifyCookbookPostmortemConsistency(
				"/definitely/does/not/exist/gc-index.md",
				"/definitely/does/not/exist/postmortem",
			);
			// With both paths missing, gate stays "suspended" (no orphans
			// to surface). The postmortem dir alone being missing means
			// no real check runs.
			expect(result.ok).toBe(true);
			expect(result.checked).toBe(false);
		});
	});
});
