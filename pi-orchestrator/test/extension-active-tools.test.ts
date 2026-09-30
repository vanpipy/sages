/**
 * extension-active-tools.test.ts — post-GC-2026-remove-magic-context.
 *
 * Asserts the session_start `setActiveTools` allowlist includes the
 * AFT_* tools (GC-2026-086, registered by @cortexkit/aft-pi) and the
 * three remaining tool groups: ORCHESTRATOR + SUBAGENT + BASELINE.
 *
 * History: GC-2026-081/GC-2026-086 added todowrite* and ctx_* tools;
 * GC-2026-remove-magic-context removed them (magic-context is gone).
 * Total active toolset: 5 (ORCHESTRATOR) + 7 (SUBAGENT) + 7
 * (BASELINE) + 11 (AFT) = 30.
 *
 * Two layers of pinning:
 *   1. Direct constant array assertion — exports of AFT_TOOLS +
 *      ORCHESTRATOR/SUBAGENT/BASELINE arrays.
 *   2. session_start hook text scan — assert each spread expression
 *      is present and the literal call to `setActiveTools(tools)`
 *      follows. Drift guard against silent removal of the spread.
 *
 * SUBAGENT_TOOLS is the concatenation of `PI_SUBAGENT_TOOLS` (3 tools,
 * registered by `@sages/pi-subagents`) + `SUBAGENT_CONTROL_TOOLS` (4
 * tools, registered by the orchestrator's `registerSubagentControlTools`).
 *
 * Run: cd pi-orchestrator && bun test ./test/extension-active-tools.test.ts
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	ORCHESTRATOR_TOOLS,
	PI_SUBAGENT_TOOLS,
	SUBAGENT_CONTROL_TOOLS,
	SUBAGENT_TOOLS,
	BASELINE_TOOLS,
	AFT_TOOLS,
} from "../src/extension.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_TS_PATH = join(__dirname, "..", "src", "extension.ts");

describe("AFT_TOOLS constant (GC-2026-086)", () => {
	const EXPECTED_AFT = [
		"aft_callgraph",
		"aft_conflicts",
		"aft_delete",
		"aft_import",
		"aft_inspect",
		"aft_move",
		"aft_outline",
		"aft_refactor",
		"aft_safety",
		"aft_search",
		"aft_zoom",
	];

	it("contains all 11 AFT tool names (completeness)", () => {
		expect(AFT_TOOLS).toEqual(expect.arrayContaining(EXPECTED_AFT));
	});

	it("is exactly 11 entries (no silent additions / no missing)", () => {
		expect(AFT_TOOLS.length).toBe(11);
	});

	it("SC1 — includes the literal string 'aft_search'", () => {
		expect(AFT_TOOLS).toContain("aft_search");
	});

	it("SC2 — includes all 11 AFT tool names verbatim", () => {
		for (const name of EXPECTED_AFT) {
			expect(AFT_TOOLS).toContain(name);
		}
	});
});

describe("existing tool allowlist constants — regression (GC-2026-081)", () => {
	it("ORCHESTRATOR_TOOLS still contains the 5 orchestrator tools", () => {
		expect(ORCHESTRATOR_TOOLS).toEqual(
			expect.arrayContaining([
				"goal_contract_create",
				"dag_synthesize",
				"task_dispatch",
				"orchestrator_audit",
				"sages_reminder",
			]),
		);
		expect(ORCHESTRATOR_TOOLS.length).toBe(5);
	});

	it("PI_SUBAGENT_TOOLS contains exactly the 3 tools registered by pi-subagents", () => {
		expect(PI_SUBAGENT_TOOLS).toEqual([
			"Agent",
			"get_subagent_result",
			"steer_subagent",
		]);
	});

	it("SUBAGENT_CONTROL_TOOLS contains exactly the 4 tools registered by the orchestrator", () => {
		expect(SUBAGENT_CONTROL_TOOLS).toEqual([
			"subagent_status",
			"subagent_steer",
			"subagent_abort",
			"subagent_resume",
		]);
	});

	it("SUBAGENT_TOOLS contains all 7 subagent tools", () => {
		expect(SUBAGENT_TOOLS).toEqual(
			expect.arrayContaining([
				...PI_SUBAGENT_TOOLS,
				...SUBAGENT_CONTROL_TOOLS,
			]),
		);
		expect(SUBAGENT_TOOLS.length).toBe(7);
	});

	it("SUBAGENT_TOOLS is the concatenation of its two semantic sub-arrays (drift guard)", () => {
		expect(SUBAGENT_TOOLS.length).toBe(
			PI_SUBAGENT_TOOLS.length + SUBAGENT_CONTROL_TOOLS.length,
		);
		expect(SUBAGENT_TOOLS).toEqual([...PI_SUBAGENT_TOOLS, ...SUBAGENT_CONTROL_TOOLS]);
	});

	it("BASELINE_TOOLS still contains the 7 baseline FS tools", () => {
		expect(BASELINE_TOOLS).toEqual(
			expect.arrayContaining(["bash", "read", "edit", "write", "grep", "find", "ls"]),
		);
		expect(BASELINE_TOOLS.length).toBe(7);
	});
});

describe("session_start hook text scan (GC-2026-086)", () => {
	const src = readFileSync(EXTENSION_TS_PATH, "utf-8");
	const hookMatch = src.match(
		/pi\.on\(\s*"session_start"\s*,\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*\);/,
	);
	const block = hookMatch?.[1] ?? "";

	it("session_start hook must exist in extension.ts", () => {
		expect(hookMatch, "session_start hook must exist").not.toBeNull();
	});

	it("session_start hook spreads AFT_TOOLS (GC-2026-086)", () => {
		expect(block).toContain("...AFT_TOOLS");
	});

	it("session_start hook does NOT spread TODOWRITE_TOOLS (post-GC-2026-remove-magic-context)", () => {
		expect(block).not.toContain("...TODOWRITE_TOOLS");
	});

	it("session_start hook does NOT spread CTX_TOOLS (post-GC-2026-remove-magic-context)", () => {
		expect(block).not.toContain("...CTX_TOOLS");
	});

	it("session_start hook spreads ORCHESTRATOR_TOOLS (regression)", () => {
		expect(block).toContain("...ORCHESTRATOR_TOOLS");
	});

	it("session_start hook spreads SUBAGENT_TOOLS (regression)", () => {
		expect(block).toContain("...SUBAGENT_TOOLS");
	});

	it("session_start hook spreads BASELINE_TOOLS (regression)", () => {
		expect(block).toContain("...BASELINE_TOOLS");
	});

	it("session_start hook calls setActiveTools(tools)", () => {
		expect(block).toMatch(/\.setActiveTools\s*\(\s*tools\s*\)/);
	});
});

describe("session_start end-to-end via MockPi (GC-2026-086)", () => {
	it("fires setActiveTools with exactly 30 entries: 5 ORCHESTRATOR + 7 SUBAGENT + 11 AFT + 7 BASELINE", async () => {
		const activeToolsCalls: string[][] = [];
		const pi = {
			setActiveTools(tools: string[]) {
				activeToolsCalls.push(tools);
			},
			setStatus(_id: string, _text: string) {
				/* noop */
			},
			registerTool(_def: unknown) {
				/* noop */
			},
			appendEntry(_type: string, _data: unknown) {
				/* noop */
			},
			on(event: string, handler: unknown) {
				if (event === "session_start") {
					(handler as (e: unknown, c: unknown) => void)({}, {});
				}
				if (event === "before_agent_start") {
					/* noop */
				}
				if (event === "tool_call") {
					/* noop */
				}
			},
		};

		const ext = await import("../src/extension.js");
		ext.default(pi as unknown as Parameters<typeof ext.default>[0]);

		expect(activeToolsCalls.length).toBe(1);
		const tools = activeToolsCalls[0]!;
		// AFT family
		expect(tools).toContain("aft_search");
		for (const t of AFT_TOOLS) expect(tools).toContain(t);
		// 5 ORCHESTRATOR + 7 SUBAGENT + 7 BASELINE
		for (const t of ORCHESTRATOR_TOOLS) expect(tools).toContain(t);
		for (const t of SUBAGENT_TOOLS) expect(tools).toContain(t);
		for (const t of BASELINE_TOOLS) expect(tools).toContain(t);
		// Total = 30, no duplicates
		expect(tools.length).toBe(30);
		expect(new Set(tools).size).toBe(30);
	});

	it("does NOT include any todowrite* or ctx_* tool names (post-GC-2026-remove-magic-context)", async () => {
		const activeToolsCalls: string[][] = [];
		const pi = {
			setActiveTools(tools: string[]) {
				activeToolsCalls.push(tools);
			},
			setStatus() {
				/* noop */
			},
			registerTool() {
				/* noop */
			},
			appendEntry() {
				/* noop */
			},
			on(event: string, handler: unknown) {
				if (event === "session_start") {
					(handler as (e: unknown, c: unknown) => void)({}, {});
				}
			},
		};
		const ext = await import("../src/extension.js");
		ext.default(pi as unknown as Parameters<typeof ext.default>[0]);
		const tools = activeToolsCalls[0]!;
		for (const t of [
			"todowrite",
			"todowrite_compile",
			"todowrite_progress",
			"ctx_search",
			"ctx_memory",
			"ctx_note",
			"ctx_reduce",
			"ctx_expand",
		]) {
			expect(tools).not.toContain(t);
		}
	});
});

