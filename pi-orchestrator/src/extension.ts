/**
 * @sages/pi-orchestrator — package entry point (default pi extension).
 *
 * Post the orchestrator-simplify + remove-workflow-run-prod +
 * decompose-task-removed + remove-goal-contract + remove-orchestrator-advisory
 * + drop-failure-catalog + iterative-intent-plan cascades the package
 * owns six LLM-facing tools (`task_inspect`, `task_consume`,
 * `task_convert_intent`, `task_plan_intent`, `task_add_phase`,
 * `task_close_intent` — see `./orchestrator-tool.ts`) and a thin
 * session-hook layer + a brainstorming slash command:
 *
 *   - session_start: `pi.setActiveTools([...])` gates which tools the
 *     LLM can see. pi's `setActiveTools` REPLACES the active tool set,
 *     so the array must contain every tool the orchestrator registers
 *     itself (the six in `ORCHESTRATOR_TOOL_NAMES`) plus the peer-owned
 *     families it curates (PI_TASKS / PI_SUBAGENT / SUBAGENT_CONTROL /
 *     AFT / BASELINE / PI_ROUTINES).
 *   - before_agent_start: prepend `templates/SYSTEM.md` (the orchestrator
 *     constitution) to the LLM system prompt.
 *   - tool_call: once-per-session soft-mode reminder that fires on the
 *     first side-effecting call (bash / edit / write).
 *   - brainstorming slash command (registered via the skill at
 *     `skills/brainstorming/SKILL.md`).
 *
 * The orchestrator exports a curated tool allowlist + soft-mode reminder
 * + system-prompt overlay + the six consumer tools above. The LLM
 * can drive any multi-stage work via raw `TaskCreate` × N +
 * `TaskExecute` directly; for the standard 2-phase (Implement + Review)
 * intent task the structured `task_convert_intent(plan)` collapses the
 * `TaskCreate` × N into one call (with shape-validated `intent_shape` +
 * `rationale` + `phases[]`), and the iterative
 * `task_plan_intent` + `task_add_phase` × N + `task_close_intent`
 * triplet does the same one-phase-at-a-time.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ORCHESTRATOR_TOOL_NAMES, registerOrchestratorTools } from "./orchestrator-tool.js";

/**
 * Tools registered by `@sages/pi-subagents` (`pi-subagents/src/index.ts`
 * lines 1154, 2040, 2138). `pi-subagents` owns the dispatch surface:
 * spawn an agent (`Agent`), poll its result (`get_subagent_result`),
 * inject a message into a running session (`steer_subagent`).
 */
export const PI_SUBAGENT_TOOLS = [
	"Agent",
	"get_subagent_result",
	"steer_subagent",
] as const;

/**
 * Subagent-control tool NAMES — the orchestrator's constant is purely
 * for `setActiveTools` filtering; it does NOT register anything.
 *
 * GC-2026-boundary-subagent-control moved the registration out of the
 * orchestrator and into `@sages/pi-subagents`. That implementation was
 * subsequently removed from pi-subagents by `a36ae68` (2026-10-11,
 * "chore sync upstream") along with its test file; `pi-subagents/src/`
 * today registers no `subagent_*` tool. pi's `setActiveTools` silently
 * drops names that are not in the tool registry, so these four are
 * currently NOT live — the model sees no such tool and any call fails
 * with "Tool <name> not found".
 *
 * The names are retained here so the allowlist is ready for a future
 * re-registration, but the prompt layer must not advertise them until
 * that happens. See the prompt-refactor design doc, open decision D7
 * (restore the control tools vs. retire the capability).
 */
export const SUBAGENT_CONTROL_TOOLS = [
	"subagent_status",
	"subagent_steer",
	"subagent_abort",
	"subagent_resume",
] as const;

/**
 * Combined subagent toolset passed to `pi.setActiveTools` at
 * `session_start`.
 */
export const SUBAGENT_TOOLS: readonly string[] = [
	...PI_SUBAGENT_TOOLS,
	...SUBAGENT_CONTROL_TOOLS,
];

/**
 * Baseline file-system tools the main agent always needs regardless
 * of profile.
 */
export const BASELINE_TOOLS: readonly string[] = [
	"bash",
	"read",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
];

/**
 * Pi-tasks tools (registered by `@sages/pi-tasks`). Exposed so the LLM
 * can drive the Implement → Review pipeline directly via TaskCreate /
 * TaskList / TaskExecute / etc.
 */
export const PI_TASKS_TOOLS: readonly string[] = [
	"TaskCreate",
	"TaskList",
	"TaskGet",
	"TaskUpdate",
	"TaskOutput",
	"TaskStop",
	"TaskExecute",
];

/**
 * AFT (Agentic File Tools) suite registered by `@cortexkit/aft-pi` at
 * extension boot. Eleven tools.
 */
export const AFT_TOOLS: readonly string[] = [
	"aft_callgraph",
	"aft_conflicts",
	"aft_delete",
	"aft_import",
	"aft_inspect",
	"aft_move",
	"aft_outline",
	"aft_refactor",
	"aft_safety",
	"aft_search",
	"aft_zoom",
];

