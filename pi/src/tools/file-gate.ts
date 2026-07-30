/**
 * File Gate — path-aware policy for main-agent file writes.
 *
 * The main orchestrator agent CANNOT directly edit ANY file (meta or
 * production). The 4 orchestrator tools (`goal_contract_create`,
 * `dag_synthesize`, `task_dispatch`, `orchestrator_audit`) write
 * orchestrator state under `.pi/orchestrator/`; everything else
 * (AGENTS.md, README.md, install scripts, test files, ...) must go
 * through the `Agent` tool.
 *
 * For meta-file edits / design-doc writes, dispatch the `developer`
 * subagent with `tdd: none` (DAG-2026-011 Phase C — the `general-purpose`
 * helper was removed; the developer agent handles design-doc writes
 * for design tasks and code changes for implementation). For production
 * code, dispatch the `developer` subagent in a managed worktree
 * (strict TDD discipline). For ad-hoc work outside the dispatch
 * surface, the user can opt into the main agent's escape mode
 * (see `pi/src/escape-window.ts`) which gives the LLM direct write tools.
 *
 * The path policy (`canMainAgentWrite`) is the **single source of
 * truth** for the bash-guard (Layer 2). The bash-guard
 * (`pi/src/tools/bash-guard.ts`) imports and uses the same function so
 * `cat > meta-file` and `sages_write meta-file` would have given the
 * same answer. With `sages_write`/`sages_edit` retired (2026-07-26),
 * the LLM-facing tool surface no longer exposes any direct write — the
 * bash-guard is the only remaining limb-side enforcement. The escape
 * window partially relaxes Layer 1 + Layer 2 for the session — see
 * `escape-window.ts` for the precise carve-out.
 *
 * Read tools (`read`, `aft_read`, `aft_search`, `codebase_*`,
 * `bash` for read-only commands) are intentionally NOT gated — the
 * main agent still needs to read user code to understand context.
 *
 * The policy is enforced at the bash layer; the system prompt
 * (`pi/templates/SYSTEM.md §1`) carries the matching convention so
 * the LLM dispatches `developer` (managed worktree) for production
 * code and `developer` with `tdd: none` for design-doc writes.
 */

import { isAbsolute, normalize } from "node:path";

/** L3: Sages meta-files where the main agent can write directly.
 *
 * GC-2026-029 contracted to root-only. Every path under pi/ and every
 * sibling pi-* subpackage is now PRODUCTION code routed through the
 * developer subagent in a managed worktree. The carve-outs for
 * pi/templates/, pi/skills/, pi/scripts/, and pi/README.md are
 * removed; sibling subpackages (pi-subagents/, pi-codebase-memory/,
 * pi-evaluator/, pi-minimax/, pi-yunxiao/) are excluded from the
 * meta-write allowlist alongside the pi/ subtree.
 */
export const META_FILE_ALLOWLIST = [
	".pi/orchestrator/", ".pi/agents/", "AGENTS.md", "README.md",
	".gitignore", ".aft.jsonc", ".claude/", ".codex/",
] as const;

/** Returns true when path is an explicitly allowlisted Sages meta-file.
 *
 * GC-2026-029 — bare entries (`README.md`, `AGENTS.md`, `package.json`,
 * `tsconfig*.json`, `.gitignore`, `.aft.jsonc`) match only at the
 * repository root. A `pi/README.md` or `pi-yunxiao/README.md` does NOT
 * match `README.md` — every path inside a Sages package subtree is
 * production code (see the canMainAgentWrite path policy).
 */
export function canMainAgentWriteMeta(path: string): boolean {
	if (!path || path.includes("\0") || path.includes("~") || isAbsolute(path)) return false;
	if (path.endsWith("/") || path.endsWith("\\")) return false;
	const normalized = normalize(path).replace(/^(?:\.\/)+/, "").replaceAll("\\", "/");
	if (normalized === ".." || normalized.startsWith("../")) return false;
	for (const entry of META_FILE_ALLOWLIST) {
		if (entry.endsWith("/")) {
			if (normalized.startsWith(entry)) return true;
		} else if (normalized === entry) {
			// Bare entries match only at the repo root, not under any
			// package subtree. GC-2026-029 collapses the historical
			// suffix-match (`/<entry>`) which let `pi/README.md`
			// pass as a meta-file.
			return true;
		}
	}
	return false;
}


