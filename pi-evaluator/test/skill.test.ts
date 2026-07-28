/**
 * pi-evaluator/test/skill.test.ts
 *
 * RED-first: tests fail before `skills/evaluator/SKILL.md` exists, pass after.
 *
 * The skill file is the SECOND layer of the 3-layer LLM hint contract.
 * It is auto-loaded by pi at extension startup (`pi.skills: ["./skills"]`
 * in package.json picks up `skills/evaluator/SKILL.md`).
 *
 * Required sections per GC-2026-019 spec:
 *   - title with "Sages" or "Reward Mode"
 *   - section explaining when reward mode is on
 *   - section explaining when to call each tool
 *   - section explaining output shape of each tool
 *   - section explaining score-0 vs no-data convention
 *   - section pointing developer to the live jsonl + report md path
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_PATH = join(import.meta.dir, "..", "skills", "evaluator", "SKILL.md");

function loadSkill(): string {
	if (!existsSync(SKILL_PATH)) return "";
	return readFileSync(SKILL_PATH, "utf8");
}

describe("skills/evaluator/SKILL.md", () => {
	test("exists at the expected path", () => {
		expect(existsSync(SKILL_PATH)).toBe(true);
	});

	test("is non-empty", () => {
		const content = loadSkill();
		expect(content.length).toBeGreaterThan(0);
	});

	test("identifies as a Sages skill", () => {
		const content = loadSkill().toLowerCase();
		expect(content).toMatch(/sages|reward mode/);
	});

	test("mentions both eval_score and eval_trend", () => {
		const content = loadSkill();
		expect(content).toContain("eval_score");
		expect(content).toContain("eval_trend");
	});

	test("documents when reward mode is on (settings.json hint)", () => {
		const content = loadSkill();
		expect(content).toMatch(/rewardMode/);
	});

	test("documents score 0 vs no-data distinction", () => {
		const content = loadSkill().toLowerCase();
		// Must distinguish score=0 with empty evidence vs score=0 with evidence
		expect(content).toContain("score");
		expect(content).toMatch(/not yet observed|not observed|truly|haven|has been/);
	});

	test("points developer at .pi/orchestrator/evals/ paths", () => {
		const content = loadSkill();
		expect(content).toMatch(/\.pi\/orchestrator\/evals/);
	});

	test("documents percentiles and trend for eval_trend", () => {
		const content = loadSkill().toLowerCase();
		expect(content).toContain("percentile");
		expect(content).toContain("trend");
	});
});
