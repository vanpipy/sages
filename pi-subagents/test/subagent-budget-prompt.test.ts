/**
 * subagent-budget-prompt.test.ts — GC-2026-038 T2
 *
 * Verifies that all 4 built-in agent prompts contain the
 * EXPLORATION_BUDGET_SECTION with the hard caps.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

describe("subagent exploration budget (GC-2026-038 T2)", () => {
	for (const name of PROMPTFiles) {
		it(`T-BUDGET-${name}: ${name} contains the exploration budget section`, () => {
			const text = readPrompt(name);
			expect(text).toContain("Exploration Budget");
		});

		it(`T-BUDGET-${name}-caps: ${name} contains the hard caps (read 30, grep 5, git 3, AFT 10)`, () => {
			const text = readPrompt(name);
			expect(text).toMatch(/max 30|read.*max 30/);
			expect(text).toMatch(/max 5/);
			expect(text).toMatch(/max 3/);
			expect(text).toMatch(/max 10/);
		});

		it(`T-BUDGET-${name}-escape: ${name} contains the BLOCKED escape hatch`, () => {
			const text = readPrompt(name);
			// The escape hatch references BLOCKED somewhere.
			expect(text).toMatch(/BLOCKED/);
		});
	}

	it("T-BUDGET-shared: all 4 prompts pin the same per-type rule (UNLIMITED writes)", () => {
		for (const name of PROMPTFiles) {
			const text = readPrompt(name);
			// At least one of the prompts explicitly says "UNLIMITED" for writes.
			// Multiple prompts may use slightly different phrasings.
			expect(text).toMatch(/UNLIMITED|unlimited/);
		}
	});
});
