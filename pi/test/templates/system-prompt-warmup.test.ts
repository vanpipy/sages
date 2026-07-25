/**
 * system-prompt-warmup.test.ts — Pin the Tool Backend Warmup contract in
 * `pi/templates/SYSTEM.md`.
 *
 * GC-2026-012: the warmup step was a *recommendation*. Promote it to a
 * *requirement*: the orchestrator LLM must invoke codebase_memory_list_projects
 * AND graphify_graph_stats in a single parallel batch, in one turn, BEFORE any
 * other tool call (including read / aft_search / ls / grep). Without this,
 * subagents spawned later in the session pay a 1-3s MCP cold-start on their
 * first code-graph call.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PI_ROOT = path.resolve(__dirname, "..", "..");
const SYSTEM_MD = path.join(PI_ROOT, "templates", "SYSTEM.md");

function readSystemMd(): string {
	const text = fs.readFileSync(SYSTEM_MD, "utf8");
	return text;
}

/**
 * Extract a `### Tool Backend Warmup` section (its body) so we can assert on
 * the section in isolation rather than on the whole document.
 */
function extractWarmupSection(text: string): string | null {
	const start = text.indexOf("### Tool Backend Warmup");
	if (start < 0) return null;
	const after = text.slice(start);
	// Stop at the next `### ` or `## ` heading boundary (whichever comes first).
	const nextHeading = after.slice(4).search(/^(##|###)\s/m);
	if (nextHeading < 0) return after;
	return after.slice(0, 4 + nextHeading);
}

describe("SYSTEM.md: Tool Backend Warmup contract (GC-2026-012)", () => {
	const text = readSystemMd();
	const section = extractWarmupSection(text);

	it("templates/SYSTEM.md exists at the canonical path", () => {
		expect(fs.existsSync(SYSTEM_MD), `missing ${SYSTEM_MD}`).toBe(true);
	});

	it("declares a '### Tool Backend Warmup' subsection", () => {
		expect(section, "Tool Backend Warmup section must exist").not.toBeNull();
	});

	it("names BOTH warmup tools verbatim", () => {
		expect(section, "section must name codebase_memory_list_projects").toMatch(
			/`?codebase_memory_list_projects`?/,
		);
		expect(section, "section must name graphify_graph_stats").toMatch(
			/`?graphify_graph_stats`?/,
		);
	});

	it("treats warmup as REQUIRED (not 'consider' / 'should')", () => {
		// Force an explicit duty verb. The first sentence of the section body
		// must use a MUST / REQUIRED-class verb on the warmup action.
		expect(section!.toLowerCase()).toMatch(/\b(must|required|required —)\b/);
	});

	it("requires parallel execution in a single turn", () => {
		// Both "parallel" and "one turn" (or equivalent — same batch, single
		// turn, etc.) must appear in the section so the LLM is told to issue
		// the two calls together rather than serially.
		expect(section!.toLowerCase()).toMatch(/\bparallel\b/);
		expect(section!.toLowerCase()).toMatch(
			/\b(one turn|single turn|same (batch|tool batch)|single (batch|tool batch))\b/,
		);
	});

	it("forbids running any other tool BEFORE warmup completes", () => {
		// The semantic requirement: warmup runs before *anything else*. Phrasing
		// may use "before any other tool call" / "before any other" / "first",
		// etc. — test generously.
		expect(section!.toLowerCase()).toMatch(
			/(before|prior to|before any other|before the first|before any).{0,40}(tool|read|aft_search)/,
		);
	});

	it("positions warmup inside 'Setup — once per session' (before 'Action Priority')", () => {
		// The setup block lists a deterministic order: context load -> warmup.
		// Warmup must be inside the 'Setup — once per session' block, before
		// '## Action Priority' so the LLM does not jump to action without it.
		const setupStart = text.indexOf("## Setup — once per session");
		const actionStart = text.indexOf("## Action Priority");
		const warmupStart = text.indexOf("### Tool Backend Warmup");
		expect(setupStart, "setup block must exist").toBeGreaterThanOrEqual(0);
		expect(actionStart, "action priority block must exist").toBeGreaterThanOrEqual(0);
		expect(warmupStart, "warmup block must exist").toBeGreaterThanOrEqual(0);
		expect(warmupStart).toBeGreaterThanOrEqual(setupStart);
		expect(warmupStart).toBeLessThan(actionStart);
	});
});
