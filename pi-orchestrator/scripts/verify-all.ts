#!/usr/bin/env bun
/**
 * verify-all.ts — GC-2026-install-pi-tasks
 *
 * Unified entry point for every verify-*.ts script under
 * pi-orchestrator/scripts/. Runs each in order, collects exit
 * codes + stdout, prints a summary, and exits 0 only if all
 * verifiers passed.
 *
 * Run from anywhere:
 *   bun run scripts/verify-all.ts
 *   bun run verify:all      # via package.json scripts.verify.all
 *
 * Verifier list (current):
 *   - verify-catalog: catalogs/ vs source files (subagent.json, event.json, namespace.json)
 *   - verify-gcdb: every goal-{id}.yaml has postmortem or carve-out
 *   - verify-isolation-modes: no forbidden 'isolation: "worktree"' literals
 *   - verify-namespace-ownership: no orchestrator path leaks in subagent templates
 *   - verify-pi-universe: cross-package consistency
 *   - verify-soft-mode-mental-model: SOFT_MODE_REMINDER runtime wiring present
 *   - verify-pi-tasks-tools: PI_TASKS_TOOLS allowlist vs pi-tasks registerTool
 *   - verify-created-by-invariant: every store.create carries created_by
 *   - verify-extension-load (GC-2026-extension-load-verify): jiti-import each
 *     registered package to surface the host loader's silent fail-soft
 *   - verify-workflow-meta-invariant (GC-2026-118 F3): workflow spec builders stamp workflow_run_goal_id
 *   - verify-task-source-invariant (GC-2026-120 AC8): chain-task create sites carry user_task_ref
 *
 * Why a wrapper script (vs just `bun run verify:catalog && bun run verify:gcdb ...`):
 *   - One command for humans/CI to run.
 *   - Aggregate exit code: any single failure fails the whole run.
 *   - Single summary line at the end so CI logs are easy to scan.
 *   - Failures from one verifier don't abort subsequent ones (so the
 *     summary reports ALL failures, not just the first).
 *
 * Each verifier is invoked via `bun` in a subprocess. We could
 * `import` them in-process for speed, but:
 *   - In-process imports mean a `throw` in any verifier aborts the
 *     entire run, hiding the rest.
 *   - Each verifier exits with a distinct contract; the subprocess
 *     boundary preserves that contract.
 *
 * No external dependencies beyond `bun` (which is also a runtime dep
 * of pi-orchestrator).
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Verifiers to run, in order. Each entry: { id, script, label }.
// The list is intentionally a flat array — easier than parsing
// package.json#scripts and decouples the verifier list from any
// future script renaming.
const VERIFIERS: { id: string; script: string; label: string }[] = [
	{
		id: "catalog",
		script: "verify-catalog.ts",
		label: "catalogs/ vs source files",
	},
	{
		id: "gcdb",
		script: "verify-gcdb.ts",
		label: "goal contracts have postmortem or carve-out",
	},
	{
		id: "isolation-modes",
		script: "verify-isolation-modes.ts",
		label: "no forbidden isolation: 'worktree' literals",
	},
	{
		id: "namespace-ownership",
		script: "verify-namespace-ownership.ts",
		label: "no orchestrator path leaks in subagent templates",
	},
	{
		id: "pi-universe",
		script: "verify-pi-universe.ts",
		label: "cross-package consistency",
	},
	{
		id: "soft-mode-mental-model",
		script: "verify-soft-mode-mental-model.ts",
		label: "SOFT_MODE_REMINDER runtime wiring",
	},
	{
		id: "pi-tasks-tools",
		script: "verify-pi-tasks-tools.ts",
		label: "PI_TASKS_TOOLS allowlist vs pi-tasks registerTool",
	},
	{
		id: "created-by-invariant",
		script: "verify-created-by-invariant.ts",
		label: "every store.create carries created_by stamp",
	},
	{
		id: "extension-load",
		script: "verify-extension-load.ts",
		label: "every registered package extension loads via jiti",
	},
	{
		id: "workflow-meta-invariant",
		script: "verify-workflow-meta-invariant.ts",
		label: "workflow spec builders stamp workflow_run_goal_id (GC-2026-118 F3)",
	},
	{
		id: "task-source-invariant",
		script: "verify-task-source-invariant.ts",
		label: "chain-task create sites in materializeDecomposeChain carry user_task_ref (GC-2026-120 AC8)",
	},
];

interface Result {
	id: string;
	label: string;
	exitCode: number;
	durationMs: number;
	stdoutTail: string;
	stderrTail: string;
}

function runVerifier(scriptRelPath: string): { exitCode: number; stdout: string; stderr: string; durationMs: number } {
	const scriptPath = join(__dirname, scriptRelPath);
	const start = Date.now();
	const r = spawnSync("bun", ["run", scriptPath], {
		encoding: "utf-8",
		timeout: 60_000,
	});
	return {
		exitCode: r.status ?? 1,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
		durationMs: Date.now() - start,
	};
}

function tail(s: string, lines = 8): string {
	const arr = s.split(/\r?\n/);
	return arr.slice(-lines).join("\n").trim();
}

async function main(): Promise<void> {
	console.log("=== verify-all: running every verifier under pi-orchestrator/scripts/ ===\n");
	const results: Result[] = [];
	let totalPassed = 0;

	for (const v of VERIFIERS) {
		process.stdout.write(`  [${v.id}] ${v.label} ... `);
		const { exitCode, stdout, stderr, durationMs } = runVerifier(v.script);
		const ok = exitCode === 0;
		if (ok) {
			totalPassed++;
			process.stdout.write(`OK (${durationMs}ms)\n`);
		} else {
			process.stdout.write(`FAIL (${durationMs}ms, exit=${exitCode})\n`);
		}
		results.push({
			id: v.id,
			label: v.label,
			exitCode,
			durationMs,
			stdoutTail: tail(stdout),
			stderrTail: tail(stderr),
		});
	}

	const totalFailed = VERIFIERS.length - totalPassed;
	console.log("");
	console.log(`=== verify-all summary: ${totalPassed}/${VERIFIERS.length} passed ===`);

	if (totalFailed === 0) {
		console.log("OK: every verifier green");
		process.exit(0);
	}

	console.log("");
	for (const r of results) {
		if (r.exitCode !== 0) {
			console.log(`--- [${r.id}] FAIL ---`);
			if (r.stdoutTail) {
				console.log("stdout (last 8 lines):");
				console.log(r.stdoutTail);
			}
			if (r.stderrTail) {
				console.log("stderr (last 8 lines):");
				console.log(r.stderrTail);
			}
			console.log("");
		}
	}

	console.log(`FAIL: ${totalFailed} verifier(s) failed`);
	process.exit(1);
}

main().catch((err) => {
	console.error("verify-all crashed:", err);
	process.exit(2);
});
