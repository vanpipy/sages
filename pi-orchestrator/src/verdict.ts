/**
 * verdict.ts — verdict parsing + follow-up suggestion helpers.
 *
 * Small standalone helpers used by `task_consume` and the orchestrator's
 * other read-side tools. No state, no class — just pure functions over
 * the Reviewer's result text.
 *
 * The Reviewer's contract (from `pi-subagents/src/default-agents.ts
 * .get("Reviewer").description`) is to emit a 4-state verdict as plain
 * text in its result. The format is not pinned in the contract, so we
 * accept either:
 *
 *   1. Prefixed form: `verdict: STATE`, `Verdict = STATE`, `**verdict:** STATE`
 *      (case-insensitive; canonical is UPPER_SNAKE but agents may write
 *      mixed case).
 *   2. Standalone line: a line that is just the verdict token, possibly
 *      with surrounding whitespace and `**` markdown emphasis.
 *
 * Both checks anchor the verdict so prose like "Let me clean up the
 * code" or "The code is clean" doesn't false-match.
 */

export type Verdict =
	| "CLEAN"
	| "NEEDS_WORK"
	| "NEEDS_REDESIGN"
	| "NEEDS_CLARIFICATION";

const VERDICTS: readonly Verdict[] = [
	"CLEAN",
	"NEEDS_WORK",
	"NEEDS_REDESIGN",
	"NEEDS_CLARIFICATION",
] as const;

/**
 * Find the verdict in a Reviewer task's result text. Returns undefined
 * when no verdict token appears.
 */
export function parseVerdict(result: string): Verdict | undefined {
	const tokens = "(CLEAN|NEEDS_WORK|NEEDS_REDESIGN|NEEDS_CLARIFICATION)";
	const prefixedRe = new RegExp(`\\bverdict\\s*[:=]\\s*\\*?\\*?${tokens}\\b`, "i");
	const standaloneRe = new RegExp(`^\\s*\\*?\\*?${tokens}\\b\\s*$`, "im");
	const match = result.match(prefixedRe) ?? result.match(standaloneRe);
	if (!match) return undefined;
	const upper = match[1].toUpperCase();
	return VERDICTS.includes(upper as Verdict) ? (upper as Verdict) : undefined;
}

/**
 * Generate a follow-up suggestion tailored to each verdict. The
 * orchestrator uses this as a hint, not a directive — the LLM still
 * makes the final call.
 */
export function suggestFollowUp(verdict: Verdict): string {
	switch (verdict) {
		case "CLEAN":
			return "Phase complete. Move to the next task or declare the goal done.";
		case "NEEDS_WORK":
			return "Spawn a Developer follow-up task with the Reviewer's feedback as its description; set its `blockedBy` to this Review so the chain stays causal.";
		case "NEEDS_REDESIGN":
			return "The approach is wrong, not just the execution. Spawn a new Implement task rather than a fix — `blockedBy` this review so the chain documents the redirect.";
		case "NEEDS_CLARIFICATION":
			return "Pause and surface the Reviewer's questions to the user before continuing. Do not spawn follow-up work until the user answers.";
	}
}