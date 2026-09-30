#!/usr/bin/env bun
/**
 * verify-pi-universe.ts — GC-2026-095
 *
 * Verifies that no file in the sages repo references the dead
 * `@mariozechner/pi-coding-agent` / `@mariozechner/pi-ai` / `@mariozechner/pi-tui`
 * upstream packages. pi 0.99.1 ships only under the `@earendil-works/*`
 * scope; the `@mariozechner/*` line stopped at 0.73.1.
 *
 * Background: pre-GC-2026-095, four sages packages
 * (`pi-orchestrator`, `pi-codebase-memory`, `pi-evaluator`, and the
 * auditor tooling under `pi-evaluator`) imported types from
 * `@mariozechner/pi-coding-agent`, while `pi-subagents` was already on
 * `@earendil-works/pi-coding-agent@0.81.1`. Two parallel pi universes
 * coexisted; only one was reachable at runtime. GC-2026-095 unified
 * the four packages on `@earendil-works/*@^0.99.1`.
 *
 * This verifier is the regression guard: any future commit that
 * re-introduces a `@mariozechner/pi-*` reference fails the gate.
 *
 * Scan scope:
 *   - Source files (`*.ts`, `*.tsx`) under every pi-* package's `src/`
 *   - Every package.json under the repo root + workspaces
 *   - Top-level `*.sh`, `*.md`, `*.json` for the pi binary install
 *     path (the `pi` binary is installed by `pi.dev/install.sh`, not
 *     pinned in this repo, but a stray `@mariozechner/pi-coding-agent`
 *     reference in docs is still a smell)
 *
 * Skipped:
 *   - `node_modules/` (the dead package may still be present as a
 *     transitive dep, that's not actionable here)
 *   - `.git/`
 *   - `dist/` (build output)
 *
 * No external dependencies. Self-test: running this script against
 * the current sages repo (post-GC-2026-095) MUST exit 0.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PI_ORCH_ROOT = join(__dirname, "..");
const REPO_ROOT = join(PI_ORCH_ROOT, "..");

// The dead upstream. Matches both bare `@mariozechner/pi-coding-agent`
// and any subpath import like `@mariozechner/pi-coding-agent/dist/...`.
const DEAD_PACKAGES = [
	"@mariozechner/pi-coding-agent",
	"@mariozechner/pi-ai",
	"@mariozechner/pi-tui",
];
const DEAD_PATTERN = new RegExp(
	`["']@mariozechner/pi-(?:coding-agent|ai|tui)(?:/[^"'\\s]+)?["']`,
	"g",
);

const SCAN_DIRS = ["src"]; // scanned under every package
const PACKAGE_JSONS = [
	"pi-orchestrator/package.json",
	"pi-subagents/package.json",
	"pi-codebase-memory/package.json",
	"pi-evaluator/package.json",
	"package.json", // root
];
const DOC_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".sh", ".yaml", ".yml"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "catalogs", ".sages", ".pi"]);
const SKIP_FILES = new Set([".DS_Store"]);

interface Offender {
	file: string;
	line: number;
	match: string;
}

function listSourceFiles(dir: string): string[] {
	const out: string[] = [];
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP_FILES.has(entry.name)) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			out.push(...listSourceFiles(full));
		} else if (DOC_EXTENSIONS.has(extname(entry.name))) {
			out.push(full);
		}
	}
	return out;
}

function scanFile(path: string): Offender[] {
	const offenders: Offender[] = [];
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return offenders;
	}
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		DEAD_PATTERN.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = DEAD_PATTERN.exec(line)) !== null) {
			offenders.push({
				file: relative(REPO_ROOT, path),
				line: i + 1,
				match: m[0],
			});
		}
	}
	return offenders;
}

function listPackageSrcFiles(): string[] {
	const out: string[] = [];
	for (const pkgDir of ["pi-orchestrator", "pi-subagents", "pi-codebase-memory", "pi-evaluator"]) {
		for (const sub of SCAN_DIRS) {
			out.push(...listSourceFiles(join(REPO_ROOT, pkgDir, sub)));
		}
	}
	return out;
}

function main(): void {
	const filesToScan = [
		...listPackageSrcFiles(),
		...PACKAGE_JSONS.map((p) => join(REPO_ROOT, p)),
	];

	const offenders: Offender[] = [];
	for (const f of filesToScan) {
		if (!existsSync(f)) continue;
		if (statSync(f).isDirectory()) continue;
		offenders.push(...scanFile(f));
	}

	if (offenders.length > 0) {
		console.error(`verify-pi-universe: FAIL — ${offenders.length} dead-upstream reference(s) found:`);
		for (const o of offenders) {
			console.error(`  ${o.file}:${o.line}  ${o.match}`);
		}
		console.error("");
		console.error("All four sages packages must import pi types from @earendil-works/*.");
		console.error("The @mariozechner/pi-coding-agent line is dead at 0.73.1;");
		console.error("the live pi 0.99.1 ships under @earendil-works/pi-coding-agent.");
		console.error("");
		console.error("To fix:");
		console.error("  1. Edit the file above.");
		console.error("  2. Update the corresponding package.json peer/dep to '@earendil-works/pi-coding-agent: ^0.99.1'.");
		console.error("  3. If imports shifted subpath (e.g. from \"@earendil-works/pi-ai\" to");
		console.error("     \"@earendil-works/pi-ai/compat\" — see GC-2026-095 postmortem), update.");
		process.exit(1);
	}

	console.log("OK: no dead-upstream @mariozechner/pi-* references in source or package.json");
	console.log(`  scanned ${filesToScan.length} file(s) across 4 pi-* packages`);
}

main();
