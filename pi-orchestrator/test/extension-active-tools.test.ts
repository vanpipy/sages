/**
 * extension-active-tools.test.ts — GC-2026-081 / GC-2026-086
 *
 * Asserts the session_start `setActiveTools` allowlist includes the
 * todowrite* tools (orchestrator's own todowwrite_compile +
 * todowrite_progress from GC-2026-074, plus pi-magic-context's
 * `todowrite`), the AFT_* tools (GC-2026-086, registered by
 * @cortexkit/aft-pi), and the ctx_* tools (GC-2026-086, registered by
 * @cortexkit/pi-magic-context). Without these, the orchestrator's
 * constitution (templates/SYSTEM.md, DEVELOPER_PROMPT, AGENTS.md)
 * advertises tools the runtime hides — the bug surfaced empirically
 * during GC-2026-076 (todowrite) and during GC-2026-086 round 2 live
 * test (`aft_search` returned "Tool aft_search not found").
 *
 * Two layers of pinning:
 *   1. Direct constant array assertion — exports of TODOWRITE_TOOLS +
 *      AFT_TOOLS + CTX_TOOLS + the three existing
 *      ORCHESTRATOR/SUBAGENT/BASELINE arrays. If anyone removes a
 *      tool from the constant, this fires.
 *   2. session_start hook text scan — read extension.ts as text and
 *      assert each spread expression is present and the literal call
 *      to `setActiveTools(tools)` follows. Drift guard against
 *      silent removal of the spread itself.
 *
 * Total active toolset: 5 (ORCHESTRATOR) + 7 (SUBAGENT) + 7
 * (BASELINE) + 3 (TODOWRITE) + 11 (AFT) + 5 (CTX) = 38.
 *
 * SUBAGENT_TOOLS expanded from 3 to 7 during the orchestrator↔subagents
 * seam audit — added the four `subagent_*` control tools
 * (status / steer / abort / resume) so the LLM has schema-level access
 * to incident-response on its own background dispatches.
 *
 * SUBAGENT_TOOLS is the concatenation of `PI_SUBAGENT_TOOLS` (3 tools,
 * registered by `@sages/pi-subagents`) + `SUBAGENT_CONTROL_TOOLS` (4
 * tools, registered by the orchestrator's `registerSubagentControlTools`).
 * Splitting them at the type level makes the ownership boundary
 * self-documenting — adding a new subagent tool forces the contributor
 * to declare which side owns it.
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
	TODOWRITE_TOOLS,
	AFT_TOOLS,
	CTX_TOOLS,
} from "../src/extension.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_TS_PATH = join(__dirname, "..", "src", "extension.ts");

describe("TODOWRITE_TOOLS constant (GC-2026-081)", () => {
	it("contains the three todowrite* tool names", () => {
		expect(TODOWRITE_TOOLS).toContain("todowrite");
		expect(TODOWRITE_TOOLS).toContain("todowrite_compile");
		expect(TODOWRITE_TOOLS).toContain("todowrite_progress");
	});

	it("is exactly 3 entries (no silent additions)", () => {
		expect(TODOWRITE_TOOLS.length).toBe(3);
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

describe("CTX_TOOLS constant (GC-2026-086)", () => {
	const EXPECTED_CTX = [
		"ctx_search",
		"ctx_memory",
		"ctx_note",
		"ctx_reduce",
		"ctx_expand",
	];

	it("contains all 5 ctx_* tool names (completeness)", () => {
		expect(CTX_TOOLS).toEqual(expect.arrayContaining(EXPECTED_CTX));
	});

	it("is exactly 5 entries (no silent additions / no missing)", () => {
		expect(CTX_TOOLS.length).toBe(5);
	});

	it("SC3 — includes all 5 ctx_* tool names verbatim", () => {
		for (const name of EXPECTED_CTX) {
			expect(CTX_TOOLS).toContain(name);
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
		// `Agent`, `get_subagent_result`, `steer_subagent` are owned by
		// `@sages/pi-subagents` (see pi-subagents/src/index.ts lines
		// 1154, 2040, 2138). Use deep equality (toEqual) on the tuple —
		// arrayContaining would silently accept extra entries.
		expect(PI_SUBAGENT_TOOLS).toEqual([
			"Agent",
			"get_subagent_result",
			"steer_subagent",
		]);
	});

	it("SUBAGENT_CONTROL_TOOLS contains exactly the 4 tools registered by the orchestrator", () => {
		// `subagent_status` / `subagent_steer` / `subagent_abort` /
		// `subagent_resume` are registered by the orchestrator's own
		// `registerSubagentControlTools` (GC-2026-073). Deep equality
		// pins both presence AND exact ordering — silent additions
		// require updating this assertion, which is the point.
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
		// Structural invariant — if anyone adds a tool to one of the
		// sub-arrays but forgets the other, this fails. The
		// concatenation in `extension.ts` is the contract.
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

describe("session_start hook text scan (GC-2026-081 + GC-2026-086)", () => {
	const src = readFileSync(EXTENSION_TS_PATH, "utf-8");
	// Locate the pi.on("session_start", () => { ... }); block.
	const hookMatch = src.match(
		/pi\.on\(\s*"session_start"\s*,\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*\);/,
	);
	const block = hookMatch?.[1] ?? "";

	it("session_start hook must exist in extension.ts", () => {
		expect(hookMatch, "session_start hook must exist").not.toBeNull();
	});

	it("session_start hook spreads TODOWRITE_TOOLS (GC-2026-081)", () => {
		expect(block).toContain("...TODOWRITE_TOOLS");
	});

	it("session_start hook spreads AFT_TOOLS (GC-2026-086)", () => {
		expect(block).toContain("...AFT_TOOLS");
	});

	it("session_start hook spreads CTX_TOOLS (GC-2026-086)", () => {
		expect(block).toContain("...CTX_TOOLS");
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

describe("session_start end-to-end via MockPi (GC-2026-081 + GC-2026-086)", () => {
	it("fires setActiveTools with exactly 38 entries: 19 existing + 3 todowrite* + 11 AFT + 5 ctx_*", async () => {
		// Minimal MockPi — just enough surface to fire session_start.
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
		// Wire the real default export on the MockPi. This runs all the
		// registerX(pi) calls (no-op on the mock) and registers the three
		// session hooks. We only need the session_start side-effect.
		ext.default(pi as unknown as Parameters<typeof ext.default>[0]);

		expect(activeToolsCalls.length).toBe(1);
		const tools = activeToolsCalls[0];
		// SC1 — todowrite family
		expect(tools).toContain("todowrite");
		expect(tools).toContain("todowrite_compile");
		expect(tools).toContain("todowrite_progress");
		// SC2 — AFT family
		expect(tools).toContain("aft_search");
		for (const t of AFT_TOOLS) expect(tools).toContain(t);
		// SC3 — ctx_* family
		for (const t of CTX_TOOLS) expect(tools).toContain(t);
		// SC4 — 19 existing still present (5 ORCHESTRATOR + 7 SUBAGENT + 7 BASELINE)
		for (const t of ORCHESTRATOR_TOOLS) expect(tools).toContain(t);
		for (const t of SUBAGENT_TOOLS) expect(tools).toContain(t);
		for (const t of BASELINE_TOOLS) expect(tools).toContain(t);
		// SC5 — 19 + 3 + 11 + 5 = 38, with no duplicates
		expect(tools.length).toBe(38);
		expect(new Set(tools).size).toBe(38);
	});
});

describe("setActiveTools order — AFT/ctx before BASELINE (GC-2026-087 SC1)", () => {
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

	it("places ctx_search BEFORE bash", async () => {
		const tools = await captureTools();
		expect(tools.indexOf("ctx_search")).toBeLessThan(tools.indexOf("bash"));
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

	it("places all ctx_* tools BEFORE all BASELINE tools", async () => {
		const tools = await captureTools();
		const lastCtxIdx = Math.max(
			...CTX_TOOLS.map((t) => tools.indexOf(t)).filter((i) => i >= 0),
		);
		const firstBaselineIdx = Math.min(
			...BASELINE_TOOLS.map((t) => tools.indexOf(t)).filter((i) => i >= 0),
		);
		expect(lastCtxIdx).toBeLessThan(firstBaselineIdx);
	});

	it("keeps the 38-entry total after reorder (no silent additions / removals)", async () => {
		const tools = await captureTools();
		expect(tools.length).toBe(38);
	});
});