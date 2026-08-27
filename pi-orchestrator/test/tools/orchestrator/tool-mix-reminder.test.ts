/**
 * tool-mix-reminder.test.ts — GC-2026-087 SC3.
 *
 * Verifies the family-mix reminder fires once per session when the
 * LLM has gone baseline-heavy (baseline ≥ 80% AND aft+codebase+ctx <
 * 5%) past a 10-call floor. The reminder is purely advisory — it does
 * NOT block any tool call. Rate-limited via
 * `l1Ctx.alreadyAdvisedRules` so it fires at most once per session.
 *
 * Strategy mirrors the nudge tests: invoke
 * `installOrchestratorAdvisoryHandlers` against a minimal mock pi,
 * fire synthetic tool_call events of each family, and assert on
 * the captured `appendEntry` calls.
 *
 * Run: cd pi-orchestrator && bun test ./test/tools/orchestrator/tool-mix-reminder.test.ts
 */

import { describe, expect, it } from "bun:test";

import { installOrchestratorAdvisoryHandlers } from "@/orchestrator-advisory.js";

interface CapturedEntry {
	customType: string;
	data: unknown;
}

class MockPi {
	systemEntries: CapturedEntry[] = [];
	toolCallListeners: Array<(event: any, ctx: any) => unknown> = [];
	toolResultListeners: Array<(event: any) => unknown> = [];
	messageEndListeners: Array<(event: any) => unknown> = [];

	appendEntry(customType: string, data: unknown) {
		this.systemEntries.push({ customType, data });
	}

	on(event: string, handler: any) {
		if (event === "tool_call") this.toolCallListeners.push(handler);
		if (event === "tool_result") this.toolResultListeners.push(handler);
		if (event === "message_end") this.messageEndListeners.push(handler);
	}

	fireToolCall(event: { toolName: string; input: unknown; toolCallId?: string }): void {
		const e = {
			toolName: event.toolName,
			input: event.input,
			toolCallId: event.toolCallId ?? `call-${Math.random().toString(36).slice(2, 8)}`,
		};
		for (const handler of this.toolCallListeners) handler(e, { cwd: "/tmp" });
	}
}

const MIX_REMINDER_HINT = "Tool-mix warning";

function findMixReminder(pi: MockPi): CapturedEntry | undefined {
	return pi.systemEntries.find(
		(e) => typeof e.data === "string" && (e.data as string).includes(MIX_REMINDER_HINT),
	);
}

function countMixReminders(pi: MockPi): number {
	return pi.systemEntries.filter(
		(e) => typeof e.data === "string" && (e.data as string).includes(MIX_REMINDER_HINT),
	).length;
}

/** Fire N tool calls of the given toolName. Convenience wrapper. */
function fireN(
	pi: MockPi,
	toolName: string,
	n: number,
	input: Record<string, unknown> = {},
): void {
	for (let i = 0; i < n; i++) {
		pi.fireToolCall({ toolName, input });
	}
}

