import { describe, expect, it } from "vitest";
import { PLAN_PROMPT } from "../src/agent-prompts/plan.js";

describe("plan-prompt: invariants", () => {
	it("exports a non-empty string", () => {
		expect(typeof PLAN_PROMPT).toBe("string");
		expect(PLAN_PROMPT.length).toBeGreaterThan(200);
	});
	it("declares read-only intent", () => expect(PLAN_PROMPT).toMatch(/READ-ONLY/i));
	it("requires a step-by-step implementation plan", () => expect(PLAN_PROMPT).toMatch(/step-by-step/i));
	it("requires the critical files output section", () => expect(PLAN_PROMPT).toContain("Critical Files for Implementation"));
	it("instructs use of codebase_memory_get_architecture", () => {
		expect(PLAN_PROMPT).toContain("codebase_memory_get_architecture");
		expect(PLAN_PROMPT).toMatch(/clusters.*entry_points/s);
	});
	it("instructs use of codebase_memory_trace_path", () => {
		expect(PLAN_PROMPT).toContain("codebase_memory_trace_path");
	});
	it("ends with todowrite for plan decomposition", () => {
		expect(PLAN_PROMPT).toContain("todowrite({ todos: [...] })");
		expect(PLAN_PROMPT).toContain("### Implementation Steps");
		expect(PLAN_PROMPT).toMatch(/every plan ends with a todowrite/i);
	});
	it("requires absolute file paths", () => expect(PLAN_PROMPT).toMatch(/absolute file paths/i));
	it("forbids emojis", () => expect(PLAN_PROMPT).toContain("Do not use emojis"));
});
