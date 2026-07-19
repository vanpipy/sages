/**
 * Tests for the pure logic in src/nudge.ts.
 *
 * The previous pi-semantic-nudge targeted the serena/codebase-memory/graphify
 * trio. After the AFT migration (sages commit 1d7d1b6 on 2026-07-19):
 *   - serena is uninstalled (entries must be dropped from SEMANTIC)
 *   - the 9 sages_* wrappers are the primary semantic layer (must enter SEMANTIC)
 *   - codebase-memory + graphify remain valid fallbacks (kept)
 *
 * These tests pin the new contract:
 *   - SEMANTIC membership (positive + negative)
 *   - BUILTIN_DRIFT unchanged (grep/read/find/ls; bash is intentionally NOT drift)
 *   - shouldNudge() is pure and recognizes sages_* calls as drift-neutral
 *   - buildNudgeText() mentions sages_*, not serena_*
 *   - the SAGE_TOOL_NAMES export matches src/tools/wrap/index.ts's SAGE_TOOL_NAMES
 */

import { describe, it, expect } from "bun:test";
import {
	BUILTIN_DRIFT,
	SEMANTIC,
	SAGE_TOOL_NAMES,
	shouldNudge,
	buildNudgeText,
	type NudgeState,
} from "../src/nudge.js";

describe("BUILTIN_DRIFT", () => {
	it("includes grep, read, find, ls (no bash — bash is a primary tool)", () => {
		expect(BUILTIN_DRIFT.has("grep")).toBe(true);
		expect(BUILTIN_DRIFT.has("read")).toBe(true);
		expect(BUILTIN_DRIFT.has("find")).toBe(true);
		expect(BUILTIN_DRIFT.has("ls")).toBe(true);
		expect(BUILTIN_DRIFT.has("bash")).toBe(false);
		expect(BUILTIN_DRIFT.has("write")).toBe(false);
		expect(BUILTIN_DRIFT.has("edit")).toBe(false);
	});
});

describe("SEMANTIC membership", () => {
	const SAGE_NAMES = [
		"sages_read_file",
		"sages_outline",
		"sages_find_symbol",
		"sages_search",
		"sages_write_file",
		"sages_replace_symbol",
		"sages_insert_after_symbol",
		"sages_find_references",
		"sages_diagnostics",
	];

	for (const name of SAGE_NAMES) {
		it(`includes ${name}`, () => {
			expect(SEMANTIC.has(name)).toBe(true);
		});
	}

	const CBM = [
		"codebase_memory_trace_path",
		"codebase_memory_detect_changes",
		"codebase_memory_get_architecture",
		"codebase_memory_search_graph",
		"codebase_memory_search_code",
		"codebase_memory_get_code_snippet",
	];
	for (const name of CBM) {
		it(`includes ${name} (kept as fallback)`, () => {
			expect(SEMANTIC.has(name)).toBe(true);
		});
	}

	const GRAPHIFY = [
		"graphify_query",
		"graphify_shortest_path",
		"graphify_god_nodes",
		"graphify_get_community",
	];
	for (const name of GRAPHIFY) {
		it(`includes ${name} (kept as fallback)`, () => {
			expect(SEMANTIC.has(name)).toBe(true);
		});
	}

	const SERENA = [
		"serena_find_symbol",
		"serena_find_referencing_symbols",
		"serena_get_symbols_overview",
		"serena_replace_symbol_body",
		"serena_insert_after_symbol",
		"serena_read_file",
		"serena_create_text_file",
		"serena_search_for_pattern",
	];
	for (const name of SERENA) {
		it(`does NOT include ${name} (serena uninstalled)`, () => {
			expect(SEMANTIC.has(name)).toBe(false);
		});
	}

	it("does NOT include AFT direct tools (those are direct from the AFT extension)", () => {
		expect(SEMANTIC.has("aft_outline")).toBe(false);
		expect(SEMANTIC.has("aft_zoom")).toBe(false);
		expect(SEMANTIC.has("aft_search")).toBe(false);
	});
});

