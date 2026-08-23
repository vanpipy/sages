/**
 * test/metrics/argument-correctness.test.ts
 *
 * Counts toolResult blocks with isError === true across session.jsonl.
 * Returns the error rate (0-1, lower is better).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArgumentCorrectness } from "../../src/metrics/argument-correctness.ts";
import type { MetricContext } from "../../src/metrics/types.ts";

let tmp: string;
const ctx: MetricContext = { cwd: "/tmp" };

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-eval-arg-corr-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function writeAndRun(entries: object[]): Promise<{ value: number; data_missing: boolean; evidence: { location: string; note: string }[] }> {
	const wfDir = join(tmp, "wf");
	mkdirSync(wfDir, { recursive: true });
	writeFileSync(join(wfDir, "session.jsonl"), makeSession(entries), "utf8");
	const m = new ArgumentCorrectness();
	return m.compute(undefined, { ...ctx, workflowPath: wfDir });
}

function makeSession(entries: object[]): string {
	return entries.map((e) => JSON.stringify(e)).join("\n");
}

describe("ArgumentCorrectness", () => {
	test("no workflowPath → data_missing", async () => {
		const m = new ArgumentCorrectness();
		const r = await m.compute(undefined, ctx);
		expect(r.data_missing).toBe(true);
	});

	test("no toolResult blocks → data_missing (0 ambiguous with no calls)", async () => {
		const r = await writeAndRun([
			{ type: "message", timestamp: "2026-08-22T10:00:00Z", message: { role: "assistant", content: [{ type: "text", content: "hi" }] } },
		]);
		expect(r.data_missing).toBe(true);
		expect(r.value).toBe(0);
	});

	test("all tool results succeeded → value 0 (lower_better)", async () => {
		const r = await writeAndRun([
			{ type: "message", timestamp: "2026-08-22T10:00:00Z", message: { role: "assistant", content: [
				{ type: "toolCall", name: "read", arguments: {} },
				{ type: "toolCall", name: "bash", arguments: {} },
				{ type: "toolResult", name: "read", content: [], isError: false },
				{ type: "toolResult", name: "bash", content: [], isError: false },
			] } },
		]);
		expect(r.data_missing).toBe(false);
		expect(r.value).toBe(0);
	});

	test("2 errors out of 4 → value 0.5", async () => {
		const r = await writeAndRun([
			{ type: "message", timestamp: "2026-08-22T10:00:00Z", message: { role: "assistant", content: [
				{ type: "toolResult", name: "bash", content: [], isError: false },
				{ type: "toolResult", name: "bash", content: [], isError: true },
				{ type: "toolResult", name: "read", content: [], isError: true },
				{ type: "toolResult", name: "read", content: [], isError: false },
			] } },
		]);
		expect(r.value).toBe(0.5);
	});

	test("evidence lists per-tool error counts", async () => {
		const r = await writeAndRun([
			{ type: "message", timestamp: "2026-08-22T10:00:00Z", message: { role: "assistant", content: [
				{ type: "toolResult", name: "bash", content: [], isError: true },
				{ type: "toolResult", name: "bash", content: [], isError: true },
				{ type: "toolResult", name: "read", content: [], isError: false },
			] } },
		]);
		expect(r.evidence.some((e) => e.location === "bash" && /2 error/.test(e.note))).toBe(true);
	});
});
