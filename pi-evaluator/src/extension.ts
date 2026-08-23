/**
 * pi-evaluator/src/extension.ts
 *
 * Default pi extension entrypoint. Loaded by pi when it resolves the
 * `@sages/pi-evaluator` package.
 *
 * Wires up:
 *   - The 2 reward mode tools (eval_score, eval_trend)
 *   - `session_start` event: read `~/.pi/agent/settings.json` and set mode
 *   - `before_agent_start` event: when mode is on, append the reward mode
 *     system-prompt augmentation to the original system prompt
 *   - `tool_call` event: when any of the 4 Sages orchestrator tools
 *     (goal_contract_create, dag_synthesize, task_dispatch, orchestrator_audit)
 *     is invoked, set state.active_workflow_path + state.active_workflow_id so
 *     the lazy eval-score self-cook path has a target (T1b).
 *
 * Mode is read ONCE per session (`session_start`) and is constant for the
 * session's lifetime. Hot-switch via `/reward` etc. is OUT OF SCOPE for T2
 * (explicit GC-2026-019 anti-goal).
 *
 * The `tool_call` listener is intentionally narrow — it only fires for the
 * 4 orchestrator tools and only writes to `state.active_workflow_*` fields.
 * It does not read session.jsonl, does not write to `.pi/orchestrator/`, and
 * does not trigger evaluation on its own (lazy path fires on the next
 * `eval_score` invocation).
 */

import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { readSagesRewardMode } from "./settings.ts";
import { REWARD_MODE_SYSTEM_PROMPT } from "./prompts.ts";
import { createEvalState, reloadCoefficients } from "./state.ts";
import { registerEvalTools, type HistoricalReport } from "./tools/index.ts";

/** Set of Sages orchestrator tool names whose invocations update eval state. */
const ORCHESTRATOR_TOOL_NAMES = new Set([
	"goal_contract_create",
	"dag_synthesize",
	"task_dispatch",
	"orchestrator_audit",
]);

interface OrchestratorToolCallEventLike {
	type?: string;
	toolName?: string;
	input?: Record<string, unknown>;
}

/**
 * Pull the workflow id out of a tool_call's input. Each of the 4 orchestrator
 * tools uses a different field name (goal_contract_create.id,
 * dag_synthesize.goal_id, task_dispatch.dag_id, orchestrator_audit.dag_id),
 * so we probe all four candidates and return the first match.
 */
function extractWorkflowId(toolName: string, input: Record<string, unknown>): string | undefined {
	if (toolName === "goal_contract_create") {
		return typeof input.id === "string" ? input.id : undefined;
	}
	if (toolName === "dag_synthesize") {
		return typeof input.goal_id === "string" ? input.goal_id : undefined;
	}
	// task_dispatch + orchestrator_audit both use dag_id.
	if (typeof input.dag_id === "string") return input.dag_id;
	return undefined;
}

/**
 * Default pi extension entrypoint.
 *
 * Called by pi exactly once per session, with the ExtensionAPI. We:
 *   1. Create the state container (initially mode=off, no active workflow).
 *   2. Register the 2 eval tools (evaluator side).
 *   3. Subscribe to `session_start` to read the reward mode at session boot.
 *   4. Subscribe to `before_agent_start` to append the reward-mode prompt
 *      suffix when mode is on.
 *
 * T3 will extend step 3/4 to capture orchestration events.
 */
export default function registerEvaluatorExtension(pi: ExtensionAPI): void {
	const state = createEvalState();

	// T2 ships an empty historical feed. T3 will replace this with a disk
	// loader that reads `.pi/orchestrator/evals/report-*.json`.
	const historical: HistoricalReport[] = [];

	// Tool registration — order independent.
	registerEvalTools(pi, state, historical);

	// ── session_start: read mode exactly once per session ──────────────────
	pi.on("session_start", () => {
		state.mode = readSagesRewardMode() ? "on" : "off";
		// Re-load coefficients at session start so edits to the user's file
		// during the previous session's lifetime are picked up. The loader is
		// best-effort — a malformed file falls back to built-in defaults
		// rather than crashing the session (reward mode is opt-in).
		reloadCoefficients(state);
	});

	// ── before_agent_start: augment the system prompt when mode is on ───────
	// Returning a partial `BeforeAgentStartEventResult` from a handler is the
	// canonical way to extend the system prompt for one turn. pi chains
	// multiple extensions' results together.
	pi.on("before_agent_start", (event: any) => {
		if (state.mode !== "on") return;
		const original: string = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
		return {
			systemPrompt: `${original}\n\n${REWARD_MODE_SYSTEM_PROMPT}`,
		};
	});

	// ── tool_call: track active workflow for lazy eval-score self-cook ──────
	// Only fires for the 4 Sages orchestrator tools. Updates state.active_workflow_path
	// (always `<cwd>/.pi/orchestrator`) and state.active_workflow_id (per-tool field).
	// No-ops when mode is off or when the input doesn't contain a recognizable id.
	pi.on("tool_call", (event: OrchestratorToolCallEventLike, ctx?: { cwd?: string }) => {
		if (state.mode !== "on") return;
		if (event?.type !== "tool_call") return;
		const toolName = typeof event.toolName === "string" ? event.toolName : "";
		if (!ORCHESTRATOR_TOOL_NAMES.has(toolName)) return;
		const input = event.input && typeof event.input === "object" ? event.input : {};
		const workflowId = extractWorkflowId(toolName, input);
		if (!workflowId) return;
		const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
		state.active_workflow_path = join(cwd, ".pi", "orchestrator");
		state.active_workflow_id = workflowId;
	});
}
