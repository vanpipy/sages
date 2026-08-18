#!/usr/bin/env bun
/**
 * verify-isolation-modes.ts — GC-2026-052 T6.1
 *
 * Verifies that the rejected `isolation: "worktree"` string
 * literal has not been re-introduced in the production source tree.
 *
 * Background: per GC-2026-031 (soft mode) + GC-2026-029 (package
 * subtree is production code), the legacy `isolation: "worktree"`
 * string literal is no longer accepted by the Agent dispatcher.
 * The three supported shapes are:
 *
 *   1. `isolation: "current-workspace"` — opt out of a worktree
 *      entirely (meta-file edits, design-doc writes).
 *   2. `isolation: { dag_id, task_id, mode: "create" }` — fresh
 *      managed worktree for production code TDD work.
 *   3. `isolation: { dag_id, task_id, mode: "reuse" }` — re-enter
 *      an existing worktree slot for serial follow-up.
 *
 * Any re-introduction of the bare string literal
 * `isolation: "worktree"` (or `isolation: 'worktree'`) in
 * production code is a regression — the dispatcher rejects it at
 * runtime, but we want to catch it at build time.
 *
 * Scan scope:
 *   - `src/`        — production TypeScript code
 *   - `subagents/`  — registry YAML
 *   - `profiles/`   — built-in + override profile YAML
 *
 * Explicitly excluded (the literal is intentionally present here):
 *   - `scripts/`    — verifiers + generators that document the
 *     rejection include the literal in their own docstrings,
 *     error messages, and `OK:` success lines. Self-referential
 *     scanning would flag the very script that performs the check.
 *   - `test/`       — tests of rejection behavior use the literal
 *     as the rejected input.
 *   - `docs/`       — cookbook / postmortem entries describing
 *     the rejection reference the literal.
 *   - `templates/`  — installed dispatch guidance documents the
 *     rejection in narrative form.
 *
 * On any hit in the scan scope: print the offending file path(s)
 * and exit 1. On no hits: print `OK: no forbidden 'isolation:
 "worktree"' literals in source` and exit 0.
 *
 * No external dependencies. Self-test: running this script
 * against the current `pi/` tree MUST exit 0.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PI_ROOT = join(__dirname, "..");

const SCAN_DIRS = ["src", "subagents", "profiles"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".pi", "fixtures"]);
const FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|yaml|yml)$/;

// The forbidden literal: `isolation: "worktree"` or `isolation: 'worktree'`.
// Anchored to `isolation` (the property name) followed by a quoted `worktree`
// value, so the regex does not fire on substrings like the word
// "worktree" appearing inside a longer word (e.g. `worktree_id`).
const FORBIDDEN = /(^|[^\w-])isolation\s*:\s*["']worktree["']/;

export interface IsolationScanResult {
	ok: boolean;
	hits: Array<{ path: string; line: number; text: string }>;
}

function walk(dir: string, hits: IsolationScanResult["hits"]): void {
	if (!existsSync(dir)) return;
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (!SKIP_DIRS.has(e.name)) walk(p, hits);
		} else if (e.isFile()) {
			if (!FILE_RE.test(e.name)) continue;
			const text = readFileSync(p, "utf-8");
			const lines = text.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i] ?? "";
				if (FORBIDDEN.test(line)) {
					hits.push({ path: p, line: i + 1, text: line.trim() });
				}
			}
		}
	}
}

export function scanForbiddenIsolation(): IsolationScanResult {
	const hits: IsolationScanResult["hits"] = [];
	for (const d of SCAN_DIRS) {
		walk(join(PI_ROOT, d), hits);
	}
	return { ok: hits.length === 0, hits };
}

function main(): void {
	const result = scanForbiddenIsolation();
	if (!result.ok) {
		console.error(
			`verify-isolation-modes: FAIL — ${result.hits.length} forbidden literal(s) of \`isolation: "worktree"\`:`,
		);
		for (const h of result.hits) {
			const relPath = h.path.startsWith(PI_ROOT) ? h.path.slice(PI_ROOT.length + 1) : h.path;
			console.error(`  ✗ ${relPath}:${h.line}: ${h.text}`);
		}
		console.error(
			`      fix: replace with \`isolation: "current-workspace"\` or the managed-worktree object form`,
		);
		process.exit(1);
	}
	console.log(`OK: no forbidden 'isolation: "worktree"' literals in source (scanned ${SCAN_DIRS.join(", ")})`);
	process.exit(0);
}

const ENTRY = process.argv[1] ?? "";
if (ENTRY.endsWith("verify-isolation-modes.ts") || ENTRY.endsWith("verify-isolation-modes.js")) {
	main();
}