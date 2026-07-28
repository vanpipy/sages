/**
 * pi-evaluator/test/prompts.test.ts
 *
 * RED-first: tests fail before src/prompts.ts exists, pass after.
 *
 * The system prompt constant is the THIRD layer of the 3-layer LLM hint
 * contract (tool description → skill file → system prompt). When reward
 * mode is on and the agent starts a turn, this string is appended to the
 * system prompt so the agent knows what tools it has.
 *
 * Required properties (per GC-2026-019 spec):
 *   - non-empty string
 *   - mentions `eval_score`
 *   - mentions `eval_trend`
 *   - hints at when to call (after DAG, after reports, before finalizing)
 *   - hints at reading the `evidence` field
 */

import { describe, expect, test } from "bun:test";

import { REWARD_MODE_SYSTEM_PROMPT } from "../src/prompts.ts";

describe("REWARD_MODE_SYSTEM_PROMPT", () => {
	test("exports a non-empty string", () => {
		expect(typeof REWARD_MODE_SYSTEM_PROMPT).toBe("string");
		expect(REWARD_MODE_SYSTEM_PROMPT.length).toBeGreaterThan(0);
	});

	test("mentions both tool names", () => {
		expect(REWARD_MODE_SYSTEM_PROMPT).toContain("eval_score");
		expect(REWARD_MODE_SYSTEM_PROMPT).toContain("eval_trend");
	});

	test("hints at WHEN to call (after DAG / after reports / before finalizing)", () => {
		const prompt = REWARD_MODE_SYSTEM_PROMPT.toLowerCase();
		const hasWhen =
			prompt.includes("after") ||
			prompt.includes("before") ||
			prompt.includes("when");
		expect(hasWhen).toBe(true);
	});

	test("hints at the evidence field for fix-pointers", () => {
		expect(REWARD_MODE_SYSTEM_PROMPT).toContain("evidence");
	});

	test("has at least 200 chars (non-trivial, not a stub)", () => {
		expect(REWARD_MODE_SYSTEM_PROMPT.length).toBeGreaterThanOrEqual(200);
	});
});
