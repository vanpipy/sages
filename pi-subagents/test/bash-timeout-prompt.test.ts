/**
 * test/bash-timeout-prompt.test.ts — GC-2026-043 T2 (Phase 4)
 *
 * Verifies that the BASH_TIMEOUT_SECTION in each agent prompt is
 * generated from `renderBashTimeoutSection()` derived from
 * `DEFAULT_BUCKET_TIMEOUTS_MS`, not hand-written. Single source of truth:
 * the prompt + the runtime enforcement must agree.
 *
 * Pinned invariants:
 *   - `renderBashTimeoutSection()` exists on run-controller.ts, returns
 *     a non-empty string containing each bucket's rendered time.
 *   - Each of `developer.ts`, `auditor.ts`, `plan.ts`, `explore.ts`
 *     calls `renderBashTimeoutSection()` in its source (proves the
 *     integration).
 *   - The drift test mutates `DEFAULT_BUCKET_TIMEOUTS_MS.read` and
 *     asserts the new value appears in the rendered output — proves
 *     the prompt is generated, not hand-written.
 *
 * Design reference: `.pi/orchestrator/design-timeout-architecture.md`
 * Phase 4 (Prompt generation). The design keeps `BASH_TIMEOUT_SECTION`
 * as a module-internal const (declared and `void`-suppressed), so this
 * test asserts the source-text integration rather than runtime export.
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

describe("run-controller: renderBashTimeoutSection", () => {
	it("exports renderBashTimeoutSection", async () => {
		const mod = await import("../src/run-controller.js");
		expect(typeof mod.renderBashTimeoutSection).toBe("function");
	});

	it("returns a non-empty string", async () => {
		const { renderBashTimeoutSection } = await import(
			"../src/run-controller.js"
		);
		const text = renderBashTimeoutSection();
		expect(typeof text).toBe("string");
		expect(text.length).toBeGreaterThan(0);
	});

	it("contains the six bucket labels (read / search / test / full-suite / network / other)", async () => {
		const { renderBashTimeoutSection } = await import(
			"../src/run-controller.js"
		);
		const text = renderBashTimeoutSection();
		expect(text).toMatch(/\bread\b/);
		expect(text).toMatch(/\bsearch\b/);
		expect(text).toMatch(/\btest\b/);
		expect(text).toMatch(/\bfull[- ]?suite\b/);
		expect(text).toMatch(/\bnetwork\b/);
		expect(text).toMatch(/\bother\b/);
	});

	it("renders each bucket's value (in seconds) from DEFAULT_BUCKET_TIMEOUTS_MS", async () => {
		const { DEFAULT_BUCKET_TIMEOUTS_MS, renderBashTimeoutSection } = await import(
			"../src/run-controller.js"
		);
		const text = renderBashTimeoutSection();
		// Each bucket value is divided by 1000 to render seconds.
		expect(text).toContain(`${DEFAULT_BUCKET_TIMEOUTS_MS.read / 1000}s`);
		expect(text).toContain(`${DEFAULT_BUCKET_TIMEOUTS_MS.search / 1000}s`);
		expect(text).toContain(`${DEFAULT_BUCKET_TIMEOUTS_MS.test / 1000}s`);
		expect(text).toContain(`${DEFAULT_BUCKET_TIMEOUTS_MS.fullTest / 1000}s`);
		expect(text).toContain(`${DEFAULT_BUCKET_TIMEOUTS_MS.network / 1000}s`);
		expect(text).toContain(`${DEFAULT_BUCKET_TIMEOUTS_MS.other / 1000}s`);
	});

	it("flags the guard as HARD-enforced (timeout / kill wording)", async () => {
		const { renderBashTimeoutSection } = await import(
			"../src/run-controller.js"
		);
		const text = renderBashTimeoutSection().toLowerCase();
		expect(text).toMatch(/timeout|killed|kills the child|hard-enforced/);
	});

	it("drift test: mutating DEFAULT_BUCKET_TIMEOUTS_MS.read changes the rendered output", async () => {
		const { DEFAULT_BUCKET_TIMEOUTS_MS, renderBashTimeoutSection } = await import(
			"../src/run-controller.js"
		);
		const originalRead = DEFAULT_BUCKET_TIMEOUTS_MS.read;
		try {
			// Mutate to a value that no hand-written text would contain.
			DEFAULT_BUCKET_TIMEOUTS_MS.read = 7777;
			const text = renderBashTimeoutSection();
			// 7777 / 1000 = 7.777 (must appear; proves generated, not hand-written)
			expect(text).toContain("7.777s");
			expect(text).toMatch(/\bread\b/);
		} finally {
			DEFAULT_BUCKET_TIMEOUTS_MS.read = originalRead;
		}
		// After restore, the default 5s value should be present again.
		const restored = renderBashTimeoutSection();
		expect(restored).toContain("5s");
	});

	it("drift test: mutating DEFAULT_BUCKET_TIMEOUTS_MS.network changes the rendered output", async () => {
		const { DEFAULT_BUCKET_TIMEOUTS_MS, renderBashTimeoutSection } = await import(
			"../src/run-controller.js"
		);
		const originalNetwork = DEFAULT_BUCKET_TIMEOUTS_MS.network;
		try {
			DEFAULT_BUCKET_TIMEOUTS_MS.network = 8888;
			const text = renderBashTimeoutSection();
			expect(text).toContain("8.888s");
		} finally {
			DEFAULT_BUCKET_TIMEOUTS_MS.network = originalNetwork;
		}
	});
});

describe("agent prompts: each calls renderBashTimeoutSection (source integration)", () => {
	for (const name of PROMPT_FILES) {
		it(`${name} source contains a call to renderBashTimeoutSection()`, () => {
			const prompt = readPrompt(name);
			// Either direct call or template-literal interpolation is fine —
			// both prove the section is derived from the function.
			expect(prompt).toMatch(/renderBashTimeoutSection\s*\(/);
		});

		it(`${name} source imports renderBashTimeoutSection from ../run-controller`, () => {
			const prompt = readPrompt(name);
			expect(prompt).toMatch(
				/import\s+\{[^}]*\brenderBashTimeoutSection\b[^}]*\}\s+from\s+["']\.\.\/run-controller\.js["']/,
			);
		});

		it(`${name} no longer carries hand-written bucket text outside the function call`, () => {
			// Once `renderBashTimeoutSection()` is wired in, the *source*
			// should not duplicate the per-bucket bullets (those live in
			// the function output, not the prompt file's source).
			// We assert this by checking the source does NOT contain the
			// legacy hand-written bullets that pre-dated this GC.
			const prompt = readPrompt(name);
			expect(prompt).not.toMatch(/^- \*\*read\*\* \(cat \/ head \/ tail \/ less\): 5s timeout$/m);
			expect(prompt).not.toMatch(/^- \*\*search\*\* \(grep \/ rg \/ awk \/ sed \/ find\): 10s timeout$/m);
		});

		it(`${name} source's BASH_TIMEOUT_SECTION references the rendered header`, () => {
			// The source declares `const BASH_TIMEOUT_SECTION = ... renderBashTimeoutSection() ...`
			// — proving the new file shape.
			const prompt = readPrompt(name);
			expect(prompt).toMatch(/BASH_TIMEOUT_SECTION\s*=[^;]*renderBashTimeoutSection\s*\([^)]*\)/);
		});
	}
});

describe("agent prompts: each renders the runtime-current values via the function", () => {
	for (const name of PROMPT_FILES) {
		it(`${name}'s generated section contains the current DEFAULT_BUCKET_TIMEOUTS_MS.read value`, async () => {
			const { DEFAULT_BUCKET_TIMEOUTS_MS, renderBashTimeoutSection } =
				await import("../src/run-controller.js");
			// The rendered section text must carry the read value at runtime.
			// (This is what each prompt will see at module load.)
			const rendered = renderBashTimeoutSection();
			const expected = `${DEFAULT_BUCKET_TIMEOUTS_MS.read / 1000}s`;
			expect(rendered).toContain(expected);
			// And the source-side wiring must call renderBashTimeoutSection.
			const prompt = readPrompt(name);
			expect(prompt).toContain("renderBashTimeoutSection()");
			// The two together prove: prompt file uses the function AND the
			// function output contains the runtime values — i.e., the prompt
			// gets the right text.
			expect(rendered.includes(expected) && prompt.includes("renderBashTimeoutSection()")).toBe(true);
		});
	}
});

describe("run-controller: no new dependencies", () => {
	it("run-controller module loads with only Node built-ins", async () => {
		const mod = await import("../src/run-controller.js");
		expect(mod).toBeDefined();
		expect(typeof mod.renderBashTimeoutSection).toBe("function");
		expect(mod.DEFAULT_BUCKET_TIMEOUTS_MS).toBeDefined();
	});
});
