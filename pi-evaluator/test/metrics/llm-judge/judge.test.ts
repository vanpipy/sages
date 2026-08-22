/**
 * test/metrics/llm-judge/judge.test.ts
 *
 * Tests for the LLM-judge infra shipped in T4:
 *   - parseJudgeReply: pure function, 4 input shapes (strict JSON, fenced JSON,
 *     bare score regex, empty/bad input)
 *   - defaultJudgeFn: integration test via bun's mock.module('@mariozechner/pi-ai')
 *   - seam: setJudgeFn/getJudgeFn/clearJudgeFn round-trip + data_missing propagation
 */
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseJudgeReply } from "../../../src/metrics/llm-judge/judge.ts";
import * as seam from "../../../src/metrics/llm-judge/seam.ts";

describe("parseJudgeReply (pure)", () => {
	function msg(text: string): AssistantMessage {
		return { content: [{ type: "text", text }] } as unknown as AssistantMessage;
	}

	test("strict JSON object → score + rationale", () => {
		expect(parseJudgeReply(msg('{"score": 0.82, "rationale": "good coverage"}'))).toEqual({
			score: 0.82,
			rationale: "good coverage",
		});
	});

	test("clips score to [0,1]", () => {
		expect(parseJudgeReply(msg('{"score": 1.5, "rationale": "x"}')).score).toBe(1);
		expect(parseJudgeReply(msg('{"score": -0.3, "rationale": "x"}')).score).toBe(0);
	});

	test("fenced JSON ```json ... ```", () => {
		const reply = msg('```json\n{"score": 0.4, "rationale": "weak"}\n```');
		expect(parseJudgeReply(reply)).toEqual({ score: 0.4, rationale: "weak" });
	});

	test("fenced JSON ```(no language tag) ... ```", () => {
		const reply = msg('```\n{"score": 0.6}\n```');
		expect(parseJudgeReply(reply).score).toBe(0.6);
	});

	test("bare 'score: 0.7' regex fallback", () => {
		expect(parseJudgeReply(msg("Overall score: 0.7 — good plan.")).score).toBe(0.7);
	});

	test("empty text → score 0 + empty-reason rationale", () => {
		expect(parseJudgeReply(msg(""))).toEqual({ score: 0, rationale: "empty reply from LLM" });
		expect(parseJudgeReply({ content: [] } as unknown as AssistantMessage)).toEqual({
			score: 0,
			rationale: "empty reply from LLM",
		});
	});

	test("unparseable reply → score 0 + truncated text in rationale", () => {
		const reply = msg("Just some prose, no number.");
		const r = parseJudgeReply(reply);
		expect(r.score).toBe(0);
		expect(r.rationale.startsWith("unparseable reply:")).toBe(true);
	});

	test("rationale is clipped to 200 chars", () => {
		const long = "x".repeat(500);
		const reply = msg(JSON.stringify({ score: 0.5, rationale: long }));
		expect(parseJudgeReply(reply).rationale.length).toBeLessThanOrEqual(200);
	});
});

describe("seam: setJudgeFn / getJudgeFn / resetJudgeFn", () => {
	beforeEach(() => seam.setJudgeFn(null));
	afterEach(() => seam.setJudgeFn(null));

	test("no judge set → judge() returns data_missing", async () => {
		const r = await seam.judge({ criteria: "x", evidence: "y", from: "llm" });
		expect(r.data_missing).toBe(true);
		expect(r.value).toBe(0);
		expect(r.evidence[0]?.note).toContain("no judge registered");
	});

	test("setJudgeFn installs a custom fn", async () => {
		seam.setJudgeFn(async () => ({ score: 0.9, rationale: "stub" }));
		const r = await seam.judge({ criteria: "x", evidence: "y", from: "llm" });
		expect(r.value).toBe(0.9);
		expect(r.evidence[0]?.note).toBe("stub");
		expect(r.data_missing).toBe(false);
	});

	test("judge fn that throws → data_missing=true + error message", async () => {
		seam.setJudgeFn(async () => {
			throw new Error("API down");
		});
		const r = await seam.judge({ criteria: "x", evidence: "y", from: "llm" });
		expect(r.data_missing).toBe(true);
		expect(r.value).toBe(0);
		expect(r.evidence[0]?.note).toContain("API down");
	});

	test("judge fn returning score outside [0,1] is clamped", async () => {
		seam.setJudgeFn(async () => ({ score: 5, rationale: "x" }));
		const r = await seam.judge({ criteria: "x", evidence: "y", from: "llm" });
		expect(r.value).toBe(1);
	});
});

describe("defaultJudgeFn integration (mocked pi-ai)", () => {
	afterEach(() => {
		seam.setJudgeFn(null);
		mock.restore();
	});

	test("calls complete() with right model + context, returns parsed score", async () => {
		const completeCalls: unknown[] = [];
		mock.module("@mariozechner/pi-ai", () => ({
			complete: async (_model: unknown, ctx: unknown) => {
				completeCalls.push(ctx);
				return { content: [{ type: "text", text: '{"score": 0.77, "rationale": "ok"}' }] };
			},
			getModel: (_provider: string, modelId: string) => ({ id: modelId, provider: "stub" }),
			getEnvApiKey: (provider: string) => `${provider.toUpperCase()}_API_KEY`,
		}));
		// Dynamic re-import after mock
		const { defaultJudgeFn } = await import("../../../src/metrics/llm-judge/judge.ts");
		const r = await defaultJudgeFn({
			criteria: "is X complete?",
			evidence: "X is 80% done",
			from: "llm",
		});
		expect(r.score).toBe(0.77);
		expect(r.rationale).toBe("ok");
		expect(completeCalls.length).toBe(1);
	});

	test("missing API key → throws (seam converts to data_missing)", async () => {
		mock.module("@mariozechner/pi-ai", () => ({
			complete: async () => ({ content: [{ type: "text", text: "x" }] }),
			getModel: () => ({ id: "x" }),
			getEnvApiKey: () => undefined,
		}));
		const { defaultJudgeFn } = await import("../../../src/metrics/llm-judge/judge.ts");
		expect(
			defaultJudgeFn({ criteria: "x", evidence: "y", from: "llm" }),
		).rejects.toThrow(/no API key/i);
	});
});
