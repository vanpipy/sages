/**
 * codebase-nudge.test.ts — GC-2026-087 SC2.
 *
 * Verifies the runtime codebase nudge fires when the LLM (root or
 * subagent) runs structural exploration commands — `ls` / `tree` /
 * `find` without content-search flags — against source paths, and
 * stays silent for:
 *  - non-bash tools
 *  - content-search bash commands (grep / rg / `find -name '*.ts'`)
 *    → those are AFT's territory, not codebase's
 *  - non-source paths (node_modules, .git, dist)
 *  - already-nudged sessions (rate-limit)
 *
 * Strategy mirrors aft-nudge.test.ts: invoke
 * `installOrchestratorAdvisoryHandlers` against a minimal mock pi,
 * capture the registered `tool_call` handler, fire synthetic events,
 * assert on captured `appendEntry` calls.
 *
 * Run: cd pi-orchestrator && bun test ./test/tools/orchestrator/codebase-nudge.test.ts
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

const CODEBASE_HINT = "Consider `codebase_memory_search_graph";

function hasCodebaseNudge(pi: MockPi): CapturedEntry | undefined {
	return pi.systemEntries.find(
		(e) => typeof e.data === "string" && (e.data as string).includes(CODEBASE_HINT),
	);
}

function countCodebaseNudges(pi: MockPi): number {
	return pi.systemEntries.filter(
		(e) => typeof e.data === "string" && (e.data as string).includes(CODEBASE_HINT),
	).length;
}

describe("GC-2026-087 SC2 — codebase-search-nudge — runtime integration", () => {
	it("emits soft reminder for `ls src/`", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "ls src/" } });

		const nudge = hasCodebaseNudge(pi);
		expect(nudge).toBeDefined();
		expect(nudge?.customType).toBe("system");
		expect(nudge?.data as string).toContain("codebase_memory_search_graph");
	});

	it("emits soft reminder for `ls -la packages/foo`", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "ls -la packages/foo" } });

		expect(hasCodebaseNudge(pi)).toBeDefined();
	});

	it("emits soft reminder for `tree src/`", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "tree src/" } });

		expect(hasCodebaseNudge(pi)).toBeDefined();
	});

	it("emits soft reminder for `find src/ -type d` (pure directory walk)", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "find src/ -type d" } });

		expect(hasCodebaseNudge(pi)).toBeDefined();
	});

	it("emits soft reminder for `find lib` (no flags at all)", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "find lib" } });

		expect(hasCodebaseNudge(pi)).toBeDefined();
	});

	it("does NOT fire for `grep -r foo src/` — that's AFT's territory", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "grep -r handleAuth src/" } });

		expect(hasCodebaseNudge(pi)).toBeUndefined();
	});

	it("does NOT fire for `find lib -name '*.ts'` — that's AFT's territory", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "find lib -name '*.ts'" } });

		expect(hasCodebaseNudge(pi)).toBeUndefined();
	});

	it("does NOT fire for `ls node_modules/` (non-source path)", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "ls node_modules/" } });

		expect(hasCodebaseNudge(pi)).toBeUndefined();
	});

	it("does NOT fire for `ls .git/`", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "ls .git/" } });

		expect(hasCodebaseNudge(pi)).toBeUndefined();
	});

	it("does NOT fire for non-bash tools", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "read", input: { filePath: "/tmp/foo.ts" } });
		pi.fireToolCall({ toolName: "ls", input: { path: "src" } });

		expect(hasCodebaseNudge(pi)).toBeUndefined();
	});

	it("rate-limits: two consecutive structural calls produce ONE codebase nudge", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "ls src/" } });
		pi.fireToolCall({ toolName: "bash", input: { command: "tree lib/" } });

		expect(countCodebaseNudges(pi)).toBe(1);
	});

	it("does NOT fire when ls writes to a file (write-intent wins)", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "ls src/ > /tmp/listing.txt" } });

		expect(hasCodebaseNudge(pi)).toBeUndefined();
	});

	it("nudge text references codebase_memory_search_graph with structural framing", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "ls src/" } });

		const nudge = hasCodebaseNudge(pi);
		expect(nudge?.data as string).toMatch(/structure|structural/i);
		expect(nudge?.data as string).toContain("codebase_memory_search_graph");
	});
});