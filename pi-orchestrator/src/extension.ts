/**
 * @sages/pi-orchestrator — package entry point (default pi extension).
 *
 * Post the orchestrator-simplify + remove-workflow-run-prod +
 * decompose-task-removed + remove-goal-contract + remove-orchestrator-advisory
 * + drop-failure-catalog cascades the package owns no tools. It exists
 * as a thin session-hook layer + a brainstorming slash command:
 *
 *   - session_start: `pi.setActiveTools([...])` gates which tools the
 *     LLM can see (PI_TASKS / PI_SUBAGENT / SUBAGENT_CONTROL / AFT /
 *     BASELINE) — none of those are owned by the orchestrator; the
 *     orchestrator only curates the allowlist.
 *   - before_agent_start: prepend `templates/SYSTEM.md` (the orchestrator
 *     constitution) to the LLM system prompt.
 *   - tool_call: once-per-session soft-mode reminder that fires on the
 *     first side-effecting call (bash / edit / write).
 *   - brainstorming slash command (registered via the skill at
 *     `skills/brainstorming/SKILL.md`).
 *
 * The orchestrator exports a curated tool allowlist + soft-mode reminder
 * + system-prompt overlay. The LLM drives any multi-stage work via raw
 * `TaskCreate` × N + `TaskExecute` directly. No orchestrator-registered
 * tool mediates the workflow.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOrchestrateTool } from "./orchestrator-tool.js";

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
 * Tools registered by `@sages/pi-subagents` (GC-2026-boundary-subagent-control
 * moved the registration out of the orchestrator). These delegate to
 * the same `AgentManager` singleton via the shared globalThis registry
 * key `Symbol.for("pi-subagents:manager")` — there is exactly one
 * manager, shared end-to-end with the `Agent` tool. The orchestrator's
 * constant is purely for `setActiveTools` filtering; it does NOT
 * register anything.
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
 * can drive the Implement → Review → optional Developer → Reviewer pipeline
 * directly via TaskCreate / TaskList / TaskExecute / etc.
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
 * Soft-mode reminder text. Fires once per session on the first side-effecting
 * tool call (bash / edit / write) to nudge the LLM toward the
 * pi-tasks-driven workflow when the active task list exceeds 2 items.
 */
const SOFT_MODE_REMINDER = `> ⚙️ **SOFT MODE — workflow pipeline recommended**
>
> If this is part of a larger workflow (>2 items in your active task list,
> i.e. above the **task-count threshold**), consider driving it through
> the pi-tasks workflow: raw \`TaskCreate\` × N (one per phase: Developer /
> Reviewer / Fix / MergerAdvisor) → \`TaskExecute\`. For ≤2 tasks (below
> the task-count threshold), direct handling is acceptable. This is a
> recommendation — the agent decides. No commands are blocked.
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
			...PI_TASKS_TOOLS,
			...SUBAGENT_TOOLS,
			...AFT_TOOLS,
			...BASELINE_TOOLS,
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
 * orchestrator's first LLM-facing tool, `orchestrate`, which materializes
 * a multi-phase workflow as a task DAG in pi-tasks's shared store.
 */
export default function registerOrchestratorExtension(pi: ExtensionAPI): void {
	installSessionHooks(pi);
	registerOrchestrateTool(pi);
}