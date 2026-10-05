/**
 * subagent-uncertainty.test.ts — GC-2026-038 T4
 *
 * Verifies the uncertainty-threshold prompt text exists in all 4 prompts
 * AND the extractAsk runtime helper extracts <ASK> blocks correctly.
 *
 * GC-2026-prompt-parser-contract-cleanup: Developer + Reviewer now import
 * the section from `_sections/uncertainty-threshold.ts`. We assert against
 * the rendered prompt for those two; explore.ts and plan.ts keep their
 * inline section and we read them as files.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractAsk } from "../src/agent-runner.js";
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

describe("subagent uncertainty threshold (GC-2026-038 T4)", () => {
	for (const name of INLINE_PROMPT_FILES) {
		it(`T-UNC-${name}: ${name} (inline) contains the uncertainty threshold section`, () => {
			const text = readPrompt(name);
			expect(text).toContain("Uncertainty Threshold");
		});

		it(`T-UNC-${name}-ask: ${name} (inline) shows the <ASK>question</ASK> markup`, () => {
			const text = readPrompt(name);
			expect(text).toMatch(/<ASK>/);
		});

		it(`T-UNC-${name}-turns: ${name} (inline) mentions the 5-turn threshold`, () => {
			const text = readPrompt(name);
			expect(text).toMatch(/5 turns/);
		});
	}

	for (const name of Object.keys(RENDERED_PROMPTS) as Array<"developer.ts" | "reviewer.ts">) {
		it(`T-UNC-${name}: ${name} (rendered) contains the uncertainty threshold section`, () => {
			expect(RENDERED_PROMPTS[name]).toContain("Uncertainty Threshold");
		});

		it(`T-UNC-${name}-ask: ${name} (rendered) shows the <ASK>question</ASK> markup`, () => {
			expect(RENDERED_PROMPTS[name]).toMatch(/<ASK>/);
		});

		it(`T-UNC-${name}-turns: ${name} (rendered) mentions the 5-turn threshold`, () => {
			expect(RENDERED_PROMPTS[name]).toMatch(/5 turns/);
		});
	}
});

describe("extractAsk runtime helper (GC-2026-038 T4)", () => {
	it("T-UNC-extract-01: returns a single ASK question", () => {
		const text = "Some text. <ASK>What API signature?</ASK> more text.";
		expect(extractAsk(text)).toEqual(["What API signature?"]);
	});

	it("T-UNC-extract-02: returns multiple ASK questions", () => {
		const text = `<ASK>First question?</ASK> blah <ASK>Second question?</ASK>`;
		expect(extractAsk(text)).toEqual(["First question?", "Second question?"]);
	});

	it("T-UNC-extract-03: returns an empty array when no ASK is present", () => {
		expect(extractAsk("Just some text without ask markup.")).toEqual([]);
	});

	it("T-UNC-extract-04: trims whitespace from extracted questions", () => {
		const text = "<ASK>  \n  Whitespace?  \n  </ASK>";
		expect(extractAsk(text)).toEqual(["Whitespace?"]);
	});

	it("T-UNC-extract-05: handles multiline ASK content", () => {
		const text = `<ASK>
			What is the deadline default?
			Should it be 20min for developer?
		</ASK>`;
		const result = extractAsk(text);
		expect(result.length).toBe(1);
		expect(result[0]).toContain("deadline default");
		expect(result[0]).toContain("20min");
	});

	it("T-UNC-extract-06: case-insensitive match", () => {
		const text = "<ask>lowercase ask</ask>";
		expect(extractAsk(text)).toEqual(["lowercase ask"]);
	});
});
