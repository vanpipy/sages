#!/usr/bin/env bun
/**
 * gen-catalog.ts — GC-2026-047 T1.1 / GC-2026-048 T2.2
 *
 * Generates five catalog files under `pi/catalogs/` from current source:
 *   - subagent.json   ← @sages/pi-subagents (DEFAULT_AGENTS, single
 *                        source of truth for subagent registration;
 *                        replaces GC-2026-048 subagents/registry.yaml)
 *   - isolation.json  ← pi/src/types.ts
 *                        (TaskNode.isolation union)
 *   - gate.json       ← pi/src/orchestrator-audit.ts
 *                        (g.* category vocabulary) +
 *                        pi/src/goal-contract.ts
 *                        (severity vocabulary)
 *   - event.json      ← pi/src/observability/events.ts
 *                        (RunEvent enum, GC-2026-050 taxonomy)
 *   - namespace.json  ← pi/src/namespace-ownership.ts
 *                        (orchestrator / developer / auditor patterns)
 *
 * Each catalog file has top-level `_source_hash` (SHA-256 chain) and
 * `_generated_at` (ISO 8601). The hash chain is computed from the bytes of
 * every source file listed in the catalog's allow-list; the verifier
 * recomputes the same chain and exits 1 on mismatch.
 *
 * Subagent catalog is a thin snapshot of pi-subagents' DEFAULT_AGENTS
 * — downstream tools can read it without importing the pi-subagents
 * package. The runtime also imports pi-subagents directly via the
 * `KNOWN_SUBAGENT_IDS` / `defaultRunInBackground` exports.
 *
 * Extraction is intentionally regex / limited parsing — NOT ts-morph.
 * A future GC (G2 / G4) will replace this with a real AST walker once
 * the registry exists; for now, the catalogs are snapshots of truth.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { KNOWN_SUBAGENT_IDS, defaultRunInBackground } from "@sages/pi-subagents";

const __dirname = dirname(fileURLToPath(import.meta.url));
// `pi/scripts/gen-catalog.ts` → `pi/` is the parent
const PI_ROOT = join(__dirname, "..");
const CATALOGS_DIR = join(PI_ROOT, "catalogs");

// ─────────────────────────────────────────────────────────────────────────────
// Source-file loading + hashing helpers
// ─────────────────────────────────────────────────────────────────────────────

interface SourceFile {
	/** Path relative to PI_ROOT (e.g. "src/types.ts") */
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
//
// GC-2026-XXX: pi-subagents owns subagent registration. We import
// DEFAULT_AGENTS (the canonical Map<string, AgentConfig>) and project
// just the two fields sages consumes (id + runInBackground) into a
// minimal catalog. Fields like kind / gather / artifact_schema used
// to live in a duplicate subagents/registry.yaml — that file was
// removed; if a downstream tool needs richer metadata, it should
// import pi-subagents directly.
// ─────────────────────────────────────────────────────────────────────────────

interface SubagentEntry {
	id: string;
	source: string;
	run_in_background_default: boolean;
}

const SUBAGENT_SOURCE_REL_PATH = "../pi-subagents/src/default-agents.ts";

function extractSubagent(): {
	entries: SubagentEntry[];
	sources: SourceFile[];
} {
	const entries: SubagentEntry[] = [];
	for (const id of KNOWN_SUBAGENT_IDS) {
		entries.push({
			id,
			source: `@sages/pi-subagents#KNOWN_SUBAGENT_IDS`,
			run_in_background_default: defaultRunInBackground(id),
		});
	}
	entries.sort((a, b) => a.id.localeCompare(b.id));

	// For the SHA-256 hash chain, also include the source file from
	// pi-subagents. We compute the hash against the on-disk source so
	// the verifier can re-check after edits.
	const sourceAbs = join(PI_ROOT, "..", "pi-subagents", "src", "default-agents.ts");
	const sources: SourceFile[] = [{
		relPath: SUBAGENT_SOURCE_REL_PATH,
		absPath: sourceAbs,
		content: readFileSync(sourceAbs, "utf-8"),
	}];

	return { entries, sources };
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
	const types = loadSource("src/types.ts");

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
	const audit = loadSource("src/orchestrator-audit.ts");
	const contract = loadSource("src/goal-contract.ts");

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
//
// GC-2026-050 T4.2: the event taxonomy now lives in
// `pi/src/observability/events.ts`. Three enums (RunEvent / StepEvent /
// SeamEvent) cover 5 + 7 + 3 = 15 events, each prefixed with its domain
// (`run/` / `step/` / `seam/`). This extractor parses the enum-member
// shape `<Name> = "<domain>/<slug>"` and emits one entry per member.
//
// Source-of-truth: `src/observability/events.ts`. The matching emitter
// (runner.ts) writes run/* events to the durable audit-state file.
// The step/* and seam/* domains were dropped when their corresponding
// observability surface was removed; this extractor now only emits
// run/* entries.
// ─────────────────────────────────────────────────────────────────────────────

interface EventEntry {
	name: string;
	id: string;
	domain: "run";
	source: string;
}

function extractEvent(): {
	entries: EventEntry[];
	sources: SourceFile[];
} {
	const events = loadSource("src/observability/events.ts");

	// Match enum members shaped `<Name> = "<domain>/<slug>"`. Anchored at
	// the start of the line so we don't pick up string literals inside
	// doc-comments or unrelated code. The domain prefix is captured as
	// group 2 so we can route the entry to its domain without re-parsing.
	const memberRegex = /^\s*([A-Z][A-Za-z0-9]*)\s*=\s*"(run|step|seam)\/([A-Za-z0-9_]+)"/gm;
	const entries: EventEntry[] = [];
	let m: RegExpExecArray | null;
	while ((m = memberRegex.exec(events.content)) !== null) {
		const name = m[1];
		const domain = m[2] as "run" | "step" | "seam";
		const slug = m[3];
		if (name === undefined || domain === undefined || slug === undefined) continue;
	entries.push({
			name,
			id: `${domain}/${slug}`,
			domain: domain as "run",
			source: "src/observability/events.ts",
		});
	}

	// Sanity guard: events.ts was emptied of the step + seam domains
	// when the corresponding observability surface was dropped. Only
	// the run/* domain remains. If the extractor drops below 1, the
	// events file has been emptied — surface loudly.
	if (entries.length < 1) {
		throw new Error(
			`event: no enum members extracted from observability/events.ts — at least 1 required`,
		);
	}

	return { entries, sources: [events] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extractor 5 — namespace ownership
// ─────────────────────────────────────────────────────────────────────────────

interface NamespaceEntry {
	id: "orchestrator" | "developer" | "auditor";
	patterns: string[];
}

function extractNamespace(): { entries: NamespaceEntry[]; sources: SourceFile[] } {
	const ns = loadSource("src/namespace-ownership.ts");

	// Parse the three pattern constants: ORCHESTRATOR_PATTERNS, DEVELOPER_PATTERNS, AUDITOR_PATTERNS.
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

	const orchestrator = parsePatterns("ORCHESTRATOR_PATTERNS");
	const dev = parsePatterns("DEVELOPER_PATTERNS");
	const aud = parsePatterns("AUDITOR_PATTERNS");

	const entries: NamespaceEntry[] = [
		{ id: "orchestrator", patterns: orchestrator },
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
			return { payload: { entries }, sources };
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
