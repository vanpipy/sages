/**
 * extension-active-tools.test.ts — the session_start allowlist.
 *
 * The orchestrator registers six LLM-facing consumer tools of its own
 * (`task_inspect` / `task_consume` / `task_convert_intent` /
 * `task_plan_intent` / `task_add_phase` / `task_close_intent`) and
 * curates an allowlist of peer-owned tools:
 *   - PI_SUBAGENT_TOOLS contains 3 tools (Agent / get_subagent_result /
 *     steer_subagent — registered by `@sages/pi-subagents`)
 *   - SUBAGENT_CONTROL_TOOLS contains 4 names (subagent_status / steer /
 *     abort / resume). The implementation was removed from pi-subagents
 *     in `a36ae68` (2026-10-11); the names stay in the allowlist but pi
 *     drops unknown names, so they are not live. See the prompt-refactor
 *     design doc, open decision D7.
 *   - SUBAGENT_TOOLS is the concatenation of the above two
 *   - BASELINE_TOOLS contains 7 file-system tools
 *   - PI_TASKS_TOOLS contains 7 workflow tools
 *   - AFT_TOOLS contains 11 tools (registered by `@cortexkit/aft-pi`)
 *   - PI_ROUTINES_TOOLS contains 6 tools (registered by `@sages/pi-routines`)
 *   - ORCHESTRATOR_TOOL_NAMES contains the orchestrator's own 6
 *
 * Total allowlist: 6 (orchestrator) + 7 (SUBAGENT) + 7 (PI_TASKS) +
 * 11 (AFT) + 7 (BASELINE) + 6 (PI_ROUTINES) = 44.
 *
 * REGRESSION GUARD: pi's `setActiveTools` REPLACES the active tool set
 * (it is not additive). A tool that is registered but missing from this
 * allowlist is invisible to the model and every call returns
 * "Tool <name> not found". Between 2026-10-11 and the fix that carried
 * this guard, the orchestrator's own six tools were in exactly that
 * state — registered in the tool registry, absent from the allowlist.
 *
 * Run: cd pi-orchestrator && bun test ./test/extension-active-tools.test.ts
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	PI_SUBAGENT_TOOLS,
	SUBAGENT_CONTROL_TOOLS,
	SUBAGENT_TOOLS,
	BASELINE_TOOLS,
	PI_TASKS_TOOLS,
	PI_ROUTINES_TOOLS,
	AFT_TOOLS,
} from "../src/extension.js";
import { ORCHESTRATOR_TOOL_NAMES } from "../src/orchestrator-tool.js";

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

describe("existing tool allowlist constants — regression (post goal-contract removal)", () => {
	it("the retired goal-contract ORCHESTRATOR_TOOLS constant is still not exported from extension.ts", () => {
		// The orchestrator's previous `ORCHESTRATOR_TOOLS = ["goal_contract_create"]`
		// was retired along with the tool itself. Asserting against the
		// export would be impossible (compile error); instead this test
		// pins the source-level contract.
		const src = readFileSync(EXTENSION_TS_PATH, "utf-8");
		expect(src).not.toMatch(/export\s+const\s+ORCHESTRATOR_TOOLS\b/);
	});

	it("ORCHESTRATOR_TOOL_NAMES holds exactly the 6 orchestrator-owned consumer tools", () => {
		expect(ORCHESTRATOR_TOOL_NAMES).toEqual([
			"task_inspect",
			"task_consume",
			"task_convert_intent",
			"task_plan_intent",
			"task_add_phase",
			"task_close_intent",
		]);
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

	it("session_start hook does NOT spread the retired ORCHESTRATOR_TOOLS constant", () => {
		expect(block).not.toContain("...ORCHESTRATOR_TOOLS,");
	});

	it("session_start hook spreads ORCHESTRATOR_TOOL_NAMES (the orchestrator's own 6 tools)", () => {
		// pi's setActiveTools REPLACES the active tool set. A registered
		// tool that is missing from this array is invisible to the model.
		expect(block).toContain("...ORCHESTRATOR_TOOL_NAMES");
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
	it("fires setActiveTools with 44 entries: 6 orchestrator + 7 subagent + 7 pi-tasks + 11 AFT + 7 baseline + 6 pi-routines", async () => {
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
		// The orchestrator's own six consumer tools MUST be in the
		// allowlist — pi's setActiveTools replaces the active set, so an
		// omission makes them invisible to the model.
		for (const t of ORCHESTRATOR_TOOL_NAMES) expect(tools).toContain(t);
		// Retired goal-contract-era tools stay out.
		expect(tools).not.toContain("goal_contract_create");
		expect(tools).not.toContain("decompose_task");
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
		// PI_ROUTINES family (opt-in via install.sh; sage pi-routines peer)
		for (const t of PI_ROUTINES_TOOLS) expect(tools).toContain(t);
		// Total: 6 + 7 + 7 + 11 + 7 + 6 = 44, no duplicates
		expect(tools.length).toBe(44);
		expect(new Set(tools).size).toBe(44);
	});
});

describe("orchestrator tool registration matches ORCHESTRATOR_TOOL_NAMES", () => {
	it("registers exactly the six names the allowlist advertises", async () => {
		const registered: string[] = [];
		const pi = {
			setActiveTools(_tools: string[]) {
				/* noop */
			},
			setStatus() {
				/* noop */
			},
			registerTool(def: { name: string }) {
				registered.push(def.name);
			},
			appendEntry() {
				/* noop */
			},
			on() {
				/* noop */
			},
		};

		const ext = await import("../src/extension.js");
		ext.default(pi as unknown as Parameters<typeof ext.default>[0]);

		expect(registered.slice().sort()).toEqual([...ORCHESTRATOR_TOOL_NAMES].sort());
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

	it("keeps the 44-entry total after reorder (no silent additions / removals)", async () => {
		const tools = await captureTools();
		expect(tools.length).toBe(44);
	});
});
