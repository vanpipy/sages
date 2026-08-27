/**
 * ctx-nudge.test.ts — GC-2026-087 SC2.
 *
 * Verifies the runtime ctx nudge fires when the LLM (root or subagent)
 * cat/head/less-reads well-known small config / data files — files
 * whose content the orchestrator's memory layer (`ctx_search`) is
 * likely to already know — and stays silent for:
 *  - non-bash tools
 *  - source code reads (cat src/foo.ts)
 *  - write-intent reads (cat README.md > out.txt)
 *  - non-config files (cat /etc/passwd)
 *  - already-nudged sessions (rate-limit)
 *
 * Strategy mirrors aft-nudge.test.ts: invoke
 * `installOrchestratorAdvisoryHandlers` against a minimal mock pi,
 * capture the registered `tool_call` handler, fire synthetic events,
 * assert on captured `appendEntry` calls.
 *
 * Run: cd pi-orchestrator && bun test ./test/tools/orchestrator/ctx-nudge.test.ts
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

const CTX_HINT = "Consider `ctx_search";

function hasCtxNudge(pi: MockPi): CapturedEntry | undefined {
	return pi.systemEntries.find(
		(e) => typeof e.data === "string" && (e.data as string).includes(CTX_HINT),
	);
}

function countCtxNudges(pi: MockPi): number {
	return pi.systemEntries.filter(
		(e) => typeof e.data === "string" && (e.data as string).includes(CTX_HINT),
	).length;
}

describe("GC-2026-087 SC2 — ctx-search-nudge — runtime integration", () => {
	it("emits soft reminder for `cat README.md`", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "cat README.md" } });

		const nudge = hasCtxNudge(pi);
		expect(nudge).toBeDefined();
		expect(nudge?.customType).toBe("system");
		expect(nudge?.data as string).toContain("ctx_search");
	});

	it("emits soft reminder for `cat AGENTS.md`", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "cat AGENTS.md" } });

		expect(hasCtxNudge(pi)).toBeDefined();
	});

	it("emits soft reminder for `cat package.json`", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "cat package.json" } });

		expect(hasCtxNudge(pi)).toBeDefined();
	});

	it("emits soft reminder for `cat tsconfig.json`", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "cat tsconfig.json" } });

		expect(hasCtxNudge(pi)).toBeDefined();
	});

	it("emits soft reminder for `head README.md` (head, not cat)", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "head README.md" } });

		expect(hasCtxNudge(pi)).toBeDefined();
	});

	it("emits soft reminder for `cat CLAUDE.md`", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "cat CLAUDE.md" } });

		expect(hasCtxNudge(pi)).toBeDefined();
	});

	it("does NOT fire for `cat src/foo.ts` (source code, not config)", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "cat src/foo.ts" } });

		expect(hasCtxNudge(pi)).toBeUndefined();
	});

	it("does NOT fire for `cat lib/index.js` (source code, not config)", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "cat lib/index.js" } });

		expect(hasCtxNudge(pi)).toBeUndefined();
	});

	it("does NOT fire for write-intent (`cat README.md > /tmp/out.txt`)", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({
			toolName: "bash",
			input: { command: "cat README.md > /tmp/out.txt" },
		});

		expect(hasCtxNudge(pi)).toBeUndefined();
	});

	it("does NOT fire for `cat /etc/passwd` (system file, not project config)", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "cat /etc/passwd" } });

		expect(hasCtxNudge(pi)).toBeUndefined();
	});

	it("does NOT fire for non-bash tools", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "read", input: { filePath: "README.md" } });

		expect(hasCtxNudge(pi)).toBeUndefined();
	});

	it("rate-limits: two consecutive config reads produce ONE ctx nudge", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "cat README.md" } });
		pi.fireToolCall({ toolName: "bash", input: { command: "cat AGENTS.md" } });

		expect(countCtxNudges(pi)).toBe(1);
	});

	it("nudge text references ctx_search with the project-knowledge framing", () => {
		const pi = new MockPi();
		installOrchestratorAdvisoryHandlers(pi as any);
		pi.fireToolCall({ toolName: "bash", input: { command: "cat README.md" } });

		const nudge = hasCtxNudge(pi);
		expect(nudge?.data as string).toContain("ctx_search");
		expect(nudge?.data as string).toMatch(/project|prior|recall/i);
	});
});