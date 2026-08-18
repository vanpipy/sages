#!/usr/bin/env bun
/**
 * verify-namespace-ownership.ts — GC-2026-052 T6.1
 *
 * Verifies that subagent + profile YAML templates do not declare
 * L3 paths (`.pi/orchestrator/...`) in their `files:` (or
 * equivalent) path lists.
 *
 * Background: per the `.pi/orchestrator/` namespace ownership
 * contract (see `AGENTS.md` and `SUBAGENTS.md`), subagent
 * dispatch is partitioned into:
 *
 *   - **L3 orchestrator** owns `goal-*.yaml`, `dag-*.yaml`,
 *     `audit-state-*.yaml`, and the orchestrator workflow
 *     rollups.
 *   - **Subagents** own their own reports (`task-{id}-report.md`)
 *     and handoffs (`handoff/{ws}/{id}-handoff.md`).
 *
 * If a subagent template lists `.pi/orchestrator/goal-*.yaml`
 * in its `files:`, that template is declaring ownership over an
 * L3 path — a namespace violation. Subagents MUST NOT modify
 * orchestrator state; only the L3 orchestrator (main agent) owns
 * those paths.
 *
 * Scan scope: every YAML file under `subagents/` and `profiles/`.
 * The check operates on the parsed YAML — any string value that
 * starts with `.pi/orchestrator/` is flagged, regardless of which
 * key it appears under.
 *
 * On any hit: print the offending file + matched path and exit 1.
 * On no hits: print `OK: no L3 path references in subagent /
 * profile templates` and exit 0.
 *
 * No external dependencies beyond `js-yaml`. Self-test: running
 * this script against the current `pi/` tree MUST exit 0.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PI_ROOT = join(__dirname, "..");

const TEMPLATE_DIRS = ["subagents", "profiles"];
const L3_PREFIX = ".pi/orchestrator/";
const L3_PATTERN = /"\.pi\/orchestrator\/[^"]+"/g;

export interface NamespaceScanResult {
	ok: boolean;
	offenders: Array<{ file: string; path: string }>;
}

function scanFile(path: string): string[] {
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return [];
	}
	// First try to parse as YAML; if it fails, fall back to raw
	// text scanning. The YAML parse succeeds for well-formed
	// config; the raw scan catches malformed files.
	const matches = new Set<string>();
	try {
		const doc = yaml.load(text);
		if (doc && typeof doc === "object") {
			walkValue(doc, matches);
		}
	} catch {
		// fall through to raw scan
	}
	for (const m of text.matchAll(L3_PATTERN)) {
		matches.add(m[0]);
	}
	return [...matches].sort();
}

function walkValue(value: unknown, out: Set<string>): void {
	if (value === null || value === undefined) return;
	if (typeof value === "string") {
		if (value.startsWith(L3_PREFIX)) out.add(`"${value}"`);
		return;
	}
	if (Array.isArray(value)) {
		for (const v of value) walkValue(v, out);
		return;
	}
	if (typeof value === "object") {
		for (const v of Object.values(value as Record<string, unknown>)) {
			walkValue(v, out);
		}
	}
}

export function scanNamespaceOwnership(): NamespaceScanResult {
	const offenders: NamespaceScanResult["offenders"] = [];
	for (const dir of TEMPLATE_DIRS) {
		const absDir = join(PI_ROOT, dir);
		if (!existsSync(absDir)) continue;
		for (const entry of readdirSync(absDir)) {
			if (!/\.(yaml|yml)$/.test(entry)) continue;
			const path = join(absDir, entry);
			const matches = scanFile(path);
			for (const m of matches) {
				offenders.push({ file: relative(PI_ROOT, path), path: m });
			}
		}
	}
	return { ok: offenders.length === 0, offenders };
}

function main(): void {
	const result = scanNamespaceOwnership();
	if (!result.ok) {
		console.error(
			`verify-namespace-ownership: FAIL — ${result.offenders.length} L3 path reference(s) in templates:`,
		);
		for (const o of result.offenders) {
			console.error(`  ✗ ${o.file}: ${o.path}`);
		}
		console.error(
			`      fix: remove the \`${L3_PREFIX}*\` path from the template — L3 orchestrator paths are owned by the main agent, not subagents.`,
		);
		process.exit(1);
	}
	console.log(
		`OK: no L3 path references in subagent templates (scanned ${TEMPLATE_DIRS.join(", ")})`,
	);
	process.exit(0);
}

const ENTRY = process.argv[1] ?? "";
if (ENTRY.endsWith("verify-namespace-ownership.ts") || ENTRY.endsWith("verify-namespace-ownership.js")) {
	main();
}