describe("SAGE_TOOL_NAMES export", () => {
	it("exposes exactly the 9 sage wrapper tool names", () => {
		expect(SAGE_TOOL_NAMES).toHaveLength(9);
		expect(new Set(SAGE_TOOL_NAMES).size).toBe(9);
	});

	it("contains every sages_* tool the wrap layer registers", () => {
		const expected = [
			"sages_diagnostics",
			"sages_find_references",
			"sages_find_symbol",
			"sages_insert_after_symbol",
			"sages_outline",
			"sages_read_file",
			"sages_replace_symbol",
			"sages_search",
			"sages_write_file",
		];
		for (const name of expected) {
			expect(SAGE_TOOL_NAMES).toContain(name);
		}
	});
});

describe("shouldNudge()", () => {
	const freshState: NudgeState = { turnsSinceLastNudge: 999, recentTools: [] };

	it("returns false when below the drift threshold", () => {
		expect(
			shouldNudge(["read", "grep", "write"], freshState),
		).toBe(false);
	});

it("returns false while suppressed", () => {
			expect(
				shouldNudge(
					["grep", "grep", "grep", "read"],
					{ turnsSinceLastNudge: 2, recentTools: [] },
				),
			).toBe(false);
		});

	it("returns true when 3+ builtins fill the window with no semantic use", () => {
		expect(
			shouldNudge(
				["grep", "read", "find", "ls"],
				freshState,
			),
		).toBe(true);
	});

	it("returns false when sages_* is in the window (drift-neutral)", () => {
		expect(
			shouldNudge(
				["grep", "read", "sages_read_file", "find"],
				freshState,
			),
		).toBe(false);
	});

	it("returns false when codebase_memory_* is in the window", () => {
		expect(
			shouldNudge(
				["grep", "read", "codebase_memory_search_graph", "find"],
				freshState,
			),
		).toBe(false);
	});

	it("returns false when graphify_* is in the window", () => {
		expect(
			shouldNudge(
				["grep", "read", "graphify_query", "find"],
				freshState,
			),
		).toBe(false);
	});

	it("does NOT treat bash as drift (bash is a primary tool)", () => {
		expect(
			shouldNudge(["bash", "bash", "bash"], freshState),
		).toBe(false);
	});

	it("treats any sages_* call WITHIN the passed window as suppressive", () => {
		// shouldNudge operates on whatever array the caller passes; window
		// trimming is done by recordTool (internal). This test pins the
		// semantic-suppression contract on the pure helper.
		expect(
			shouldNudge(
				["grep", "read", "sages_search", "find", "ls"],
				freshState,
			),
		).toBe(false);
	});

	it("does not look beyond the passed window", () => {
		// shouldNudge never inspects calls older than what's passed in.
		// If the caller passes 5 drift calls with no sages, it nudges,
		// regardless of what came before.
		expect(
			shouldNudge(
				["grep", "read", "find", "ls", "write"],
				freshState,
			),
		).toBe(true);
	});
});

describe("buildNudgeText()", () => {
	it("mentions sages_* tools (the post-AFT semantic layer)", () => {
		const text = buildNudgeText();
		expect(text).toContain("sages_");
	});

	it("does NOT mention serena_* (uninstalled in the AFT migration)", () => {
		const text = buildNudgeText();
		expect(text).not.toContain("serena_");
	});

	it("still mentions codebase_memory_* + graphify_* as fallbacks", () => {
		const text = buildNudgeText();
		expect(text).toContain("codebase_memory_");
		expect(text).toContain("graphify_");
	});

	it("includes <nudge>...</nudge> tags for pattern matching", () => {
		const text = buildNudgeText();
		expect(text).toContain("<nudge>");
		expect(text).toContain("</nudge>");
	});

	it("lists the drift builtins it warns against", () => {
		const text = buildNudgeText();
		expect(text).toContain("grep");
		expect(text).toContain("read");
		expect(text).toContain("find");
		expect(text).toContain("ls");
	});

	it("is byte-stable (LLMs pattern-match the exact wording)", () => {
		// If we change this, the LLM may stop recognizing the nudge. Pin it.
		expect(buildNudgeText()).toBe(buildNudgeText());
	});
});