#!/usr/bin/env bun
/**
 * verify-subagent-roster.ts — GC-2026-052 T6.1
 *
 * Verifies two-way consistency between the two subagent-roster
 * surfaces:
 *
 *   1. `KNOWN_SUBAGENT_IDS` exported by `@sages/pi-subagents` — the
 *      canonical list of subagent ids. The runtime registry loader
 *      `sages/pi/src/tools/orchestrator/dag-synthesizer.ts` consults
 *      this list at synthesize time.
 *   2. `pi/templates/SUBAGENTS.md` — the orchestrator-facing deployment
 *      reference table. The roster has to be visible to the human /
 *      LLM reading the orchestrator docs.
 *
 * The verifier enforces equivalence between these two surfaces.
 * On mismatch: print the offending id and exit 1. On match: print
 * `OK: subagent roster — KNOWN_SUBAGENT_IDS = SUBAGENTS.md` and
 * exit 0.
 *
 * Self-test: running this script against the current `pi/` tree
 * MUST exit 0.
 *
 * Entry-point guard matches the pattern in `verify-catalog.ts` —
 * the helper functions are also importable by tests without
 * triggering `process.exit(0)` on import.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_SUBAGENT_IDS } from "@sages/pi-subagents";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PI_ROOT = join(__dirname, "..");
const SUBAGENTS_MD = join(PI_ROOT, "templates", "SUBAGENTS.md");

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
	const registryIds = new Set(KNOWN_SUBAGENT_IDS);

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
			`in KNOWN_SUBAGENT_IDS but missing from SUBAGENTS.md table: ${registryOnly.join(", ")}`,
		);
	}
	if (tableOnly.length > 0) {
		parts.push(
			`in SUBAGENTS.md table but missing from KNOWN_SUBAGENT_IDS: ${tableOnly.join(", ")}`,
		);
	}
	return { ok: false, error: parts.join("; "), registryOnly, tableOnly };
}

function main(): void {
	const result = checkSubagentRoster();
	if (!result.ok) {
		console.error(`verify-subagent-roster: FAIL`);
		console.error(`  ✗ ${result.error}`);
		console.error(
			`      fix: edit SUBAGENTS.md (the orchestrator-facing doc) to agree with KNOWN_SUBAGENT_IDS (defined in pi-subagents)`,
		);
		process.exit(1);
	}
	const ids = KNOWN_SUBAGENT_IDS;
	console.log(
		`OK: subagent roster — KNOWN_SUBAGENT_IDS (${ids.length}) = SUBAGENTS.md table`,
	);
	for (const id of ids) {
		console.log(`  ✓ ${id}`);
	}
	process.exit(0);
}

const ENTRY = process.argv[1] ?? "";
if (ENTRY.endsWith("verify-subagent-roster.ts") || ENTRY.endsWith("verify-subagent-roster.js")) {
	main();
}