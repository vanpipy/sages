#!/usr/bin/env bun
/**
 * verify-subagent-roster.ts — GC-2026-052 T6.1
 *
 * Verifies three-way consistency across the three subagent-roster
 * sources of truth:
 *
 *   1. `pi/subagents/registry.yaml` — runtime registry loaded by
 *      `pi/src/tools/orchestrator/subagent-registry.ts`. The
 *      canonical list of subagent ids.
 *   2. `pi/templates/SUBAGENTS.md` — the orchestrator-facing
 *      deployment reference table. The roster has to be visible
 *      to the human / LLM reading the orchestrator docs.
 *   3. The set of `subagent_type` ids actually accepted by
 *      `pi/src/tools/orchestrator/dag-synthesizer.ts` — derived
 *      from the registry at runtime, so the synthesizer is
 *      automatically in sync as long as the registry is.
 *
 * The verifier enforces two-way equivalence between the registry
 * and the SUBAGENTS.md table. (The synthesizer is a runtime
 * derivative of the registry; its set always equals the registry's
 * `ids` set.) On mismatch: print the offending id and exit 1. On
 * match: print `OK: subagent roster — registry = SUBAGENTS.md`
 * and exit 0.
 *
 * No external dependencies beyond `js-yaml` (already a runtime
 * dep of pi). Self-test: running this script against the current
 * `pi/` tree MUST exit 0.
 *
 * Entry-point guard matches the pattern in `verify-catalog.ts` —
 * the helper functions are also importable by tests (e.g.
 * `test/verify-subagent-roster.test.ts`) without triggering
 * `process.exit(0)` on import.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PI_ROOT = join(__dirname, "..");

const REGISTRY_PATH = join(PI_ROOT, "subagents", "registry.yaml");
const SUBAGENTS_MD = join(PI_ROOT, "templates", "SUBAGENTS.md");

interface RegistryEntry {
	id: string;
	kind?: string;
	isolation?: string[];
	run_in_background?: boolean;
	gather?: boolean;
	artifact_schema?: string[];
}

interface Registry {
	subagents: RegistryEntry[];
}

function loadRegistry(): Registry {
	const raw = readFileSync(REGISTRY_PATH, "utf-8");
	const parsed = yaml.load(raw) as Registry;
	if (!parsed || !Array.isArray(parsed.subagents)) {
		throw new Error(
			`registry: required 'subagents' array is missing in ${REGISTRY_PATH}`,
		);
	}
	const seen = new Set<string>();
	for (const [i, e] of parsed.subagents.entries()) {
		if (!e || typeof e.id !== "string" || e.id.length === 0) {
			throw new Error(`registry: entry ${i} missing 'id' field`);
		}
		if (seen.has(e.id)) {
			throw new Error(`registry: duplicate id '${e.id}'`);
		}
		seen.add(e.id);
	}
	return parsed;
}

/**
 * Extract subagent ids from the SUBAGENTS.md roster table.
 *
 * The table format is:
 *   | Stage | `subagent_type`     | ... |
 *   |-------|---------------------|-----|
 *   | 1     | `Explore`           | ... |
 *   | 2     | `Plan`              | ... |
 *   | ...   | ...                 | ... |
 *
 * We only pick data rows (those whose first column is a numeric
 * stage index, since the header row's first column is the literal
 * word `Stage`). This avoids capturing `Stage` or `subagent_type`
 * from the header.
 */
function extractTableIds(markdown: string): Set<string> {
	const ids = new Set<string>();
	// Match data rows: `| <digits> | `<name>` | ...`
	const dataRow = /^\|\s*\d+\s*\|\s*`([A-Za-z][\w-]*)`\s*\|/;
	for (const line of markdown.split("\n")) {
		const m = line.match(dataRow);
		if (m && m[1]) ids.add(m[1]);
	}
	return ids;
}

export interface RosterResult {
	ok: boolean;
	error?: string;
	registryOnly?: string[];
	tableOnly?: string[];
}

export function checkSubagentRoster(): RosterResult {
	const registry = loadRegistry();
	const registryIds = new Set(registry.subagents.map((s) => s.id));

	const md = readFileSync(SUBAGENTS_MD, "utf-8");
	const tableIds = extractTableIds(md);

	const registryOnly = [...registryIds].filter((id) => !tableIds.has(id)).sort();
	const tableOnly = [...tableIds].filter((id) => !registryIds.has(id)).sort();

	if (registryOnly.length === 0 && tableOnly.length === 0) {
		return { ok: true };
	}
	const parts: string[] = [];
	if (registryOnly.length > 0) {
		parts.push(
			`in registry but missing from SUBAGENTS.md table: ${registryOnly.join(", ")}`,
		);
	}
	if (tableOnly.length > 0) {
		parts.push(
			`in SUBAGENTS.md table but missing from registry: ${tableOnly.join(", ")}`,
		);
	}
	return { ok: false, error: parts.join("; "), registryOnly, tableOnly };
}

function main(): void {
	const result = checkSubagentRoster();
	if (!result.ok) {
		console.error(`verify-subagent-roster: FAIL`);
		console.error(`  ✗ ${result.error}`);
		console.error(`      fix: edit ${REGISTRY_PATH} (the runtime source of truth) AND`);
		console.error(`           the roster table in ${SUBAGENTS_MD} to agree on the same id set`);
		process.exit(1);
	}
	const registry = loadRegistry();
	console.log(
		`OK: subagent roster — registry (${registry.subagents.length}) = SUBAGENTS.md table (${registry.subagents.length})`,
	);
	for (const e of registry.subagents) {
		console.log(`  ✓ ${e.id}`);
	}
	process.exit(0);
}

const ENTRY = process.argv[1] ?? "";
if (ENTRY.endsWith("verify-subagent-roster.ts") || ENTRY.endsWith("verify-subagent-roster.js")) {
	main();
}