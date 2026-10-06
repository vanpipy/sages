#!/usr/bin/env bun
/**
 * verify-pi-tasks-tools.ts — GC-2026-099 R6
 *
 * Verifies that the `PI_TASKS_TOOLS` allowlist declared in
 * `pi-orchestrator/src/extension.ts` matches the tool names actually
 * registered by `pi-tasks/src/index.ts` via `registerTool({ name: ... })`.
 *
 * Two directions of drift are bugs:
 *
 *   1. **Allowlist name not registered in pi-tasks.** The orchestrator
 *      promises the LLM that `TaskXxx` is available, but pi-tasks
 *      never registers it — `ctx.executeTool("TaskXxx")` returns
 *      "tool not found" and the LLM hits a runtime error.
 *
 *   2. **pi-tasks registers a tool NOT in the allowlist.** The orchestrator
 *      doesn't pass the new tool through `setActiveTools` — the LLM
 *      can't see it, defeating the purpose of registering it.
 *
 * Both directions fail this gate. The fix is one of:
 *
 *   - Rename / remove the tool in pi-tasks + update the allowlist
 *   - Add / remove the entry in the allowlist to match pi-tasks
 *   - If the tool was intentionally hidden from the orchestrator
 *     session (rare), move the registration out of the default
 *     extension factory — the verifier will catch it.
 *
 * Self-test: running this script against the current `pi-tasks/` and
 * `pi-orchestrator/` trees MUST exit 0.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PI_ORCH_ROOT = join(__dirname, "..");
const PI_TASKS_ROOT = join(PI_ORCH_ROOT, "..", "pi-tasks");
const ORCH_EXTENSION = join(PI_ORCH_ROOT, "src", "extension.ts");
const TASKS_INDEX = join(PI_TASKS_ROOT, "src", "index.ts");

export interface PiTasksToolsScan {
	allowlist: string[];
	registered: string[];
}

/**
 * Extract the allowlist names from `PI_TASKS_TOOLS = readonly string[] = [ ... ];`
 * in the orchestrator's extension.ts. The parser is deliberately
 * narrow: it matches a single declaration block bounded by
 * `PI_TASKS_TOOLS: readonly string[] = [` and the closing `];`.
 */
export function extractAllowlist(extensionSrc: string): string[] {
	const m = extensionSrc.match(
		/PI_TASKS_TOOLS\s*:\s*readonly\s+string\[\]\s*=\s*\[([\s\S]*?)\]/,
	);
	if (!m || !m[1]) return [];
	const out: string[] = [];
	for (const inner of m[1].matchAll(/["'`]([^"'`]+)["'`]/g)) {
		if (inner[1]) out.push(inner[1]);
	}
	return out;
}

/**
 * Extract every `name: "X"` literal that follows a `pi.registerTool({`
 * call in `pi-tasks/src/index.ts`. The parser is narrow on purpose:
 * it only matches the `name` field of a `registerTool` call shape.
 */
export function extractRegisteredTasksToolNames(tasksIndexSrc: string): string[] {
	const out: string[] = [];
	// Match `pi.registerTool({` then `name: "..."` within the next ~100
	// lines (long enough to span the multi-line tool definition bodies).
	// Multi-call safe: each match consumes one registerTool block.
	const re = /pi\.registerTool\(\s*\{[\s\S]*?name:\s*["'`]([^"'`]+)["'`]/g;
	for (const m of tasksIndexSrc.matchAll(re)) {
		if (m[1]) out.push(m[1]);
	}
	return out;
}

export function scan(): PiTasksToolsScan {
	const extSrc = existsSync(ORCH_EXTENSION)
		? readFileSync(ORCH_EXTENSION, "utf-8")
		: "";
	const tasksSrc = existsSync(TASKS_INDEX)
		? readFileSync(TASKS_INDEX, "utf-8")
		: "";
	return {
		allowlist: extractAllowlist(extSrc),
		registered: extractRegisteredTasksToolNames(tasksSrc),
	};
}

export interface PiTasksToolsResult {
	ok: boolean;
	allowlistMissing: string[]; // names in allowlist NOT in registered
	registeredExtra: string[]; // names registered NOT in allowlist
	allowlist: string[];
	registered: string[];
}

export function check(): PiTasksToolsResult {
	const { allowlist, registered } = scan();
	const allowSet = new Set(allowlist);
	const regSet = new Set(registered);
	return {
		ok:
			allowlist.every((n) => regSet.has(n)) &&
			registered.every((n) => allowSet.has(n)),
		allowlistMissing: allowlist.filter((n) => !regSet.has(n)),
		registeredExtra: registered.filter((n) => !allowSet.has(n)),
		allowlist,
		registered,
	};
}

function main(): void {
	if (!existsSync(ORCH_EXTENSION) || !existsSync(TASKS_INDEX)) {
		console.error(
			`verify-pi-tasks-tools: FAIL — missing source files (orch=${existsSync(ORCH_EXTENSION)}, tasks=${existsSync(TASKS_INDEX)})`,
		);
		process.exit(1);
	}
	const r = check();
	if (!r.ok) {
		console.error(`verify-pi-tasks-tools: FAIL — PI_TASKS_TOOLS drift`);
		if (r.allowlistMissing.length > 0) {
			console.error(
				`  allowlist names NOT registered in pi-tasks (LLM will get "tool not found"):`,
			);
			for (const n of r.allowlistMissing) console.error(`    - ${n}`);
		}
		if (r.registeredExtra.length > 0) {
			console.error(
				`  pi-tasks names NOT in allowlist (orchestrator will hide the tool from the LLM):`,
			);
			for (const n of r.registeredExtra) console.error(`    - ${n}`);
		}
		process.exit(1);
	}
	console.log(
		`OK: pi-tasks tool allowlist matches — ${r.allowlist.length} tool(s) allowlisted, ${r.registered.length} registered`,
	);
	process.exit(0);
}

const ENTRY = process.argv[1] ?? "";
if (
	ENTRY.endsWith("verify-pi-tasks-tools.ts") ||
	ENTRY.endsWith("verify-pi-tasks-tools.js")
) {
	main();
}