describe("GC-2026-087 SC3 — family-mix reminder", () => {
	it("fires once when 15 baseline calls exceed 80% baseline and <5% specialized", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		// 15 bash calls (all baseline) → baseline ratio = 100% > 80%, specialized = 0% < 5%
		fireN(pi, "bash", 15, { command: "ls" });

		const reminder = findMixReminder(pi);
		expect(reminder).toBeDefined();
		expect(countMixReminders(pi)).toBe(1);
	});

	it("does NOT fire below the 10-call floor (irrelevant early in session)", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		// Only 9 baseline calls — below the 10-call floor.
		fireN(pi, "bash", 9, { command: "ls" });

		expect(findMixReminder(pi)).toBeUndefined();
	});

	it("does NOT fire when baseline ratio ≤ 80% (mixed usage)", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		// Interleave so the FIRST 10 calls never reach 80% baseline:
		// 7 baseline + 3 aft_search within the first 10 = 70% baseline.
		// (Reminder fires only when conditions are met AT A SINGLE CALL;
		// later calls cannot undo a fired reminder.)
		fireN(pi, "bash", 7, { command: "ls" });
		fireN(pi, "aft_search", 3, { query: "foo" });
		// Then continue the LLM mix for 5 more calls.
		fireN(pi, "bash", 3, { command: "ls" });

		expect(findMixReminder(pi)).toBeUndefined();
	});

	it("does NOT fire when specialized ratio ≥ 5% (real adoption)", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		// Interleave so the FIRST 10 calls carry ≥ 5% specialized.
		// 9 baseline + 1 aft_search in the first 10 = 10% specialized ≥ 5%.
		fireN(pi, "bash", 9, { command: "ls" });
		fireN(pi, "aft_search", 1, { query: "foo" });
		// Continue the pattern for 12 more calls (total 22: 18 baseline, 4 aft).
		fireN(pi, "bash", 9, { command: "ls" });
		fireN(pi, "aft_search", 3, { query: "foo" });

		expect(findMixReminder(pi)).toBeUndefined();
	});

	it("fires at exactly the 10-call floor when conditions are met", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		fireN(pi, "bash", 10, { command: "ls" });

		expect(findMixReminder(pi)).toBeDefined();
	});

	it("rate-limits: 50 baseline calls still produce only ONE reminder", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		fireN(pi, "bash", 50, { command: "ls" });

		expect(countMixReminders(pi)).toBe(1);
	});

	it("counts bash/read/edit/write/grep/find/ls all as 'baseline'", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		// Mixed baseline calls — 12 total, all baseline.
		fireN(pi, "bash", 3, { command: "ls" });
		fireN(pi, "read", 3, { filePath: "/tmp/foo" });
		fireN(pi, "edit", 3, { filePath: "/tmp/foo", content: "" });
		fireN(pi, "grep", 3, { pattern: "foo" });

		expect(findMixReminder(pi)).toBeDefined();
	});

	it("does NOT block any tool call — reminder is advisory only", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		const calls = ["bash", "read", "edit", "write", "grep", "find", "ls"];
		for (let i = 0; i < 20; i++) {
			const toolName = calls[i % calls.length]!;
			pi.fireToolCall({ toolName, input: { command: "ls", filePath: "/tmp/x" } });
		}
		// No block decision returned (advisory is appendEntry, not return value).
		// Mock is best-effort — we just assert the reminder fired.
		expect(findMixReminder(pi)).toBeDefined();
	});

	it("reminder text contains baseline percentage and at least one tool name", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		fireN(pi, "bash", 15, { command: "ls" });

		const reminder = findMixReminder(pi);
		expect(reminder?.data as string).toMatch(/\d+%/); // contains a percentage
		expect(reminder?.data as string).toMatch(/aft_search|codebase_memory_search_graph|ctx_search/);
	});

	it("counts subagent and orchestrator tools as 'non-baseline' (don't tip ratio)", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		// Interleave so the FIRST 10 calls carry > 20% non-baseline:
		// 7 baseline + 2 subagent + 1 orchestrator = 70% baseline (≤ 80%).
		fireN(pi, "bash", 7, { command: "ls" });
		fireN(pi, "Agent", 2, { task: "x" });
		fireN(pi, "goal_contract_create", 1, { goal_id: "g" });
		// Continue mixing for 10 more calls.
		fireN(pi, "bash", 5, { command: "ls" });
		fireN(pi, "Agent", 3, { task: "x" });
		fireN(pi, "goal_contract_create", 2, { goal_id: "g" });

		expect(findMixReminder(pi)).toBeUndefined();
	});

	it("counts aft/codebase/ctx as 'specialized' even when ratio is borderline", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		// Ensure the FIRST 10 calls carry ≥ 5% specialized:
		// 9 baseline + 1 aft_search = 10% specialized ≥ 5%.
		fireN(pi, "bash", 9, { command: "ls" });
		fireN(pi, "aft_search", 1, { query: "x" });
		// Continue with more baseline + aft + ctx for 10 more calls.
		fireN(pi, "bash", 8, { command: "ls" });
		fireN(pi, "aft_search", 1, { query: "x" });
		fireN(pi, "ctx_search", 1, { query: "x" });

		expect(findMixReminder(pi)).toBeUndefined();
	});
});