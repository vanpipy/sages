import { describe, expect, it } from "vitest";
import { EXPLORE_PROMPT } from "../src/agent-prompts/explore.js";

describe("explore-prompt: invariants", () => {
	it("exports a non-empty string", () => {
		expect(typeof EXPLORE_PROMPT).toBe("string");
		expect(EXPLORE_PROMPT.length).toBeGreaterThan(200);
	});
	it("declares read-only intent", () =>
		expect(EXPLORE_PROMPT).toMatch(/READ-ONLY/i));
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
		expect(EXPLORE_PROMPT).toContain(
			"NOT for `find`/`cat`/`grep` (use AFT/MCP equivalents above)",
		);
	});
	it("instructs use of ctx_search for past work", () => {
		expect(EXPLORE_PROMPT).toContain("ctx_search");
		expect(EXPLORE_PROMPT).toMatch(/Past work \/ memory/i);
	});
	it("requires three-level onboarding output structure", () => {
		expect(EXPLORE_PROMPT).toContain("### 1-Line Summary");
		expect(EXPLORE_PROMPT).toContain("### 5-Minute Explanation");
		expect(EXPLORE_PROMPT).toContain("### Deep Dive");
		expect(EXPLORE_PROMPT).toContain("absolute file paths");
		expect(EXPLORE_PROMPT).toContain("Do not use emojis");
	});
	it("requires absolute file paths", () =>
		expect(EXPLORE_PROMPT).toMatch(/absolute file paths/i));
	it("forbids emojis", () =>
		expect(EXPLORE_PROMPT).toContain("Do not use emojis"));
});

describe("explore-prompt: FIRST tool priorities (GC-2026-087 P2)", () => {
	// GC-2026-087 P2: Explore is the search-specialist role. The
	// audit showed even this role defaults to bash grep instead of
	// AFT. A FIRST tool priorities section at the top makes the
	// preference unmissable. The table is more emphatic than the
	// developer's because Explore's whole job is finding code — the
	// LLM should never bash-grep when AFT exists.

	it("declares a 'FIRST tool priorities' section header", () => {
		expect(EXPLORE_PROMPT).toMatch(/^##\s+FIRST tool priorities.*$/m);
	});

	it("FIRST tool priorities section sits BEFORE the Output section", () => {
		// Explore's structure is short: # Tool Usage, ## FIRST tool
		// priorities, ## Output. The Output section is the LLM's
		// reporting template; FIRST tool priorities must come before
		// it so the LLM sees the preference before being told what
		// to produce.
		const firstIdx =
			EXPLORE_PROMPT.match(/^##\s+FIRST tool priorities.*$/m)?.index ?? -1;
		const outputIdx = EXPLORE_PROMPT.match(/^##\s+Output.*$/m)?.index ?? -1;
		expect(firstIdx).toBeGreaterThanOrEqual(0);
		expect(outputIdx).toBeGreaterThanOrEqual(0);
		expect(
			firstIdx,
			"FIRST tool priorities must come BEFORE Output",
		).toBeLessThan(outputIdx);
	});

	it("includes at least 3 bullet entries (each '- **Task**: ...')", () => {
		expect(EXPLORE_PROMPT).toContain("## FIRST tool priorities");
		const section =
			EXPLORE_PROMPT.split("## FIRST tool priorities")[1]?.split("##")[0] ??
			"";
		const entries = section
			.split("\n")
			.filter((l) => l.trim().startsWith("- **"));
		expect(
			entries.length,
			`expected >= 3 bullet entries, got ${entries.length}`,
		).toBeGreaterThanOrEqual(3);
	});

	it("references AFT, codebase_memory, and ctx_ tool families in the section", () => {
		expect(EXPLORE_PROMPT).toContain("## FIRST tool priorities");
		const section =
			EXPLORE_PROMPT.split("## FIRST tool priorities")[1]?.split("##")[0] ??
			"";
		expect(section, "must reference AFT").toMatch(/aft_/);
		expect(section, "must reference codebase_memory").toMatch(
			/codebase_memory/,
		);
		expect(section, "must reference ctx_").toMatch(/ctx_/);
	});
});
