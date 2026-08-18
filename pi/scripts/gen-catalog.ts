#!/usr/bin/env bun
/**
 * gen-catalog.ts — GC-2026-047 T1.1
 *
 * Generates five catalog files under `pi/catalogs/` from current source:
 *   - subagent.json   ← pi/src/tools/orchestrator/dag-synthesizer.ts
 *                        (knownSubagents Set) +
 *                        pi/src/tools/orchestrator/task-dispatcher.ts
 *                        (defaultRunInBackground switch)
 *   - isolation.json  ← pi/src/tools/orchestrator/types.ts
 *                        (TaskNode.isolation union)
 *   - gate.json       ← pi/src/tools/orchestrator/orchestrator-audit.ts
 *                        (g.* category vocabulary) +
 *                        pi/src/tools/orchestrator/goal-contract.ts
 *                        (severity vocabulary)
 *   - event.json      ← pi/src/extension.ts + pi/src/soft-mode.ts
 *                        (current `pi.appendEntry("system", ...)` keys)
 *                        [marked _pre_gc_2026_050 — GC-2026-050 replaces]
 *   - namespace.json  ← pi/src/tools/orchestrator/namespace-ownership.ts
 *                        (L3 / developer / auditor patterns)
 *
 * Each catalog file has top-level `_source_hash` (SHA-256 chain) and
 * `_generated_at` (ISO 8601). The hash chain is computed from the bytes of
 * every source file listed in the catalog's allow-list; the verifier
 * recomputes the same chain and exits 1 on mismatch.
 *
 * No external dependencies. bun builtins + `node:crypto` only.
 *
 * Extraction is intentionally regex / limited parsing — NOT ts-morph.
 * A future GC (G2 / G4) will replace this with a real AST walker once
 * the registry exists; for now, the catalogs are snapshots of truth.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// `pi/scripts/gen-catalog.ts` → `pi/` is the parent
const PI_ROOT = join(__dirname, "..");
const CATALOGS_DIR = join(PI_ROOT, "catalogs");

// ─────────────────────────────────────────────────────────────────────────────
// Source-file loading + hashing helpers
// ─────────────────────────────────────────────────────────────────────────────

interface SourceFile {
	/** Path relative to PI_ROOT (e.g. "src/tools/orchestrator/types.ts") */
	relPath: string;
	/** Absolute path on disk */
	absPath: string;
	/** File contents as utf-8 string */
	content: string;
}

function loadSource(relPath: string): SourceFile {
	const absPath = join(PI_ROOT, relPath);
	const content = readFileSync(absPath, "utf-8");
	return { relPath, absPath, content };
}