/**
 * pi-routines (SAGES sage peer — fork of `@davecodes/pi-routines@0.6.0`;
 * see `pi-routines/SAGES-FORK.md` for lineage) tools. Six tools, all
 * optional — the Sages orchestrator allowlist includes them, but if
 * pi-routines isn't installed the LLM simply sees the names and the
 * runtime reports "tool not registered" when called. This graceful
 * degradation matches the soft-mode contract: missing extensions don't
 * break the session, they just lose capability.
 *
 * The Sages board-watch routine (bundled at
 * `templates/sages-routines/sages-board-watch.json`, installed AND
 * activated by `scripts/install.sh` — the routine entry is written
 * into `state.json` atomically as part of the install) drives a
 * periodic pulse that wakes the LLM to route out-of-turn task
 * additions (case 2/3 from the awareness RFC). To opt out:
 * `/routine-stop sages-board-watch`.
 */
export const PI_ROUTINES_TOOLS: readonly string[] = [
	"routine_create",
	"routine_list",
	"routine_delete",
	"routine_run_now",
	"routine_set_state",
	"routine_get_state",
];

/**
 * Soft-mode reminder text. Fires once per session on the first side-effecting
 * tool call (bash / edit / write) to nudge the LLM toward the
 * pi-tasks-driven workflow when the active task list exceeds 2 items.
 */
const SOFT_MODE_REMINDER = `> ⚙️ **SOFT MODE — workflow pipeline recommended**
>
> If this is part of a larger workflow (>2 items in your active task list,
> i.e. above the **task-count threshold**), consider driving it through
> the pi-tasks workflow: raw \`TaskCreate\` × N (one per phase: Developer
> for Implement, Reviewer for Review) → \`TaskExecute\`. For the
> standard 2-phase shape on an intent task, the
> \`task_convert_intent(plan)\` tool collapses both \`TaskCreate\` calls
> into one (with shape-validated \`intent_shape\` + \`rationale\` +
> \`phases[]\`). For complex goals (multi-phase / multi-track /
> investigate-then-fix) prefer the iterative flow:
> \`task_plan_intent\` + \`task_add_phase\` × N + \`task_close_intent\`,
> which lets you commit the plan one phase at a time. For ≤2 tasks
> (below the task-count threshold), direct handling is acceptable.
> This is a recommendation — the agent decides. No commands are blocked.
`;

/**
 * Path to `templates/SYSTEM.md` — the orchestrator constitution that
 * gets prepended to the LLM's system prompt on every agent start.
 */
const SYSTEM_PROMPT_TEMPLATE = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"templates",
	"SYSTEM.md",
);



/**
 * Install the three session-level hooks.
 */
export function installSessionHooks(pi: ExtensionAPI): void {
	// 1. session_start — setActiveTools + setStatus.
	pi.on("session_start", () => {
		const tools: string[] = [
			// The orchestrator's OWN tools. pi's setActiveTools replaces the
			// active set, so omitting these makes them invisible to the
			// model even though they are registered. See
			// ORCHESTRATOR_TOOL_NAMES in ./orchestrator-tool.ts.
			...ORCHESTRATOR_TOOL_NAMES,
			...PI_TASKS_TOOLS,
			...SUBAGENT_TOOLS,
			...AFT_TOOLS,
			...BASELINE_TOOLS,
			...PI_ROUTINES_TOOLS,
		];
		pi.setActiveTools(tools);
		(pi as unknown as {
			setStatus?: (key: string, text: string) => void;
		}).setStatus?.("sages-orchestrator", "📜 orchestrator active");
	});

	// 2. before_agent_start — prepend templates/SYSTEM.md.
	pi.on("before_agent_start", (event: unknown) => {
		if (!existsSync(SYSTEM_PROMPT_TEMPLATE)) return undefined;
		const overlay = readFileSync(SYSTEM_PROMPT_TEMPLATE, "utf-8");
		const systemPrompt =
			typeof event === "object" && event !== null && "systemPrompt" in event
				? (event as { systemPrompt?: string }).systemPrompt
				: undefined;
		return {
			systemPrompt: overlay + "\n\n---\n\n" + (systemPrompt ?? ""),
		};
	});

	// 3. tool_call — fire the soft-mode reminder once per session on the
	// first side-effecting tool call (bash / edit / write).
	let reminderFired = false;
	pi.on("tool_call", (event: unknown) => {
		if (reminderFired) return undefined;
		const toolName =
			typeof event === "object" && event !== null && "toolName" in event
				? (event as { toolName?: string }).toolName
				: undefined;
		if (toolName !== "bash" && toolName !== "edit" && toolName !== "write") return undefined;
		reminderFired = true;
		pi.appendEntry("system", SOFT_MODE_REMINDER);
		return undefined;
	});
}

/**
 * Default pi extension entrypoint. Wires the three session hooks:
 * session_start / before_agent_start / tool_call. Also registers the
 * orchestrator's six LLM-facing consumer tools (`task_inspect`,
 * `task_consume`, `task_convert_intent`, `task_plan_intent`,
 * `task_add_phase`, `task_close_intent`).
 *
 * The orchestrator is a consumer of the task flow, not its manager —
 * it adds tasks via pi-tasks's `TaskCreate` (with `type` set to
 * "intent" or "plan"), reads via `TaskList` / `TaskGet`, and dispatches
 * via `TaskExecute`. The orchestrator's six tools add: routing on the
 * read side (`task_inspect`), verdict parsing on completion
 * (`task_consume`), and intent → plan conversion on the write side
 * (`task_convert_intent` atomic + the `task_plan_intent` /
 * `task_add_phase` / `task_close_intent` iterative trio that lets the
 * LLM commit one phase at a time).
 */
export default function registerOrchestratorExtension(pi: ExtensionAPI): void {
	installSessionHooks(pi);
	registerOrchestratorTools(pi);
}