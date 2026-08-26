/**
 * aft-nudge.test.ts — GC-2026-075 integration test.
 *
 * Verifies the runtime AFT nudge fires when the LLM (root or subagent)
 * runs grep / rg / find against source paths, and stays silent for:
 *  - non-bash tools
 *  - non-code-search bash commands (cat, ls, build artifacts)
 *  - already-nudged sessions (rate-limit)
 *
 * Strategy: invoke `installOrchestratorAdvisoryHandlers` against a
 * minimal mock pi, capture the registered `tool_call` handler, fire
 * synthetic events, and assert on the captured `appendEntry` calls.
 */
import { describe, expect, it } from "bun:test";

import { installOrchestratorAdvisoryHandlers } from "@/orchestrator-advisory.js";

interface CapturedEntry {
	customType: string;
	data: unknown;
}

interface CapturedHandler {
	event: { toolName: string; input: unknown; toolCallId?: string };
	handler: (event: any, ctx: any) => unknown;
}

class MockPi {
	tools = new Map<string, unknown>();
	systemEntries: CapturedEntry[] = [];
	toolCallListeners: Array<(event: any, ctx: any) => unknown> = [];
	toolResultListeners: Array<(event: any) => unknown> = [];
	messageEndListeners: Array<(event: any) => unknown> = [];

	registerTool(def: { name: string }) {
		this.tools.set(def.name, def);
	}

	appendEntry(customType: string, data: unknown) {
		this.systemEntries.push({ customType, data });
	}

	on(event: string, handler: any) {
		if (event === "tool_call") this.toolCallListeners.push(handler);
		if (event === "tool_result") this.toolResultListeners.push(handler);
		if (event === "message_end") this.messageEndListeners.push(handler);
	}

	/** Fire a single tool_call event into all listeners. */
	fireToolCall(event: {
		toolName: string;
		input: unknown;
		toolCallId?: string;
	}): CapturedHandler {
		const e = {
			toolName: event.toolName,
			input: event.input,
			toolCallId: event.toolCallId ?? `call-${Math.random().toString(36).slice(2, 8)}`,
		};
		for (const handler of this.toolCallListeners) handler(e, { cwd: "/tmp" });
		return { event: e, handler: this.toolCallListeners[0]! };
	}
}

const AFT_HINT = "Consider `aft_search";

function appendEntriesByType(pi: MockPi, type: string): CapturedEntry[] {
	return pi.systemEntries.filter((e) => e.customType === type);
}

function hasAftNudge(pi: MockPi): CapturedEntry | undefined {
	return appendEntriesByType(pi, "system").find(
		(e) => typeof e.data === "string" && (e.data as string).includes(AFT_HINT),
	);
}

describe("GC-2026-075 AFT nudge — runtime integration", () => {
	it("emits a soft reminder when bash runs grep against src/", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({
			toolName: "bash",
			input: { command: "grep -r handleAuth src/" },
		});

		const nudge = hasAftNudge(pi);
		expect(nudge).toBeDefined();
		expect(nudge?.customType).toBe("system");
		expect(nudge?.data as string).toMatch(/Read-only code search detected/);
		expect(nudge?.data as string).toContain("aft_search");
	});

	it("emits reminder for find against lib/", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "find lib -name '*.ts'" } });

		expect(hasAftNudge(pi)).toBeDefined();
	});

	it("emits reminder for rg against packages/", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "rg -n TODO packages/" } });

		expect(hasAftNudge(pi)).toBeDefined();
	});

	it("does NOT emit reminder for non-source paths (node_modules)", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({
			toolName: "bash",
			input: { command: "grep -r something node_modules/" },
		});

		expect(hasAftNudge(pi)).toBeUndefined();
	});

	it("does NOT emit reminder for non-bash tools", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "read", input: { filePath: "/tmp/foo.ts" } });
		pi.fireToolCall({
			toolName: "write",
			input: { filePath: "/tmp/foo.ts", content: "" },
		});

		expect(hasAftNudge(pi)).toBeUndefined();
	});

	it("does NOT emit reminder for plain cat/ls/echo", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "cat src/foo.ts" } });
		pi.fireToolCall({ toolName: "bash", input: { command: "ls -la" } });
		pi.fireToolCall({ toolName: "bash", input: { command: "echo hello" } });

		expect(hasAftNudge(pi)).toBeUndefined();
	});

	it("rate-limits: two consecutive grep calls produce ONE nudge", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "grep handleAuth src/auth.ts" } });
		pi.fireToolCall({ toolName: "bash", input: { command: "grep configLoader src/main.ts" } });

		const nudges = appendEntriesByType(pi, "system").filter(
			(e) => typeof e.data === "string" && (e.data as string).includes(AFT_HINT),
		);
		expect(nudges).toHaveLength(1);
	});

	it("does NOT emit reminder when grep writes to redirect (write-intent wins)", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({
			toolName: "bash",
			input: { command: "grep -r foo src/ > /tmp/out.txt" },
		});

		// write-intent — bash-guard emits nothing for this; the nudge
		// branch only fires on code-search. No reminder expected.
		expect(hasAftNudge(pi)).toBeUndefined();
	});

	it("nudge text references aft_search with the query placeholder", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({
			toolName: "bash",
			input: { command: "grep -r handleAuth src/" },
		});

		const nudge = hasAftNudge(pi);
		expect(nudge?.data as string).toMatch(/aft_search\(\{ query:/);
		expect(nudge?.data as string).toContain("indexed");
		expect(nudge?.data as string).toContain("ranked");
	});
});
