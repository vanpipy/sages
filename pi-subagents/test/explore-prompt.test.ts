import { describe, expect, it } from "vitest";
import { EXPLORE_PROMPT } from "../src/agent-prompts/explore.js";

describe("explore-prompt: invariants", () => {
	it("exports a non-empty string", () => {
		expect(typeof EXPLORE_PROMPT).toBe("string");
		expect(EXPLORE_PROMPT.length).toBeGreaterThan(200);
	});
	it("declares read-only intent", () => expect(EXPLORE_PROMPT).toMatch(/READ-ONLY/i));
	it("forbids representative file modifications", () => {
		expect(EXPLORE_PROMPT).toContain("Creating new files");
		expect(EXPLORE_PROMPT).toContain("Modifying existing files");
		expect(EXPLORE_PROMPT).toContain("Using redirect operators");
	});
	it("directs searches through find, grep, and read tools", () => {
		expect(EXPLORE_PROMPT).toContain("find tool");
		expect(EXPLORE_PROMPT).toContain("grep tool");
		expect(EXPLORE_PROMPT).toContain("read tool");
	});
	it("requires absolute file paths", () => expect(EXPLORE_PROMPT).toMatch(/absolute file paths/i));
	it("forbids emojis", () => expect(EXPLORE_PROMPT).toContain("Do not use emojis"));
});
