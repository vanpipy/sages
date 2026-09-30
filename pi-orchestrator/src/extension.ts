/**
 * @sages/pi-orchestrator — package entry point (default pi extension).
 *
 * After GC-2026-orchestrator-simplify the orchestrator owns exactly
 * ONE tool (`goal_contract_create`). The DAG, dispatch, audit, and
 * reminder tools were removed — workflow is now driven by pi-tasks
 * (TaskCreate × 4 + TaskExecute) and orchestrated at the workflow
 * level by the future `workflow_run` tool (GC-2).
 *
 * Registers:
 *   - `goal_contract_create` — the intent + lock contract tool
 *   - `registerSubagentControlTools` — subagent_status / steer / abort / resume
 *   - Orchestrator advisory pipeline (post-tool detector + nudges)
 *
 * Three session-level hooks (preserved):
 *   1. `session_start`        — `pi.setActiveTools([...])`
 *   2. `before_agent_start`   — prepend `templates/SYSTEM.md`
 *   3. `tool_call`            — soft-mode reminder (first bash call)
 *
 * Brainstorming is registered separately as a slash command.
 *
 * Peer dependencies:
 *   - @earendil-works/pi-coding-agent  — ExtensionAPI type
 *   - @sages/pi-subagents           — Agent / get_subagent_result / steer_subagent
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerGoalContractTool } from "./goal-contract.js";
import { registerSubagentControlTools } from "./subagent-control.js";
import {
	installOrchestratorAdvisoryHandlers,
	type OrchestratorAdvisoryRuntimeDeps,
} from "./orchestrator-advisory.js";

/**
 * Tools always exposed to the main agent when the orchestrator
 * extension is loaded. After GC-2026-orchestrator-simplify this is
 * just one entry: `goal_contract_create`. The workflow itself is
 * driven by pi-tasks (TaskCreate / TaskExecute / etc.) which are
 * registered by `@sages/pi-tasks` and exposed via the active
 * toolset. GC-2 will add `workflow_run` here.
 */
export const ORCHESTRATOR_TOOLS: readonly string[] = [
	"goal_contract_create",
];

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
 * Tools registered by the orchestrator's own `registerSubagentControlTools`
 * (GC-2026-073). These delegate to the same `AgentManager` singleton
 * via the shared globalThis registry key
 * `Symbol.for("pi-subagents:manager")` — there is exactly one manager,
 * shared end-to-end with the `Agent` tool.
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
 * can drive the Implement → Review → optional Fix → Merge pipeline
 * directly via TaskCreate / TaskList / TaskExecute / etc. GC-2 will
 * add `workflow_run` as a one-shot pipeline runner on top of this.
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
 * Soft-mode reminder text. Fires once per session on the first `bash`
 * tool call to nudge the LLM toward the pi-tasks-driven workflow when
 * the active task list exceeds 2 items (the historical `dag_threshold`).
 */
const SOFT_MODE_REMINDER = `> ⚙️ **SOFT MODE — workflow pipeline recommended**
>
> If this is part of a larger workflow (>2 items in your active task list,
> i.e. above the **task-count threshold**), consider driving it through
> the pi-tasks workflow: \`goal_contract_create\` → \`TaskCreate\` × 4
> (Implement / Review / optional Fix / Merge) → \`TaskExecute\`. For ≤2
> tasks (below the task-count threshold), direct handling is acceptable.
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
 * Register all orchestrator tools on the pi extension. Idempotent.
 */
export function registerOrchestratorTools(
	pi: ExtensionAPI,
	runtime?: OrchestratorAdvisoryRuntimeDeps,
): void {
	registerGoalContractTool(pi);
	// GC-2026-073: programmatic LLM-facing tools for inspecting and
	// controlling subagents.
	registerSubagentControlTools(pi);
	// GC-2026-053: orchestrator tool_call audit wiring.
	installOrchestratorAdvisoryHandlers(pi, runtime);
}

/**
 * Install the three session-level hooks.
 */
export function installSessionHooks(pi: ExtensionAPI): void {
	// 1. session_start — setActiveTools + setStatus.
	pi.on("session_start", () => {
		const tools: string[] = [
			...ORCHESTRATOR_TOOLS,
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
	pi.on("before_agent_start", (event: any) => {
		if (!existsSync(SYSTEM_PROMPT_TEMPLATE)) return undefined;
		const overlay = readFileSync(SYSTEM_PROMPT_TEMPLATE, "utf-8");
		return {
			systemPrompt: overlay + "\n\n---\n\n" + (event.systemPrompt ?? ""),
		};
	});

	// 3. tool_call — fire the soft-mode reminder once per session on the
	// first bash call.
	let reminderFired = false;
	pi.on("tool_call", (event: any) => {
		if (reminderFired) return undefined;
		if (event?.toolName !== "bash") return undefined;
		reminderFired = true;
		pi.appendEntry("system", SOFT_MODE_REMINDER);
		return undefined;
	});
}

/**
 * Register the `/brainstorm` slash command. Called separately from
 * `registerOrchestratorTools` because the brainstorm flow is an
 * interactive state machine, not an LLM-callable tool.
 */
export function registerBrainstormCommand(pi: ExtensionAPI): void {
	// The brainstorm slash command is registered via the skill in
	// `skills/brainstorming/SKILL.md`.
}

/**
 * Default pi extension entrypoint.
 */
export default function registerOrchestratorExtension(pi: ExtensionAPI): void {
	registerOrchestratorTools(pi);
	installSessionHooks(pi);
}
