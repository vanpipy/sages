/**
 * subagent-budget-prompt.test.ts — GC-2026-subagent-recording-no-budget
 *
 * Verifies the prompt-section contract flipped in this GC: the 4 built-in
 * agent prompts no longer carry hard caps (read 30 / grep 5 / git 3 / AFT 10)
 * for tool usage. Instead, every prompt that previously included the
 * EXPLORATION_BUDGET_SECTION now interpolates RECORDING_NOTICE_SECTION —
 * the "no turn or time limit + every tool call is recorded" replacement.
 *
 * The old test pinned the hard caps (GC-2026-038 T2). This file is the
 * inverse: it pins the absence of hard caps + the presence of the
 * recording notice across all 4 prompts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEVELOPER_PROMPT } from "../src/agent-prompts/developer.js";
import { REVIEWER_PROMPT } from "../src/agent-prompts/reviewer.js";
import { RECORDING_NOTICE_SECTION } from "../src/agent-prompts/_sections/recording-notice.js";

const INLINE_PROMPT_FILES = ["explore.ts", "plan.ts"] as const;

const RENDERED_PROMPTS: Record<"developer.ts" | "reviewer.ts", string> = {
	"developer.ts": DEVELOPER_PROMPT,
	"reviewer.ts": REVIEWER_PROMPT,
};

function readPrompt(name: string): string {
	return readFileSync(
		join(import.meta.dirname, "../src/agent-prompts", name),
		"utf8",
	);
}

describe("subagent exploration budget REMOVED + recording notice present (GC-2026-subagent-recording-no-budget)", () => {
	// Section-deleted assertions: the hard caps that drove GC-2026-038 T2
	// are gone. Pin the absence so a regression that re-introduces them
	// (e.g. an unmerged revert) breaks this test.
	for (const name of INLINE_PROMPT_FILES) {
		it(`T-NOCAP-${name}: ${name} (inline) does NOT contain the hard caps`, () => {
			const text = readPrompt(name);
			expect(text).not.toContain("Exploration Budget (hard caps on read tools)");
		});
		it(`T-NOCAP-${name}-read30: ${name} (inline) does NOT cap read at 30`, () => {
			const text = readPrompt(name);
			expect(text).not.toMatch(/\*\*read\*\*:\s*max 30/);
		});
	}
	for (const name of Object.keys(RENDERED_PROMPTS) as Array<"developer.ts" | "reviewer.ts">) {
		it(`T-NOCAP-${name}: ${name} (rendered) does NOT contain the hard caps`, () => {
			expect(RENDERED_PROMPTS[name]).not.toContain(
				"Exploration Budget (hard caps on read tools)",
			);
		});
		it(`T-NOCAP-${name}-read30: ${name} (rendered) does NOT cap read at 30`, () => {
			expect(RENDERED_PROMPTS[name]).not.toMatch(/\*\*read\*\*:\s*max 30/);
		});
	}

	// Recording-notice positive assertions: every prompt that previously
	// carried the budget now carries the recording notice. The inline
	// `explore.ts` / `plan.ts` previously had their own embedded budget
	// sections; we don't pin a specific text on those, but the rendered
	// Developer + Reviewer prompts MUST contain the section byte-identical.
	it("T-NOREC-dev: DEVELOPER_PROMPT contains RECORDING_NOTICE_SECTION verbatim", () => {
		expect(DEVELOPER_PROMPT).toContain(RECORDING_NOTICE_SECTION);
	});
	it("T-NOREC-rev: REVIEWER_PROMPT contains RECORDING_NOTICE_SECTION verbatim", () => {
		expect(REVIEWER_PROMPT).toContain(RECORDING_NOTICE_SECTION);
	});
	it("T-NOREC-section: RECORDING_NOTICE_SECTION promises no turn or time limit", () => {
		expect(RECORDING_NOTICE_SECTION).toMatch(
			/\*\*no\s+turn\s+or\s+time\s+limit/,
		);
	});
});
