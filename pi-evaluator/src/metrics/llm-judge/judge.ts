/**
 * pi-evaluator/src/metrics/llm-judge/judge.ts
 *
 * Wires the real `complete()` call from `@mariozechner/pi-ai` into the seam.
 *
 * `defaultJudgeFn` is installed by `registerBuiltinMetrics` (called from
 * extension.ts on session_start). If `getEnvApiKey(provider)` returns
 * undefined, the call throws → seam returns `data_missing:true` → the
 * hybrid metric falls back to its heuristic branch.
 *
 * `parseJudgeReply` is exported as a pure helper so unit tests can exercise
 * it without mocking the LLM. The function tolerates 3 input shapes:
 *   - strict JSON object with score (preferred)
 *   - JSON wrapped in ```json ... ``` markdown fences
 *   - bare `score: <n>` regex match (last resort fallback)
 */
import {
	type Api,
	type AssistantMessage,
	type Context,
	type KnownProvider,
	type Model,
	complete,
	getEnvApiKey,
	getModel,
} from "@mariozechner/pi-ai";
import type { JudgeFn, JudgeFnResult, JudgeInput } from "./seam.ts";

const DEFAULT_PROVIDER = "anthropic" as const;
const DEFAULT_MODEL_ID = "claude-sonnet-4-5" as const;

/**
 * Parses an AssistantMessage's text content into a JudgeFnResult.
 * Tolerates 3 input shapes (strict JSON, fenced JSON, bare score regex).
 * Returns `{ score: 0, rationale: <parse-error> }` on failure.
 */
export function parseJudgeReply(reply: AssistantMessage): JudgeFnResult {
	const text = (reply.content ?? [])
		.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
		.map((c) => c.text)
		.join("");
	if (!text.trim()) {
		return { score: 0, rationale: "empty reply from LLM" };
	}

	// 1. Try strict JSON parse
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && typeof parsed.score === "number") {
			return {
				score: clamp(parsed.score),
				rationale: typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 200) : "",
			};
		}
	} catch {
		// fall through
	}

	// 2. Try fenced JSON (```json ... ```)
	const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
	if (fenceMatch?.[1]) {
		try {
			const parsed = JSON.parse(fenceMatch[1]);
			if (typeof parsed === "object" && parsed !== null && typeof parsed.score === "number") {
				return {
					score: clamp(parsed.score),
					rationale: typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 200) : "",
				};
			}
		} catch {
			// fall through
		}
	}

	// 3. Bare "score: <number>" regex (last resort)
	const scoreMatch = /\bscore\s*[:=]\s*([0-9]*\.?[0-9]+)/i.exec(text);
	if (scoreMatch?.[1]) {
		const n = Number(scoreMatch[1]);
		if (!Number.isNaN(n)) {
			return { score: clamp(n), rationale: text.slice(0, 200) };
		}
	}

	return { score: 0, rationale: `unparseable reply: ${text.slice(0, 100)}` };
}

function clamp(n: number): number {
	return Math.max(0, Math.min(1, n));
}

/**
 * The real LLM-judge function. Reads provider/model from JudgeInput (with
 * defaults), builds a `Context` from the criterion + evidence, calls
 * `complete()` from `@mariozechner/pi-ai`, parses the reply.
 *
 * Throws on missing API key (the seam converts that to `data_missing:true`).
 */
export const defaultJudgeFn: JudgeFn = async (input: JudgeInput): Promise<JudgeFnResult> => {
	const provider = (input.provider ?? DEFAULT_PROVIDER) as KnownProvider;
	const modelId = input.modelId ?? DEFAULT_MODEL_ID;

	const apiKey = getEnvApiKey(provider);
	if (!apiKey) {
		throw new Error(
			`no API key found for provider '${provider}' (set the provider's env var, e.g. ANTHROPIC_API_KEY)`,
		);
	}

	// modelId is loose (user passes any string); getModel requires a literal keyof
	// MODELS[provider] for type-safety. We accept the runtime risk for flexibility.
	const model = getModel(provider as KnownProvider, modelId as never) as unknown as Model<Api>;

	const ctx: Context = {
		systemPrompt: "You are an impartial judge. Reply with JSON only.",
		messages: [
			{
				role: "user" as const,
				content: `Criterion:\n${input.criteria}\n\nEvidence:\n${input.evidence}`,
				timestamp: Date.now(),
			},
		],
	};

	const reply = await complete(model, ctx, { temperature: 0 });
	return parseJudgeReply(reply);
};
