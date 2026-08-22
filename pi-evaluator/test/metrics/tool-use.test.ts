/**
 * test/metrics/tool-use.test.ts
 *
 * Pure-LLM metric. Tests cover:
 *   - no workflowPath → data_missing
 *   - missing session.jsonl → data_missing
 *   - empty session (no tool calls) → data_missing
 *   - session with tool calls → judge() called with summary
 *   - judge returning data_missing → metric propagates
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolUse } from "../../src/metrics/tool-use.ts";
import { setJudgeFn } from "../../src/metrics/llm-judge/seam.ts";
import type { MetricContext } from "../../src/metrics/types.ts";

let tmp: string;
const ctx: MetricContext = { cwd: "/tmp" };

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-eval-tool-u-"));
	mkdirSync(tmp, { recursive: true });
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	setJudgeFn(null);
});

function writeSession(jsonl: string): void {
	writeFileSync(join(tmp, "session.jsonl"), jsonl, "utf8");
}

describe("ToolUse", () => {
	test("no workflowPath → data_missing", async () => {
		const m = new ToolUse();
		const r = await m.compute(undefined, ctx);
		expect(r.data_missing).toBe(true);
	});

	test("missing session.jsonl → data_missing", async () => {
		const m = new ToolUse();
		const r = await m.compute(undefined, { ...ctx, workflowPath: tmp });
		expect(r.data_missing).toBe(true);
	});

	test("empty session (no tool calls) → data_missing", async () => {
		writeSession("");
		const m = new ToolUse();
		const r = await m.compute(undefined, { ...ctx, workflowPath: tmp });
		expect(r.data_missing).toBe(true);
	});

	test("session with tool calls → calls judge() with per-tool summary", async () => {
		const session = [
			JSON.stringify({
				type: "message",
				timestamp: "2026-08-22T10:00:00Z",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", name: "read", arguments: {} },
						{ type: "toolResult", name: "read", content: [], isError: false },
						{ type: "toolCall", name: "bash", arguments: {} },
						{ type: "toolResult", name: "bash", content: [], isError: false },
						{ type: "toolCall", name: "bash", arguments: {} },
						{ type: "toolResult", name: "bash", content: [], isError: true },
					],
				},
			}),
		].join("\n");
		writeSession(session);

		let captured: { criteria: string; evidence: string } | undefined;
		setJudgeFn(async (input) => {
			captured = { criteria: input.criteria, evidence: input.evidence };
			return { score: 0.65, rationale: "decent" };
		});
		const m = new ToolUse();
		const r = await m.compute(undefined, { ...ctx, workflowPath: tmp });
		expect(r.data_missing).toBe(false);
		expect(r.value).toBe(0.65);
		expect(captured).toBeDefined();
		expect(captured?.criteria).toContain("tool");
		expect(captured?.evidence).toContain("read: 1 calls, 0 errors");
		expect(captured?.evidence).toContain("bash: 2 calls, 1 errors");
		expect(captured?.evidence).toContain("(none)→read");
	});

	test("judge data_missing → metric propagates", async () => {
		writeSession(
			JSON.stringify({
				type: "message",
				timestamp: "2026-08-22T10:00:00Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "read", arguments: {} }],
				},
			}),
		);
		// No judge set → judge returns data_missing
		const m = new ToolUse();
		const r = await m.compute(undefined, { ...ctx, workflowPath: tmp });
		expect(r.data_missing).toBe(true);
	});
});
