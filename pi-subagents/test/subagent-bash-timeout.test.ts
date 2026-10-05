/**
 * subagent-bash-timeout.test.ts — GC-2026-038 T5 (updated for GC-2026-043 Phase 4)
 *
 * Verifies that each agent prompt's bash-timeout guard is in sync with
 * the runtime enforcement (Rendered from `renderBashTimeoutSection()`,
 * which derives from `DEFAULT_BUCKET_TIMEOUTS_MS`).
 *
 * Updated per design doc Phase 4:
 *   - The per-bucket values must match `DEFAULT_BUCKET_TIMEOUTS_MS`
 *     (not be hand-written in each prompt).
 *   - The surrounding prose (anti-patterns, escape hatch) stays
 *     hand-written and remains pinned here.
 *
 * GC-2026-prompt-parser-contract-cleanup: Developer + Reviewer now import
 * the section from `_sections/bash-timeout.ts` (which itself calls
 * `renderBashTimeoutSection()`). Explore + Plan still inline the section
 * with their own `renderBashTimeoutSection()` call. The loop below picks
 * the right check per prompt file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PROMPT_DIR = join(import.meta.dirname, "../src/agent-prompts");

// Prompts that still carry the section inline.
const INLINE_PROMPT_FILES = ["explore.ts", "plan.ts"] as const;

// Prompts that import the section from _sections/.
const IMPORTED_PROMPT_FILES = ["developer.ts", "reviewer.ts"] as const;

function readPrompt(name: string): string {
	return readFileSync(join(PROMPT_DIR, name), "utf8");
}

function readSection(name: string): string {
	return readFileSync(join(PROMPT_DIR, "_sections", name), "utf8");
}

describe("subagent bash timeout guard (GC-2026-038 T5, GC-2026-043 Phase 4)", () => {
	for (const name of INLINE_PROMPT_FILES) {
		it(`T-BASH-${name}: ${name} (inline) uses renderBashTimeoutSection() (not hand-written)`, async () => {
			const prompt = readPrompt(name);
			expect(prompt).toMatch(/renderBashTimeoutSection\s*\(/);
		});

		it(`T-BASH-${name}-values: ${name}'s runtime-rendered section pins read=5s and network=5s`, async () => {
			const { renderBashTimeoutSection, DEFAULT_BUCKET_TIMEOUTS_MS } =
				await import("../src/run-controller.js");
			const rendered = renderBashTimeoutSection();
			expect(rendered).toContain(`${DEFAULT_BUCKET_TIMEOUTS_MS.read / 1000}s`);
			expect(rendered).toContain(
				`${DEFAULT_BUCKET_TIMEOUTS_MS.network / 1000}s`,
			);
			const prompt = readPrompt(name);
			expect(prompt).toContain("renderBashTimeoutSection()");
		});
	}

	for (const name of IMPORTED_PROMPT_FILES) {
		it(`T-BASH-${name}: ${name} (imported) source imports _sections/bash-timeout`, () => {
			const prompt = readPrompt(name);
			expect(prompt).toMatch(
				/from\s+["']\.\/_sections\/bash-timeout\.js["']/,
			);
		});

		it(`T-BASH-${name}-section: _sections/bash-timeout.ts calls renderBashTimeoutSection()`, () => {
			const section = readSection("bash-timeout.ts");
			expect(section).toMatch(/renderBashTimeoutSection\s*\(/);
		});
	}

	it("T-BASH-shared: runtime-rendered section pins full per-bucket table (read 5s, search 10s, test 30s, full-suite 90s, network 5s)", async () => {
		const { renderBashTimeoutSection } = await import(
			"../src/run-controller.js"
		);
		const rendered = renderBashTimeoutSection();
		expect(rendered).toMatch(/read.*5s/);
		expect(rendered).toMatch(/search.*10s/);
		expect(rendered).toMatch(/test.*30s/);
		expect(rendered).toMatch(/full[- ]?suite.*90s/);
		expect(rendered).toMatch(/network.*5s/);
	});

	it("T-BASH-anti-patterns: developer.ts (rendered) keeps its hand-written anti-patterns prose", async () => {
		const { DEVELOPER_PROMPT } = await import(
			"../src/agent-prompts/developer.js"
		);
		// Anti-patterns stay hand-written — they reference project context the
		// function output doesn't carry (commands specific to this codebase).
		// Rendered output uses literal backticks (not escaped) since the
		// template literal has already been interpolated.
		expect(DEVELOPER_PROMPT).toContain(
			"Do NOT run `bun test` (full suite) in a loop",
		);
		expect(DEVELOPER_PROMPT).toContain("Do NOT run `git log -p`");
		expect(DEVELOPER_PROMPT).toContain("Do NOT use bash grep/rg/find/cat");
	});
});
