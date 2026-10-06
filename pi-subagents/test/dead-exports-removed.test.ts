/**
 * dead-exports-removed.test.ts — GC-2026-107 RED-phase guard.
 *
 * AFT dead-code + unused-export analyzer flagged 6 pi-subagents exports as
 * having zero callers anywhere in the monorepo:
 *
 *   - setNetworkAllowedDefaults   (settings.ts)
 *   - readAllDiagnostics          (diagnostic.ts)
 *   - resetFailureCatalogCache    (failure-catalog.ts)
 *   - resetLeaseWarnings          (worktree-lease.ts)
 *   - getSessionTokens            (usage.ts)
 *   - readWorktreeGitdir          (worktree-ownership.ts)
 *
 * This test asserts the symbols are NOT accessible via the workspace import
 * path (`@sages/pi-subagents/<file>`). Before the fix the import resolves
 * to a module namespace that exposes them (test fails). After the fix the
 * symbols are gone (test passes).
 *
 * The test imports each module dynamically so the `import` itself never
 * throws — we read `namespace.symbol` and assert it is `undefined`.
 */

import { describe, expect, it } from "vitest";

const cases = [
	{
		file: "settings",
		symbol: "setNetworkAllowedDefaults",
	},
	{
		file: "diagnostic",
		symbol: "readAllDiagnostics",
	},
	{
		file: "failure-catalog",
		symbol: "resetFailureCatalogCache",
	},
	{
		file: "worktree-lease",
		symbol: "resetLeaseWarnings",
	},
	{
		file: "usage",
		symbol: "getSessionTokens",
	},
	{
		file: "worktree-ownership",
		symbol: "readWorktreeGitdir",
	},
] as const;

describe("GC-2026-107: dead exports removed", () => {
	for (const { file, symbol } of cases) {
		it(`${file}: ${symbol} is not exported`, async () => {
			const mod = (await import(
				`@sages/pi-subagents/${file}` as string
			)) as Record<string, unknown>;
			expect(typeof mod[symbol]).toBe("undefined");
		});
	}
});
