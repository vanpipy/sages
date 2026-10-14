/**
 * skills-orchestrator-decomposition.test.ts — content pin for the
 * "Designing the plan — quick reference" section in
 * `pi-orchestrator/skills/orchestrator/SKILL.md`.
 *
 * The methodology lives in the schema (`src/orchestrator-tool.ts` +
 * `src/phase-validation.ts`), NOT in this SKILL.md section. The
 * SKILL.md is a thin reference. These tests pin only the structural
 * shape of the reference (presence of the shape catalog, the
 * PHASE_AGENT_TYPE table, the canonical example, the source-of-truth
 * pointer) — they do NOT pin exact prose. Any contributor who edits
 * prose freely should still see the section heading + tables +
 * example + pointer, and these tests should still pass.
 *
 * Run: `cd pi-orchestrator && bun test ./test/skills-orchestrator-decomposition.test.ts`
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_MD = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../skills/orchestrator/SKILL.md",
);

function load(): string {
	return readFileSync(SKILL_MD, "utf8");
}

describe("orchestrator SKILL.md — plan quick reference", () => {
	it("exists and is readable", () => {
		const md = load();
		expect(md.length).toBeGreaterThan(0);
	});

	it("includes the 'Designing the plan — quick reference' heading", () => {
		const md = load();
		expect(md).toMatch(/^##\s+Designing the plan — quick reference$/m);
	});

	it("contains the shape catalog with all 6 intent_shapes", () => {
		const md = load();
		for (const shape of [
			"trivial",
			"small",
			"standard",
			"investigate-then-fix",
			"multi-phase",
			"multi-track",
		]) {
			expect(md).toContain(shape);
		}
	});

	it("contains the PHASE_AGENT_TYPE table mapping every phase", () => {
		const md = load();
		expect(md).toMatch(/PHASE_AGENT_TYPE/);
		for (const phase of ["investigate", "design", "implement", "test", "review"]) {
			expect(md).toContain(phase);
		}
		// The mapping row for review → Reviewer. Markdown table cells are
		// wrapped in backticks, so allow backticks around the names.
		expect(md).toMatch(/`?review`?\s*\|\s*`?Reviewer`?/);
	});

	it("contains one worked example showing the structured plan shape", () => {
		const md = load();
		// Section heading: "Worked example — `standard` shape" — the regex
		// must allow the backtick between 'standard' and 'shape'.
		expect(md).toMatch(/Worked example.*standard.*shape/i);
		expect(md).toMatch(/task_convert_intent\(/);
		expect(md).toMatch(/intent_shape:/);
		expect(md).toMatch(/rationale:/);
		expect(md).toMatch(/phases:\s*\[/);
	});

	it("does NOT document the legacy free-form plan[] shape", () => {
		// The old shape was a bare array of {subject, agentType, ...}.
		// The new shape is a structured { intent_shape, rationale, phases } object.
		const md = load();
		expect(md).not.toMatch(/agentType:\s*"Developer"/);
		expect(md).not.toMatch(/agentType:\s*"Reviewer"/);
	});

	it("points readers at the source-of-truth (src/phase-validation.ts)", () => {
		const md = load();
		expect(md).toMatch(/src\/phase-validation\.ts/);
	});

	it("flags the validation-rejected anti-patterns explicitly", () => {
		const md = load();
		expect(md).toMatch(/### Anti-patterns the validation rejects/);
		expect(md).toMatch(/Over-decomposition/);
		expect(md).toMatch(/Under-decomposition/);
		expect(md).toMatch(/Wrong first phase/);
		expect(md).toMatch(/Missing Reviewer on production code/);
	});

	it("section sits AFTER 'The LLM\\'s responsibility' and BEFORE 'Soft mode (unchanged)'", () => {
		const md = load();
		const respIdx = md.search(/^##\s+The LLM's responsibility$/m);
		const tplIdx = md.search(/^##\s+Designing the plan — quick reference$/m);
		const softIdx = md.search(/^##\s+Soft mode$/m);
		expect(respIdx).toBeGreaterThan(-1);
		expect(tplIdx).toBeGreaterThan(-1);
		expect(softIdx).toBeGreaterThan(-1);
		expect(respIdx).toBeLessThan(tplIdx);
		expect(tplIdx).toBeLessThan(softIdx);
	});

	it("includes the 'Planning methodology — from intent to structured plan' section with all 5 steps", () => {
		const md = load();
		expect(md).toMatch(/^##\s+Planning methodology — from intent to structured plan$/m);

		// The 5-step loop headings.
		expect(md).toMatch(/^####\s+1\.\s+Read the intent/m);
		expect(md).toMatch(/^####\s+2\.\s+Classify/m);
		expect(md).toMatch(/^####\s+3\.\s+Compose/m);
		expect(md).toMatch(/^####\s+4\.\s+Decompose/m);
		expect(md).toMatch(/^####\s+5\.\s+Surface/m);

		// Step 2 must include the shape-classification heuristics table
		// covering all 6 intent_shapes.
		const step2 = md.match(/^####\s+2\.\s+Classify[\s\S]+?(?=^####\s+3\.)/m);
		expect(step2).not.toBeNull();
		const step2Text = step2![0];
		for (const shape of [
			"trivial",
			"small",
			"standard",
			"investigate-then-fix",
			"multi-phase",
			"multi-track",
		]) {
			expect(step2Text).toContain(shape);
		}

		// "When to /brainstorm instead" branch — guards against the
		// methodology becoming a blanket rule that skips brainstorming.
		expect(md).toMatch(/^###\s+When to `\/brainstorm` instead$/m);
		expect(md).toMatch(/\/brainstorm\s+\[request\]/);
	});
});
