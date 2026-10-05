/**
 * subagent-checkpoint.test.ts — GC-2026-038 T3
 *
 * Verifies the checkpoint protocol prompt text exists in all 4 prompts
 * AND the parseCheckpoint runtime helper extracts the correct fields.
 *
 * GC-2026-prompt-parser-contract-cleanup: Developer + Reviewer now import
 * the section from `_sections/checkpoint-protocol.ts` rather than carrying
 * the text inline. The file-content grep is no longer authoritative for
 * those two prompts — we read the *rendered* prompt constants (which DO
 * contain the section after template-literal interpolation) for
 * developer/reviewer, and keep the file-content check for explore/plan
 * which still carry the section inline.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseCheckpoint } from "../src/agent-runner.js";
import { DEVELOPER_PROMPT } from "../src/agent-prompts/developer.js";
import { REVIEWER_PROMPT } from "../src/agent-prompts/reviewer.js";

// Inline-section prompts (no shared library yet — out of scope for the
// prompt-parser-contract-cleanup GC; explore.ts and plan.ts are not part
// of the Implement → Review ⇆ Fix pipeline the GC targets).
const INLINE_PROMPT_FILES = ["explore.ts", "plan.ts"] as const;

function readPrompt(name: string): string {
	return readFileSync(
		join(import.meta.dirname, "../src/agent-prompts", name),
		"utf8",
	);
}

const RENDERED_PROMPTS: Record<"developer.ts" | "reviewer.ts", string> = {
	"developer.ts": DEVELOPER_PROMPT,
	"reviewer.ts": REVIEWER_PROMPT,
};

describe("subagent checkpoint protocol (GC-2026-038 T3)", () => {
	for (const name of INLINE_PROMPT_FILES) {
		it(`T-CKPT-${name}: ${name} (inline) contains the checkpoint protocol section`, () => {
			const text = readPrompt(name);
			expect(text).toContain("Checkpoint Protocol");
		});

		it(`T-CKPT-${name}-format: ${name} (inline) shows the [checkpoint N/200 turns, Xm] format`, () => {
			const text = readPrompt(name);
			expect(text).toContain("checkpoint N/200 turns");
		});

		it(`T-CKPT-${name}-blocked: ${name} (inline) mentions the 2-consecutive-no-progress BLOCKED rule`, () => {
			const text = readPrompt(name);
			expect(text).toMatch(/2 consecutive checkpoints|2 consecutive/);
		});
	}

	// Shared-library consumers (GC-2026-prompt-parser-contract-cleanup): the
	// section is imported from _sections/checkpoint-protocol.ts and interpolated
	// at module load. We assert against the rendered prompt so a future edit
	// that drops the section from the prompt body fails these tests.
	for (const name of Object.keys(RENDERED_PROMPTS) as Array<"developer.ts" | "reviewer.ts">) {
		it(`T-CKPT-${name}: ${name} (rendered) contains the checkpoint protocol section`, () => {
			expect(RENDERED_PROMPTS[name]).toContain("Checkpoint Protocol");
		});

		it(`T-CKPT-${name}-format: ${name} (rendered) shows the [checkpoint N/200 turns, Xm] format`, () => {
			expect(RENDERED_PROMPTS[name]).toContain("checkpoint N/200 turns");
		});

		it(`T-CKPT-${name}-blocked: ${name} (rendered) mentions the 2-consecutive-no-progress BLOCKED rule`, () => {
			expect(RENDERED_PROMPTS[name]).toMatch(/2 consecutive checkpoints|2 consecutive/);
		});
	}
});

describe("parseCheckpoint runtime helper (GC-2026-038 T3)", () => {
	it("T-CKPT-parse-01: parses a single checkpoint line", () => {
		const text =
			"[checkpoint 5/200 turns, 1m32s] 1 test written (RED). 0 commits. blocker: none.";
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
		const out = parseCheckpoint(
			"[checkpoint 5/200 turns, 5m] 1 test. 0 commits. blocker: none.",
		);
		expect(out).not.toBeNull();
		expect(out!.timeMinutes).toBe(5);
	});

	it("T-CKPT-parse-05: parses 'commit' vs 'commits' (singular form)", () => {
		const out = parseCheckpoint(
			"[checkpoint 5/200 turns, 1m] 1 commit done. 1 commit. blocker: none.",
		);
		expect(out).not.toBeNull();
		expect(out!.commitCount).toBe(1);
	});
});
