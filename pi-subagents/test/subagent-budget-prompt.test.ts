/**
 * subagent-budget-prompt.test.ts — GC-2026-038 T2
 *
 * Verifies that the 4 built-in agent prompts contain the
 * EXPLORATION_BUDGET_SECTION with the hard caps.
 *
 * GC-2026-prompt-parser-contract-cleanup: Developer + Reviewer now import
 * the section from `_sections/exploration-budget.ts` and interpolate it
 * into the rendered prompt. Explore + Plan still carry the section inline.
 * We check both shapes: rendered prompt for the importers, source file for
 * the inliners.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEVELOPER_PROMPT } from "../src/agent-prompts/developer.js";
import { REVIEWER_PROMPT } from "../src/agent-prompts/reviewer.js";

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

describe("subagent exploration budget (GC-2026-038 T2)", () => {
	for (const name of INLINE_PROMPT_FILES) {
		it(`T-BUDGET-${name}: ${name} (inline) contains the exploration budget section`, () => {
			const text = readPrompt(name);
			expect(text).toContain("Exploration Budget");
		});

		it(`T-BUDGET-${name}-caps: ${name} (inline) contains the hard caps (read 30, grep 5, git 3, AFT 10)`, () => {
			const text = readPrompt(name);
			expect(text).toMatch(/max 30|read.*max 30/);
			expect(text).toMatch(/max 5/);
			expect(text).toMatch(/max 3/);
			expect(text).toMatch(/max 10/);
		});

		it(`T-BUDGET-${name}-escape: ${name} (inline) contains the BLOCKED escape hatch`, () => {
			const text = readPrompt(name);
			expect(text).toMatch(/BLOCKED/);
		});
	}

	for (const name of Object.keys(RENDERED_PROMPTS) as Array<"developer.ts" | "reviewer.ts">) {
		it(`T-BUDGET-${name}: ${name} (rendered) contains the exploration budget section`, () => {
			expect(RENDERED_PROMPTS[name]).toContain("Exploration Budget");
		});

		it(`T-BUDGET-${name}-caps: ${name} (rendered) contains the hard caps (read 30, grep 5, git 3, AFT 10)`, () => {
			expect(RENDERED_PROMPTS[name]).toMatch(/max 30|read.*max 30/);
			expect(RENDERED_PROMPTS[name]).toMatch(/max 5/);
			expect(RENDERED_PROMPTS[name]).toMatch(/max 3/);
			expect(RENDERED_PROMPTS[name]).toMatch(/max 10/);
		});

		it(`T-BUDGET-${name}-escape: ${name} (rendered) contains the BLOCKED escape hatch`, () => {
			expect(RENDERED_PROMPTS[name]).toMatch(/BLOCKED/);
		});
	}

	it("T-BUDGET-shared: all 4 prompts pin the same per-type rule (UNLIMITED writes)", () => {
		for (const name of INLINE_PROMPT_FILES) {
			const text = readPrompt(name);
			expect(text).toMatch(/UNLIMITED|unlimited/);
		}
		for (const name of Object.keys(RENDERED_PROMPTS) as Array<"developer.ts" | "reviewer.ts">) {
			expect(RENDERED_PROMPTS[name]).toMatch(/UNLIMITED|unlimited/);
		}
	});
});
