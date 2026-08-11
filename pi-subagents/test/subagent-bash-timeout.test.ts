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
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PROMPT_DIR = join(import.meta.dirname, "../src/agent-prompts");

const PROMPT_FILES = [
	"developer.ts",
	"auditor.ts",
	"explore.ts",
	"plan.ts",
] as const;

function readPrompt(name: string): string {
	return readFileSync(join(PROMPT_DIR, name), "utf8");
}

describe("subagent bash timeout guard (GC-2026-038 T5, GC-2026-043 Phase 4)", () => {
	for (const name of PROMPT_FILES) {
		it(`T-BASH-${name}: ${name} uses renderBashTimeoutSection() (not hand-written)`, async () => {
			const prompt = readPrompt(name);
			expect(prompt).toMatch(/renderBashTimeoutSection\s*\(/);
		});

		it(`T-BASH-${name}-values: ${name}'s runtime-rendered section pins read=5s and network=5s`, async () => {
			const { renderBashTimeoutSection, DEFAULT_BUCKET_TIMEOUTS_MS } =
				await import("../src/run-controller.js");
			const rendered = renderBashTimeoutSection();
			// The rendered output must carry the current values — proves that
			// each prompt's `BASH_TIMEOUT_SECTION` (which is the function output)
			// is up to date with the runtime enforcement.
			expect(rendered).toContain(`${DEFAULT_BUCKET_TIMEOUTS_MS.read / 1000}s`);
			expect(rendered).toContain(
				`${DEFAULT_BUCKET_TIMEOUTS_MS.network / 1000}s`,
			);
			// And the prompt file must call the function (so the rendered output
			// is what the prompt actually sees at module-load).
			const prompt = readPrompt(name);
			expect(prompt).toContain("renderBashTimeoutSection()");
		});
	}

	it("T-BASH-shared: developer.ts pins full per-bucket table (read 5s, search 10s, test 30s, full-suite 90s, network 5s)", async () => {
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

	it("T-BASH-anti-patterns: developer.ts keeps its hand-written anti-patterns prose", () => {
		const prompt = readPrompt("developer.ts");
		// Anti-patterns stay hand-written — they reference project context the
		// function output doesn't carry (commands specific to this codebase).
		// Source uses escaped backticks (`\``) inside the template literal.
		expect(prompt).toContain(
			"Do NOT run \\`bun test\\` (full suite) in a loop",
		);
		expect(prompt).toContain("Do NOT run \\`git log -p\\`");
		expect(prompt).toContain("Do NOT use bash grep/rg/find/cat");
	});
});
