/**
 * Tests for pi-subagents/src/tools/personal-todowrite-tool.ts (registration).
 *
 * GC-2026-coupon-nonhit-block follow-up (Path A): the personal todowrite
 * tool is registered on a per-agent `pi` instance before session creation.
 * These tests verify the registration contract (name, parameters, execute
 * semantics) without instantiating a real AgentSession.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerPersonalTodowriteTools } from "../../src/tools/personal-todowrite-tool.js";
import {
	loadTodos,
} from "../../src/tools/personal-todowrite.js";

interface CapturedTool {
	name: string;
	label?: string;
	description: string;
	parameters: unknown;
	execute: (
		_toolCallId: string,
		params: unknown,
		_signal: unknown,
		_onUpdate: unknown,
		_ctx: unknown,
	) => unknown;
}

class FakePi {
	tools = new Map<string, CapturedTool>();
	registerTool(t: CapturedTool): void {
		this.tools.set(t.name, t);
	}
}

let cwd: string;
let homeBackup: string | undefined;
let pi: FakePi;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "pi-personal-todo-tool-"));
	homeBackup = process.env.HOME;
	process.env.HOME = cwd;
	pi = new FakePi();
	registerPersonalTodowriteTools(pi, { cwd });
});

afterEach(() => {
	if (homeBackup !== undefined) process.env.HOME = homeBackup;
	else delete process.env.HOME;
	rmSync(cwd, { recursive: true, force: true });
});

function exec<T = unknown>(name: string, params: unknown): { content: Array<{ type: string; text: string }>; details?: T } {
	const tool = pi.tools.get(name);
	if (!tool) throw new Error(`Tool not registered: ${name}`);
	const result = tool.execute("test-id", params, undefined, undefined, { cwd });
	// Wrap into the canonical ToolResult shape the registered-tool-wrapper
	// produces, mirroring the real pi.registerTool boundary.
	if (
		result !== null &&
		typeof result === "object" &&
		Array.isArray((result as { content?: unknown }).content)
	) {
		return result as { content: Array<{ type: string; text: string }>; details?: T };
	}
	return {
		content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
		details: result as T,
	};
}

describe("registerPersonalTodowriteTools", () => {
	it("registers two tools with the expected names", () => {
		expect(pi.tools.has("todowrite")).toBe(true);
		expect(pi.tools.has("todowrite_progress")).toBe(true);
	});

	it("todowrite replaces the list (Claude Code-compatible shape)", async () => {
		const result = exec("todowrite", {
			items: [
				{ content: "Read AGENTS.md", status: "completed" },
				{ content: "Write RED test", status: "in_progress" },
				{ content: "Write GREEN impl" },
			],
		});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.count).toBe(3);
		expect(parsed.items.map((i: { id: string }) => i.id)).toEqual([
			"todo-1",
			"todo-2",
			"todo-3",
		]);
		expect(parsed.items[2].status).toBe("pending");
		// Persisted to disk
		const onDisk = loadTodos(cwd);
		expect(onDisk).toHaveLength(3);
	});

	it("todowrite with empty items clears the list", () => {
		exec("todowrite", {
			items: [
				{ content: "x", status: "pending" },
				{ content: "y", status: "pending" },
			],
		});
		expect(loadTodos(cwd)).toHaveLength(2);
		exec("todowrite", { items: [] });
		expect(loadTodos(cwd)).toEqual([]);
	});

	it("todowrite preserves prior status when re-setting without status", () => {
		exec("todowrite", {
			items: [{ id: "t1", content: "foo", status: "in_progress" }],
		});
		const back = exec("todowrite", {
			items: [{ id: "t1", content: "foo" }],
		});
		const parsed = JSON.parse(back.content[0].text);
		expect(parsed.items[0].status).toBe("in_progress");
	});

	it("todowrite_progress returns the current list + summary", () => {
		exec("todowrite", {
			items: [
				{ content: "a", status: "completed" },
				{ content: "b", status: "in_progress" },
				{ content: "c", status: "pending" },
			],
		});
		const result = exec("todowrite_progress", {});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.items).toHaveLength(3);
		expect(parsed.summary).toEqual({
			total: 3,
			byStatus: {
				completed: 1,
				failed: 0,
				in_progress: 1,
				pending: 1,
				skipped: 0,
			},
			inProgressId: "todo-2",
		});
	});

	it("todowrite_progress on an empty list returns summary zeros", () => {
		const result = exec("todowrite_progress", {});
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.items).toEqual([]);
		expect(parsed.summary).toEqual({
			total: 0,
			byStatus: {
				completed: 0,
				failed: 0,
				in_progress: 0,
				pending: 0,
				skipped: 0,
			},
			inProgressId: null,
		});
	});

	it("two agents with different cwds see independent lists", () => {
		const cwdB = mkdtempSync(join(tmpdir(), "pi-personal-todo-tool-B-"));
		try {
			const piB = new FakePi();
			registerPersonalTodowriteTools(piB, { cwd: cwdB });
			pi.tools.get("todowrite")!.execute("a", { items: [{ content: "A", status: "pending" }] }, undefined, undefined, { cwd });
			piB.tools.get("todowrite")!.execute("b", { items: [{ content: "B", status: "completed" }] }, undefined, undefined, { cwd: cwdB });
			expect(loadTodos(cwd)).toHaveLength(1);
			expect(loadTodos(cwdB)).toHaveLength(1);
			expect(loadTodos(cwd)[0].content).toBe("A");
			expect(loadTodos(cwdB)[0].content).toBe("B");
		} finally {
			rmSync(cwdB, { recursive: true, force: true });
		}
	});
});
