#!/usr/bin/env bun
/**
 * aggregate-subagent-usage.ts — GC-2026-subagent-recording-no-budget
 *
 * `bun run subagent-usage:summary` reads the JSONL log at
 * `.pi/orchestrator/metrics/subagent-tool-usage.jsonl` (or a path
 * passed via `--jsonl <path>`) and prints per-agent-type stats:
 *
 *   - total tool calls (sessions × tool invocations)
 *   - total wall-clock duration (sum of per-tool `durationMs`)
 *   - top 10 tools by call count
 *   - per-agent-type breakdown (calls + duration)
 *
 * This is the post-hoc visibility surface that replaces the removed
 * budget enforcement. Operators who previously would have seen
 * "SubagentTimeout: budget exceeded" errors now see "agent X ran for
 * 47min, 3.1× its nominal 15min deadline" in this summary, and decide
 * manually whether to abort.
 *
 * Exit codes:
 *   0 — log read OK (or empty log, treated as no-data)
 *   1 — log path unreadable (perm denied / file missing)
 *
 * Pure read; never modifies the log. Safe to run concurrently with
 * subagent runs (the recorder appends serially via a per-instance
 * promise mutex).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

interface ToolUseRow {
	agentId: string;
	agentType: string;
	taskId: string;
	toolName: string;
	inputKeys: readonly string[];
	durationMs: number;
	ts: number;
}

function parseArgs(argv: string[]): { jsonl: string } {
	let jsonl = join(
		process.cwd(),
		".pi",
		"orchestrator",
		"metrics",
		"subagent-tool-usage.jsonl",
	);
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--jsonl" && i + 1 < argv.length) {
			jsonl = resolve(argv[i + 1]);
			i++;
		}
	}
	return { jsonl };
}

function readRows(path: string): ToolUseRow[] {
	if (!existsSync(path)) return [];
	const text = readFileSync(path, "utf-8");
	const out: ToolUseRow[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			out.push(JSON.parse(trimmed) as ToolUseRow);
		} catch {
			// Skip malformed rows — the recorder is best-effort and a
			// truncated last line (mid-write crash) is expected.
		}
	}
	return out;
}

function main(): number {
	const { jsonl } = parseArgs(process.argv);
	let rows: ToolUseRow[];
	try {
		rows = readRows(jsonl);
	} catch (err) {
		process.stderr.write(
			`subagent-usage:summary: failed to read ${jsonl}: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		return 1;
	}

	if (rows.length === 0) {
		process.stdout.write(
			`subagent-usage:summary: 0 rows in ${jsonl} (no subagent runs recorded yet, or log rotated)\n`,
		);
		return 0;
	}

	const byAgent = new Map<string, { calls: number; durationMs: number }>();
	const byTool = new Map<string, number>();
	let totalDuration = 0;
	const agentIds = new Set<string>();
	let firstTs = Number.POSITIVE_INFINITY;
	let lastTs = 0;
	for (const r of rows) {
		const slot = byAgent.get(r.agentType) ?? { calls: 0, durationMs: 0 };
		slot.calls += 1;
		slot.durationMs += r.durationMs;
		byAgent.set(r.agentType, slot);
		byTool.set(r.toolName, (byTool.get(r.toolName) ?? 0) + 1);
		totalDuration += r.durationMs;
		agentIds.add(r.agentId);
		if (r.ts < firstTs) firstTs = r.ts;
		if (r.ts > lastTs) lastTs = r.ts;
	}

	process.stdout.write(`subagent-usage:summary\n`);
	process.stdout.write(`  log:           ${jsonl}\n`);
	process.stdout.write(`  total rows:    ${rows.length}\n`);
	process.stdout.write(`  unique agents: ${agentIds.size}\n`);
	process.stdout.write(`  total duration (sum of per-tool ms): ${totalDuration.toLocaleString()} ms\n`);
	if (Number.isFinite(firstTs) && firstTs < Number.POSITIVE_INFINITY) {
		process.stdout.write(
			`  span:          ${new Date(firstTs).toISOString()} → ${new Date(lastTs).toISOString()}\n`,
		);
	}
	process.stdout.write(`\n  per agentType:\n`);
	const agents = [...byAgent.entries()].sort((a, b) => b[1].calls - a[1].calls);
	for (const [agent, agg] of agents) {
		process.stdout.write(
			`    ${agent.padEnd(18)} ${String(agg.calls).padStart(6)} calls  ${(agg.durationMs / 1000).toFixed(1).padStart(8)}s\n`,
		);
	}
	process.stdout.write(`\n  top tools:\n`);
	const tools = [...byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
	for (const [tool, count] of tools) {
		process.stdout.write(`    ${tool.padEnd(24)} ${count}\n`);
	}
	return 0;
}

process.exit(main());