function fileHash(content: string): string {
	return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Build the per-file hash chain: `"<file1>:<hash1>;<file2>:<hash2>"`.
 * The same chain format is used by `verify-catalog.ts` to recompute and
 * compare — order MUST be stable across runs.
 */
function sourceHashChain(files: SourceFile[]): string {
	return files.map((f) => `${f.relPath}:${fileHash(f.content)}`).join(";");
}

/** Top-level SHA-256 of the chain string itself (defense in depth). */
function sha256Hex(s: string): string {
	return createHash("sha256").update(s, "utf-8").digest("hex");
}

function writeCatalog(
	name: string,
	payload: Record<string, unknown>,
	sources: SourceFile[],
): void {
	const generatedAt = new Date().toISOString();
	const chain = sourceHashChain(sources);
	const _source_hash = sha256Hex(chain);
	const obj = {
		_source_hash,
		_generated_at: generatedAt,
		_source_files: sources.map((f) => f.relPath),
		...payload,
	};
	mkdirSync(CATALOGS_DIR, { recursive: true });
	const outPath = join(CATALOGS_DIR, `${name}.json`);
	writeFileSync(outPath, JSON.stringify(obj, null, 2) + "\n", "utf-8");
	console.log(
		`  wrote ${relative(PI_ROOT, outPath)} (${sources.length} source file(s), hash=${_source_hash.slice(0, 12)}…)`,
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Extractor 1 — subagent roster
// ─────────────────────────────────────────────────────────────────────────────

interface SubagentEntry {
	id: string;
	source: string;
	run_in_background_default: boolean;
}

function extractSubagent(): {
	entries: SubagentEntry[];
	sources: SourceFile[];
} {
	const synth = loadSource("src/tools/orchestrator/dag-synthesizer.ts");
	const dispatcher = loadSource("src/tools/orchestrator/task-dispatcher.ts");

	// 1. Parse the `knownSubagents` Set literal in dag-synthesizer.ts.
	// Match `const knownSubagents = new Set([ ... ])` (whitespace-tolerant).
	const setMatch = synth.content.match(
		/const\s+knownSubagents\s*=\s*new\s+Set\(\[([\s\S]*?)\]\)/,
	);
	if (!setMatch) {
		throw new Error(
			"subagent: `const knownSubagents = new Set([...])` not found in dag-synthesizer.ts",
		);
	}
	const idRegex = /"([A-Za-z][A-Za-z0-9_-]*)"/g;
	const ids: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = idRegex.exec(setMatch[1])) !== null) {
		ids.push(m[1]);
	}
	if (ids.length === 0) {
		throw new Error("subagent: no ids parsed from knownSubagents Set");
	}

	// 2. Parse `defaultRunInBackground` switch in task-dispatcher.ts.
	// The function body is `export function defaultRunInBackground(...) { switch (...) { ... } }`.
	// We capture the function body then walk the switch statement, tracking
	// fall-through case labels until the next `return` statement. A single
	// `return` may serve multiple stacked `case` labels (TypeScript's
	// fall-through is implicit and silent).
	const fnMatch = dispatcher.content.match(
		/export\s+function\s+defaultRunInBackground[\s\S]*?^}/m,
	);
	if (!fnMatch) {
		throw new Error(
			"subagent: export function defaultRunInBackground not found in task-dispatcher.ts",
		);
	}
	const fnBody = fnMatch[0];
	const lines = fnBody.split("\n");

	let pendingCases: string[] = [];
	let defaultReturns: boolean | null = null;
	const explicitCases: Array<{ ids: string[]; returns: boolean }> = [];

	for (const line of lines) {
		const caseMatch = line.match(/^\s*case\s+"([^"]+)"\s*:/);
		if (caseMatch) {
			pendingCases.push(caseMatch[1]);
			continue;
		}
		const defaultMatch = line.match(/^\s*default\s*:/);
		if (defaultMatch) {
			pendingCases.push("__default__");
			continue;
		}
		const returnMatch = line.match(/^\s*return\s+(true|false)\s*;/);
		if (returnMatch) {
			const value = returnMatch[1] === "true";
			const realIds = pendingCases.filter((id) => id !== "__default__");
			if (pendingCases.includes("__default__")) {
				defaultReturns = value;
			}
			if (realIds.length > 0) {
				explicitCases.push({ ids: realIds, returns: value });
			}
			pendingCases = [];
			continue;
		}
		// Any other top-level token (closing brace, new statement) resets
		// the pending list — defensive.
		if (/^\s*[}]/.test(line)) {
			pendingCases = [];
		}
	}

	if (explicitCases.length === 0 && defaultReturns === null) {
		throw new Error(
			"subagent: no case label or default returning a value parsed from defaultRunInBackground",
		);
	}

	// Build the set of ids with `background = true`:
	//   - any id in an explicit case that returns true
	//   - any id in `ids` (knownSubagents) NOT in any explicit case,
	//     if the default case returns true (fall-through to default).
	const backgroundIds = new Set<string>();
	const explicitIds = new Set<string>();
	for (const c of explicitCases) {
		for (const id of c.ids) explicitIds.add(id);
		if (c.returns) {
			for (const id of c.ids) backgroundIds.add(id);
		}
	}
	if (defaultReturns === true) {
		for (const id of ids) {
			if (!explicitIds.has(id)) {
				backgroundIds.add(id);
			}
		}
	}

	// 3. Build entries. The source pointer is the location in dag-synthesizer.ts.
	const entries: SubagentEntry[] = ids.map((id) => ({
		id,
		source: "pi/src/tools/orchestrator/dag-synthesizer.ts#knownSubagents",
		run_in_background_default: backgroundIds.has(id),
	}));

	return { entries, sources: [synth, dispatcher] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extractor 2 — isolation modes
// ─────────────────────────────────────────────────────────────────────────────

interface IsolationEntry {
	id: string;
	kind: "object" | "literal";
	valid_for_subagent: string[];
}

/**
 * Hardcoded `valid_for_subagent` mapping mirrors the current dispatch policy
 * (overlay §0 / Sages SKILL.md). It is intentionally a snapshot — future GCs
 * (G2 / G4) will replace this with a real policy registry.
 *
 * Source-of-truth location for the union itself is `types.ts` `TaskNode.isolation`.
 */
const ISOLATION_VALID_FOR: Record<string, string[]> = {
	"worktree-create": ["developer", "test-writer", "doc-writer", "migrator"],
	"current-workspace": ["developer", "test-writer", "doc-writer", "migrator"],
	none: ["Explore", "Plan", "auditor", "merger", "git-expert"],
};

function extractIsolation(): { entries: IsolationEntry[]; sources: SourceFile[] } {
	const types = loadSource("src/tools/orchestrator/types.ts");

	// Locate the `isolation:` field on `TaskNode` and parse the union
	// members. We expect three kinds:
	//   1. `{ dag_id: ...; mode: "create" | "reuse" }`  → "worktree-create", kind=object
	//   2. `"current-workspace"`                          → kind=literal
	//   3. `"none"`                                       → kind=literal
	const isoMatch = types.content.match(
		/isolation\s*:\s*([\s\S]*?)\n\s*\/\*\*\s+Whether this task requires strict TDD/,
	);
	if (!isoMatch) {
		throw new Error(
			"isolation: `isolation:` field on TaskNode not found in types.ts",
		);
	}
	const unionBody = isoMatch[1];

	// 1. Object form: look for `mode: "create" | "reuse"` → "worktree-create"
	const hasWorktreeObject = /mode\s*:\s*"create"\s*\|\s*"reuse"/.test(unionBody);
	if (!hasWorktreeObject) {
		throw new Error(
			'isolation: object form mode: "create" | "reuse" not found',
		);
	}

	// 2. Literal forms
	const literalRegex = /\|\s*"([A-Za-z][A-Za-z0-9_-]*)"/g;
	const literalIds: string[] = [];
	let lm: RegExpExecArray | null;
	while ((lm = literalRegex.exec(unionBody)) !== null) {
		literalIds.push(lm[1]);
	}
	if (!literalIds.includes("current-workspace") || !literalIds.includes("none")) {
		throw new Error(
			`isolation: expected literals "current-workspace" and "none" in union, found [${literalIds.join(", ")}]`,
		);
	}

	const entries: IsolationEntry[] = [
		{
			id: "worktree-create",
			kind: "object",
			valid_for_subagent: ISOLATION_VALID_FOR["worktree-create"]!,
		},
		{
			id: "current-workspace",
			kind: "literal",
			valid_for_subagent: ISOLATION_VALID_FOR["current-workspace"]!,
		},
		{
			id: "none",
			kind: "literal",
			valid_for_subagent: ISOLATION_VALID_FOR["none"]!,
		},
	];

	return { entries, sources: [types] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extractor 3 — gate catalogue
// ─────────────────────────────────────────────────────────────────────────────

interface GateEntry {
	id: string;
	severity: string[];
	validates: string;
}

const GATE_VALIDATES: Record<string, string> = {
	ink: "task-level audit report presence (has_report + verdict=CERTIFIED)",
	nose: "cross-task SC coverage against goal contract",
	foot: "cross-cutting verification_cmd re-runs",
	castration: "workflow-level security (orphaned worktrees, shared secrets)",
	death: "long-term viability (orphaned branches, drive-by refactor)",
};

const SEVERITY_VALIDATES: Record<string, string> = {
	critical: "defect finding → audit verdict downgraded to REJECT",
	major: "defect finding → audit verdict downgraded to REVISE",
	minor: "defect finding → score deduction, no verdict change",
};

function extractGate(): {
	categories: GateEntry[];
	severities: GateEntry[];
	sources: SourceFile[];
} {
	const audit = loadSource("src/tools/orchestrator/orchestrator-audit.ts");
	const contract = loadSource("src/tools/orchestrator/goal-contract.ts");

	// Parse the gate category enum from orchestrator-audit.ts. The category
	// is repeated across the `finding` + `findings` shapes; we extract the
	// set of distinct values from any Type.Literal("ink")-style occurrence.
	const catRegex = /Type\.Literal\("([a-z][a-z0-9_-]*)"\)/g;
	const catSet = new Set<string>();
	let am: RegExpExecArray | null;
	while ((am = catRegex.exec(audit.content)) !== null) {
		catSet.add(am[1]);
	}
	// Expected: ink, nose, foot, castration, death
	for (const required of ["ink", "nose", "foot", "castration", "death"]) {
		if (!catSet.has(required)) {
			throw new Error(
				`gate: category "${required}" not found in orchestrator-audit.ts (got [${[...catSet].join(", ")}])`,
			);
		}
	}
	const categories: GateEntry[] = ["ink", "nose", "foot", "castration", "death"].map(
		(id) => ({
			id,
			severity: ["critical", "major", "minor"],
			validates: GATE_VALIDATES[id]!,
		}),
	);

	// Parse severity enum from goal-contract.ts. Look for the severity
	// Type.Union([...]) on the success_criterion shape.
	const sevRegex = /Type\.Literal\("([a-z]+)"\)/g;
	const sevSet = new Set<string>();
	let gm: RegExpExecArray | null;
	while ((gm = sevRegex.exec(contract.content)) !== null) {
		sevSet.add(gm[1]);
	}
	for (const required of ["blocker", "major", "minor"]) {
		if (!sevSet.has(required)) {
			// severity appears in the success_criterion shape — confirm presence
			throw new Error(
				`gate: severity "${required}" not found in goal-contract.ts (got [${[...sevSet].join(", ")}])`,
			);
		}
	}
	const severities: GateEntry[] = ["critical", "major", "minor"].map((id) => ({
		id,
		severity: [],
		validates: SEVERITY_VALIDATES[id]!,
	}));

	return { categories, severities, sources: [audit, contract] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extractor 4 — event vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The full event taxonomy is GC-2026-050's job. T1.1 only extracts the
 * `kind` keys that are CURRENTLY emitted via `pi.appendEntry("system", ...)`.
 * The catalog is marked `_pre_gc_2026_050` so downstream readers can detect
 * the pre-2026-050 snapshot.
 */
function extractEvent(): {
	pre_gc_2026_050: true;
	entries: Array<{ key: string; source: string; description: string }>;
	sources: SourceFile[];
} {
	const extension = loadSource("src/extension.ts");
	const softMode = loadSource("src/soft-mode.ts");

	// Extract all `pi.appendEntry("system", <EXPR>)` calls.
	const callRegex = /pi\.appendEntry\(\s*"([a-z]+)"\s*,/g;
	const keys = new Set<string>();
	let em: RegExpExecArray | null;
	while ((em = callRegex.exec(extension.content)) !== null) {
		keys.add(em[1]);
	}

	// Currently the only emission is "system" (SOFT_MODE_REMINDER).
	// This is a snapshot — when GC-2026-050 lands and adds more kinds
	// (e.g. "user-reminder", "audit-state"), re-run `bun run gen:catalog`
	// to update this catalog.
	const entries: Array<{ key: string; source: string; description: string }> = [];
	for (const key of keys) {
		entries.push({
			key,
			source: "pi/src/extension.ts#appendEntry",
			description: `entries appended under "${key}" — currently only SOFT_MODE_REMINDER; full taxonomy is GC-2026-050`,
		});
	}
	// Cross-reference: soft-mode.ts defines the SOFT_MODE_REMINDER string.
	// We don't extract its text; the catalog records the key only.
	if (!softMode.content.includes("SOFT_MODE_REMINDER")) {
		throw new Error(
			"event: SOFT_MODE_REMINDER constant not found in soft-mode.ts (expected sibling source)",
		);
	}

	return { pre_gc_2026_050: true, entries, sources: [extension, softMode] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extractor 5 — namespace ownership
// ─────────────────────────────────────────────────────────────────────────────

interface NamespaceEntry {
	id: "l3" | "developer" | "auditor";
	patterns: string[];
}

function extractNamespace(): { entries: NamespaceEntry[]; sources: SourceFile[] } {
	const ns = loadSource("src/tools/orchestrator/namespace-ownership.ts");

	// Parse the three pattern constants: L3_PATTERNS, DEVELOPER_PATTERNS, AUDITOR_PATTERNS.
	function parsePatterns(constName: string): string[] {
		// Match the array body between `[` and the first `]`. We capture
		// everything between them (non-greedy). The trailing `;` is required
		// so a bare `foo = [bar]` inside a larger expression doesn't match.
		const re = new RegExp(
			`(?:const|let|var)\\s+${constName}\\s*=\\s*\\[([\\s\\S]*?)\\];`,
		);
		const match = ns.content.match(re);
		if (!match) {
			throw new Error(`namespace: constant ${constName} not found in namespace-ownership.ts`);
		}
		// Each element is `new RegExp(\`<pattern>\`)` or `^...$` literal.
		// We capture the pattern string between backticks.
		const body = match[1];
		const patterns: string[] = [];
		const tickRegex = /`([^`]+)`/g;
		let pm: RegExpExecArray | null;
		while ((pm = tickRegex.exec(body)) !== null) {
			patterns.push(pm[1]);
		}
		if (patterns.length === 0) {
			throw new Error(`namespace: no patterns parsed from ${constName}`);
		}
		return patterns;
	}

	const l3 = parsePatterns("L3_PATTERNS");
	const dev = parsePatterns("DEVELOPER_PATTERNS");
	const aud = parsePatterns("AUDITOR_PATTERNS");

	const entries: NamespaceEntry[] = [
		{ id: "l3", patterns: l3 },
		{ id: "developer", patterns: dev },
		{ id: "auditor", patterns: aud },
	];

	return { entries, sources: [ns] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

interface CatalogDescriptor {
	name: string;
	run: () => { entries?: unknown; [k: string]: unknown } & { sources: SourceFile[] };
}

const CATALOGS: CatalogDescriptor[] = [
	{
		name: "subagent",
		run: () => {
			const { entries, sources } = extractSubagent();
			return { payload: { entries }, sources };
		},
	},
	{
		name: "isolation",
		run: () => {
			const { entries, sources } = extractIsolation();
			return { payload: { entries }, sources };
		},
	},
	{
		name: "gate",
		run: () => {
			const { categories, severities, sources } = extractGate();
			return { payload: { categories, severities }, sources };
		},
	},
	{
		name: "event",
		run: () => {
			const { entries, sources } = extractEvent();
			return { payload: { pre_gc_2026_050: true, entries }, sources };
		},
	},
	{
		name: "namespace",
		run: () => {
			const { entries, sources } = extractNamespace();
			return { payload: { entries }, sources };
		},
	},
];

function main(): void {
	const startedAt = Date.now();
	console.log(`gen-catalog: emitting ${CATALOGS.length} catalog(s) to ${relative(PI_ROOT, CATALOGS_DIR)}/`);
	for (const c of CATALOGS) {
		const { payload, sources } = c.run();
		writeCatalog(c.name, payload, sources);
	}
	const elapsedMs = Date.now() - startedAt;
	console.log(`gen-catalog: done in ${elapsedMs}ms`);
}

main();