describe("setActiveTools order — AFT before BASELINE (GC-2026-087 SC1)", () => {
	async function captureTools(): Promise<string[]> {
		const activeToolsCalls: string[][] = [];
		const pi = {
			setActiveTools(tools: string[]) {
				activeToolsCalls.push(tools);
			},
			setStatus() {
				/* noop */
			},
			registerTool() {
				/* noop */
			},
			appendEntry() {
				/* noop */
			},
			on(event: string, handler: unknown) {
				if (event === "session_start") {
					(handler as (e: unknown, c: unknown) => void)({}, {});
				}
			},
		};
		const ext = await import("../src/extension.js");
		ext.default(pi as unknown as Parameters<typeof ext.default>[0]);
		return activeToolsCalls[0]!;
	}

	it("places aft_search BEFORE bash (LLM adoption bias toward earlier tools)", async () => {
		const tools = await captureTools();
		expect(tools.indexOf("aft_search")).toBeLessThan(tools.indexOf("bash"));
	});

	it("places aft_outline BEFORE bash", async () => {
		const tools = await captureTools();
		expect(tools.indexOf("aft_outline")).toBeLessThan(tools.indexOf("bash"));
	});

	it("places all AFT tools BEFORE all BASELINE tools", async () => {
		const tools = await captureTools();
		const lastAftIdx = Math.max(
			...AFT_TOOLS.map((t) => tools.indexOf(t)).filter((i) => i >= 0),
		);
		const firstBaselineIdx = Math.min(
			...BASELINE_TOOLS.map((t) => tools.indexOf(t)).filter((i) => i >= 0),
		);
		expect(lastAftIdx).toBeLessThan(firstBaselineIdx);
	});

	it("keeps the 30-entry total after reorder (no silent additions / removals)", async () => {
		const tools = await captureTools();
		expect(tools.length).toBe(30);
	});
});