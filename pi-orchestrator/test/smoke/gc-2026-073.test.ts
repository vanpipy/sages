/**
 * GC-2026-073 smoke test — session-hooks wiring (adapted for orchestrator-simplify)
 *
 * Verifies that the orchestrator's `extension.ts` default export wires
 * the three session-level hooks:
 *
 *   1. `session_start`        — `pi.setActiveTools([...])` + `pi.setStatus(...)`
 *   2. `before_agent_start`   — prepends `templates/SYSTEM.md` overlay
 *   3. `tool_call`            — fires `pi.appendEntry("system", SOFT_MODE_REMINDER)`
 *                              once per session on the first `bash` call
 *
 * After GC-2026-orchestrator-simplify the orchestrator registers
 * 1 tool (`goal_contract_create`) + 4 subagent control tools. The
 * active toolset now includes pi-tasks tools (TaskCreate / TaskList /
 * TaskExecute / etc.) for driving the Implement → Review → optional
 * Fix → Merge pipeline.
 *
 * Self-contained MockPi (no real pi runtime). Run:
 *   cd pi-orchestrator && bun test ./test/smoke/gc-2026-073.test.ts
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PI_ORCH_ROOT = join(__dirname, "..", "..");

// ─── Mock pi runtime ────────────────────────────────────────────────────────

class MockPi {
	tools = new Map<string, { name: string; description: string; label?: string; parameters: any; execute: any }>();
	systemEntries: Array<{ customType: string; data: any }> = [];
	toolCallListeners: Array<(event: any, ctx: any) => any> = [];
	beforeAgentStartListeners: Array<(event: any, ctx: any) => any> = [];
	sessionStartListeners: Array<(event: any, ctx: any) => any> = [];

	setActiveToolsCalls: string[][] = [];
	setStatusCalls: Array<{ id: string; text: string }> = [];
	activeTools: string[] | null = null;

	registerTool(def: any) {
		this.tools.set(def.name, def);
	}

	appendEntry(customType: string, data: any) {
		this.systemEntries.push({ customType, data });
	}

	setActiveTools(tools: string[]): void {
		this.activeTools = tools;
		this.setActiveToolsCalls.push(tools);
	}

	getActiveTools(): string[] {
		return this.activeTools ?? [];
	}

	setStatus(id: string, text: string): void {
		this.setStatusCalls.push({ id, text });
	}

	on(event: string, handler: any): void {
		if (event === "tool_call") this.toolCallListeners.push(handler);
		else if (event === "before_agent_start") this.beforeAgentStartListeners.push(handler);
		else if (event === "session_start") this.sessionStartListeners.push(handler);
	}

	fireSessionStart(event: any = {}) {
		for (const h of this.sessionStartListeners) h(event, {});
	}

	fireBeforeAgentStart(event: any) {
		let result = event;
		for (const h of this.beforeAgentStartListeners) {
			const r = h(result, {});
			if (r) result = r;
		}
		return result;
	}

	fireToolCall(event: { toolName: string; input: any; timestamp?: number }) {
		for (const h of this.toolCallListeners) h({ toolName: event.toolName, input: event.input }, {});
	}
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("GC-2026-073 smoke: orchestrator extension.ts default export", () => {
	let pi: MockPi;

	beforeEach(() => {
		pi = new MockPi();
	});

	it("SMOKE-073-1: default export registers the orchestrator's own tools (goal_contract_create + workflow_run + decompose_task — GC-2026-task-feeding-and-decomposition)", async () => {
		const ext = await import("../../src/extension.js");
		expect(typeof ext.default).toBe("function");
		ext.default(pi as any);
		const toolNames = [...pi.tools.keys()].sort();
		// GC-2026-boundary-subagent-control: the 4 subagent control tools
		// (subagent_status / steer / abort / resume) moved out of the
		// orchestrator and into pi-subagents. The orchestrator's
		// default export registers the three orchestrator-owned tools
		// (goal_contract_create + workflow_run + decompose_task). The 4
		// subagent control tools are covered by pi-subagents' own smoke test.
		expect(toolNames).toEqual([
			"decompose_task",
			"goal_contract_create",
			"workflow_run",
		]);
	});

	it("SMOKE-073-2: session_start calls setActiveTools with orchestrator + subagent + pi-tasks + AFT + baseline tools", async () => {
		const ext = await import("../../src/extension.js");
		ext.default(pi as any);
		pi.fireSessionStart();
		expect(pi.setActiveToolsCalls.length).toBe(1);
		const tools = pi.setActiveToolsCalls[0];
		// Orchestrator
		expect(tools).toContain("goal_contract_create");
		// Subagent (pi-subagents)
		expect(tools).toContain("Agent");
		expect(tools).toContain("get_subagent_result");
		expect(tools).toContain("steer_subagent");
		// Subagent control (orchestrator)
		expect(tools).toContain("subagent_status");
		expect(tools).toContain("subagent_steer");
		expect(tools).toContain("subagent_abort");
		expect(tools).toContain("subagent_resume");
		// Pi-tasks
		expect(tools).toContain("TaskCreate");
		expect(tools).toContain("TaskList");
		expect(tools).toContain("TaskExecute");
		// AFT
		expect(tools).toContain("aft_search");
		// Baseline
		expect(tools).toContain("bash");
		expect(tools).toContain("read");
		expect(tools).toContain("edit");
		expect(tools).toContain("write");
		// Removed tools must NOT be in the active toolset
		expect(tools).not.toContain("dag_synthesize");
		expect(tools).not.toContain("task_dispatch");
		expect(tools).not.toContain("orchestrator_audit");
		expect(tools).not.toContain("sages_reminder");
		expect(tools).not.toContain("todowrite_compile");
		expect(tools).not.toContain("todowrite_progress");
		expect(tools).not.toContain("todowrite");
	});

	it("SMOKE-073-3: session_start calls setStatus with the orchestrator banner", async () => {
		const ext = await import("../../src/extension.js");
		ext.default(pi as any);
		pi.fireSessionStart();
		expect(pi.setStatusCalls.length).toBe(1);
		expect(pi.setStatusCalls[0].id).toBe("sages-orchestrator");
		expect(pi.setStatusCalls[0].text).toMatch(/orchestrator active/);
	});

	it("SMOKE-073-4: before_agent_start prepends templates/SYSTEM.md to systemPrompt", async () => {
		const ext = await import("../../src/extension.js");
		ext.default(pi as any);
		// Confirm the template exists at the expected location
		const templatePath = join(PI_ORCH_ROOT, "templates", "SYSTEM.md");
		expect(existsSync(templatePath)).toBe(true);
		const result = pi.fireBeforeAgentStart({ systemPrompt: "USER_PROMPT" });
		expect(result.systemPrompt).toContain("USER_PROMPT");
		// The overlay should mention orchestrator content (constitution)
		expect(result.systemPrompt).toMatch(/orchestrator|Soft mode|workflow/i);
	});

	it("SMOKE-073-5: first bash tool_call fires the soft-mode reminder via appendEntry", async () => {
		const ext = await import("../../src/extension.js");
		ext.default(pi as any);
		// GC-2026-087 SC2: use `echo` instead of `ls -la` so the new
		// codebase-search-nudge doesn't add a second system entry.
		pi.fireToolCall({ toolName: "bash", input: { command: "echo hello" } });
		expect(pi.systemEntries.length).toBe(1);
		expect(pi.systemEntries[0].customType).toBe("system");
		const data = pi.systemEntries[0].data;
		const text = typeof data === "string" ? data : data?.text;
		expect(typeof text).toBe("string");
		expect(text).toMatch(/SOFT MODE/);
		// After orchestrator-simplify the reminder mentions pi-tasks workflow
		// instead of "4-stage DAG" / "subagent dispatch".
		expect(text).toMatch(/pi-tasks|workflow/i);
		expect(text).not.toMatch(/4-stage DAG|subagent dispatch/i);
	});

	it("SMOKE-073-6: soft-mode reminder fires only once per session (subsequent bash → no new entry)", async () => {
		const ext = await import("../../src/extension.js");
		ext.default(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "echo one" } });
		pi.fireToolCall({ toolName: "bash", input: { command: "echo two" } });
		pi.fireToolCall({ toolName: "bash", input: { command: "echo three" } });
		expect(pi.systemEntries.length).toBe(1);
	});

	it("SMOKE-073-7: read tool_call does NOT trigger the reminder; bash/edit/write do (GC-2026-098 L3)", async () => {
		// GC-2026-098 L3: the soft-mode reminder gate was extended from
		// bash-only to bash/edit/write. Sessions that begin with edit
		// (no bash) should still see the nudge. read/grep/find stay
		// silent — read-only operations don't signal workflow-worthy work.
		const ext = await import("../../src/extension.js");
		ext.default(pi as any);
		pi.fireToolCall({ toolName: "read", input: { path: "foo.ts" } });
		expect(pi.systemEntries.length).toBe(0);
		pi.fireToolCall({ toolName: "edit", input: { path: "foo.ts" } });
		expect(pi.systemEntries.length).toBe(1);
	});
});
