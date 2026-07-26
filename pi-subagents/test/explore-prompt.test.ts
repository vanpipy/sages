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
	it("instructs use of codebase_memory_search_graph for symbol lookup", () => {
		expect(EXPLORE_PROMPT).toContain("codebase_memory_search_graph");
		expect(EXPLORE_PROMPT).toMatch(/Named symbol lookup/i);
	});
	it("instructs use of aft_search for concept search", () => {
		expect(EXPLORE_PROMPT).toContain("aft_search");
		expect(EXPLORE_PROMPT).toMatch(/Concept \/ pattern search/i);
	});
	it("warns against using bash find/cat/grep (use AFT/MCP instead)", () => {
		expect(EXPLORE_PROMPT).toContain("NOT for `find`/`cat`/`grep` (use AFT/MCP equivalents above)");
	});
	it("instructs use of ctx_search for past work", () => {
		expect(EXPLORE_PROMPT).toContain("ctx_search");
		expect(EXPLORE_PROMPT).toMatch(/Past work \/ memory/i);
	});
	it("requires absolute file paths", () => expect(EXPLORE_PROMPT).toMatch(/absolute file paths/i));
	it("forbids emojis", () => expect(EXPLORE_PROMPT).toContain("Do not use emojis"));
});
