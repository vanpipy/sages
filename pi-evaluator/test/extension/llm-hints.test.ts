/**
 * pi-evaluator/test/extension/llm-hints.test.ts
 *
 * RED-first: tests fail before src/extension.ts + tools + prompts + skill
 * file all exist and conform, pass after.
 *
 * These tests pin the GC-2026-019 "3-layer LLM hint" contract end-to-end:
 *
 *   Layer 1: every registered tool's `description` is detailed enough to
 *            give the LLM a useful mental model.
 *   Layer 2: skills/evaluator/SKILL.md exists with required content.
 *   Layer 3: REWARD_MODE_SYSTEM_PROMPT constant is non-empty and mentions
 *            both tools + the evidence field.
 *
 * Plus an integration test: when mode is on, the registered tools + the
 * `before_agent_start` handler cooperate to actually deliver the augmented
 * system prompt + the working tools, so the LLM has both the descriptive
 * hint AND the actionable prompt annotation simultaneously.
 */

import { describe, expect, test } from "bun:test";

import { makeEvalScoreTool } from "../../src/tools/eval-score.ts";
import { makeEvalTrendTool } from "../../src/tools/eval-trend.ts";
import { REWARD_MODE_SYSTEM_PROMPT } from "../../src/prompts.ts";
import { createEvalState } from "../../src/state.ts";

const REQUIRED_EVAL_SCORE_WORDS = ["score", "dimension", "evidence"];
const REQUIRED_EVAL_TREND_WORDS = ["trend", "percentile", "historical"];

function hasAll(text: string, words: string[]): boolean {
	const lower = text.toLowerCase();
	return words.every((w) => lower.includes(w.toLowerCase()));
}

describe("Layer 1: tool descriptions", () => {
	test("eval_score description is detailed (≥100 chars) and mentions score/dimension/evidence", () => {
		const tool = makeEvalScoreTool(createEvalState());
		expect(tool.description.length).toBeGreaterThanOrEqual(100);
		expect(hasAll(tool.description, REQUIRED_EVAL_SCORE_WORDS)).toBe(true);
	});

	test("eval_trend description is detailed (≥100 chars) and mentions trend/percentile/historical", () => {
		const tool = makeEvalTrendTool(createEvalState());
		expect(tool.description.length).toBeGreaterThanOrEqual(100);
		expect(hasAll(tool.description, REQUIRED_EVAL_TREND_WORDS)).toBe(true);
	});

	test("eval_score description mentions it takes no arguments (LLM hint)", () => {
		const tool = makeEvalScoreTool(createEvalState());
		const lower = tool.description.toLowerCase();
		expect(lower).toMatch(/no arguments|no parameters|takes no/);
	});

	test("eval_trend description mentions it takes no arguments (LLM hint)", () => {
		const tool = makeEvalTrendTool(createEvalState());
		const lower = tool.description.toLowerCase();
		expect(lower).toMatch(/no arguments|no parameters|takes no/);
	});

	test("eval_score description mentions the 5 dimensions", () => {
		const tool = makeEvalScoreTool(createEvalState());
		const lower = tool.description.toLowerCase();
		expect(lower).toContain("goal");
		expect(lower).toContain("dag");
		expect(lower).toContain("implement");
		expect(lower).toContain("audit");
		expect(lower).toContain("coordination");
	});
});

describe("Layer 2: skill file", () => {
	test("skill file shipped at known path", async () => {
		const fs = await import("node:fs");
		const path = await import("node:path");
		const SKILL = path.join(import.meta.dir, "..", "..", "skills", "evaluator", "SKILL.md");
		expect(fs.existsSync(SKILL)).toBe(true);
		const content = fs.readFileSync(SKILL, "utf8");
		expect(content.length).toBeGreaterThan(0);
		expect(content).toContain("eval_score");
		expect(content).toContain("eval_trend");
	});
});

describe("Layer 3: system prompt constant", () => {
	test("REWARD_MODE_SYSTEM_PROMPT is non-empty and mentions both tools + evidence field", () => {
		expect(REWARD_MODE_SYSTEM_PROMPT.length).toBeGreaterThanOrEqual(200);
		expect(REWARD_MODE_SYSTEM_PROMPT).toContain("eval_score");
		expect(REWARD_MODE_SYSTEM_PROMPT).toContain("eval_trend");
		expect(REWARD_MODE_SYSTEM_PROMPT).toContain("evidence");
	});
});

describe("Integration: 3 layers cooperate end-to-end (mode ON)", () => {
	test("mode-ON scenario: tools work, prompt is augmented, descriptions are rich", async () => {
		// Build the same wiring the extension does, but with a fake pi.
		const { default: registerEvaluatorExtension } = await import("../../src/extension.ts");
		const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
		const tools: Array<{ name: string; description: string }> = [];
		const fakePi = {
			on(event: string, h: (...args: unknown[]) => unknown) {
				const arr = handlers.get(event) ?? [];
				arr.push(h);
				handlers.set(event, arr);
			},
			registerTool(tool: { name: string; description: string }) {
				tools.push(tool);
			},
		};

		// Process the registration.
		registerEvaluatorExtension(fakePi as unknown as Parameters<typeof registerEvaluatorExtension>[0]);

		// Simulate session_start with rewardMode=true via env override.
		const fs = await import("node:fs");
		const os = await import("node:os");
		const path = await import("node:path");
		const fakeHome = path.join(os.tmpdir(), `pi-eval-llm-hints-${Date.now()}`);
		fs.mkdirSync(path.join(fakeHome, ".pi", "agent"), { recursive: true });
		fs.writeFileSync(
			path.join(fakeHome, ".pi", "agent", "settings.json"),
			JSON.stringify({ sages: { rewardMode: true } }),
			"utf8",
		);
		const originalHome = process.env.HOME;
		process.env.HOME = fakeHome;
		try {
			const beforeAgentStart = handlers.get("before_agent_start")!;
			expect(beforeAgentStart.length).toBeGreaterThan(0);

			// First, before session_start, the prompt is not augmented.
			{
				const r = beforeAgentStart[0]!({
					type: "before_agent_start",
					prompt: "hi",
					systemPrompt: "BASE",
				});
				expect(r).toBeUndefined();
			}

			// Fire session_start to flip mode on.
			const sessionStart = handlers.get("session_start")!;
			await sessionStart[0]!({ type: "session_start", reason: "startup" });

			// Now the prompt IS augmented.
			const r2 = beforeAgentStart[0]!({
				type: "before_agent_start",
				prompt: "hi",
				systemPrompt: "BASE",
			});
			expect(r2).toBeDefined();
			const r2obj = r2 as { systemPrompt?: string };
			expect(r2obj.systemPrompt).toContain("BASE");
			expect(r2obj.systemPrompt).toContain(REWARD_MODE_SYSTEM_PROMPT);

			// And both tools are registered with rich descriptions.
			const scoreTool = tools.find((t) => t.name === "eval_score");
			const trendTool = tools.find((t) => t.name === "eval_trend");
			expect(scoreTool).toBeDefined();
			expect(trendTool).toBeDefined();
			expect(scoreTool!.description.length).toBeGreaterThanOrEqual(100);
			expect(trendTool!.description.length).toBeGreaterThanOrEqual(100);
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			fs.rmSync(fakeHome, { recursive: true, force: true });
		}
	});
});
