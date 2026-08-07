/**
 * subagent-checkpoint.test.ts — GC-2026-038 T3
 *
 * Verifies the checkpoint protocol prompt text exists in all 4 prompts
 * AND the parseCheckpoint runtime helper extracts the correct fields.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseCheckpoint } from "../src/agent-runner.js";

const PROMPTFiles = [
	"developer.ts",
	"auditor.ts",
	"explore.ts",
	"plan.ts",
] as const;

function readPrompt(name: string): string {
	return readFileSync(
		join(import.meta.dirname, "../src/agent-prompts", name),
		"utf8",
	);
}

describe("subagent checkpoint protocol (GC-2026-038 T3)", () => {
	for (const name of PROMPTFiles) {
		it(`T-CKPT-${name}: ${name} contains the checkpoint protocol section`, () => {
			const text = readPrompt(name);
			expect(text).toContain("Checkpoint Protocol");
		});

		it(`T-CKPT-${name}-format: ${name} shows the [checkpoint N/200 turns, Xm] format`, () => {
			const text = readPrompt(name);
			expect(text).toContain("checkpoint N/200 turns");
		});

		it(`T-CKPT-${name}-blocked: ${name} mentions the 2-consecutive-no-progress BLOCKED rule`, () => {
			const text = readPrompt(name);
			expect(text).toMatch(/2 consecutive checkpoints|2 consecutive/);
		});
	}
});

describe("parseCheckpoint runtime helper (GC-2026-038 T3)", () => {
	it("T-CKPT-parse-01: parses a single checkpoint line", () => {
		const text = "[checkpoint 5/200 turns, 1m32s] 1 test written (RED). 0 commits. blocker: none.";
		const out = parseCheckpoint(text);
		expect(out).not.toBeNull();
		expect(out!.turnNumber).toBe(5);
		expect(out!.timeMinutes).toBeCloseTo(1.533, 2); // 1m32s = 1.533m
		expect(out!.workSummary).toContain("1 test written");
		expect(out!.commitCount).toBe(0);
		expect(out!.blocker).toBe("none");
	});

	it("T-CKPT-parse-02: parses the LAST checkpoint when multiple are present", () => {
		const text = `Some progress.
[checkpoint 5/200 turns, 1m32s] first commit. 0 commits. blocker: none.
[checkpoint 10/200 turns, 3m15s] 1 test passing. 1 commits. blocker: none.`;
		const out = parseCheckpoint(text);
		expect(out).not.toBeNull();
		expect(out!.turnNumber).toBe(10);
		expect(out!.commitCount).toBe(1);
	});

	it("T-CKPT-parse-03: returns null when no checkpoint is present", () => {
		expect(parseCheckpoint("Just some text without a checkpoint.")).toBeNull();
	});

	it("T-CKPT-parse-04: tolerates varying time formats (m, s, m+s)", () => {
		const out = parseCheckpoint("[checkpoint 5/200 turns, 5m] 1 test. 0 commits. blocker: none.");
		expect(out).not.toBeNull();
		expect(out!.timeMinutes).toBe(5);
	});

	it("T-CKPT-parse-05: parses 'commit' vs 'commits' (singular form)", () => {
		const out = parseCheckpoint("[checkpoint 5/200 turns, 1m] 1 commit done. 1 commit. blocker: none.");
		expect(out).not.toBeNull();
		expect(out!.commitCount).toBe(1);
	});
});
