/**
 * extension-active-tools.test.ts — GC-2026-orchestrator-simplify +
 * GC-2026-workflow-run + GC-2026-boundary-subagent-control.
 *
 * Asserts the session_start `setActiveTools` allowlist:
 *   - ORCHESTRATOR_TOOLS contains exactly 2 tools
 *     (`goal_contract_create`, `workflow_run` — GC-2026-workflow-run added
 *     the latter as a one-shot 5-phase pipeline runner)
 *   - PI_SUBAGENT_TOOLS contains 3 tools (Agent / get_subagent_result /
 *     steer_subagent — registered by `@sages/pi-subagents`)
 *   - SUBAGENT_CONTROL_TOOLS contains 4 tools (subagent_status / steer /
 *     abort / resume — registered by `@sages/pi-subagents` since
 *     GC-2026-boundary-subagent-control; orchestrator's constant
 *     is wiring-only)
 *   - SUBAGENT_TOOLS is the concatenation of the above two
 *   - BASELINE_TOOLS contains 7 file-system tools
 *   - PI_TASKS_TOOLS contains 7 workflow tools
 *   - AFT_TOOLS contains 11 tools (registered by `@cortexkit/aft-pi`)
 *
 * The orchestrator's 4 DAG / dispatch / audit / reminder tools plus
 * the todowrite trio are gone after orchestrator-simplify — the
 * TODOWRITE_TOOLS and CTX_TOOLS allowlists were already removed in
 * the GC-2026-remove-magic-context GC.
 *
 * Total active toolset: 2 (ORCHESTRATOR) + 7 (SUBAGENT) + 7 (PI_TASKS) +
 * 11 (AFT) + 7 (BASELINE) = 34.
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
	PI_TASKS_TOOLS,
	AFT_TOOLS,
} from "../src/extension.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_TS_PATH = join(__dirname, "..", "src", "extension.ts");

describe("PI_TASKS_TOOLS constant (GC-2026-orchestrator-simplify)", () => {
	const EXPECTED_PI_TASKS = [
		"TaskCreate",
		"TaskList",
		"TaskGet",
		"TaskUpdate",
		"TaskOutput",
		"TaskStop",
		"TaskExecute",
	];

	it("contains all 7 pi-tasks tool names", () => {
		expect(PI_TASKS_TOOLS).toEqual(expect.arrayContaining(EXPECTED_PI_TASKS));
	});

	it("is exactly 7 entries (no silent additions / no missing)", () => {
		expect(PI_TASKS_TOOLS.length).toBe(7);
	});

	it("includes TaskCreate and TaskExecute for pipeline driving", () => {
		expect(PI_TASKS_TOOLS).toContain("TaskCreate");
		expect(PI_TASKS_TOOLS).toContain("TaskExecute");
	});
});

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

describe("existing tool allowlist constants — regression (GC-2026-orchestrator-simplify)", () => {
	it("ORCHESTRATOR_TOOLS contains exactly 2 tools: goal_contract_create + workflow_run", () => {
		expect(ORCHESTRATOR_TOOLS).toEqual(["goal_contract_create", "workflow_run"]);
		expect(ORCHESTRATOR_TOOLS.length).toBe(2);
	});

	it("ORCHESTRATOR_TOOLS does NOT include any of the removed 4 tools", () => {
		expect(ORCHESTRATOR_TOOLS).not.toContain("dag_synthesize");
		expect(ORCHESTRATOR_TOOLS).not.toContain("task_dispatch");
		expect(ORCHESTRATOR_TOOLS).not.toContain("orchestrator_audit");
		expect(ORCHESTRATOR_TOOLS).not.toContain("sages_reminder");
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

describe("session_start hook text scan (GC-2026-orchestrator-simplify)", () => {
	const src = readFileSync(EXTENSION_TS_PATH, "utf-8");
	const hookMatch = src.match(
		/pi\.on\(\s*"session_start"\s*,\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*\);/,
	);
	const block = hookMatch?.[1] ?? "";

	it("session_start hook must exist in extension.ts", () => {
		expect(hookMatch, "session_start hook must exist").not.toBeNull();
	});

	it("session_start hook spreads PI_TASKS_TOOLS (workflow engine)", () => {
		expect(block).toContain("...PI_TASKS_TOOLS");
	});

	it("session_start hook spreads AFT_TOOLS (regression)", () => {
		expect(block).toContain("...AFT_TOOLS");
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

	it("session_start hook does NOT spread TODOWRITE_TOOLS (deleted)", () => {
		expect(block).not.toContain("...TODOWRITE_TOOLS");
	});

	it("session_start hook does NOT spread CTX_TOOLS (deleted)", () => {
		expect(block).not.toContain("...CTX_TOOLS");
	});

	it("session_start hook calls setActiveTools(tools)", () => {
		expect(block).toMatch(/\.setActiveTools\s*\(\s*tools\s*\)/);
	});
});

describe("session_start end-to-end via MockPi (GC-2026-orchestrator-simplify)", () => {
	it("fires setActiveTools with 34 entries: 2 orchestrator + 7 subagent + 7 pi-tasks + 11 AFT + 7 baseline", async () => {
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
		const tools = activeToolsCalls[0];
		// ORCHESTRATOR family — just goal_contract_create
		expect(tools).toContain("goal_contract_create");
		expect(tools).not.toContain("dag_synthesize");
		expect(tools).not.toContain("task_dispatch");
		expect(tools).not.toContain("orchestrator_audit");
		expect(tools).not.toContain("sages_reminder");
		// PI_TASKS family
		for (const t of PI_TASKS_TOOLS) expect(tools).toContain(t);
		// AFT family
		for (const t of AFT_TOOLS) expect(tools).toContain(t);
		// SUBAGENT family
		for (const t of SUBAGENT_TOOLS) expect(tools).toContain(t);
		// BASELINE family
		for (const t of BASELINE_TOOLS) expect(tools).toContain(t);
		// Total: 1 + 7 + 7 + 11 + 7 = 33, no duplicates
		expect(tools.length).toBe(34);
		expect(new Set(tools).size).toBe(34);
	});
});

describe("setActiveTools order — pi-tasks/AFT before BASELINE", () => {
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

	it("places TaskCreate BEFORE bash", async () => {
		const tools = await captureTools();
		expect(tools.indexOf("TaskCreate")).toBeLessThan(tools.indexOf("bash"));
	});

	it("places TaskExecute BEFORE bash", async () => {
		const tools = await captureTools();
		expect(tools.indexOf("TaskExecute")).toBeLessThan(tools.indexOf("bash"));
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

	it("places all PI_TASKS tools BEFORE all BASELINE tools", async () => {
		const tools = await captureTools();
		const lastPiTasksIdx = Math.max(
			...PI_TASKS_TOOLS.map((t) => tools.indexOf(t)).filter((i) => i >= 0),
		);
		const firstBaselineIdx = Math.min(
			...BASELINE_TOOLS.map((t) => tools.indexOf(t)).filter((i) => i >= 0),
		);
		expect(lastPiTasksIdx).toBeLessThan(firstBaselineIdx);
	});

	it("keeps the 33-entry total after reorder (no silent additions / removals)", async () => {
		const tools = await captureTools();
		expect(tools.length).toBe(34);
	});
});