const META_WRITE_PATTERNS: RegExp[] = [
	// Orchestrator state (goals, dags, audits, designs, etc.)
	/^\.pi\//,
	// Root meta files
	/^README\.md$/,
	/^AGENTS\.md$/,
	/^package\.json$/,
	/^tsconfig(\..+)?\.json$/,
	/^\.gitignore$/,
	/^\.aft\.jsonc?$/,
	/^\.claude\//,
	/^\.codex\//,
];

/** Patterns that explicitly deny — production code & user source. */
const PRODUCTION_DENY_PATTERNS: RegExp[] = [
	// Common user source roots
	/^src\//,
	/^test\//,
	/^tests\//,
	/^lib\//,
	/^app\//,
	/^cmd\//,
	/^internal\//,
	/^pkg\//,
	// Compiled / interpreted source extensions at root
	/\.(ts|tsx|js|jsx|mjs|cjs|py|pyw|go|rs|java|rb|php|cs|cpp|cc|c|h|hpp|swift|kt)$/,
];

/**
 * Returns true iff the main agent may write to the given path.
 *
 * This is the single source of truth for write policy — used by the
 * bash-guard (Layer 2) to decide whether `cat > path` / `sed -i path` /
 * `tee path` / etc. are allowed. The LLM-facing tool surface no
 * longer includes any direct write tool, so the main agent must
 * dispatch a subagent to perform writes — but the path policy still
 * matters because (a) the subagent inherits the dispatcher's cwd
 * (and the bash-guard applies to its bash commands too), and (b) a
 * future tool must use the same function.
 *
 * Deny rules (in order):
 *   1. Empty / null-byte / `..` / `~/` / absolute paths
 *   2. Production code patterns (user source roots + source extensions)
 *   3. Default deny (anything not explicitly allowlisted)
 *
 * Allow rules: matches `META_WRITE_PATTERNS`.
 */
export function canMainAgentWrite(path: string): boolean {
	if (!path) return false;
	if (path.includes("\0") || path.includes("..") || path.includes("~")) return false;
	if (isAbsolute(path)) return false;
	// Empty filename
	if (path.endsWith("/") || path.endsWith("\\")) return false;

	// Meta paths override production-deny (a path under pi/ is Sages own
	// source, NOT user code, even though it ends in .ts).
	for (const re of META_WRITE_PATTERNS) {
		if (re.test(path)) return true;
	}

	for (const re of PRODUCTION_DENY_PATTERNS) {
		if (re.test(path)) return false;
	}

	return false;
}

/** Human-readable explanation of the policy (used by the bash-guard). */
export function policyMessage(path: string): string {
	return [
		`Path "${path}" is not main-agent-writable.`,
		``,
		`The main agent has NO direct write tools. All file changes must be`,
		`dispatched to a subagent via the Agent tool. The path policy is`,
		`contracted (GC-2026-029) to root-only meta + .pi/orchestrator/*`,
		`+ .pi/agents/*; every Sages package subtree is production code`,
		`and routes through the developer subagent in a managed worktree:`,
		`  - For meta-file edits (AGENTS.md, README.md, config tweaks,`,
		`    .pi/orchestrator/* / .pi/agents/* design-doc writes): dispatch`,
		`    developer with isolation: "current-workspace" + tdd: "none"`,
		`    (no TDD, just write the design / edit). Review the diff before`,
		`    committing.`,
		`  - For production code (anything under a Sages package subtree,`,
		`    src/, test/, lib/, *.ts, *.py, ...): dispatch developer`,
		`    with managed worktree isolation`,
		`    (pass isolation: { dag_id, task_id, worktree_id?, mode: "create" | "reuse" }).`,
		``,
		`Allowed paths for direct developer dispatch:`,
		`  - .pi/orchestrator/*  (goal/dag/audit/state/designs)`,
		`  - .pi/agents/*         (agent prompts installed to ~/.pi/agent/agents/)`,
		`  - .claude/, .codex/    (tooling config)`,
		`  - README.md, AGENTS.md, package.json, tsconfig*.json`,
		`  - .gitignore, .aft.jsonc`,
		``,
		`Everything else (the entire Sages package subtree plus all user`,
		`source) is production code and requires the developer subagent`,
		`in a managed worktree.`,
		``,
		`See SYSTEM.md section 1 "Action Priority" for the policy.`,
	].join("\n");
}
