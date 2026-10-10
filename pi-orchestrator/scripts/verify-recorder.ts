#!/usr/bin/env bun
/**
 * verify-recorder.ts — GC-2026-subagent-recording-no-budget
 *
 * Verify gate asserting the post-hoc tool-use recording layer is wired:
 *
 *   1. `pi-subagents/src/recording.ts` exists and exports ToolUseRecorder +
 *      RECORDING_PATH_DEFAULT + SUBAGENTS_TOOL_USE + SUBAGENTS_RECORDING_ERROR
 *      + emitToolUse + the ToolUseRecord shape.
 *   2. The aggregator script `pi-orchestrator/scripts/aggregate-subagent-usage.ts`
 *      exists, is executable, and references RECORDING_PATH_DEFAULT.
 *   3. The removed budget-enforcement files are GONE (negative assertion):
 *      - pi-subagents/src/budget.ts
 *      - pi-subagents/src/agent-prompts/_sections/boundary-discipline.ts
 *      - pi-subagents/src/agent-prompts/_sections/exploration-budget.ts
 *   4. The replacement recording-notice section exists.
 *   5. The recording-notice section is interpolated by both Developer and
 *      Reviewer prompts (no drift).
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — at least one check failed (printed before exit)
 *
 * Pure read; never modifies the repo. Run as a `verify:recorder` gate
 * alongside the existing `verify:catalog` / `verify:namespace-ownership`
 * scripts.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..");
const piSubagentsRoot = join(repoRoot, "pi-subagents");
const piSubagentsSrc = join(piSubagentsRoot, "src");

let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`  ✓ ${label}\n`);
	} else {
		process.stdout.write(`  ✗ ${label}${detail ? ` — ${detail}` : ""}\n`);
		failures += 1;
	}
}

function readText(path: string): string {
	return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

function main(): number {
	process.stdout.write(`verify:recorder\n`);

	// 1. recording.ts exports the right surface
	const recordingSrc = readText(join(piSubagentsSrc, "recording.ts"));
	check(
		"recording.ts exports ToolUseRecorder class",
		/export\s+class\s+ToolUseRecorder\b/.test(recordingSrc),
	);
	check(
		"recording.ts exports ToolUseRecord interface",
		/export\s+interface\s+ToolUseRecord\b/.test(recordingSrc),
	);
	check(
		"recording.ts exports RECORDING_PATH_DEFAULT",
		/export\s+const\s+RECORDING_PATH_DEFAULT\b/.test(recordingSrc),
	);
	check(
		"RECORDING_PATH_DEFAULT points at .pi/orchestrator/metrics/subagent-tool-usage.jsonl",
		/RECORDING_PATH_DEFAULT\s*=\s*["']\.pi\/orchestrator\/metrics\/subagent-tool-usage\.jsonl["']/.test(
			recordingSrc,
		),
	);
	check(
		"recording.ts exports SUBAGENTS_TOOL_USE channel",
		/export\s+const\s+SUBAGENTS_TOOL_USE\s*=\s*["']subagents:tool-use["']/.test(recordingSrc),
	);
	check(
		"recording.ts exports SUBAGENTS_RECORDING_ERROR channel",
		/export\s+const\s+SUBAGENTS_RECORDING_ERROR\s*=\s*["']subagents:recording-error["']/.test(
			recordingSrc,
		),
	);
	check(
		"recording.ts exports emitToolUse helper",
		/export\s+function\s+emitToolUse\b/.test(recordingSrc),
	);

	// 2. aggregator script exists + references the constant
	const aggregatorPath = join(
		repoRoot,
		"pi-orchestrator",
		"scripts",
		"aggregate-subagent-usage.ts",
	);
	const aggregatorExists = existsSync(aggregatorPath);
	check("aggregator script exists", aggregatorExists, aggregatorPath);
	if (aggregatorExists) {
		const agg = readFileSync(aggregatorPath, "utf-8");
		check(
			"aggregator script references RECORDING_PATH_DEFAULT (or its derivative)",
			/subagent-tool-usage\.jsonl/.test(agg),
		);
	}

	// 3. negative assertion — removed files
	const budgetTs = join(piSubagentsSrc, "budget.ts");
	const boundary = join(
		piSubagentsSrc,
		"agent-prompts",
		"_sections",
		"boundary-discipline.ts",
	);
	const exploration = join(
		piSubagentsSrc,
		"agent-prompts",
		"_sections",
		"exploration-budget.ts",
	);
	check("budget.ts is deleted (no turn-budget enforcement)", !existsSync(budgetTs));
	check(
		"boundary-discipline.ts is deleted (no max_turns survival prompt)",
		!existsSync(boundary),
	);
	check(
		"exploration-budget.ts is deleted (no read/grep caps)",
		!existsSync(exploration),
	);

	// 4. replacement section exists
	const recordingNotice = join(
		piSubagentsSrc,
		"agent-prompts",
		"_sections",
		"recording-notice.ts",
	);
	check("recording-notice.ts exists (replacement section)", existsSync(recordingNotice));
	if (existsSync(recordingNotice)) {
		const src = readFileSync(recordingNotice, "utf-8");
		check(
			"recording-notice exports RECORDING_NOTICE_SECTION",
			/export\s+const\s+RECORDING_NOTICE_SECTION\s*=\s*`/.test(src),
		);
		check(
			"recording-notice mentions no turn or time limit",
			/\*\*no\s+turn\s+or\s+time\s+limit/.test(src),
		);
	}

	// 5. Developer + Reviewer interpolate RECORDING_NOTICE_SECTION
	const devPath = join(piSubagentsSrc, "agent-prompts", "developer.ts");
	const revPath = join(piSubagentsSrc, "agent-prompts", "reviewer.ts");
	const dev = readText(devPath);
	const rev = readText(revPath);
	check(
		"DEVELOPER_PROMPT interpolates RECORDING_NOTICE_SECTION",
		/\$\{RECORDING_NOTICE_SECTION\}/.test(dev),
	);
	check(
		"REVIEWER_PROMPT interpolates RECORDING_NOTICE_SECTION",
		/\$\{RECORDING_NOTICE_SECTION\}/.test(rev),
	);
	check(
		"DEVELOPER_PROMPT no longer references BOUNDARY_DISCIPLINE_SECTION",
		!/\$\{BOUNDARY_DISCIPLINE_SECTION\}/.test(dev) &&
			!/BOUNDARY_DISCIPLINE_SECTION/.test(dev),
	);
	check(
		"DEVELOPER_PROMPT no longer references EXPLORATION_BUDGET_SECTION",
		!/\$\{EXPLORATION_BUDGET_SECTION\}/.test(dev) &&
			!/EXPLORATION_BUDGET_SECTION/.test(dev),
	);

	process.stdout.write(
		`\nverify:recorder: ${failures === 0 ? "OK" : `${failures} failure(s)`}\n`,
	);
	return failures === 0 ? 0 : 1;
}

process.exit(main());
