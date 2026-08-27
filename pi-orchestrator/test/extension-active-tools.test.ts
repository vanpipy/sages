/**
 * extension-active-tools.test.ts — GC-2026-081
 *
 * Asserts the session_start `setActiveTools` allowlist includes the
 * todowrite* tools (orchestrator's own todowwrite_compile +
 * todowrite_progress from GC-2026-074, plus pi-magic-context's
 * `todowrite`). Without this, the orchestrator's constitution
 * (templates/SYSTEM.md) advertises a tool the runtime hides — the
 * bug surfaced empirically during GC-2026-076 (8-SC / 2-task DAG ran
 * end-to-end with zero todowrite activity).
 *
 * Two layers of pinning:
 *   1. Direct constant array assertion — exports of TODOWRITE_TOOLS
 *      + the three existing ORCHESTRATOR/SUBAGENT/BASELINE arrays.
 *      If anyone removes a tool from the constant, this fires.
 *   2. session_start hook text scan — read extension.ts as text and
 *      assert the spread expression is present and the literal call
 *      to `setActiveTools(tools)` follows. Drift guard against
 *      silent removal of the spread itself.
 *
 * Run: cd pi-orchestrator && bun test ./test/extension-active-tools.test.ts
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	ORCHESTRATOR_TOOLS,
	SUBAGENT_TOOLS,
	BASELINE_TOOLS,
	TODOWRITE_TOOLS,
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

	it("SUBAGENT_TOOLS still contains the 3 subagent tools", () => {
		expect(SUBAGENT_TOOLS).toEqual(
			expect.arrayContaining(["Agent", "get_subagent_result", "steer_subagent"]),
		);
		expect(SUBAGENT_TOOLS.length).toBe(3);
	});

	it("BASELINE_TOOLS still contains the 7 baseline FS tools", () => {
		expect(BASELINE_TOOLS).toEqual(
			expect.arrayContaining(["bash", "read", "edit", "write", "grep", "find", "ls"]),
		);
		expect(BASELINE_TOOLS.length).toBe(7);
	});
});

describe("session_start hook text scan (GC-2026-081)", () => {
	const src = readFileSync(EXTENSION_TS_PATH, "utf-8");
	// Locate the pi.on("session_start", () => { ... }); block.
	const hookMatch = src.match(
		/pi\.on\(\s*"session_start"\s*,\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*\);/,
	);
	const block = hookMatch?.[1] ?? "";

	it("session_start hook must exist in extension.ts", () => {
		expect(hookMatch, "session_start hook must exist").not.toBeNull();
	});

	it("session_start hook spreads TODOWRITE_TOOLS", () => {
		expect(block).toContain("...TODOWRITE_TOOLS");
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

describe("session_start end-to-end via MockPi (GC-2026-081)", () => {
	it("fires setActiveTools with exactly 18 entries: 15 existing + 3 todowrite*", async () => {
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
		// SC1
		expect(tools).toContain("todowrite");
		// SC2
		expect(tools).toContain("todowrite_compile");
		// SC3
		expect(tools).toContain("todowrite_progress");
		// SC4 — 15 existing still present
		for (const t of ORCHESTRATOR_TOOLS) expect(tools).toContain(t);
		for (const t of SUBAGENT_TOOLS) expect(tools).toContain(t);
		for (const t of BASELINE_TOOLS) expect(tools).toContain(t);
		// 15 + 3 = 18, with no duplicates
		expect(tools.length).toBe(18);
		expect(new Set(tools).size).toBe(18);
	});
});