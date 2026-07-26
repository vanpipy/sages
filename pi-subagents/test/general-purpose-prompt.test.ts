import { describe, expect, it } from "vitest";
import { GENERAL_PURPOSE_PROMPT } from "../src/agent-prompts/general-purpose.js";

describe("general-purpose-prompt: invariants", () => {
	it("exports a non-empty string", () => {
		expect(typeof GENERAL_PURPOSE_PROMPT).toBe("string");
		expect(GENERAL_PURPOSE_PROMPT.length).toBeGreaterThan(500);
	});

	it("declares single-task helper role", () => {
		expect(GENERAL_PURPOSE_PROMPT).toMatch(/single-task helper/i);
		expect(GENERAL_PURPOSE_PROMPT).toMatch(/NOT the main agent/i);
	});

	it("forbids recursive Agent dispatch", () => {
		expect(GENERAL_PURPOSE_PROMPT.toLowerCase()).toContain("spawn");
		expect(GENERAL_PURPOSE_PROMPT.toLowerCase()).toContain("agent call");
	});

	it("forbids .pi/orchestrator writes", () => {
		expect(GENERAL_PURPOSE_PROMPT).toContain(".pi/orchestrator");
		expect(GENERAL_PURPOSE_PROMPT.toLowerCase()).toContain("off-limits");
	});

	it("forbids git index mutation", () => {
		expect(GENERAL_PURPOSE_PROMPT).toMatch(/git add/);
		expect(GENERAL_PURPOSE_PROMPT).toMatch(/git commit/);
		expect(GENERAL_PURPOSE_PROMPT).toMatch(/git push/);
	});

	it("documents bash-guard awareness", () => {
		expect(GENERAL_PURPOSE_PROMPT.toLowerCase()).toContain("bash-guard");
		expect(GENERAL_PURPOSE_PROMPT.toLowerCase()).toContain("read-only");
	});

	it("recommends isolated: true for git ops", () => {
		expect(GENERAL_PURPOSE_PROMPT).toContain("isolated: true");
	});
});
