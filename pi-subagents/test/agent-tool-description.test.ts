/**
 * agent-tool-description.test.ts — Pin the prompt wording.
 *
 * GC-2026-014 follow-up: the Anthropic-specific fuzzy names "haiku" /
 * "sonnet" should not appear in the Agent tool description that the LLM
 * reads — they prime the LLM to emit those exact strings, which then fail
 * to resolve on a non-Anthropic registry (e.g. minimax-cn/minimax-cn).
 * The new wording is generic ("any substring of a registered id") and
 * points the LLM at the parent session's model as the default.
 *
 * Two surfaces need to drop the haiku/sonnet examples:
 *
 *   - `pi/templates/agent-tool-description.md:73` — the `toolDescriptionMode:
 *     "custom"` copy (file is installed to ~/.pi/agent/ by install.sh).
 *   - `pi-subagents/src/index.ts:1046 + 1141-1144` — the default "full"
 *     description rendered when `toolDescriptionMode` is not custom.
 *
 * `install.test.sh` deliberately pins `model: "anthropic/claude-haiku-4-5"`
 * inside `default-agents.ts` because the **default Explore agent** is
 * *intentionally* pinned to a cheap model id (a documented exception,
 * not the prompt wording we're changing here). This test only checks the
 * prompt surfaces, not the agent config pin.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Resolve the repo root from cwd (the repo layout has `pi/` and `pi-subagents/`
 * side-by-side). Tests use this so the repo works regardless of whether
 * Vitest is invoked from `pi-subagents/` or the project root.
 */
function repoRoot(): string {
	return join(import.meta.dirname, "..", "..");
}

describe("agent-tool-description.md (custom mode template)", () => {
	const templatePath = join(
		repoRoot(),
		"pi",
		"templates",
		"agent-tool-description.md",
	);

	it("exists and is readable", () => {
		// Sanity check — a broken path would be a setup error rather than a
		// wording regression.
		expect(readFileSync(templatePath, "utf-8").length).toBeGreaterThan(0);
	});

	it("does NOT advertise 'haiku' / 'sonnet' as fuzzy model examples", () => {
		// The original line:  `- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").`
		// The new wording redirects to "any substring of a registered id" and points at the parent session's model.
		// We assert that neither the Anthropic-fuzzy examples ("haiku", "sonnet")
		// nor their code-local references survive in this template. We allow
		// "haiku"/"sonnet" to appear in unrelated prose (e.g. the developer
		// prompt discussing Anthropic pricing) — this test is surgical.
		const text = readFileSync(templatePath, "utf-8");
		const linesWithHaikuOrSonnet = text
			.split("\n")
			.filter((line) => /\bhaiku\b/i.test(line) || /\bsonnet\b/i.test(line));
		// The bug surface is the *Example* wording. Print the offending lines for
		// debugging when the assertion trips.
		expect(
			linesWithHaikuOrSonnet,
			`agent-tool-description.md must not contain haiku/sonnet examples — found:\n${linesWithHaikuOrSonnet.join("\n")}`,
		).toEqual([]);
	});
});

describe("index.ts (full mode description + model parameter schema)", () => {
	const indexPath = join(repoRoot(), "pi-subagents", "src", "index.ts");

	it("does NOT contain haiku/sonnet fuzzy examples in the tool description or model param schema", () => {
		// The prompt surfaces live in two places: the prose `description`
		// (line ~1046) and the TypeBox model param description (line ~1144).
		// We scan the whole file but ONLY assert against the two specific
		// landmark strings so a future contributor adding a different code
		// comment about Anthropic pricing doesn't get flagged here.
		const text = readFileSync(indexPath, "utf-8");

		// Locate the landmark regions by searching for their unique anchors.
		const descriptionStart = text.indexOf(
			"Use model to specify a different model",
		);
		expect(
			descriptionStart,
			"tool description landmark not found in index.ts",
		).toBeGreaterThanOrEqual(0);
		const descriptionChunk = text.slice(
			descriptionStart,
			descriptionStart + 500,
		);
		expect(
			descriptionChunk,
			"the Agent tool description still lists haiku/sonnet as fuzzy examples",
		).not.toMatch(/\bhaiku\b/);
		expect(descriptionChunk).not.toMatch(/\bsonnet\b/);

		const modelParamStart = text.indexOf("Optional model override.");
		expect(
			modelParamStart,
			"model param description landmark not found",
		).toBeGreaterThanOrEqual(0);
		const modelParamChunk = text.slice(modelParamStart, modelParamStart + 500);
		expect(modelParamChunk).not.toMatch(/\bhaiku\b/);
		expect(modelParamChunk).not.toMatch(/\bsonnet\b/);
	});
});

describe("prompt templates: SYSTEM.md + SUBAGENTS.md", () => {
	it("SYSTEM.md Explore row does not mention the legacy 'haiku model' phrasing", () => {
		// Original line:  | `Agent({ subagent_type: "Explore" })` | pi-subagents built-in; fast haiku model |
		// New line:      | `Agent({ subagent_type: "Explore" })` | pi-subagents built-in; fast cheap model from the parent registry (settings.json default) |
		const text = readFileSync(
			join(repoRoot(), "pi", "templates", "SYSTEM.md"),
			"utf-8",
		);
		// We look for the Explore row, then a small window around it.
		const idx = text.indexOf('subagent_type: "Explore"');
		expect(
			idx,
			"Explore row landmark not found in SYSTEM.md",
		).toBeGreaterThanOrEqual(0);
		const chunk = text.slice(idx, idx + 400);
		expect(
			chunk.toLowerCase(),
			"SYSTEM.md Explore row still mentions 'haiku'",
		).not.toContain("haiku");
	});

	it("SUBAGENTS.md Explore roster row does not mention 'Haiku' as the model's identity", () => {
		// Original: | 1     | `Explore` ... | Fast codebase search. Haiku — cheap, fast, **read-only**.        |
		// New:      | 1     | `Explore` ... | cheap, fast, read-only — inherits the parent registry's cheapest available model when dispatched without model=.
		const text = readFileSync(
			join(repoRoot(), "pi", "templates", "SUBAGENTS.md"),
			"utf-8",
		);
		// Locate the roster table by its anchor and slice the table block so
		// earlier `Explore` mentions (e.g. dispatch examples) don't blow up the
		// fixture's window.
		const agentRosterStart = text.indexOf("## Agent Roster");
		expect(
			agentRosterStart,
			"Agent Roster section not found in SUBAGENTS.md",
		).toBeGreaterThanOrEqual(0);
		const rosterBlock = text.slice(agentRosterStart, agentRosterStart + 2000);
		// Locate the Explore roster row. The roster table puts `Haiku —` in
		// the LAST cell (Purpose), so a naive non-greedy `*?` match would stop
		// at the next `|`, miss it, and false-negative the test. Match the
		// full row through end-of-line with `[\s\S]*?(?=\n|$)` so we capture
		// every column cell.
		const exploreRowMatch = rosterBlock.match(
			/^\|\s*1\s*\|\s*`Explore`[\s\S]*?(?=\n|$)/m,
		);
		expect(
			exploreRowMatch,
			"Explore roster row not found in SUBAGENTS.md Agent Roster table",
		).not.toBeNull();
		const exploreRowText = exploreRowMatch![0];
		expect(
			exploreRowText,
			"SUBAGENTS.md Explore roster row still references 'Haiku' or 'Sonnet'",
		).not.toMatch(/\bHaiku\b/);
		expect(exploreRowText).not.toMatch(/\bSonnet\b/);
	});
});
