/**
 * verdict.test.ts — Unit tests for the verdict parser + follow-up
 * helper. Pure functions, no state.
 */

import { describe, expect, it } from "bun:test";
import { parseVerdict, suggestFollowUp, type Verdict } from "../src/verdict.js";

describe("parseVerdict", () => {
	it("extracts a bare CLEAN token on its own line", () => {
		// The Reviewer's standard output ends with the verdict on a line by
		// itself. Multi-line agent output is the norm.
		expect(parseVerdict("All checks pass.\nCLEAN\n")).toBe("CLEAN");
		expect(parseVerdict("CLEAN")).toBe("CLEAN");
	});

	it("extracts NEEDS_WORK from a `verdict: NEEDS_WORK` line", () => {
		expect(parseVerdict("Issue in tests.\nverdict: NEEDS_WORK\n")).toBe("NEEDS_WORK");
	});

	it("accepts `Verdict =` and other separators", () => {
		expect(parseVerdict("Verdict = NEEDS_REDESIGN")).toBe("NEEDS_REDESIGN");
		expect(parseVerdict("verdict:NEEDS_CLARIFICATION")).toBe("NEEDS_CLARIFICATION");
	});

	it("is case-insensitive on the verdict token (prefixed form)", () => {
		expect(parseVerdict("verdict: clean")).toBe("CLEAN");
		expect(parseVerdict("VERDICT: needs_work")).toBe("NEEDS_WORK");
	});

	it("returns undefined when no verdict token appears", () => {
		expect(parseVerdict("The code looks good to me.")).toBeUndefined();
		expect(parseVerdict("")).toBeUndefined();
	});

	it("does not match verdict-like words that are not in the 4-state set", () => {
		// Defensive: NEARLY, UNSURE, FAIL etc. are not in the set.
		expect(parseVerdict("verdict: NEARLY")).toBeUndefined();
		expect(parseVerdict("verdict: UNSURE")).toBeUndefined();
	});

	it("does not false-match on prose that mentions the words", () => {
		// 'clean' / 'work' as English words mid-line — the `verdict:` prefix
		// anchor AND the standalone-line anchor keep this from matching.
		expect(parseVerdict("Let me clean up the code.")).toBeUndefined();
		expect(parseVerdict("The code is clean.")).toBeUndefined();
		expect(parseVerdict("Let me work on this.")).toBeUndefined();
	});
});

describe("suggestFollowUp", () => {
	const verdicts: Verdict[] = [
		"CLEAN",
		"NEEDS_WORK",
		"NEEDS_REDESIGN",
		"NEEDS_CLARIFICATION",
	];

	it("returns a non-empty hint for every verdict in the 4-state set", () => {
		for (const v of verdicts) {
			const hint = suggestFollowUp(v);
			expect(typeof hint).toBe("string");
			expect(hint.length).toBeGreaterThan(0);
		}
	});

	it("CLEAN hints at moving on, not at spawning follow-up work", () => {
		const hint = suggestFollowUp("CLEAN");
		expect(hint.toLowerCase()).toContain("complete");
		expect(hint.toLowerCase()).not.toContain("follow-up task");
	});

	it("NEEDS_WORK hints at a Developer follow-up, with a blockedBy hint", () => {
		const hint = suggestFollowUp("NEEDS_WORK");
		expect(hint.toLowerCase()).toContain("developer");
		expect(hint.toLowerCase()).toContain("blockedby");
	});

	it("NEEDS_REDESIGN hints at a new Implement task rather than a fix", () => {
		const hint = suggestFollowUp("NEEDS_REDESIGN");
		expect(hint.toLowerCase()).toContain("implement");
		expect(hint.toLowerCase()).not.toContain("developer");
	});

	it("NEEDS_CLARIFICATION hints at pausing for the user", () => {
		const hint = suggestFollowUp("NEEDS_CLARIFICATION");
		expect(hint.toLowerCase()).toContain("pause");
		expect(hint.toLowerCase()).toContain("user");
	});
});