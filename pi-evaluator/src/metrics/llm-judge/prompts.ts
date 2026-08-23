/**
 * pi-evaluator/src/metrics/llm-judge/prompts.ts
 *
 * Prompt templates for the LLM-judge. Kept in a separate file so they can be
 * tweaked without re-touching the wiring layer (judge.ts).
 *
 * The judge is asked for a 0-1 score + rationale. Output is parsed as JSON;
 * `parseJudgeReply` in judge.ts handles schema drift (fallback to 0 on bad
 * JSON, with a warning note in the evidence array).
 */

export const JUDGE_SYSTEM_PROMPT = `You are an impartial judge of an AI agent's output.

Score the evidence below on the criterion. Return a JSON object with two fields:
- "score": a number in [0, 1] where 0 = completely fails the criterion, 1 = perfectly satisfies
- "rationale": a single-sentence justification (max 200 chars)

Return ONLY the JSON object. No prose, no markdown fences.

CRITERION:
{CRITERIA}

EVIDENCE:
{EVIDENCE}`;

/** Build a Context-ready user message from a judge invocation. */
export function buildJudgeUserMessage(input: {
	criteria: string;
	evidence: string;
}): { role: "user"; content: string; timestamp: number } {
	const prompt = JUDGE_SYSTEM_PROMPT.replace("{CRITERIA}", input.criteria).replace(
		"{EVIDENCE}",
		input.evidence,
	);
	return { role: "user", content: prompt, timestamp: Date.now() };
}
