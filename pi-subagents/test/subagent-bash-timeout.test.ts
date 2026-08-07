/**
 * subagent-bash-timeout.test.ts — GC-2026-038 T5
 *
 * Verifies the bash-timeout-guard prompt text exists in all 4 prompts
 * with the per-bucket timeouts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PROMPTFiles = [
	"developer.ts",
	"auditor.ts",
	"explore.ts",
	"plan.ts",
] as const;

function readPrompt(name: string): string {
	return readFileSync(
		join(import.meta.dirname, "../src/agent-prompts", name),
		"utf8",
	);
}

describe("subagent bash timeout guard (GC-2026-038 T5)", () => {
	for (const name of PROMPTFiles) {
		it(`T-BASH-${name}: ${name} contains the bash timeout guard section`, () => {
			const text = readPrompt(name);
			expect(text).toContain("Bash Timeout Guard");
		});

		it(`T-BASH-${name}-read: ${name} pins a 5s read timeout`, () => {
			const text = readPrompt(name);
			expect(text).toMatch(/read.*5s|read.*5 s/);
		});

		it(`T-BASH-${name}-network: ${name} pins a 5s network fail-fast`, () => {
			const text = readPrompt(name);
			expect(text).toMatch(/network.*5s|network.*5 s/);
		});
	}

	it("T-BASH-shared: developer.ts pins full per-bucket table (read 5s, search 10s, test 30s, full-suite 90s, network 5s)", () => {
		const text = readPrompt("developer.ts");
		expect(text).toMatch(/read.*5s/);
		expect(text).toMatch(/search.*10s/);
		expect(text).toMatch(/test.*30s/);
		expect(text).toMatch(/90s/);
		expect(text).toMatch(/network.*5s/);
	});
});
